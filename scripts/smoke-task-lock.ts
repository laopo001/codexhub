import { mkdir, mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

type MachineSummary = {
  machineId: string;
  online?: boolean;
  capabilities?: {
    projectLauncher?: boolean;
  };
};

type ProjectOpenResponse = {
  result?: {
    sessionId?: string;
    threadId?: string;
    cwd?: string;
  };
};

type LocalTask = {
  taskId: string;
  lastStatus?: "queued" | "completed" | "failed" | "skipped";
  threadId?: string;
  lastError?: string;
};

type TaskRunResponse = {
  ok?: boolean;
  skipped?: boolean;
  task?: LocalTask;
  sessionId?: string;
  threadId?: string;
};

type MachineCommand = {
  commandId: string;
  type: "start_session" | "list_directory";
  cwd?: string;
};

type SessionCommand = {
  commandId: string;
  type: string;
  threadId?: string;
};

const main = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-task-lock."));
  const dataDir = path.join(root, "state");
  const projectDir = path.join(root, "project");
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  process.env.CODEX_HUB_DATA_DIR = dataDir;
  process.env.CODEX_HUB_LOCAL_MACHINE = "0";
  process.env.CODEX_HUB_PLUGIN_TELEGRAM = "0";
  process.env.TELEGRAM_BOT_TOKEN = "";

  const port = await findFreePort();
  const { startServer } = await import("../src/server/index.js");
  const server = await startServer({ host: "127.0.0.1", port });
  const apiBase = `http://127.0.0.1:${port}`;
  const fake = new FakeMachine(apiBase, {
    machineId: `task-lock-machine-${process.pid}`,
    sessionId: `task-lock-session-${process.pid}`,
    threadId: `task-lock-thread-${process.pid}`,
    cwd: projectDir
  });

  try {
    await fake.start();
    const machine = await waitForMachine(apiBase, fake.machineId);
    console.log(`fake machine ok: ${machine.machineId}`);

    const open = await apiJson<ProjectOpenResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: fake.machineId, path: projectDir })
    });
    assertNoWorkerId(open, "/api/projects/open");
    if (open.result?.sessionId !== fake.sessionId || open.result?.threadId !== fake.threadId) {
      throw new Error(`project open returned unexpected session/thread: ${JSON.stringify(open)}`);
    }

    const created = await apiJson<{ task?: LocalTask }>(apiBase, "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Task lock smoke",
        enabled: false,
        schedule: "* * * * *",
        machineId: fake.machineId,
        projectPath: projectDir,
        input: "hold this task open"
      })
    });
    assertNoWorkerId(created, "POST /api/tasks");
    const taskId = created.task?.taskId;
    if (!taskId) throw new Error("task create did not return taskId");

    const firstRun = apiJson<TaskRunResponse>(apiBase, `/api/tasks/${encodeURIComponent(taskId)}/run`, { method: "POST" });
    const secondRun = apiJson<TaskRunResponse>(apiBase, `/api/tasks/${encodeURIComponent(taskId)}/run`, { method: "POST" });
    const results = await Promise.all([firstRun, secondRun]);
    for (const result of results) assertNoWorkerId(result, "POST /api/tasks/:taskId/run");
    const queued = results.find((result) => !result.skipped);
    const skipped = results.find((result) => result.skipped);
    if (!queued || queued.task?.lastStatus !== "queued") {
      throw new Error(`one concurrent task run should be queued: ${JSON.stringify(results)}`);
    }
    if (!skipped || skipped.task?.lastStatus !== "skipped") {
      throw new Error(`one concurrent task run should be skipped: ${JSON.stringify(results)}`);
    }
    console.log("task duplicate skip ok");

    await fake.completeNextTurn();
    await waitForTaskStatus(apiBase, taskId, "completed");
    console.log("task completion unlock ok");

    const third = await apiJson<TaskRunResponse>(apiBase, `/api/tasks/${encodeURIComponent(taskId)}/run`, { method: "POST" });
    assertNoWorkerId(third, "POST /api/tasks/:taskId/run after unlock");
    if (third.skipped || third.task?.lastStatus !== "queued") {
      throw new Error(`task lock did not release after completion: ${JSON.stringify(third)}`);
    }
    await fake.completeNextTurn();
    await waitForTaskStatus(apiBase, taskId, "completed");
    console.log("task rerun ok");
  } finally {
    fake.stop();
    await server.stop();
  }
};

class FakeMachine {
  private ws: WebSocket | null = null;
  private sessionRegistered = false;
  private pendingTurns: SessionCommand[] = [];
  private turnWaiters: Array<(command: SessionCommand) => void> = [];

  constructor(
    private readonly apiBase: string,
    readonly options: {
      machineId: string;
      sessionId: string;
      threadId: string;
      cwd: string;
    }
  ) {}

  get machineId() {
    return this.options.machineId;
  }

  get sessionId() {
    return this.options.sessionId;
  }

  get threadId() {
    return this.options.threadId;
  }

  async start() {
    const ws = new WebSocket(machineTransportUrl(this.apiBase));
    this.ws = ws;
    ws.addEventListener("message", (event) => this.handleMessage(event.data));
    await waitForWebSocketOpen(ws);
    this.send({
      type: "register",
      commandCursor: 0,
      registration: {
        machineId: this.options.machineId,
        type: "registered",
        name: "Task Lock Fake Machine",
        hostname: "task-lock-host",
        cwd: this.options.cwd,
        capabilities: { projectLauncher: true }
      }
    });
  }

