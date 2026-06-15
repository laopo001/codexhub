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
  nextRunAt?: string | null;
  runs?: Array<{
    runId: string;
    status: "queued" | "completed" | "failed" | "skipped";
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    threadId?: string;
  }>;
};

type TaskRunResponse = {
  ok?: boolean;
  skipped?: boolean;
  task?: LocalTask;
  sessionId?: string;
  threadId?: string;
};

type RealtimeMessage = {
  type?: string;
  threadId?: string;
  kind?: string;
  historical?: boolean;
  record?: {
    id?: string;
    type?: string;
    payload?: unknown;
  };
};

type PartialRateLimitWindow = {
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: number;
};

type PartialThreadUsage = {
  context?: {
    usedTokens?: number;
    windowTokens?: number;
  } | null;
  primaryRateLimit?: PartialRateLimitWindow | null;
  secondaryRateLimit?: PartialRateLimitWindow | null;
};

type ThreadDetail = {
  threadUsage?: PartialThreadUsage;
  records?: Array<{
    type?: string;
    payload?: unknown;
  }>;
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
  includeHidden?: boolean;
  input?: unknown;
  turnId?: string;
  goal?: {
    objective?: string | null;
    status?: string | null;
    tokenBudget?: number | null;
  };
  reviewTarget?: {
    type?: string;
  };
  options?: {
    collaborationMode?: "default" | "plan" | null;
    goalMode?: boolean | null;
    goalObjective?: string | null;
    goalTokenBudget?: number | null;
    serviceTier?: string | null;
  };
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
  process.env.CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS = "25";
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
    const modelCatalogPromise = apiJson<{
      models?: Array<{
        model?: string;
        supportedReasoningEfforts?: Array<{ value?: string }>;
        serviceTiers?: Array<{ value?: string }>;
      }>;
    }>(apiBase, `/api/sessions/${encodeURIComponent(fake.sessionId)}/models`);
    const modelListCommand = await fake.nextSessionCommand("list_models");
    if (modelListCommand.includeHidden !== false) {
      throw new Error(`model catalog command should not include hidden models by default: ${JSON.stringify(modelListCommand)}`);
    }
    const modelCatalog = await modelCatalogPromise;
    const catalogModel = modelCatalog.models?.find((model) => model.model === "gpt-5.5");
    if (!catalogModel) {
      throw new Error(`model catalog response missing gpt-5.5: ${JSON.stringify(modelCatalog)}`);
    }
    if (!catalogModel.supportedReasoningEfforts?.some((option) => option.value === "xhigh")) {
      throw new Error(`model catalog response missing reasoning effort: ${JSON.stringify(modelCatalog)}`);
    }
    if (!catalogModel.serviceTiers?.some((option) => option.value === "fast")) {
      throw new Error(`model catalog response missing fast service tier: ${JSON.stringify(modelCatalog)}`);
    }
    console.log("session model catalog ok");
    await fake.expectNoSessionCommand("subscribe_thread_records", 100);
    await assertThreadRecordSubscription(apiBase, fake.threadId, fake);
    console.log("thread record subscription ok");
    await assertAppServerOnlyThreadSubscription(apiBase, fake.threadId, fake);
    console.log("app-server-only thread subscription ok");
    await assertHistoricalSnapshotPublishesMarkedRecordEvents(apiBase, fake.threadId, fake);
    console.log("historical snapshot record events marked ok");

    const compactPromise = apiJson<{ ok?: boolean }>(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}/compact`,
      { method: "POST" }
    );
    const compactCommand = await fake.nextSessionCommand("compact_thread");
    if (compactCommand.threadId !== fake.threadId) {
      throw new Error(`thread compact command mismatch: ${JSON.stringify(compactCommand)}`);
    }
    const compactResult = await compactPromise;
    if (!compactResult.ok) throw new Error(`thread compact response mismatch: ${JSON.stringify(compactResult)}`);
    console.log("thread compact command ok");

    const reviewPromise = apiJson<{ ok?: boolean; reviewThreadId?: string }>(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}/review`,
      { method: "POST" }
    );
    const reviewCommand = await fake.nextSessionCommand("review_thread");
    if (reviewCommand.threadId !== fake.threadId || reviewCommand.reviewTarget?.type !== "uncommittedChanges") {
      throw new Error(`thread review command mismatch: ${JSON.stringify(reviewCommand)}`);
    }
    const reviewResult = await reviewPromise;
    if (!reviewResult.ok || reviewResult.reviewThreadId !== fake.threadId) {
      throw new Error(`thread review response mismatch: ${JSON.stringify(reviewResult)}`);
    }
    console.log("thread review command ok");

    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "plan and pursue this smoke task",
        source: "web",
        options: {
          collaborationMode: "plan",
          goalMode: true,
          goalObjective: "finish the plan and goal smoke",
          goalTokenBudget: 1234,
          serviceTier: "priority"
        }
      })
    });
    const modeTurn = await fake.nextTurn();
    await fake.expectNoSessionCommand("subscribe_thread_records", 100);
    if (modeTurn.options?.collaborationMode !== "plan" || modeTurn.options?.goalMode !== true) {
      throw new Error(`web turn mode options were not forwarded: ${JSON.stringify(modeTurn.options)}`);
    }
    if (modeTurn.options.goalObjective !== "finish the plan and goal smoke" || modeTurn.options.goalTokenBudget !== 1234) {
      throw new Error(`web turn goal options were not forwarded: ${JSON.stringify(modeTurn.options)}`);
    }
    if (modeTurn.options.serviceTier !== "priority") {
      throw new Error(`web turn service tier option was not forwarded: ${JSON.stringify(modeTurn.options)}`);
    }
    fake.completeTurn(modeTurn);
    console.log("web turn mode options ok");

    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "default follow-up should not inherit composer modes",
        source: "web"
      })
    });
    const defaultTurn = await fake.nextTurn();
    if (defaultTurn.options?.collaborationMode || defaultTurn.options?.goalMode) {
      throw new Error(`composer mode options leaked into default turn: ${JSON.stringify(defaultTurn.options)}`);
    }
    fake.completeTurn(defaultTurn);
    console.log("web turn mode one-shot ok");

    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "hold this web turn open",
        source: "web"
      })
    });
    const activeWebTurn = await fake.nextTurn();
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "steered web follow-up",
        source: "web"
      })
    });
    const steer = await fake.nextSteer();
    if (steer.input !== "steered web follow-up") {
      throw new Error(`web steer input mismatch: ${JSON.stringify(steer.input)}`);
    }
    if (steer.turnId !== activeWebTurn.turnId) {
      throw new Error(`web steer used wrong turnId: ${JSON.stringify({ expected: activeWebTurn.turnId, actual: steer.turnId })}`);
    }
    fake.emitTokenUsage(activeWebTurn);
    await assertThreadUsageRateLimits(apiBase, fake.threadId);
    console.log("app-server token usage rate limits ok");
    fake.completeTurn(activeWebTurn);
    console.log("web running turn steer ok");

    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "hold goal web turn open",
        source: "web"
      })
    });
    const activeGoalTurn = await fake.nextTurn();
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "replace the active goal",
        source: "web",
        options: { goalMode: true }
      })
    });
    const setGoal = await fake.nextSessionCommand("set_goal");
    if (setGoal.options?.goalMode) {
      throw new Error(`web goal update command mismatch: ${JSON.stringify(setGoal)}`);
    }
    if (setGoal.goal?.objective !== "replace the active goal" || setGoal.goal.status !== "active") {
      throw new Error(`web goal update payload mismatch: ${JSON.stringify(setGoal.goal)}`);
    }
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "paused" })
    });
    const pausedGoal = await fake.nextSessionCommand("set_goal");
    if (pausedGoal.goal?.status !== "paused") {
      throw new Error(`web goal pause payload mismatch: ${JSON.stringify(pausedGoal.goal)}`);
    }
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, { method: "DELETE" });
    const clearedGoal = await fake.nextSessionCommand("clear_goal");
    if (clearedGoal.threadId !== fake.threadId) {
      throw new Error(`web goal clear command mismatch: ${JSON.stringify(clearedGoal)}`);
    }
    const clearedDetail = await apiJson<{ records?: Array<{ payload?: { type?: string } }> }>(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}`
    );
    if (!clearedDetail.records?.some((record) => record.payload?.type === "thread_goal_cleared")) {
      throw new Error(`web goal clear record missing: ${JSON.stringify(clearedDetail.records)}`);
    }
    fake.completeTurn(activeGoalTurn);
    console.log("web running goal update ok");

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
    const task = created.task;
    const taskId = task?.taskId;
    if (!taskId) throw new Error("task create did not return taskId");
    if (task.nextRunAt !== null) {
      throw new Error(`disabled task should not expose nextRunAt: ${JSON.stringify(task)}`);
    }

    const firstRun = apiJson<TaskRunResponse>(apiBase, `/api/tasks/${encodeURIComponent(taskId)}/run`, { method: "POST" });
    const secondRun = apiJson<TaskRunResponse>(apiBase, `/api/tasks/${encodeURIComponent(taskId)}/run`, { method: "POST" });
    const results = await Promise.all([firstRun, secondRun]);
    for (const result of results) assertNoWorkerId(result, "POST /api/tasks/:taskId/run");
    const queued = results.find((result) => !result.skipped);
    const skipped = results.find((result) => result.skipped);
    if (!queued || queued.task?.lastStatus !== "queued") {
      throw new Error(`one concurrent task run should be queued: ${JSON.stringify(results)}`);
    }
    if (!queued.task.runs?.some((run) => run.status === "queued")) {
      throw new Error(`queued task run summary missing: ${JSON.stringify(queued.task)}`);
    }
    if (!skipped || skipped.task?.lastStatus !== "skipped") {
      throw new Error(`one concurrent task run should be skipped: ${JSON.stringify(results)}`);
    }
    if (!skipped.task.runs?.some((run) => run.status === "skipped")) {
      throw new Error(`skipped task run summary missing: ${JSON.stringify(skipped.task)}`);
    }
    console.log("task duplicate skip ok");

    await fake.completeNextTurn();
    const completed = await waitForTaskStatus(apiBase, taskId, "completed");
    const completedRun = completed.runs?.find((run) => run.status === "completed");
    if (!completedRun || completedRun.durationMs == null) {
      throw new Error(`completed task run summary missing duration: ${JSON.stringify(completed)}`);
    }
    console.log("task completion unlock ok");

    const third = await apiJson<TaskRunResponse>(apiBase, `/api/tasks/${encodeURIComponent(taskId)}/run`, { method: "POST" });
    assertNoWorkerId(third, "POST /api/tasks/:taskId/run after unlock");
    if (third.skipped || third.task?.lastStatus !== "queued") {
      throw new Error(`task lock did not release after completion: ${JSON.stringify(third)}`);
    }
    await fake.completeNextTurn();
    const rerun = await waitForTaskStatus(apiBase, taskId, "completed");
    if ((rerun.runs ?? []).filter((run) => run.status === "completed").length < 2) {
      throw new Error(`task rerun history missing completed runs: ${JSON.stringify(rerun)}`);
    }
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
  private pendingSteers: SessionCommand[] = [];
  private pendingSessionCommandsByType = new Map<string, SessionCommand[]>();
  private turnWaiters: Array<(command: SessionCommand) => void> = [];
  private steerWaiters: Array<(command: SessionCommand) => void> = [];
  private sessionCommandWaitersByType = new Map<string, Array<(command: SessionCommand) => void>>();

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
    this.completeTurn(command);
  }

  async nextTurn() {
    return await this.waitForTurn();
  }

  async nextSteer() {
    return await this.waitForSteer();
  }

  async nextSessionCommand(type: string, timeoutMs = 5000) {
    return await this.waitForSessionCommand(type, timeoutMs);
  }

  async expectNoSessionCommand(type: string, timeoutMs = 100) {
    const existing = this.pendingSessionCommandsByType.get(type)?.shift();
    if (existing) throw new Error(`unexpected ${type} command: ${JSON.stringify(existing)}`);
    let resolved = false;
    await new Promise<void>((resolve, reject) => {
      const waiter = (command: SessionCommand) => {
        resolved = true;
        reject(new Error(`unexpected ${type} command: ${JSON.stringify(command)}`));
      };
      const waiters = this.sessionCommandWaitersByType.get(type) ?? [];
      waiters.push(waiter);
      this.sessionCommandWaitersByType.set(type, waiters);
      setTimeout(() => {
        if (resolved) return;
        const current = this.sessionCommandWaitersByType.get(type) ?? [];
        this.sessionCommandWaitersByType.set(type, current.filter((item) => item !== waiter));
        resolve();
      }, timeoutMs);
    });
  }

  emitTokenUsage(command: SessionCommand) {
    const threadId = command.threadId ?? this.options.threadId;
    if (!command.turnId) throw new Error(`fake turn missing turnId: ${JSON.stringify(command)}`);
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: {
        type: "thread_event",
        threadId,
        heartbeat: false,
        message: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId,
            turnId: command.turnId,
            tokenUsage: {
              last: {
                inputTokens: 1200,
                cachedInputTokens: 800,
                outputTokens: 90,
                reasoningOutputTokens: 10,
                totalTokens: 1300
              },
              modelContextWindow: 200000,
              rateLimits: {
                limitId: "codex",
                limitName: null,
                primary: {
                  usedPercent: 12.5,
                  windowMinutes: 300,
                  resetsAt: 1781058359
                },
                secondary: {
                  usedPercent: 64,
                  windowMinutes: 10080,
                  resetsAt: 1781140554
                },
                credits: null,
                individualLimit: null,
                planType: "pro",
                rateLimitReachedType: null
              }
            }
          }
        }
      }
    });
  }

  emitTurnsSnapshot(turnId: string) {
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: {
        type: "thread_turns_snapshot",
        threadId: this.options.threadId,
        heartbeat: false,
        turns: [
          {
            id: turnId,
            startedAt: 1781058300,
            completedAt: 1781058360,
            items: [
              {
                id: `${turnId}-agent`,
                type: "agentMessage",
                text: "historical snapshot final answer"
              }
            ]
          }
        ]
      }
    });
  }

  completeTurn(command: SessionCommand) {
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
    this.recordSessionCommand(command);
    if (command.type === "resume_thread" || command.type === "start_thread") {
      this.send({
        type: "session_command_result",
        sessionId: this.options.sessionId,
        commandId: command.commandId,
        result: { threadId: command.threadId ?? this.options.threadId }
      });
      return;
    }
    if (command.type === "subscribe_thread_records" || command.type === "unsubscribe_thread_records") {
      this.send({
        type: "session_command_result",
        sessionId: this.options.sessionId,
        commandId: command.commandId,
        result: { ok: true }
      });
      return;
    }
    if (command.type === "list_models") {
      this.send({
        type: "session_command_result",
        sessionId: this.options.sessionId,
        commandId: command.commandId,
        result: {
          models: [
            {
              id: "model-gpt-5.5",
              model: "gpt-5.5",
              displayName: "GPT-5.5",
              description: "Fake smoke model",
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [
                { value: "high", label: "High" },
                { value: "xhigh", label: "XHigh" }
              ],
              defaultServiceTier: "default",
              serviceTiers: [
                { value: "default", label: "Default" },
                { value: "fast", label: "Fast" }
              ]
            }
          ]
        }
      });
      return;
    }
    if (command.type !== "turn") {
      if (command.type === "set_goal") {
        this.send({
          type: "session_command_result",
          sessionId: this.options.sessionId,
          commandId: command.commandId,
          result: { ok: true }
        });
        return;
      }
      if (command.type === "clear_goal") {
        this.send({
          type: "session_event",
          sessionId: this.options.sessionId,
          event: {
            type: "thread_event",
            threadId: command.threadId ?? this.options.threadId,
            commandId: command.commandId,
            message: { id: command.commandId, result: { cleared: true } },
            heartbeat: false
          }
        });
        return;
      }
      if (command.type === "compact_thread") {
        this.send({
          type: "session_command_result",
          sessionId: this.options.sessionId,
          commandId: command.commandId,
          result: { ok: true }
        });
        return;
      }
      if (command.type === "review_thread") {
        const turnId = `fake-review-${command.commandId}`;
        this.send({
          type: "session_event",
          sessionId: this.options.sessionId,
          event: {
            type: "thread_execution_changed",
            threadId: command.threadId ?? this.options.threadId,
            running: true,
            turnId,
            heartbeat: false
          }
        });
        this.send({
          type: "session_command_result",
          sessionId: this.options.sessionId,
          commandId: command.commandId,
          result: { ok: true, reviewThreadId: command.threadId ?? this.options.threadId }
        });
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
        return;
      }
      if (command.type === "steer") {
        this.pendingSteers.push(command);
        const waiter = this.steerWaiters.shift();
        if (waiter) waiter(this.pendingSteers.shift()!);
        this.send({
          type: "session_command_result",
          sessionId: this.options.sessionId,
          commandId: command.commandId,
          result: { turnId: command.turnId }
        });
        return;
      }
      this.send({
        type: "session_command_error",
        sessionId: this.options.sessionId,
        commandId: command.commandId,
        message: `Unsupported session command: ${command.type}`
      });
      return;
    }
    const turn = { ...command, turnId: `fake-turn-${command.commandId}` };
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: {
        type: "thread_execution_changed",
        threadId: command.threadId ?? this.options.threadId,
        running: true,
        turnId: turn.turnId,
        heartbeat: false
      }
    });
    this.pendingTurns.push(turn);
    const waiter = this.turnWaiters.shift();
    if (waiter) waiter(this.pendingTurns.shift()!);
  }

  private recordSessionCommand(command: SessionCommand) {
    const waiters = this.sessionCommandWaitersByType.get(command.type) ?? [];
    const waiter = waiters.shift();
    if (waiter) {
      this.sessionCommandWaitersByType.set(command.type, waiters);
      waiter(command);
      return;
    }
    const pending = this.pendingSessionCommandsByType.get(command.type) ?? [];
    pending.push(command);
    this.pendingSessionCommandsByType.set(command.type, pending);
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

  private waitForSteer(timeoutMs = 5000) {
    const existing = this.pendingSteers.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise<SessionCommand>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for fake session steer command")), timeoutMs);
      this.steerWaiters.push((command) => {
        clearTimeout(timer);
        resolve(command);
      });
    });
  }

  private waitForSessionCommand(type: string, timeoutMs = 5000) {
    const existing = this.pendingSessionCommandsByType.get(type)?.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise<SessionCommand>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for fake session ${type} command`)), timeoutMs);
      const waiters = this.sessionCommandWaitersByType.get(type) ?? [];
      waiters.push((command) => {
        clearTimeout(timer);
        resolve(command);
      });
      this.sessionCommandWaitersByType.set(type, waiters);
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

