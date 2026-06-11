import { mkdir, mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

type MachineCommand = {
  seq: number;
  commandId: string;
  type: "start_session" | "list_directory" | "stop_session";
  cwd?: string;
  sessionId?: string;
};

type SessionCommand = {
  seq: number;
  commandId: string;
  type: string;
  threadId?: string;
  input?: string;
};

type MachineMessage =
  | { type: "registered"; machineId: string }
  | { type: "commands"; cursor: number; commands: MachineCommand[] }
  | { type: "session_registered"; sessionId: string }
  | { type: "session_commands"; sessionId: string; cursor: number; commands: SessionCommand[] }
  | { type: "error"; message: string };

const main = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-server-bridge-smoke."));
  const parentDataDir = path.join(root, "parent-state");
  const childDataDir = path.join(root, "child-state");
  const projectDir = path.join(root, "project");
  await mkdir(parentDataDir, { recursive: true });
  await mkdir(childDataDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  const parentPort = await findFreePort();
  const childPort = await findFreePort();
  const { startServer } = await import("../src/server/index.js");

  process.env.CODEX_HUB_LOCAL_MACHINE = "0";
  process.env.CODEX_HUB_PLUGIN_TELEGRAM = "0";
  process.env.TELEGRAM_BOT_TOKEN = "";

  process.env.CODEX_HUB_DATA_DIR = parentDataDir;
  const parent = await startServer({
    host: "127.0.0.1",
    port: parentPort,
    features: { localMachine: false, ssh: false, tasks: false, integrations: false }
  });
  process.env.CODEX_HUB_DATA_DIR = childDataDir;
  const child = await startServer({
    host: "127.0.0.1",
    port: childPort,
    features: { localMachine: false, ssh: false, tasks: false, integrations: false }
  });

  const parentApi = `http://127.0.0.1:${parentPort}`;
  const childApi = `http://127.0.0.1:${childPort}`;
  const fakeMachine = new FakeLocalMachine(childApi, projectDir);

  try {
    await fakeMachine.start();
    await apiJson(childApi, "/api/server-connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Child Group",
        url: parentApi,
        enabled: true
      })
    });

    const serverMachine = await waitFor(
      async () => {
        const payload = await apiJson<{ machines?: Array<{ machineId: string; type?: string; name?: string; online?: boolean }> }>(
          parentApi,
          "/api/machines"
        );
        return payload.machines?.find((machine) => machine.type === "server" && machine.name === "Child Group" && machine.online) ?? null;
      },
      "server machine registration"
    );
    console.log(`server machine ok: ${serverMachine.machineId}`);

    const opened = await apiJson<{ result?: { sessionId?: string; threadId?: string; cwd?: string } }>(parentApi, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: serverMachine.machineId, path: projectDir, reuse: true })
    });
    const sessionId = opened.result?.sessionId;
    const threadId = opened.result?.threadId;
    if (sessionId !== fakeMachine.sessionId || threadId !== fakeMachine.threadId) {
      throw new Error(`unexpected bridged session/thread: ${JSON.stringify(opened)}`);
    }
    console.log(`server bridge project ok: ${sessionId} ${threadId}`);

    await apiJson(parentApi, `/api/threads/${encodeURIComponent(threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello from parent", source: "web" })
    });

    const parentThread = await waitFor(
      async () => {
        const thread = await apiJson<{ records?: Array<{ payload?: { message?: string } }> }>(
          parentApi,
          `/api/threads/${encodeURIComponent(threadId)}`
        );
        return thread.records?.some((record) => record.payload?.message === "child response") ? thread : null;
      },
      "mirrored parent thread response"
    );
    if (!parentThread.records?.length) throw new Error("parent thread did not contain records");
    console.log("server bridge turn mirror ok");

    const childThread = await apiJson<{ records?: Array<{ payload?: { message?: string } }> }>(
      childApi,
      `/api/threads/${encodeURIComponent(threadId)}`
    );
    if (!childThread.records?.some((record) => record.payload?.message === "child response")) {
      throw new Error("child thread did not receive bridged turn output");
    }
    console.log("child thread owner ok");
  } finally {
    await fakeMachine.stop().catch(() => undefined);
    await child.stop();
    await parent.stop();
  }
};

class FakeLocalMachine {
  readonly machineId = `local-server-bridge-smoke-${process.pid}`;
  readonly sessionId = `session-server-bridge-smoke-${process.pid}`;
  readonly threadId = `thread-server-bridge-smoke-${process.pid}`;
  private ws: WebSocket | null = null;
  private commandCursor = 0;
  private sessionCursor = 0;

  constructor(private readonly apiBase: string, private readonly cwd: string) {}

  async start() {
    this.ws = await openWebSocket(machineUrl(this.apiBase));
    this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
    this.send({
      type: "register",
      commandCursor: this.commandCursor,
      registration: {
        machineId: this.machineId,
        type: "local",
        name: "Fake Local",
        hostname: "fake-local",
        capabilities: { projectLauncher: true }
      }
    });
    await waitFor(async () => this.ws?.readyState === WebSocket.OPEN ? true : null, "fake local machine websocket");
  }

  async stop() {
    this.send({ type: "unregister" });
    this.ws?.close();
  }

  private handleMessage(data: unknown) {
    const message = parseMessage(data);
    if (!message) return;
    if (message.type === "commands") {
      this.commandCursor = Math.max(this.commandCursor, message.cursor);
      for (const command of message.commands) this.handleMachineCommand(command);
      return;
    }
    if (message.type === "session_commands") {
      this.sessionCursor = Math.max(this.sessionCursor, message.cursor);
      for (const command of message.commands) this.handleSessionCommand(command);
    }
  }

  private handleMachineCommand(command: MachineCommand) {
    if (command.type === "start_session") {
      this.registerSession();
      this.sendThreadSnapshot();
      this.send({
        type: "command_result",
        commandId: command.commandId,
        result: {
          sessionId: this.sessionId,
          threadId: this.threadId,
          appServerUrl: "http://127.0.0.1/fake-app-server",
          cwd: this.cwd,
          reused: false
        }
      });
      this.commandCursor = Math.max(this.commandCursor, command.seq);
      return;
    }
    if (command.type === "list_directory") {
      this.send({
        type: "command_result",
        commandId: command.commandId,
        result: {
          cwd: this.cwd,
          home: this.cwd,
          entries: []
        }
      });
      this.commandCursor = Math.max(this.commandCursor, command.seq);
      return;
    }
    if (command.type === "stop_session") {
      this.send({
        type: "command_result",
        commandId: command.commandId,
        result: {
          sessionId: this.sessionId,
          stopped: true,
          cwd: this.cwd
        }
      });
      this.commandCursor = Math.max(this.commandCursor, command.seq);
    }
  }

  private handleSessionCommand(command: SessionCommand) {
    if (command.type === "observe_thread_records" || command.type === "unobserve_thread_records") {
      this.sessionCursor = Math.max(this.sessionCursor, command.seq);
      return;
    }
    if (command.type === "turn" || command.type === "steer") {
      this.sendThreadEvent("record", userRecord(this.threadId, "hello from parent"));
      this.sendThreadEvent("record", assistantRecord(this.threadId, "child response"));
      this.sendThreadEvent("done");
      this.send({
        type: "session_command_result",
        sessionId: this.sessionId,
        commandId: command.commandId,
        result: { ok: true }
      });
      this.sessionCursor = Math.max(this.sessionCursor, command.seq);
    }
  }

  private registerSession() {
    this.send({
      type: "session_register",
      sessionId: this.sessionId,
      commandCursor: this.sessionCursor,
      registration: {
        machineId: this.machineId,
        name: "Fake Session",
        workingDirectory: this.cwd,
        appServerUrl: "http://127.0.0.1/fake-app-server",
        hostname: "fake-local"
      }
    });
  }

  private sendThreadSnapshot() {
    this.send({
      type: "session_thread_snapshot",
      sessionId: this.sessionId,
      thread: threadDetail(this.threadId, this.cwd, [])
    });
  }

  private sendThreadEvent(kind: "record" | "done", record?: unknown) {
    this.send({
      type: "session_thread_event",
      sessionId: this.sessionId,
      event: {
        seq: Date.now(),
        threadId: this.threadId,
        kind,
        thread: threadSummary(this.threadId, this.cwd, kind !== "done"),
        record
      }
    });
  }

  private send(message: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }
}

const threadDetail = (threadId: string, cwd: string, records: unknown[]) => ({
  ...threadSummary(threadId, cwd, false),
  records,
  lastSeq: 0
});

const threadSummary = (threadId: string, cwd: string, running: boolean) => ({
  threadId,
  workingDirectory: cwd,
  session: {
    sessionId: `session-server-bridge-smoke-${process.pid}`,
    online: true,
    runnable: true
  },
  status: running ? "running" : "idle",
  running,
  title: "Server bridge smoke",
  updatedAt: new Date().toISOString(),
  messageCount: 0,
  threadUsage: {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  }
});

const userRecord = (threadId: string, message: string) => ({
  id: `smoke:user:${Date.now()}`,
  type: "event_msg",
  timestamp: new Date().toISOString(),
  payload: {
    type: "user_message",
    message,
    images: [],
    text_elements: []
  },
  sourceThreadId: threadId
});

const assistantRecord = (threadId: string, message: string) => ({
  id: `smoke:assistant:${Date.now()}`,
  type: "event_msg",
  timestamp: new Date().toISOString(),
  payload: {
    type: "agent_message",
    message,
    phase: "final_answer"
  },
  sourceThreadId: threadId
});

const machineUrl = (apiBase: string) => {
  const url = new URL("/api/machines/connect", apiBase);
  url.protocol = "ws:";
  return url.toString();
};

const openWebSocket = async (url: string) => {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      ws.close();
      reject(new Error(`Timed out opening ${url}`));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Could not open ${url}`));
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });
  return ws;
};

const apiJson = async <T,>(apiBase: string, route: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(new URL(route, apiBase), init);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
};

const waitFor = async <T,>(fn: () => Promise<T | null> | T | null, label: string, timeoutMs = 15_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const parseMessage = (data: unknown): MachineMessage | null => {
  try {
    const parsed = JSON.parse(String(data)) as MachineMessage;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const findFreePort = async () => await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close(() => reject(new Error("Could not allocate port")));
      return;
    }
    const port = address.port;
    server.close(() => resolve(port));
  });
});

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