  stop() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: "unregister" });
      this.ws.close();
    }
    this.ws = null;
  }

  async completeNextTurn() {
    const command = await this.waitForTurn();
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: {
        type: "thread_execution_changed",
        threadId: command.threadId ?? this.options.threadId,
        running: false,
        heartbeat: false
      }
    });
    this.send({
      type: "session_command_result",
      sessionId: this.options.sessionId,
      commandId: command.commandId,
      result: { ok: true }
    });
  }

  private handleMessage(data: unknown) {
    const message = JSON.parse(String(data)) as {
      type: string;
      commands?: MachineCommand[] | SessionCommand[];
    };
    assertNoWorkerId(message, `machine websocket ${message.type}`);
    if (message.type === "commands") {
      for (const command of message.commands as MachineCommand[] ?? []) this.handleMachineCommand(command);
    }
    if (message.type === "session_commands") {
      for (const command of message.commands as SessionCommand[] ?? []) this.handleSessionCommand(command);
    }
  }

  private handleMachineCommand(command: MachineCommand) {
    if (command.type !== "start_session") {
      this.send({ type: "command_error", commandId: command.commandId, message: `Unsupported machine command: ${command.type}` });
      return;
    }
    this.registerSession();
    this.send({
      type: "command_result",
      commandId: command.commandId,
      result: {
        sessionId: this.options.sessionId,
        threadId: this.options.threadId,
        appServerUrl: "ws://127.0.0.1:9",
        cwd: this.options.cwd,
        reused: this.sessionRegistered
      }
    });
  }

  private handleSessionCommand(command: SessionCommand) {
    if (command.type === "resume_thread" || command.type === "start_thread") {
      this.send({
        type: "session_command_result",
        sessionId: this.options.sessionId,
        commandId: command.commandId,
        result: { threadId: command.threadId ?? this.options.threadId }
      });
      return;
    }
    if (command.type !== "turn") {
      this.send({
        type: "session_command_error",
        sessionId: this.options.sessionId,
        commandId: command.commandId,
        message: `Unsupported session command: ${command.type}`
      });
      return;
    }
    this.pendingTurns.push(command);
    const waiter = this.turnWaiters.shift();
    if (waiter) waiter(this.pendingTurns.shift()!);
  }

  private registerSession() {
    if (this.sessionRegistered) return;
    this.sessionRegistered = true;
    this.send({
      type: "session_register",
      sessionId: this.options.sessionId,
      commandCursor: 0,
      registration: {
        machineId: this.options.machineId,
	        name: "Task Lock Fake Session",
	        workingDirectory: this.options.cwd,
	        appServerUrl: "ws://127.0.0.1:9",
	        hostname: "task-lock-host"
	      }
	    });
  }

  private waitForTurn(timeoutMs = 5000) {
    const existing = this.pendingTurns.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise<SessionCommand>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for fake session turn command")), timeoutMs);
      this.turnWaiters.push((command) => {
        clearTimeout(timer);
        resolve(command);
      });
    });
  }

  private send(message: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("fake machine websocket is not open");
    this.ws.send(JSON.stringify(message));
  }
}

const waitForMachine = async (apiBase: string, machineId: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const data = await apiJson<{ machines?: MachineSummary[] }>(apiBase, "/api/machines").catch(() => ({ machines: [] }));
    const machine = data.machines?.find((item) => item.machineId === machineId && item.online && item.capabilities?.projectLauncher);
    if (machine) return machine;
    await delay(100);
  }
  throw new Error(`fake machine did not register: ${machineId}`);
};

const waitForTaskStatus = async (
  apiBase: string,
  taskId: string,
  status: NonNullable<LocalTask["lastStatus"]>
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const data = await apiJson<{ tasks?: LocalTask[] }>(apiBase, "/api/tasks");
    const task = data.tasks?.find((item) => item.taskId === taskId);
    if (task?.lastStatus === status) return task;
    await delay(100);
  }
  throw new Error(`task ${taskId} did not reach status ${status}`);
};

const apiJson = async <T = unknown>(apiBase: string, pathname: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(new URL(pathname, apiBase), {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`HTTP ${response.status} ${pathname}: ${text}`);
  return data as T;
};

const assertNoWorkerId = (value: unknown, label: string) => {
  const path = findKey(value, "workerId");
  if (path) throw new Error(`${label} exposed workerId at ${path}`);
};

const findKey = (value: unknown, key: string, trail = "$"): string | null => {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findKey(value[index], key, `${trail}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const entryTrail = `${trail}.${entryKey}`;
    if (entryKey === key) return entryTrail;
    const found = findKey(entryValue, key, entryTrail);
    if (found) return found;
  }
  return null;
};

const machineTransportUrl = (apiBase: string) => {
  const url = new URL("/api/machines/connect", apiBase);
  url.protocol = "ws:";
  return url.toString();
};

const waitForWebSocketOpen = async (ws: WebSocket) => await new Promise<void>((resolve, reject) => {
  if (ws.readyState === WebSocket.OPEN) {
    resolve();
    return;
  }
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", () => reject(new Error("fake machine websocket failed")), { once: true });
});

const findFreePort = async () => await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close(() => reject(new Error("failed to allocate port")));
      return;
    }
    const port = address.port;
    server.close(() => resolve(port));
  });
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await main();