const assertThreadUsageRateLimits = async (apiBase: string, threadId: string) => {
  const detail = await waitForThreadUsage(apiBase, threadId);
  const primary = detail.threadUsage?.primaryRateLimit;
  const secondary = detail.threadUsage?.secondaryRateLimit;
  if (
    primary?.usedPercent !== 12.5
    || primary.windowMinutes !== 300
    || primary.resetsAt !== 1781058359
    || secondary?.usedPercent !== 64
    || secondary.windowMinutes !== 10080
    || secondary.resetsAt !== 1781140554
  ) {
    throw new Error(`thread usage did not include rate limits: ${JSON.stringify(detail.threadUsage)}`);
  }
  const usageRecord = detail.records?.find((record) => {
    const payload = objectValue(record.payload);
    return record.type === "event_msg" && payload?.type === "token_count";
  });
  const rateLimits = objectValue(objectValue(usageRecord?.payload)?.rate_limits);
  const recordPrimary = objectValue(rateLimits?.primary);
  const recordSecondary = objectValue(rateLimits?.secondary);
  if (
    recordPrimary?.used_percent !== 12.5
    || recordPrimary.window_minutes !== 300
    || recordPrimary.resets_at !== 1781058359
    || recordSecondary?.used_percent !== 64
    || recordSecondary.window_minutes !== 10080
    || recordSecondary.resets_at !== 1781140554
  ) {
    throw new Error(`token_count record did not preserve rate_limits: ${JSON.stringify(usageRecord)}`);
  }
};

const waitForThreadUsage = async (apiBase: string, threadId: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const detail = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    if (detail.threadUsage?.primaryRateLimit && detail.threadUsage.secondaryRateLimit) return detail;
    await delay(100);
  }
  throw new Error(`thread ${threadId} did not receive token usage rate limits`);
};

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const assertHistoricalSnapshotPublishesMarkedRecordEvents = async (apiBase: string, threadId: string, fake: FakeMachine) => {
  const subscription = await subscribeThread(apiBase, threadId);
  try {
    const subscribe = await fake.nextSessionCommand("subscribe_thread_records");
    if (subscribe.threadId !== threadId) throw new Error(`subscribe command used wrong thread: ${JSON.stringify(subscribe)}`);
    subscription.messages.length = 0;

    const turnId = `historical-turn-${process.pid}`;
    fake.emitTurnsSnapshot(turnId);
    await waitForRealtimeMessage(
      subscription.messages,
      (message) =>
        message.type === "record"
        && message.historical === true
        && typeof message.record?.id === "string"
        && message.record.id.includes(`:${turnId}:`),
      "historical snapshot record event"
    );
    await delay(100);
    const unmarkedHistoricalRecordEvent = subscription.messages.find((message) =>
      message.type === "record"
      && message.historical !== true
      && typeof message.record?.id === "string"
      && message.record.id.includes(`:${turnId}:`)
    );
    if (unmarkedHistoricalRecordEvent) {
      throw new Error(`historical snapshot published an unmarked record event: ${JSON.stringify(unmarkedHistoricalRecordEvent)}`);
    }

    const detail = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    if (!detail.records?.some((record) => {
      const payload = objectValue(record.payload);
      return record.type === "event_msg" && payload?.type === "task_complete" && payload.turn_id === turnId;
    })) {
      throw new Error(`historical snapshot task_complete was not retained in thread detail: ${JSON.stringify(detail.records)}`);
    }
  } finally {
    subscription.ws.send(JSON.stringify({ type: "unsubscribe_thread", threadId }));
    await fake.nextSessionCommand("unsubscribe_thread_records").catch(() => undefined);
    subscription.ws.close();
  }
};

const assertThreadRecordSubscription = async (apiBase: string, threadId: string, fake: FakeMachine) => {
  const first = await subscribeThread(apiBase, threadId);
  try {
    const subscribe = await fake.nextSessionCommand("subscribe_thread_records");
    if (subscribe.threadId !== threadId) throw new Error(`subscribe command used wrong thread: ${JSON.stringify(subscribe)}`);

    const second = await subscribeThread(apiBase, threadId);
    try {
      await fake.expectNoSessionCommand("subscribe_thread_records", 100);
      first.ws.send(JSON.stringify({ type: "unsubscribe_thread", threadId }));
      await fake.expectNoSessionCommand("unsubscribe_thread_records", 100);
      second.ws.send(JSON.stringify({ type: "unsubscribe_thread", threadId }));
      const unsubscribe = await fake.nextSessionCommand("unsubscribe_thread_records");
      if (unsubscribe.threadId !== threadId) throw new Error(`unsubscribe command used wrong thread: ${JSON.stringify(unsubscribe)}`);
    } finally {
      second.ws.close();
    }
  } finally {
    first.ws.close();
  }
};

const assertAppServerOnlyThreadSubscription = async (apiBase: string, threadId: string, fake: FakeMachine) => {
  const subscription = await subscribeThread(apiBase, threadId);
  try {
    const subscribe = await fake.nextSessionCommand("subscribe_thread_records");
    if (subscribe.threadId !== threadId) throw new Error(`subscribe command used wrong thread: ${JSON.stringify(subscribe)}`);

    const detail = await apiJson<Record<string, unknown>>(
      apiBase,
      `/api/threads/${encodeURIComponent(threadId)}`
    );
    if (!Array.isArray(detail.records)) throw new Error(`thread detail did not expose normalized records: ${JSON.stringify(detail)}`);

    subscription.ws.send(JSON.stringify({ type: "unsubscribe_thread", threadId }));
    const unsubscribe = await fake.nextSessionCommand("unsubscribe_thread_records");
    if (unsubscribe.threadId !== threadId) throw new Error(`unsubscribe command used wrong thread: ${JSON.stringify(unsubscribe)}`);
  } finally {
    subscription.ws.close();
  }
};

const subscribeThread = async (apiBase: string, threadId: string) => {
  const messages: RealtimeMessage[] = [];
  const ws = new WebSocket(webRealtimeUrl(apiBase));
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as RealtimeMessage);
  });
  await waitForWebSocketOpen(ws);
  ws.send(JSON.stringify({ type: "subscribe_thread", threadId, after: 0 }));
  await waitForRealtimeMessage(
    messages,
    (message) => message.type === "thread_subscribed" && message.threadId === threadId,
    "thread subscription acknowledgement"
  );
  return { ws, messages };
};

const waitForRealtimeMessage = async (
  messages: RealtimeMessage[],
  predicate: (message: RealtimeMessage) => boolean,
  label: string,
  timeoutMs = 5000
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const message = messages.find(predicate);
    if (message) return message;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
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

const webRealtimeUrl = (apiBase: string) => {
  const url = new URL("/api/events/ws", apiBase);
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
