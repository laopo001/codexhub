import { randomUUID } from "node:crypto";
import { asRecord, type CodexRecord } from "./codexRecord.js";
import { recordsToViews } from "./codexRecordView.js";
import type { ProxyInput } from "./proxyInput.js";
import type { ThreadOptions, Usage } from "./threadOptions.js";
import { emptyThreadUsage, threadRateLimitsFromValue, threadUsageFromRecords, type ThreadRateLimits, type ThreadUsage } from "./threadUsage.js";

export type ThreadSummary = {
  threadId: string;
  workingDirectory: string;
  model?: string;
  modelReasoningEffort?: ThreadOptions["modelReasoningEffort"];
  session: ThreadSessionSummary;
  status: "running" | "idle";
  running: boolean;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastUsage?: Usage;
  threadUsage: ThreadUsage;
};

export type ThreadSessionSummary = {
  sessionId?: string;
  name?: string;
  appServerUrl?: string;
  online: boolean;
  runnable: boolean;
  lastSeenAt?: string;
};

export type SessionSummary = {
  sessionId: string;
  machineId?: string;
  name?: string;
  workingDirectory: string;
  appServerUrl?: string;
  online: boolean;
  status: "online" | "offline";
  createdAt?: string;
  lastSeenAt: string;
  offlineSinceAt?: string;
  offlineReason?: SessionOfflineReason;
  pid?: number;
  hostname?: string;
  accountRateLimits?: ThreadRateLimits | null;
  threads: ThreadSummary[];
};

export type ThreadRunOptions = {
  model?: string | null;
  modelReasoningEffort?: ThreadOptions["modelReasoningEffort"] | null;
  collaborationMode?: "default" | "plan" | null;
  goalMode?: boolean | null;
  goalObjective?: string | null;
  goalTokenBudget?: number | null;
};

export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";

export type ThreadGoalUpdate = {
  objective?: string | null;
  status?: ThreadGoalStatus | null;
  tokenBudget?: number | null;
};

export type ThreadDetail = ThreadSummary & {
  records: CodexRecord[];
  lastSeq: number;
};

export type ThreadCandidateSummary = {
  threadId: string;
  cwd: string;
  path: string;
  updatedAt: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
  artifactCount: number;
  messageCount: number;
};

export type ThreadStreamEvent = {
  seq: number;
  threadId: string;
  kind: "thread" | "record" | "done";
  historical?: boolean;
  thread: ThreadSummary;
  record?: CodexRecord;
};

export type SessionRegistration = {
  machineId?: string;
  name?: string;
  workingDirectory: string;
  appServerUrl?: string;
  pid?: number;
  hostname?: string;
};

type InternalSessionRegistration = SessionRegistration & {
  sessionId?: string;
  transportId?: string;
};

export type SessionOfflineReason = "heartbeat_timeout" | "transport_disconnected" | "unregistered";

export type SessionStreamEvent = {
  seq: number;
  kind: "sessions";
  sessions: SessionSummary[];
};

export type SessionCommand = {
  seq: number;
  commandId: string;
  type:
    | "fork_thread"
    | "rollback_thread"
    | "turn"
    | "steer"
    | "set_goal"
    | "clear_goal"
    | "stop"
    | "list_threads"
    | "start_thread"
    | "resume_thread"
    | "subscribe_thread_records"
    | "unsubscribe_thread_records";
  workingDirectory: string;
  createdAt: string;
  threadId?: string;
  input?: ProxyInput;
  turnId?: string;
  numTurns?: number;
  keepTurns?: number;
  limit?: number;
  goal?: ThreadGoalUpdate;
  options?: ThreadRunOptions;
};

export type SessionThreadCandidatesResult = {
  threads: ThreadCandidateSummary[];
};

export type SessionThreadCommandResult = {
  threadId: string;
};

export type SessionCommandResult = SessionThreadCandidatesResult | SessionThreadCommandResult | ThreadDetail;

export type SessionEventInput =
  | {
      type: "thread_event";
      threadId: string;
      commandId?: string;
      heartbeat?: boolean;
      message: unknown;
    }
  | {
      type: "thread_turns_snapshot";
      threadId: string;
      heartbeat?: boolean;
      turns: unknown[];
    }
  | {
      type: "thread_execution_changed";
      threadId: string;
      running: boolean;
      turnId?: string;
      heartbeat?: boolean;
    }
  | {
      type: "session_settings_changed";
      threadId: string;
      model?: string | null;
      modelReasoningEffort?: ThreadOptions["modelReasoningEffort"] | null;
      heartbeat?: boolean;
    }
  | {
      type: "account_rate_limits_updated";
      rateLimits: unknown;
      heartbeat?: boolean;
    };

type SessionState = SessionSummary & {
  transportId?: string;
  commands: SessionCommand[];
  waiters: Set<SessionCommandWaiter>;
};

type ThreadState = {
  threadId: string;
  workingDirectory: string;
  sessionId?: string;
  appServerTurnId?: string;
  threadOptions: ThreadOptions;
  running: boolean;
  title: string;
  updatedAt: string;
  records: CodexRecord[];
  recordSeq: number;
  threadUsage: ThreadUsage;
  events: ThreadStreamEvent[];
  subscribers: Set<(event: ThreadStreamEvent) => void>;
  lastUsage?: Usage;
  seq: number;
};

type PendingCommand = {
  type: SessionCommand["type"];
  threadId?: string;
  workingDirectory?: string;
  keepTurns?: number;
  resolve: (value?: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

type QueuedTurn = {
  input: ProxyInput;
  source: "web" | "telegram" | "task";
  options?: ThreadRunOptions;
  resolve: () => void;
  reject: (error: Error) => void;
};

type SessionCommandWaiter = () => void;

export class ThreadHub {
  private readonly threads = new Map<string, ThreadState>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly activeTurnCommands = new Map<string, string>();
  private readonly queuedTurns = new Map<string, QueuedTurn[]>();
  private readonly sessionEvents: SessionStreamEvent[] = [];
  private readonly sessionSubscribers = new Set<(event: SessionStreamEvent) => void>();
  private lastSessionSnapshotKey = "";
  private sessionSeq = 0;

  constructor(
    private readonly defaultThreadOptions: ThreadOptions = {},
    private readonly options: { onCatalogChange?: () => void; onThreadChange?: () => void } = {}
  ) {}

  registerSession(registration: InternalSessionRegistration): { sessionId: string; session: SessionSummary } {
    const now = new Date().toISOString();
    const sessionId = registration.sessionId?.trim() || randomUUID();
    const existing = this.sessions.get(sessionId);
    if (existing) {
      for (const waiter of [...existing.waiters]) waiter();
    }
    const session: SessionState = {
      sessionId,
      machineId: registration.machineId,
      name: registration.name,
      workingDirectory: registration.workingDirectory,
      appServerUrl: registration.appServerUrl,
      online: true,
      status: "online",
      createdAt: existing?.createdAt ?? now,
      lastSeenAt: now,
      pid: registration.pid,
      hostname: registration.hostname,
      accountRateLimits: existing?.accountRateLimits ?? null,
      threads: [],
      transportId: registration.transportId,
      commands: existing?.commands ?? [],
      waiters: existing?.waiters ?? new Set()
    };
    this.sessions.set(sessionId, session);
    for (const thread of this.threads.values()) {
      if (thread.sessionId === sessionId) {
        thread.sessionId = sessionId;
        this.publish(thread, "thread");
      }
    }
    this.publishSessions();
    return { sessionId, session: this.sessionSummary(session) };
  }

  heartbeatSession(sessionId: string, registration: Partial<SessionRegistration> = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false };
    const previousState = this.sessionVisibleState(session);
    const now = new Date().toISOString();
    session.name = registration.name ?? session.name;
    session.machineId = registration.machineId ?? session.machineId;
    session.workingDirectory = registration.workingDirectory ?? session.workingDirectory;
    session.appServerUrl = registration.appServerUrl ?? session.appServerUrl;
    session.pid = registration.pid ?? session.pid;
    session.hostname = registration.hostname ?? session.hostname;
    session.online = true;
    session.status = "online";
    session.lastSeenAt = now;
    delete session.offlineSinceAt;
    delete session.offlineReason;
    if (previousState !== this.sessionVisibleState(session)) {
      for (const thread of this.threads.values()) {
        if (thread.sessionId === sessionId) this.publish(thread, "thread");
      }
      this.publishSessions();
    }
    return { ok: true, sessionId };
  }

  unregisterSession(sessionId: string, transportId?: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false };
    if (transportId && session.transportId && session.transportId !== transportId) return { ok: true, sessionId };
    this.removeSession(session, `Session unregistered: ${sessionId}`, "unregistered");
    return { ok: true, sessionId };
  }

  disconnectSession(sessionId: string, transportId?: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false };
    if (transportId && session.transportId && session.transportId !== transportId) return { ok: true, sessionId };
    this.markSessionOffline(session, `Session transport disconnected: ${sessionId}`, "transport_disconnected");
    return { ok: true, sessionId };
  }

  failSessionCommand(sessionId: string, commandId: string, message: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false };
    const pending = this.pendingCommands.get(commandId);
    const error = new Error(message || `Session command failed: ${commandId}`);
    if (pending?.threadId && this.activeTurnCommands.get(pending.threadId) === commandId) {
      this.finishSessionTurnByThread(pending.threadId, error);
    } else {
      this.rejectCommand(commandId, error);
    }
    return { ok: true, sessionId, commandId };
  }

  resolveSessionCommand(sessionId: string, commandId: string, result: unknown) {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false };
    const pending = this.pendingCommands.get(commandId);
    if (!pending) return { ok: false };
    if (pending.type === "start_thread" || pending.type === "resume_thread") {
      const threadId = commandResultThreadId(result);
      if (!threadId) {
        this.rejectCommand(commandId, new Error(`Session command did not return threadId: ${pending.type}`));
        return { ok: false, sessionId, commandId };
      }
      const thread = this.ensureThread(threadId, session, {
        result: { thread: { id: threadId, cwd: pending.workingDirectory ?? session.workingDirectory } }
      });
      this.resolveCommand(commandId, this.detail(thread));
      return { ok: true, sessionId, commandId };
    }
    this.resolveCommand(commandId, result);
    return { ok: true, sessionId, commandId };
  }

  markStaleSessionsOffline(timeoutMs: number, now = Date.now(), offlineRetentionMs = Number.POSITIVE_INFINITY) {
    let offline = 0;
    let removed = 0;
    for (const session of this.sessions.values()) {
      if (session.online) {
        const lastSeenAt = Date.parse(session.lastSeenAt);
        if (Number.isFinite(lastSeenAt) && now - lastSeenAt <= timeoutMs) continue;
        this.markSessionOffline(session, `Session heartbeat timed out: ${session.sessionId}`, "heartbeat_timeout", now);
        offline += 1;
        continue;
      }

      const offlineSinceAt = Date.parse(session.offlineSinceAt ?? session.lastSeenAt);
      if (!Number.isFinite(offlineSinceAt) || now - offlineSinceAt < offlineRetentionMs) continue;
      this.removeSession(session, `Session offline retention expired: ${session.sessionId}`, session.offlineReason ?? "heartbeat_timeout", now);
      removed += 1;
    }
    return { offline, removed };
  }

  listSessions(options: { includeOffline?: boolean } = {}): SessionSummary[] {
    return [...this.sessions.values()]
      .filter((session) => options.includeOffline || session.online || Boolean(session.offlineSinceAt))
      .map((session) => this.sessionSummary(session));
  }

  subscribeSessions(after: number, callback: (event: SessionStreamEvent) => void) {
    const events = after > 0 ? this.sessionEvents.filter((item) => item.seq > after) : [];
    if (events.length) {
      for (const event of events) callback(event);
    } else {
      callback(this.sessionSnapshotEvent());
    }
    this.sessionSubscribers.add(callback);
    return () => this.sessionSubscribers.delete(callback);
  }

  async waitSessionCommands(sessionId: string, after: number, timeoutMs = 25000) {
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, cursor: after, commands: [] };
    if (sessionCommandsAfter(session, after).length === 0) {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout;
        const waiter = () => {
          clearTimeout(timer);
          session.waiters.delete(waiter);
          resolve();
        };
        timer = setTimeout(waiter, timeoutMs);
        session.waiters.add(waiter);
      });
    }
    const commands = sessionCommandsAfter(session, after);
    return {
      sessionId,
      cursor: commands.at(-1)?.seq ?? after,
      commands
    };
  }

  clampSessionCommandCursor(sessionId: string, requestedCursor: number) {
    const session = this.sessions.get(sessionId);
    const maxCursor = session?.commands.at(-1)?.seq ?? 0;
    return Math.min(requestedCursor, maxCursor);
  }

  applySessionEvent(sessionId: string, input: SessionEventInput) {
    if (input.heartbeat !== false) this.heartbeatSession(sessionId);
    const session = this.requireSession(sessionId);
    if (input.type === "account_rate_limits_updated") {
      const rateLimits = threadRateLimitsFromValue(input.rateLimits, new Date().toISOString());
      if (rateLimits) {
        session.accountRateLimits = rateLimits;
        this.publishSessions();
      }
      return { ok: true, session: this.sessionSummary(session) };
    }

    if (input.type === "thread_execution_changed") {
      const thread = this.ensureThread(input.threadId, session, {
        params: { threadId: input.threadId, cwd: session.workingDirectory }
      });
      this.applyThreadExecutionState(thread, input.running, input.turnId);
      return { ok: true, thread: this.summary(thread) };
    }

    if (input.type === "session_settings_changed") {
      const thread = this.ensureThread(input.threadId, session, {
        params: { threadId: input.threadId, cwd: session.workingDirectory }
      });
      this.applySessionSettings(thread, input.model, input.modelReasoningEffort);
      return { ok: true, thread: this.summary(thread) };
    }

    if (input.type === "thread_turns_snapshot") {
      const thread = this.ensureThread(input.threadId, session, {
        params: { threadId: input.threadId, cwd: session.workingDirectory }
      });
      this.applyAppServerTurnsSnapshot(thread, input.turns);
      return { ok: true, thread: this.summary(thread) };
    }

    const message = asRecord(input.message);
    if (!message) return { ok: true };

    const threadId = this.threadIdForSessionEvent(input, message);
    const error = asRecord(message.error);
    if (error) {
      this.rejectCommand(input.commandId, new Error(stringify(error)));
      if (threadId) this.finishSessionTurnByThread(threadId, new Error(stringify(error)));
      return { ok: true };
    }

    const thread = threadId ? this.ensureThread(threadId, session, message) : null;
    const pending = input.commandId ? this.pendingCommands.get(input.commandId) : undefined;
    if (thread && pending?.type === "fork_thread" && pending.threadId && pending.keepTurns) {
      const source = this.threads.get(pending.threadId);
      if (source && source.threadId !== thread.threadId) this.seedForkedThreadRecords(source, thread, pending.keepTurns);
    }
    if (thread && pending?.type === "rollback_thread" && asRecord(asRecord(message.result)?.thread)) {
      this.applyRollbackRecordCrop(thread, pending.keepTurns);
    }
    if (thread) this.applyAppServerMessage(thread, message);

    if (input.commandId) this.resolveCommandFromMessage(input.commandId, thread);
    return { ok: true, thread: thread ? this.summary(thread) : undefined };
  }

  listThreads(): ThreadSummary[] {
    return [...this.threads.values()].map((thread) => this.summary(thread));
  }

  getThread(threadId: string): ThreadDetail | null {
    const thread = this.threads.get(threadId);
    return thread ? this.detail(thread) : null;
  }

  attachSessionThread(sessionId: string, threadId: string, workingDirectory?: string): ThreadSummary {
    const session = this.requireOnlineSession(sessionId);
    const thread = this.ensureThread(threadId, session, {
      params: { threadId, cwd: workingDirectory ?? session.workingDirectory }
    });
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
    return this.summary(thread);
  }

  subscribeThreadRecords(threadId: string) {
    const thread = this.requireThread(threadId);
    const session = this.requireThreadSession(thread);
    this.enqueueSessionCommand(session.sessionId, {
      commandId: randomUUID(),
      type: "subscribe_thread_records",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId
    });
    return { subscribed: true };
  }

  unsubscribeThreadRecords(threadId: string) {
    const thread = this.requireThread(threadId);
    const session = this.requireThreadSession(thread);
    this.enqueueSessionCommand(session.sessionId, {
      commandId: randomUUID(),
      type: "unsubscribe_thread_records",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId
    });
    return { subscribed: false };
  }

  getThreadUsage(threadId?: string): ThreadUsage {
    if (!threadId) return emptyThreadUsage();
    return this.threads.get(threadId)?.threadUsage ?? emptyThreadUsage();
  }

  async listSessionThreadCandidates(
    sessionId: string,
    limit = 50,
    workingDirectory?: string
  ): Promise<SessionThreadCandidatesResult> {
    const session = this.requireOnlineSession(sessionId);
    const cwd = workingDirectory || session.workingDirectory;
    const commandId = randomUUID();
    const promise = this.waitForCommand<SessionThreadCandidatesResult>(commandId, "list_threads", undefined, 60_000, cwd);
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "list_threads",
      workingDirectory: cwd,
      createdAt: new Date().toISOString(),
      limit
    });
    return await promise;
  }

  async startSessionThread(sessionId: string, workingDirectory?: string): Promise<ThreadDetail> {
    const session = this.requireOnlineSession(sessionId);
    const cwd = workingDirectory || session.workingDirectory;
    const commandId = randomUUID();
    const promise = this.waitForCommand<ThreadDetail>(commandId, "start_thread", undefined, 60_000, cwd);
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "start_thread",
      workingDirectory: cwd,
      createdAt: new Date().toISOString()
    });
    return await promise;
  }

  async resumeSessionThread(sessionId: string, threadId: string, workingDirectory?: string): Promise<ThreadDetail> {
    const session = this.requireOnlineSession(sessionId);
    const cwd = workingDirectory || this.threads.get(threadId)?.workingDirectory || session.workingDirectory;
    const commandId = randomUUID();
    const promise = this.waitForCommand<ThreadDetail>(commandId, "resume_thread", threadId, 60_000, cwd);
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "resume_thread",
      workingDirectory: cwd,
      createdAt: new Date().toISOString(),
      threadId
    });
    return await promise;
  }

  async forkThread(threadId: string, recordId?: string): Promise<ThreadDetail> {
    const source = this.requireThread(threadId);
    const session = this.requireThreadSession(source);
    const rollbackPlan = recordId ? rollbackPlanAfterRecord(source, recordId) : { rollbackTurns: 0, keepTurns: 0 };
    const forkSeedTurns = recordId ? rollbackPlan.keepTurns : appServerTurnIds(source).length;
    const commandId = randomUUID();
    const promise = this.waitForCommand<ThreadDetail>(commandId, "fork_thread", source.threadId, undefined, source.workingDirectory);
    const pending = this.pendingCommands.get(commandId);
    if (pending) pending.keepTurns = forkSeedTurns;
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "fork_thread",
      workingDirectory: source.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: source.threadId,
      options: { ...source.threadOptions }
    });
    const forkedThread = await promise;
    if (rollbackPlan.rollbackTurns <= 0) return forkedThread;
    return await this.rollbackThread(forkedThread.threadId, rollbackPlan.rollbackTurns, rollbackPlan.keepTurns);
  }

  async rollbackThreadAfterRecord(threadId: string, recordId: string): Promise<ThreadDetail> {
    const thread = this.requireThread(threadId);
    const rollbackPlan = rollbackPlanAfterRecord(thread, recordId);
    if (rollbackPlan.rollbackTurns <= 0) return this.detail(thread);
    return await this.rollbackThread(thread.threadId, rollbackPlan.rollbackTurns, rollbackPlan.keepTurns);
  }

  async rollbackThreadTurns(threadId: string, numTurns: number, keepTurns?: number): Promise<ThreadDetail> {
    return await this.rollbackThread(threadId, numTurns, keepTurns);
  }

  private async rollbackThread(threadId: string, numTurns: number, keepTurns?: number): Promise<ThreadDetail> {
    const thread = this.requireThread(threadId);
    const session = this.requireThreadSession(thread);
    const commandId = randomUUID();
    const effectiveKeepTurns = typeof keepTurns === "number" && Number.isFinite(keepTurns)
      ? Math.max(0, Math.floor(keepTurns))
      : Math.max(0, appServerTurnIds(thread).length - numTurns);
    const promise = this.waitForCommand<ThreadDetail>(commandId, "rollback_thread", thread.threadId, undefined, thread.workingDirectory);
    const pending = this.pendingCommands.get(commandId);
    if (pending) pending.keepTurns = effectiveKeepTurns;
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "rollback_thread",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId,
      numTurns,
      keepTurns: effectiveKeepTurns
    });
    return promise;
  }

  async deleteThread(threadId: string) {
    const thread = this.requireThread(threadId);
    thread.running = false;
    this.rejectQueuedTurns(thread.threadId, new Error(`Thread deleted: ${thread.threadId}`));
    this.threads.delete(threadId);
    this.publish(thread, "done");
    this.publishThreadCatalog();
    return { deleted: true };
  }

  stopTurn(threadId: string) {
    const thread = this.requireThread(threadId);
    if (!thread.running) return { stopped: false };
    const session = this.requireThreadSession(thread);
    this.enqueueSessionCommand(session.sessionId, {
      commandId: randomUUID(),
      type: "stop",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId,
      turnId: thread.appServerTurnId
    });
    return { stopped: true };
  }

  runLocalCommand(threadId: string, input: ProxyInput, _source: "web" | "telegram" | "task" = "web") {
    const command = parseLocalSlashCommand(input);
    if (!command) return { handled: false };

    const thread = this.requireThread(threadId);
    const session = thread.sessionId ? this.sessions.get(thread.sessionId) : null;
    this.appendUserInputRecord(thread, input);
    this.appendHubRecord(thread, "event_msg", {
      type: "agent_message",
      message: this.localCommandMessage(thread, command),
      phase: "final_answer"
    });
    return { handled: true, command };
  }

  runTurn(threadId: string, input: ProxyInput, _source: "web" | "telegram" | "task" = "web", options?: ThreadRunOptions) {
    const thread = this.requireThread(threadId);
    if (thread.running && _source === "web" && options?.goalMode) {
      return this.setThreadGoal(thread, goalUpdateFromInput(input, options));
    }
    if (thread.running && _source === "web" && thread.appServerTurnId) {
      return this.steerTurn(thread, input, thread.appServerTurnId);
    }
    if (thread.running) return this.queueTurn(thread, input, _source, options);
    return this.startTurn(thread, input, _source, options);
  }

  private startTurn(thread: ThreadState, input: ProxyInput, _source: "web" | "telegram" | "task" = "web", options?: ThreadRunOptions) {
    if (thread.running) throw new Error(`Thread is already running: ${thread.threadId}`);
    const session = this.requireThreadSession(thread);
    const commandOptions = options ? { ...options } : { ...thread.threadOptions };
    if (options) thread.threadOptions = applyThreadRunOptions(thread.threadOptions, options);
    const commandId = randomUUID();
    const promise = this.waitForCommand<void>(commandId, "turn", thread.threadId, turnCommandTimeoutMs(), thread.workingDirectory);
    this.activeTurnCommands.set(thread.threadId, commandId);

    const userText = summarizeInput(input);
    if (userText && thread.title === thread.threadId) thread.title = userText.slice(0, 80);
    thread.running = true;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");

    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "turn",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      input,
      threadId: thread.threadId,
      options: commandOptions
    });
    return promise;
  }

  private steerTurn(thread: ThreadState, input: ProxyInput, turnId: string) {
    const session = this.requireThreadSession(thread);
    const commandId = randomUUID();
    const promise = this.waitForCommand<void>(commandId, "steer", thread.threadId, undefined, thread.workingDirectory);
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "steer",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      input,
      threadId: thread.threadId,
      turnId
    });
    return promise;
  }

  setGoal(threadId: string, goal: ThreadGoalUpdate) {
    return this.setThreadGoal(this.requireThread(threadId), goal);
  }

  clearGoal(threadId: string) {
    const thread = this.requireThread(threadId);
    const session = this.requireThreadSession(thread);
    const commandId = randomUUID();
    const promise = this.waitForCommand<void>(commandId, "clear_goal", thread.threadId, undefined, thread.workingDirectory);
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "clear_goal",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId
    });
    return promise;
  }

  private setThreadGoal(thread: ThreadState, goal: ThreadGoalUpdate) {
    const session = this.requireThreadSession(thread);
    const commandId = randomUUID();
    const promise = this.waitForCommand<void>(commandId, "set_goal", thread.threadId, undefined, thread.workingDirectory);
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "set_goal",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId,
      goal
    });
    return promise;
  }

  private queueTurn(thread: ThreadState, input: ProxyInput, source: "web" | "telegram" | "task", options?: ThreadRunOptions) {
    return new Promise<void>((resolve, reject) => {
      const queue = this.queuedTurns.get(thread.threadId) ?? [];
      queue.push({
        input,
        source,
        options: options ? { ...options } : undefined,
        resolve,
        reject
      });
      this.queuedTurns.set(thread.threadId, queue);
      thread.updatedAt = new Date().toISOString();
      this.publish(thread, "thread");
    });
  }

  runSessionThreadTurn(
    sessionId: string,
    threadId: string,
    input: ProxyInput,
    source: "web" | "telegram" | "task" = "web",
    options?: ThreadRunOptions,
    workingDirectory?: string
  ) {
    const session = this.requireOnlineSession(sessionId);
    const existing = this.threads.get(threadId);
    const thread = this.ensureThread(threadId, session, {
      params: { threadId, cwd: workingDirectory ?? existing?.workingDirectory ?? session.workingDirectory }
    });
    const command = this.runLocalCommand(thread.threadId, input, source);
    if (command.handled) {
      return {
        thread: this.summary(thread),
        promise: Promise.resolve(),
        command: command.command
      };
    }
    const promise = this.runTurn(thread.threadId, input, source, options);
    return { thread: this.summary(thread), promise };
  }

  subscribe(threadId: string, after: number, callback: (event: ThreadStreamEvent) => void) {
    const thread = this.requireThread(threadId);
    for (const event of thread.events.filter((item) => item.seq > after)) callback(event);
    thread.subscribers.add(callback);
    return () => thread.subscribers.delete(callback);
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  private requireOnlineSession(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (!session.online) throw new Error(`Session is offline: ${sessionId}`);
    return session;
  }

  private threadIdForSessionEvent(input: Extract<SessionEventInput, { type: "thread_event" }>, message: Record<string, unknown>) {
    const pending = input.commandId ? this.pendingCommands.get(input.commandId) : undefined;
    if (pending?.type === "fork_thread") {
      return resultThreadIdFromAppServerMessage(message)
        ?? input.threadId
        ?? threadIdFromAppServerMessage(message);
    }
    return input.threadId ?? threadIdFromAppServerMessage(message);
  }

  private requireThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread;
  }

  private onlineSessionsForWorkspace(workingDirectory: string) {
    return [...this.sessions.values()]
      .filter((session) => session.online && session.workingDirectory === workingDirectory)
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  }

  private uniqueOnlineSessionForWorkspace(workingDirectory: string) {
    const sessions = this.onlineSessionsForWorkspace(workingDirectory);
    return sessions.length === 1 ? sessions[0] : null;
  }

  private requireThreadSession(thread: ThreadState) {
    const current = thread.sessionId ? this.sessions.get(thread.sessionId) : null;
    if (current?.online) return current;
    const sessions = this.onlineSessionsForWorkspace(thread.workingDirectory);
    const replacement = sessions.length === 1 ? sessions[0] : null;
    if (replacement) {
      thread.sessionId = replacement.sessionId;
      this.publish(thread, "thread");
      this.publishThreadCatalog();
      return replacement;
    }
    if (sessions.length > 1) {
      throw new Error(`Multiple online sessions for workspace. Resume this thread in one codexhub instance before sending: ${thread.threadId}`);
    }
    throw new Error(`No online session for thread: ${thread.threadId}`);
  }

  private enqueueSessionCommand(sessionId: string, command: Omit<SessionCommand, "seq">) {
    const session = this.requireSession(sessionId);
    const next: SessionCommand = {
      ...command,
      seq: (session.commands.at(-1)?.seq ?? 0) + 1
    };
    session.commands.push(next);
    if (session.commands.length > 500) session.commands.splice(0, session.commands.length - 500);
    for (const waiter of [...session.waiters]) waiter();
    return next;
  }

  private waitForCommand<T>(
    commandId: string,
    type: SessionCommand["type"],
    threadId?: string,
    timeoutMs: number | null | undefined = 30000,
    workingDirectory?: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
          this.pendingCommands.delete(commandId);
          if (threadId && this.activeTurnCommands.get(threadId) === commandId) {
            this.activeTurnCommands.delete(threadId);
            const thread = this.threads.get(threadId);
            if (thread) {
              thread.running = false;
              this.publish(thread, "done");
            }
          }
          reject(new Error(`Session command timed out: ${type}`));
        }, timeoutMs)
        : undefined;
      this.pendingCommands.set(commandId, {
        type,
        threadId,
        workingDirectory,
        resolve: resolve as (value?: unknown) => void,
        reject,
        timer
      });
    });
  }

  private resolveCommandFromMessage(commandId: string, thread: ThreadState | null) {
    const pending = this.pendingCommands.get(commandId);
    if (!pending) return;
    if ((pending.type === "fork_thread" || pending.type === "rollback_thread") && thread) {
      this.resolveCommand(commandId, this.detail(thread));
      return;
    }
    if (pending.type === "set_goal" || pending.type === "clear_goal") {
      if (pending.type === "clear_goal" && thread) this.appendThreadGoalClearedRecord(thread);
      this.resolveCommand(commandId);
    }
  }

  private resolveCommand(commandId: string, value?: unknown) {
    const pending = this.pendingCommands.get(commandId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingCommands.delete(commandId);
    pending.resolve(value);
  }

  private rejectCommand(commandId: string | undefined, error: Error) {
    if (!commandId) return;
    const pending = this.pendingCommands.get(commandId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingCommands.delete(commandId);
    pending.reject(error);
  }

  private markSessionOffline(
    session: SessionState,
    message: string,
    reason: SessionOfflineReason,
    now = Date.now()
  ) {
    const wasOnline = session.online;
    const offlineSinceAt = new Date(now).toISOString();
    session.online = false;
    session.status = "offline";
    session.offlineSinceAt = session.offlineSinceAt ?? offlineSinceAt;
    session.offlineReason = reason;
    this.rejectPendingSessionCommands(session, new Error(message));
    for (const waiter of [...session.waiters]) waiter();
    for (const thread of this.threads.values()) {
      if (thread.sessionId !== session.sessionId) continue;
      this.rejectQueuedTurns(thread.threadId, new Error(message));
      if (thread.running) {
        this.finishSessionTurnByThread(thread.threadId, new Error(message));
      } else if (wasOnline) {
        this.publish(thread, "thread");
      }
    }
    if (wasOnline) this.publishSessions();
  }

  private removeSession(
    session: SessionState,
    message: string,
    reason: SessionOfflineReason,
    now = Date.now()
  ) {
    const error = new Error(message);
    const offlineSinceAt = new Date(now).toISOString();
    session.online = false;
    session.status = "offline";
    session.offlineSinceAt = session.offlineSinceAt ?? offlineSinceAt;
    session.offlineReason = reason;
    this.rejectPendingSessionCommands(session, error);
    for (const waiter of [...session.waiters]) waiter();
    this.sessions.delete(session.sessionId);
    for (const thread of this.threads.values()) {
      if (thread.sessionId !== session.sessionId) continue;
      this.rejectQueuedTurns(thread.threadId, error);
      if (thread.running) {
        this.finishSessionTurnByThread(thread.threadId, error);
      } else {
        this.publish(thread, "thread");
      }
    }
    this.publishSessions();
  }

  private rejectPendingSessionCommands(session: SessionState, error: Error) {
    for (const command of session.commands) this.rejectCommand(command.commandId, error);
  }

  private ensureThread(threadId: string, session: SessionState, message: Record<string, unknown>) {
    const existing = this.threads.get(threadId);
    if (existing) {
      if (existing.sessionId !== session.sessionId) {
        existing.sessionId = session.sessionId;
        this.publish(existing, "thread");
        this.publishThreadCatalog();
      }
      return existing;
    }

    const appThread = appServerThreadFromMessage(message);
    const now = new Date().toISOString();
    const workingDirectory = typeof appThread?.cwd === "string" ? appThread.cwd : session.workingDirectory;
    const title = typeof appThread?.preview === "string" && appThread.preview.trim()
      ? appThread.preview.slice(0, 80)
      : threadId;
    const thread: ThreadState = {
      threadId,
      workingDirectory,
      sessionId: session.sessionId,
      threadOptions: { ...this.defaultThreadOptions },
      running: false,
      title,
      updatedAt: now,
      records: [],
      recordSeq: 0,
      threadUsage: emptyThreadUsage(),
      events: [],
      subscribers: new Set(),
      seq: 0
    };
    this.threads.set(thread.threadId, thread);
    this.publish(thread, "thread");
    this.publishThreadCatalog();
    return thread;
  }

  private applyAppServerMessage(thread: ThreadState, message: unknown) {
    const record = asRecord(message);
    if (!record) return;

    const result = asRecord(record.result);
    const resultThread = asRecord(result?.thread);
    if (resultThread) {
      this.applyAppServerThread(thread, resultThread);
      this.applyAppServerThreadTurns(thread, resultThread, { historicalRecords: true });
    }

    const method = typeof record.method === "string" ? record.method : "";
    const params = asRecord(record.params);
    if (!method || !params) return;

    if (method === "thread/started") {
      const appThread = asRecord(params.thread);
      if (appThread) {
        this.applyAppServerThread(thread, appThread);
        this.applyAppServerThreadTurns(thread, appThread, { historicalRecords: true });
      }
      return;
    }

    if (method === "thread/status/changed") {
      return;
    }

    if (method === "thread/settings/updated") {
      return;
    }

    if (method === "thread/goal/updated") {
      return;
    }

    if (method === "thread/goal/cleared") {
      this.appendThreadGoalClearedRecord(thread, params);
      return;
    }

    if (method === "turn/started") {
      const turn = asRecord(params.turn);
      if (turn) this.applyAppServerTurn(thread, turn);
      return;
    }

    if (method === "turn/completed") {
      const turn = asRecord(params.turn);
      if (turn) this.applyAppServerTurn(thread, turn, { replaceTurnRecords: true });
      this.finishSessionTurn(thread);
      return;
    }

    if (method === "error") {
      const error = asRecord(params.error);
      this.appendHubRecord(thread, "error", {
        type: "app_server_error",
        message: typeof error?.message === "string" ? error.message : stringify(params)
      });
      this.finishSessionTurn(thread);
      return;
    }

    if (method === "item/agentMessage/delta") {
      this.applyAppServerAgentMessageDeltaEvent(thread, params);
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      this.applyAppServerItemEvent(thread, params, method === "item/completed" ? "completed" : "inProgress");
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      this.applyAppServerCommandExecutionOutputDelta(thread, params);
      return;
    }

    if (method === "rawResponseItem/completed") {
      this.applyAppServerRawResponseItemEvent(thread, params);
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      this.applyAppServerTokenUsageEvent(thread, params);
      return;
    }
  }

  private applyAppServerTurnsSnapshot(thread: ThreadState, turns: unknown[]) {
    const turnRecords = turns.map(asRecord).filter((turn): turn is Record<string, unknown> => Boolean(turn));
    const turnIds = new Set(turnRecords.map((turn) => typeof turn.id === "string" ? turn.id : "").filter(Boolean));
    thread.records = thread.records.filter((record) => {
      const turnId = turnIdFromAppRecordId(thread.threadId, record.id);
      return !turnId || !turnIds.has(turnId);
    });
    thread.recordSeq = thread.records.reduce((max, record) => (
      typeof record.order === "number" && record.order > max ? record.order : max
    ), 0);
    for (const turnRecord of turnRecords) this.applyAppServerTurn(thread, turnRecord, { historicalRecords: true });
    thread.records = orderThreadRecords(thread.records);
    thread.updatedAt = latestRecordTimestamp(thread.records) ?? new Date().toISOString();
    thread.lastUsage = latestUsage(thread.records);
    thread.threadUsage = threadUsageFromRecords(thread.records);
    this.publish(thread, "thread", undefined, { historical: true });
  }

  private applyAppServerThreadTurns(
    thread: ThreadState,
    appThread: Record<string, unknown>,
    options: { historicalRecords?: boolean } = {}
  ) {
    if (!Array.isArray(appThread.turns)) return;
    for (const turn of appThread.turns) {
      const turnRecord = asRecord(turn);
      if (turnRecord) this.applyAppServerTurn(thread, turnRecord, { historicalRecords: options.historicalRecords });
    }
    if (!options.historicalRecords) return;
    thread.records = orderThreadRecords(thread.records);
    thread.updatedAt = latestRecordTimestamp(thread.records) ?? new Date().toISOString();
    thread.lastUsage = latestUsage(thread.records);
    thread.threadUsage = threadUsageFromRecords(thread.records);
    this.publish(thread, "thread", undefined, { historical: options.historicalRecords });
  }

  private applyAppServerTurn(
    thread: ThreadState,
    turn: Record<string, unknown>,
    options: { replaceTurnRecords?: boolean; historicalRecords?: boolean } = {}
  ) {
    const turnId = typeof turn.id === "string" ? turn.id : "";
    if (!turnId) return;
    if (options.replaceTurnRecords) {
      thread.records = thread.records.filter((record) => turnIdFromAppRecordId(thread.threadId, record.id) !== turnId);
      thread.recordSeq = thread.records.reduce((max, record) => (
        typeof record.order === "number" && record.order > max ? record.order : max
      ), 0);
    }
    const lifecycleRecords = codexRecordsFromAppServerTurnLifecycle(thread.threadId, turnId, turn);
    for (const record of lifecycleRecords.filter(isTaskStartedRecord)) {
      this.upsertRecord(thread, record, { historical: options.historicalRecords });
    }
    const timestamp = timestampFromSeconds(turn.completedAt) ?? timestampFromSeconds(turn.startedAt);
    if (Array.isArray(turn.items)) {
      for (const item of turn.items) {
        const itemRecord = asRecord(item);
        const record = itemRecord ? codexRecordFromAppServerItem(thread.threadId, turnId, itemRecord, timestamp) : null;
        if (record) this.upsertRecord(thread, record, { historical: options.historicalRecords });
      }
    }
    for (const record of lifecycleRecords.filter(isTaskCompleteRecord)) {
      this.upsertRecord(thread, record, { historical: options.historicalRecords });
    }
  }

  private applyAppServerItemEvent(thread: ThreadState, params: Record<string, unknown>, fallbackStatus?: string) {
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    const item = asRecord(params.item);
    if (!turnId || !item) return;
    const timestamp = timestampFromMillis(params.timestamp) ?? timestampFromSeconds(params.createdAt);
    const record = codexRecordFromAppServerItem(thread.threadId, turnId, item, timestamp, fallbackStatus);
    if (!record) return;
    const existing = thread.records.find((item) => item.id === record.id);
    this.upsertRecord(thread, {
      ...record,
      timestamp: record.timestamp ?? existing?.timestamp ?? new Date().toISOString()
    });
  }

  private applyAppServerAgentMessageDeltaEvent(thread: ThreadState, params: Record<string, unknown>) {
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    const item = asRecord(params.item);
    const itemId = typeof params.itemId === "string" && params.itemId
      ? params.itemId
      : typeof item?.id === "string" && item.id ? item.id : "";
    const delta = typeof params.delta === "string"
      ? params.delta
      : typeof params.textDelta === "string"
        ? params.textDelta
        : "";
    if (!turnId || !itemId || !delta) return;

    const id = `app:${thread.threadId}:${turnId}:agent:${itemId}`;
    const existing = thread.records.find((record) => record.id === id);
    const existingPayload = asRecord(existing?.payload);
    const existingMessage = typeof existingPayload?.message === "string" ? existingPayload.message : "";
    const phase = typeof params.phase === "string"
      ? params.phase
      : typeof item?.phase === "string"
        ? item.phase
        : typeof existingPayload?.phase === "string" ? existingPayload.phase : "assistant";
    this.upsertRecord(thread, {
      id,
      timestamp: existing?.timestamp ?? timestampFromMillis(params.timestamp) ?? timestampFromSeconds(params.createdAt) ?? new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: existingMessage + delta,
        phase,
        status: "in_progress"
      },
      sourceThreadId: thread.threadId
    });
  }

  private applyAppServerCommandExecutionOutputDelta(thread: ThreadState, params: Record<string, unknown>) {
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    const itemId = typeof params.itemId === "string"
      ? params.itemId
      : typeof params.callId === "string"
        ? params.callId
        : "";
    const delta = typeof params.delta === "string"
      ? params.delta
      : typeof params.outputDelta === "string"
        ? params.outputDelta
        : "";
    if (!turnId || !itemId || !delta) return;

    const id = `app:${thread.threadId}:${turnId}:item:commandExecution:${itemId}`;
    const existing = thread.records.find((item) => item.id === id);
    const existingPayload = asRecord(existing?.payload);
    const existingOutput = typeof existingPayload?.aggregated_output === "string" ? existingPayload.aggregated_output : "";
    const payload = existingPayload && existing?.type === "response_item"
      ? {
          ...existingPayload,
          type: "local_shell_call",
          call_id: typeof existingPayload.call_id === "string" ? existingPayload.call_id : itemId,
          status: existingPayload.status ?? "in_progress",
          aggregated_output: existingOutput + delta
        }
      : {
          type: "local_shell_call",
          call_id: itemId,
          status: "in_progress",
          action: { type: "exec", command: [] },
          aggregated_output: delta,
          exit_code: null
        };
    this.upsertRecord(thread, {
      id,
      timestamp: existing?.timestamp ?? new Date().toISOString(),
      type: "response_item",
      payload,
      sourceThreadId: thread.threadId
    });
  }

  private applyAppServerRawResponseItemEvent(thread: ThreadState, params: Record<string, unknown>) {
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    const item = asRecord(params.item) ?? asRecord(params.rawResponseItem);
    if (!turnId || !item) return;
    const record = codexRecordFromRawResponseItem(thread.threadId, turnId, item);
    if (record) this.upsertRecord(thread, record);
  }

  private applyAppServerTokenUsageEvent(thread: ThreadState, params: Record<string, unknown>) {
    const turnId = typeof params.turnId === "string" ? params.turnId : thread.appServerTurnId ?? "";
    const usage = asRecord(params.tokenUsage) ?? asRecord(params.usage);
    if (!turnId || !usage) return;
    const record = codexRecordFromAppServerUsage(thread.threadId, turnId, usage);
    if (record) this.upsertRecord(thread, record);
  }

  private applyAppServerThread(thread: ThreadState, appThread: Record<string, unknown>) {
    let changed = false;
    if (typeof appThread.cwd === "string" && thread.workingDirectory !== appThread.cwd) {
      thread.workingDirectory = appThread.cwd;
      changed = true;
    }
    if (typeof appThread.preview === "string" && appThread.preview.trim()) {
      const title = appThread.preview.slice(0, 80);
      if (thread.title !== title) {
        thread.title = title;
        changed = true;
      }
    }
    if (!changed) return;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
  }

  private applySessionSettings(
    thread: ThreadState,
    model: string | null | undefined,
    modelReasoningEffort: ThreadOptions["modelReasoningEffort"] | null | undefined
  ) {
    let changed = false;
    const nextModel = typeof model === "string" && model ? model : undefined;
    if (thread.threadOptions.model !== nextModel) {
      thread.threadOptions = { ...thread.threadOptions, model: nextModel };
      if (!nextModel) delete thread.threadOptions.model;
      changed = true;
    }
    const nextEffort = isThreadReasoningEffort(modelReasoningEffort) ? modelReasoningEffort : undefined;
    if (thread.threadOptions.modelReasoningEffort !== nextEffort) {
      thread.threadOptions = { ...thread.threadOptions, modelReasoningEffort: nextEffort };
      if (!nextEffort) delete thread.threadOptions.modelReasoningEffort;
      changed = true;
    }
    if (!changed) return;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
  }

  private applyThreadExecutionState(thread: ThreadState, running: boolean, turnId?: string) {
    if (!running) {
      if (thread.running || this.activeTurnCommands.has(thread.threadId)) {
        this.finishSessionTurn(thread);
        return;
      }
      if (thread.appServerTurnId !== undefined) {
        thread.appServerTurnId = undefined;
        thread.updatedAt = new Date().toISOString();
        this.publish(thread, "thread");
      }
      return;
    }
    let changed = false;
    if (thread.running !== running) {
      thread.running = running;
      changed = true;
    }
    if (thread.appServerTurnId !== turnId) {
      thread.appServerTurnId = turnId;
      changed = true;
    }
    if (!changed) return;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
  }

  private appendHubRecord(thread: ThreadState, type: string, payload: unknown) {
    const record: CodexRecord = {
      id: `proxy:${randomUUID()}`,
      timestamp: new Date().toISOString(),
      type,
      payload,
      order: ++thread.recordSeq,
      sourceThreadId: thread.threadId
    };
    thread.records.push(record);
    thread.records = orderThreadRecords(thread.records);
    thread.updatedAt = record.timestamp ?? thread.updatedAt;
    this.publish(thread, "record", record);
  }

  private appendThreadGoalClearedRecord(thread: ThreadState, payload: Record<string, unknown> = {}) {
    this.appendHubRecord(thread, "event_msg", {
      ...payload,
      type: "thread_goal_cleared",
      threadId: typeof payload.threadId === "string" ? payload.threadId : thread.threadId,
      message: typeof payload.message === "string" ? payload.message : "Goal cleared"
    });
  }

  private appendUserInputRecord(thread: ThreadState, input: ProxyInput) {
    const record: CodexRecord = {
      id: `proxy:user:${randomUUID()}`,
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "user_message",
        message: summarizeInput(input),
        images: imageUrls(input),
        text_elements: []
      },
      order: ++thread.recordSeq,
      sourceThreadId: thread.threadId
    };
    thread.records.push(record);
    thread.records = orderThreadRecords(thread.records);
    thread.updatedAt = record.timestamp ?? thread.updatedAt;
    this.publish(thread, "record", record);
  }

  private resetThreadRecords(thread: ThreadState) {
    thread.records = [];
    thread.recordSeq = 0;
    thread.lastUsage = undefined;
    thread.threadUsage = emptyThreadUsage();
  }

  private applyRollbackRecordCrop(thread: ThreadState, keepTurns: number | undefined) {
    if (keepTurns == null || keepTurns <= 0) {
      this.resetThreadRecords(thread);
      return;
    }
    const keptTurnIds = new Set(appServerTurnIds(thread).slice(0, keepTurns));
    thread.records = thread.records.filter((record) => {
      const turnId = turnIdFromAppRecordId(thread.threadId, record.id);
      return !turnId || keptTurnIds.has(turnId);
    });
    thread.records = orderThreadRecords(thread.records);
    thread.recordSeq = thread.records.reduce((max, record) => (
      typeof record.order === "number" && record.order > max ? record.order : max
    ), 0);
    thread.updatedAt = latestRecordTimestamp(thread.records) ?? new Date().toISOString();
    thread.lastUsage = latestUsage(thread.records);
    thread.threadUsage = threadUsageFromRecords(thread.records);
  }

  private seedForkedThreadRecords(source: ThreadState, forked: ThreadState, keepTurns: number) {
    if (keepTurns <= 0) return;
    const keptTurnIds = new Set(appServerTurnIds(source).slice(0, keepTurns));
    for (const record of source.records) {
      const turnId = turnIdFromAppRecordId(source.threadId, record.id);
      if (!turnId || !keptTurnIds.has(turnId)) continue;
      this.upsertRecord(forked, remapAppRecordThreadId(record, source.threadId, forked.threadId));
    }
    forked.recordSeq = forked.records.reduce((max, record) => (
      typeof record.order === "number" && record.order > max ? record.order : max
    ), 0);
    forked.updatedAt = latestRecordTimestamp(forked.records) ?? new Date().toISOString();
    forked.lastUsage = latestUsage(forked.records);
    forked.threadUsage = threadUsageFromRecords(forked.records);
  }

  private removeMatchingAppServerTranscriptRecord(thread: ThreadState, incoming: CodexRecord) {
    const index = this.matchingAppServerTranscriptRecordIndex(thread, incoming);
    if (index !== -1) thread.records.splice(index, 1);
  }

  private matchingAppServerTranscriptRecordIndex(thread: ThreadState, incoming: CodexRecord) {
    if (!incoming.type || incoming.type !== "event_msg") return -1;
    const incomingPayload = asRecord(incoming.payload);
    if (!incomingPayload) return -1;
    const incomingType = incomingPayload?.type;
    if (incomingType !== "user_message" && incomingType !== "agent_message") return -1;
    const incomingTurnId = turnIdFromAppRecordId(thread.threadId, incoming.id);
    return thread.records.findIndex((record) => {
      if (!record.id.startsWith("app:")) return false;
      const recordTurnId = turnIdFromAppRecordId(thread.threadId, record.id);
      const payload = asRecord(record.payload);
      if (!payload || payload.type !== incomingType) return false;
      if ((incomingTurnId || recordTurnId) && (incomingTurnId !== recordTurnId || recordTurnId === null)) return false;
      if (payload.message !== incomingPayload.message) return false;
      if (incomingType === "agent_message" && payload.phase !== incomingPayload.phase) return false;
      if (incomingType === "user_message") {
        return JSON.stringify(payload.images ?? []) === JSON.stringify(incomingPayload.images ?? []);
      }
      return true;
    });
  }

  private upsertRecord(thread: ThreadState, record: CodexRecord, options: { historical?: boolean } = {}) {
    const existingIndex = thread.records.findIndex((item) => item.id === record.id);
    if (existingIndex === -1) {
      const replacementIndex = this.matchingAppServerTranscriptRecordIndex(thread, record);
      if (replacementIndex !== -1) {
        if (typeof record.order !== "number") record = { ...record, order: thread.records[replacementIndex].order };
        if (recordsEqual(thread.records[replacementIndex], record)) return;
        thread.records[replacementIndex] = record;
      } else {
        if (typeof record.order !== "number") record = { ...record, order: ++thread.recordSeq };
        thread.records.push(record);
      }
    } else {
      if (typeof record.order !== "number") record = { ...record, order: thread.records[existingIndex].order };
      if (recordsEqual(thread.records[existingIndex], record)) return;
      thread.records[existingIndex] = record;
    }
    thread.records = orderThreadRecords(thread.records);
    thread.updatedAt = latestRecordTimestamp(thread.records) ?? record.timestamp ?? new Date().toISOString();
    thread.lastUsage = latestUsage(thread.records);
    thread.threadUsage = threadUsageFromRecords(thread.records);
    this.publish(thread, "record", record, { historical: options.historical });
  }

  private finishSessionTurnByThread(threadId: string, error?: Error) {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    if (error) this.appendHubRecord(thread, "error", { type: "error", message: error.message });
    this.finishSessionTurn(thread, error);
  }

  private finishSessionTurn(thread: ThreadState, error?: Error) {
    const commandId = this.activeTurnCommands.get(thread.threadId);
    if (commandId) {
      this.activeTurnCommands.delete(thread.threadId);
      if (error) this.rejectCommand(commandId, error);
      else this.resolveCommand(commandId);
    }
    const wasRunning = thread.running;
    thread.running = false;
    thread.appServerTurnId = undefined;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, wasRunning ? "done" : "thread");
    this.startNextQueuedTurn(thread);
  }

  private startNextQueuedTurn(thread: ThreadState) {
    if (thread.running) return;
    const queue = this.queuedTurns.get(thread.threadId);
    const next = queue?.shift();
    if (!queue || !next) {
      this.queuedTurns.delete(thread.threadId);
      return;
    }
    if (!queue.length) this.queuedTurns.delete(thread.threadId);
    try {
      this.startTurn(thread, next.input, next.source, next.options).then(next.resolve, next.reject);
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)));
      this.startNextQueuedTurn(thread);
    }
  }

  private rejectQueuedTurns(threadId: string, error: Error) {
    const queue = this.queuedTurns.get(threadId);
    if (!queue?.length) return;
    this.queuedTurns.delete(threadId);
    for (const item of queue) item.reject(error);
  }

  private publish(
    thread: ThreadState,
    kind: ThreadStreamEvent["kind"],
    record?: CodexRecord,
    options: { historical?: boolean } = {}
  ) {
    const streamEvent: ThreadStreamEvent = {
      seq: ++thread.seq,
      threadId: thread.threadId,
      kind,
      ...(options.historical ? { historical: true } : {}),
      thread: this.summary(thread),
      record
    };
    thread.events.push(streamEvent);
    if (thread.events.length > 1000) thread.events.splice(0, thread.events.length - 1000);
    for (const subscriber of thread.subscribers) subscriber(streamEvent);
    this.options.onThreadChange?.();
  }

  private summary(thread: ThreadState): ThreadSummary {
    return {
      threadId: thread.threadId,
      workingDirectory: thread.workingDirectory,
      model: thread.threadOptions.model,
      modelReasoningEffort: thread.threadOptions.modelReasoningEffort,
      session: this.threadSessionSummary(thread),
      status: thread.running ? "running" : "idle",
      running: thread.running,
      title: thread.title,
      updatedAt: thread.updatedAt,
      messageCount: recordsToViews(thread.records).length,
      lastUsage: thread.lastUsage,
      threadUsage: thread.threadUsage
    };
  }

  private detail(thread: ThreadState): ThreadDetail {
    return {
      ...this.summary(thread),
      records: orderThreadRecords(thread.records),
      lastSeq: thread.seq
    };
  }

  private sessionSummary(session: SessionState): SessionSummary {
    const threads = this.sessionThreads(session);
    return {
      sessionId: session.sessionId,
      machineId: session.machineId,
      name: session.name,
      workingDirectory: session.workingDirectory,
      appServerUrl: session.appServerUrl,
      online: session.online,
      status: session.online ? "online" : "offline",
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      offlineSinceAt: session.offlineSinceAt,
      offlineReason: session.offlineReason,
      pid: session.pid,
      hostname: session.hostname,
      accountRateLimits: session.accountRateLimits ?? null,
      threads
    };
  }

  private sessionThreads(session: SessionState): ThreadSummary[] {
    const summaries = [...this.threads.values()]
      .filter((thread) => thread.sessionId === session.sessionId)
      .map((thread) => this.summary(thread));
    return summaries.sort((left, right) => {
      return Number(right.running) - Number(left.running)
        || right.updatedAt.localeCompare(left.updatedAt);
    });
  }

  private sessionVisibleState(session: SessionState) {
    return JSON.stringify({
      sessionId: session.sessionId,
      machineId: session.machineId,
      name: session.name,
      workingDirectory: session.workingDirectory,
      appServerUrl: session.appServerUrl,
      online: session.online,
      status: session.online ? "online" : "offline",
      offlineSinceAt: session.offlineSinceAt,
      offlineReason: session.offlineReason,
      pid: session.pid,
      hostname: session.hostname,
      accountRateLimits: session.accountRateLimits ?? null
    });
  }

  private sessionSnapshotEvent(): SessionStreamEvent {
    return {
      seq: this.sessionSeq,
      kind: "sessions",
      sessions: this.listSessions()
    };
  }

  private publishSessions() {
    const sessions = this.listSessions();
    const snapshotKey = sessionSnapshotKey(sessions);
    if (snapshotKey === this.lastSessionSnapshotKey) return;
    this.lastSessionSnapshotKey = snapshotKey;
    const event: SessionStreamEvent = {
      seq: ++this.sessionSeq,
      kind: "sessions",
      sessions
    };
    this.sessionEvents.push(event);
    if (this.sessionEvents.length > 1000) this.sessionEvents.splice(0, this.sessionEvents.length - 1000);
    for (const subscriber of this.sessionSubscribers) subscriber(event);
  }

  private publishThreadCatalog() {
    this.publishSessions();
    this.options.onCatalogChange?.();
  }

  private threadSessionSummary(thread: ThreadState): ThreadSessionSummary {
    const session = thread.sessionId ? this.sessions.get(thread.sessionId) : null;
    if (session?.online) return threadSessionSummary(session);
    const replacement = this.uniqueOnlineSessionForWorkspace(thread.workingDirectory);
    if (replacement) return threadSessionSummary(replacement);
    if (session) return threadSessionSummary(session);
    return { online: false, runnable: false };
  }

  private localCommandMessage(thread: ThreadState, command: string) {
    if (command === "status") return threadStatusMessage(thread, this.threadSessionSummary(thread));
    if (command === "help") return slashHelpMessage();
    if (command === "model") return modelCommandMessage(thread);
    return [
      `Unsupported slash command: /${command}`,
      "",
      "Codex slash commands are local UI commands. codexhub handles only the supported commands listed below and does not forward unsupported slash commands as user turns.",
      slashHelpMessage()
    ].join("\n");
  }
}

const threadSessionSummary = (session: SessionState): ThreadSessionSummary => ({
  sessionId: session.sessionId,
  name: session.name,
  appServerUrl: session.appServerUrl,
  online: session.online,
  runnable: session.online,
  lastSeenAt: session.lastSeenAt
});

const sessionSnapshotKey = (sessions: SessionSummary[]) => JSON.stringify(sessions.map((session) => ({
  ...session,
  lastSeenAt: undefined,
  threads: session.threads.map(threadSummarySnapshotKey)
})));

const threadSummarySnapshotKey = (thread: ThreadSummary) => ({
  ...thread,
  session: {
    ...thread.session,
    lastSeenAt: undefined
  }
});

const sessionCommandsAfter = (session: SessionState, after: number) =>
  session.commands.filter((command) => command.seq > after);

const codexRecordFromAppServerItem = (
  threadId: string,
  turnId: string,
  item: Record<string, unknown>,
  timestamp?: string,
  fallbackStatus?: string
): CodexRecord | null => {
  const itemType = typeof item.type === "string" ? item.type : "";
  const itemId = typeof item.id === "string" && item.id ? item.id : stablePayloadKey(item);
  const status = appServerStatus(item.status ?? fallbackStatus);
  const base = {
    id: `app:${threadId}:${turnId}:item:${itemType}:${itemId}`,
    timestamp,
    sourceThreadId: threadId
  };

  if (itemType === "userMessage") {
    return {
      ...base,
      id: `app:${threadId}:${turnId}:user:${itemId}`,
      type: "event_msg",
      payload: {
        type: "user_message",
        message: userMessageText(item.content),
        images: userMessageImages(item.content),
        text_elements: userMessageTextElements(item.content)
      }
    };
  }

  if (itemType === "agentMessage") {
    if (typeof item.text !== "string") return null;
    return {
      ...base,
      id: `app:${threadId}:${turnId}:agent:${itemId}`,
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: item.text,
        phase: typeof item.phase === "string" ? item.phase : "assistant",
        ...(status ? { status } : {})
      }
    };
  }

  if (itemType === "reasoning") {
    return {
      ...base,
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: stringArray(item.summary),
        content: stringArray(item.content).join("\n")
      }
    };
  }

  if (itemType === "commandExecution") {
    return {
      ...base,
      type: "response_item",
      payload: {
        type: "local_shell_call",
        call_id: itemId,
        status,
        action: {
          type: "exec",
          command: commandExecutionCommand(item)
        },
        aggregated_output: commandExecutionOutput(item),
        exit_code: commandExecutionExitCode(item)
      }
    };
  }

  if (itemType === "fileChange") {
    return {
      ...base,
      type: "response_item",
      payload: {
        type: "file_change",
        changes: fileChanges(item.changes),
        status
      }
    };
  }

  if (itemType === "mcpToolCall") {
    return {
      ...base,
      type: "response_item",
      payload: {
        type: "mcp_tool_call",
        server: typeof item.server === "string" ? item.server : "",
        tool: typeof item.tool === "string" ? item.tool : "",
        arguments: item.arguments,
        result: item.result,
        error: item.error,
        status
      }
    };
  }

  if (itemType === "dynamicToolCall") {
    return {
      ...base,
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: itemId,
        status,
        success: typeof item.success === "boolean" ? item.success : undefined,
        name: typeof item.tool === "string" ? item.tool : "tool",
        namespace: typeof item.namespace === "string" ? item.namespace : undefined,
        arguments: JSON.stringify(item.arguments ?? {}),
        content_items: Array.isArray(item.contentItems) ? item.contentItems : undefined
      }
    };
  }

  if (itemType === "collabAgentToolCall") {
    return {
      ...base,
      type: "response_item",
      payload: {
        type: "collab_agent_tool_call",
        call_id: itemId,
        tool: typeof item.tool === "string" ? item.tool : "agent",
        status,
        sender_thread_id: typeof item.senderThreadId === "string" ? item.senderThreadId : undefined,
        receiver_thread_ids: stringArray(item.receiverThreadIds),
        prompt: typeof item.prompt === "string" ? item.prompt : undefined,
        model: typeof item.model === "string" ? item.model : undefined,
        reasoning_effort: typeof item.reasoningEffort === "string" ? item.reasoningEffort : undefined,
        agents_states: item.agentsStates
      }
    };
  }

  if (itemType === "webSearch") {
    const query = typeof item.query === "string" ? item.query : webSearchQuery(item.action);
    return {
      ...base,
      type: "response_item",
      payload: {
        type: "web_search_call",
        query,
        action: item.action,
        status: "completed"
      }
    };
  }

  if (itemType === "imageView") {
    return {
      ...base,
      type: "response_item",
      payload: {
        type: "image_view",
        path: typeof item.path === "string" ? item.path : "",
        status: "completed"
      }
    };
  }

  if (itemType === "imageGeneration") {
    return {
      ...base,
      type: "response_item",
      payload: {
        type: "image_generation_call",
        call_id: itemId,
        status: typeof item.status === "string" ? item.status : undefined,
        prompt: typeof item.revisedPrompt === "string" ? item.revisedPrompt : undefined,
        revised_prompt: typeof item.revisedPrompt === "string" ? item.revisedPrompt : undefined,
        saved_path: typeof item.savedPath === "string" ? item.savedPath : undefined,
        result: typeof item.result === "string" ? item.result : ""
      }
    };
  }

  if (itemType === "plan") {
    return {
      ...base,
      type: "event_msg",
      payload: {
        type: "plan",
        message: typeof item.text === "string" ? item.text : stringify(item)
      }
    };
  }

  if (itemType === "contextCompaction") {
    const compactionStatus = status ?? "completed";
    return {
      ...base,
      type: "event_msg",
      payload: {
        type: "context_compaction",
        status: compactionStatus,
        message: compactionStatus === "completed" ? "Compaction complete" : "Compacting"
      }
    };
  }

  return null;
};

const codexRecordFromRawResponseItem = (
  threadId: string,
  turnId: string,
  item: Record<string, unknown>
): CodexRecord | null => {
  const itemType = typeof item.type === "string" ? item.type : "";
  if (!itemType || itemType === "message" || itemType === "agent_message") return null;
  const key = rawResponseItemKey(item);
  return {
    id: `app:${threadId}:${turnId}:raw:${itemType}:${key}`,
    timestamp: new Date().toISOString(),
    type: "response_item",
    payload: normalizeRawResponseItem(item),
    sourceThreadId: threadId
  };
};

const codexRecordFromAppServerUsage = (
  threadId: string,
  turnId: string,
  usage: Record<string, unknown>
): CodexRecord | null => {
  const last = asRecord(usage.last);
  if (!last) return null;
  const rateLimits = tokenUsageRateLimits(usage.rateLimits ?? usage.rate_limits);
  return {
    id: `app:${threadId}:${turnId}:usage`,
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: tokenUsageBreakdown(last),
        model_context_window: typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : undefined
      },
      ...(rateLimits ? { rate_limits: rateLimits } : {})
    },
    sourceThreadId: threadId
  };
};

const normalizeRawResponseItem = (item: Record<string, unknown>) => {
  if (item.type !== "web_search_call") return item;
  const action = asRecord(item.action);
  return {
    ...item,
    query: webSearchQuery(action)
  };
};

const tokenUsageBreakdown = (value: Record<string, unknown>) => ({
  input_tokens: tokenUsageNumber(value.inputTokens),
  cached_input_tokens: tokenUsageNumber(value.cachedInputTokens),
  output_tokens: tokenUsageNumber(value.outputTokens),
  reasoning_output_tokens: tokenUsageNumber(value.reasoningOutputTokens),
  total_tokens: tokenUsageNumber(value.totalTokens)
});

const tokenUsageRateLimits = (value: unknown) => {
  const record = asRecord(value);
  if (!record) return undefined;
  const primary = tokenUsageRateLimitWindow(record.primary);
  const secondary = tokenUsageRateLimitWindow(record.secondary);
  if (!primary && !secondary) return undefined;
  return {
    limit_id: stringOrNullValue(record.limit_id ?? record.limitId),
    limit_name: stringOrNullValue(record.limit_name ?? record.limitName),
    primary,
    secondary,
    credits: record.credits ?? null,
    individual_limit: record.individual_limit ?? record.individualLimit ?? null,
    plan_type: stringOrNullValue(record.plan_type ?? record.planType),
    rate_limit_reached_type: stringOrNullValue(record.rate_limit_reached_type ?? record.rateLimitReachedType)
  };
};

const tokenUsageRateLimitWindow = (value: unknown) => {
  const record = asRecord(value);
  if (!record) return undefined;
  const usedPercent = tokenUsageNumber(record.usedPercent ?? record.used_percent);
  const windowMinutes = tokenUsageNumber(
    record.windowMinutes
    ?? record.window_minutes
    ?? record.windowDurationMins
    ?? record.window_duration_mins
  );
  const resetsAt = tokenUsageNumber(record.resetsAt ?? record.resets_at);
  if (usedPercent === undefined || windowMinutes === undefined || resetsAt === undefined) return undefined;
  return {
    used_percent: usedPercent,
    window_minutes: windowMinutes,
    resets_at: resetsAt
  };
};

const stringOrNullValue = (value: unknown) =>
  typeof value === "string" ? value : value === null ? null : undefined;

const userMessageText = (content: unknown) =>
  userMessageContent(content)
    .map((item) => typeof item.text === "string" ? item.text : null)
    .filter((text): text is string => Boolean(text))
    .join("\n");

const userMessageImages = (content: unknown) =>
  userMessageContent(content)
    .map((item) => typeof item.url === "string" ? item.url : typeof item.path === "string" ? item.path : null)
    .filter((url): url is string => Boolean(url));

const userMessageTextElements = (content: unknown) =>
  userMessageContent(content).flatMap((item) => Array.isArray(item.text_elements) ? item.text_elements : []);

const userMessageContent = (content: unknown) =>
  Array.isArray(content) ? content.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : [];

const stringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const commandExecutionCommand = (item: Record<string, unknown>) => {
  const action = asRecord(item.action);
  const value = item.command ?? item.cmd ?? action?.command ?? action?.cmd;
  if (Array.isArray(value)) return value.filter((part): part is string => typeof part === "string" && Boolean(part));
  return typeof value === "string" && value ? [value] : [];
};

const commandExecutionOutput = (item: Record<string, unknown>) => {
  const direct = item.aggregatedOutput ?? item.aggregated_output ?? item.output;
  if (typeof direct === "string") return direct;
  const output = [
    typeof item.stdout === "string" ? item.stdout : "",
    typeof item.stderr === "string" ? item.stderr : ""
  ].filter(Boolean);
  return output.join("\n");
};

const commandExecutionExitCode = (item: Record<string, unknown>) => {
  const value = item.exitCode ?? item.exit_code;
  return typeof value === "number" ? value : null;
};

const fileChanges = (value: unknown) =>
  Array.isArray(value)
    ? value.map((item) => {
      const record = asRecord(item);
      const kind = asRecord(record?.kind);
      return {
        path: typeof record?.path === "string" ? record.path : "",
        kind: typeof kind?.type === "string" ? kind.type : typeof record?.kind === "string" ? record.kind : "update",
        diff: typeof record?.diff === "string" ? record.diff : undefined
      };
    })
    : [];

const appServerStatus = (status: unknown) =>
  status === "inProgress" ? "in_progress" : typeof status === "string" ? status : undefined;

const webSearchQuery = (action: unknown) => {
  const record = asRecord(action);
  if (typeof record?.query === "string") return record.query;
  if (Array.isArray(record?.queries)) return record.queries.filter((item): item is string => typeof item === "string").join("\n");
  return "";
};

const rawResponseItemKey = (item: Record<string, unknown>) => {
  for (const key of ["call_id", "id", "name"]) {
    const value = item[key];
    if (typeof value === "string" && value) return value;
  }
  return stablePayloadKey(item);
};

const stablePayloadKey = (value: unknown) => {
  const text = stringify(value);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
};

const timestampFromMillis = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined;

const timestampFromSeconds = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;

const codexRecordsFromAppServerTurnLifecycle = (
  threadId: string,
  turnId: string,
  turn: Record<string, unknown>
): CodexRecord[] => {
  const startedAt = timestampFromSeconds(turn.startedAt);
  const completedAt = timestampFromSeconds(turn.completedAt);
  const durationMs = startedAt && completedAt ? timestampDeltaMs(startedAt, completedAt) : undefined;
  const firstTokenMs = appServerFirstTokenMs(turn, startedAt);
  const records: CodexRecord[] = [];
  if (startedAt) {
    records.push({
      id: `app:${threadId}:${turnId}:event:task_started`,
      timestamp: startedAt,
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId
      },
      sourceThreadId: threadId
    });
  }
  if (completedAt) {
    records.push({
      id: `app:${threadId}:${turnId}:event:task_complete`,
      timestamp: completedAt,
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: turnId,
        ...(durationMs == null ? {} : { duration_ms: durationMs }),
        ...(firstTokenMs == null ? {} : { time_to_first_token_ms: firstTokenMs })
      },
      sourceThreadId: threadId
    });
  }
  return records;
};

const isTaskStartedRecord = (record: CodexRecord) =>
  asRecord(record.payload)?.type === "task_started";

const isTaskCompleteRecord = (record: CodexRecord) =>
  asRecord(record.payload)?.type === "task_complete";

const timestampDeltaMs = (startedAt: string, completedAt: string) => {
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  return Number.isFinite(startedMs) && Number.isFinite(completedMs)
    ? Math.max(0, completedMs - startedMs)
    : undefined;
};

const appServerFirstTokenMs = (turn: Record<string, unknown>, startedAt: string | undefined) => {
  const direct = numberValue(turn.timeToFirstTokenMs) ?? numberValue(turn.time_to_first_token_ms);
  if (direct != null && Number.isFinite(direct)) return Math.max(0, direct);
  const firstTokenAt = timestampFromSeconds(turn.firstTokenAt) ?? timestampFromSeconds(turn.first_token_at);
  return startedAt && firstTokenAt ? timestampDeltaMs(startedAt, firstTokenAt) : undefined;
};

const tokenUsageNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const latestUsage = (records: CodexRecord[]) => {
  const views = recordsToViews(records);
  for (let i = views.length - 1; i >= 0; i -= 1) {
    if (views[i].usage) return views[i].usage;
  }
  return undefined;
};

const latestRecordTimestamp = (records: CodexRecord[]) => {
  let latest: { timestamp: string; time: number } | undefined;
  let fallback: string | undefined;
  for (const record of records) {
    const timestamp = record.timestamp;
    if (!timestamp) continue;
    fallback = timestamp;
    const time = Date.parse(timestamp);
    if (Number.isFinite(time) && (!latest || time > latest.time)) {
      latest = { timestamp, time };
    }
  }
  return latest?.timestamp ?? fallback;
};

const orderThreadRecords = (records: CodexRecord[]) =>
  records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => compareThreadRecords(left.record, right.record) || left.index - right.index)
    .map((entry) => entry.record);

const compareThreadRecords = (left: CodexRecord, right: CodexRecord) => {
  const leftTime = recordTimeMs(left);
  const rightTime = recordTimeMs(right);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
  if (leftTime !== null && rightTime === null) return -1;
  if (leftTime === null && rightTime !== null) return 1;
  const leftOrder = typeof left.order === "number" ? left.order : Number.MAX_SAFE_INTEGER;
  const rightOrder = typeof right.order === "number" ? right.order : Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return 0;
};

const recordTimeMs = (record: CodexRecord) => {
  const time = Date.parse(record.timestamp ?? "");
  return Number.isFinite(time) ? time : null;
};

const recordsEqual = (left: CodexRecord, right: CodexRecord) =>
  JSON.stringify(left) === JSON.stringify(right);

const remapAppRecordThreadId = (record: CodexRecord, sourceThreadId: string, forkedThreadId: string): CodexRecord => ({
  ...record,
  id: record.id.replace(`app:${sourceThreadId}:`, `app:${forkedThreadId}:`),
  sourceThreadId: forkedThreadId
});

const threadIdFromAppServerMessage = (message: Record<string, unknown>) => {
  const params = asRecord(message.params);
  const thread = asRecord(params?.thread);
  const result = asRecord(message.result);
  const resultThread = asRecord(result?.thread);
  return typeof params?.threadId === "string"
    ? params.threadId
    : typeof thread?.id === "string"
      ? thread.id
      : typeof resultThread?.id === "string"
        ? resultThread.id
        : undefined;
};

const resultThreadIdFromAppServerMessage = (message: Record<string, unknown>) => {
  const result = asRecord(message.result);
  const resultThread = asRecord(result?.thread);
  return typeof resultThread?.id === "string" ? resultThread.id : undefined;
};

const commandResultThreadId = (result: unknown) => {
  const record = asRecord(result);
  return typeof record?.threadId === "string" ? record.threadId : undefined;
};

const appServerThreadFromMessage = (message: Record<string, unknown>) => {
  const params = asRecord(message.params);
  const result = asRecord(message.result);
  return asRecord(result?.thread) ?? asRecord(params?.thread);
};

const rollbackPlanAfterRecord = (thread: ThreadState, recordId: string) => {
  const targetTurnId = turnIdFromAppRecordId(thread.threadId, recordId);
  if (!targetTurnId) throw new Error(`Cannot fork from record without app-server turn id: ${recordId}`);
  const turnIds = appServerTurnIds(thread);
  const targetIndex = turnIds.indexOf(targetTurnId);
  if (targetIndex === -1) throw new Error(`Cannot find fork target turn for record: ${recordId}`);
  return {
    rollbackTurns: turnIds.length - targetIndex - 1,
    keepTurns: targetIndex + 1
  };
};

const appServerTurnIds = (thread: ThreadState) => {
  const turnIds: string[] = [];
  for (const record of thread.records) {
    const turnId = turnIdFromAppRecordId(thread.threadId, record.id);
    if (turnId && !turnIds.includes(turnId)) turnIds.push(turnId);
  }
  return turnIds;
};

const turnIdFromAppRecordId = (threadId: string, recordId: string) => {
  const prefix = `app:${threadId}:`;
  if (!recordId.startsWith(prefix)) return null;
  const rest = recordId.slice(prefix.length);
  const [turnId, kind] = rest.split(":");
  if (!turnId || !kind) return null;
  return turnId;
};

const summarizeInput = (input: ProxyInput) => {
  if (typeof input === "string") return input;
  return input
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
};

const goalUpdateFromInput = (input: ProxyInput, options: ThreadRunOptions): ThreadGoalUpdate => {
  const configuredObjective = typeof options.goalObjective === "string" ? options.goalObjective.trim() : "";
  const objective = configuredObjective || summarizeInput(input).trim();
  return {
    objective: objective ? objective.slice(0, 4000) : "Pursue the attached user request.",
    status: "active",
    ...(hasOwn(options, "goalTokenBudget") ? { tokenBudget: options.goalTokenBudget } : {})
  };
};

const imageUrls = (input: ProxyInput) => {
  if (typeof input === "string") return [];
  return input
    .filter((item) => item.type === "image")
    .map((item) => item.url);
};

const parseLocalSlashCommand = (input: ProxyInput) => {
  if (typeof input !== "string") return null;
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s|$)/.exec(input.trim());
  return match?.[1].toLowerCase() ?? null;
};

const threadStatusMessage = (thread: ThreadState, session: ThreadSessionSummary) => [
  "Codex Hub status",
  `thread: ${thread.threadId}`,
  `folder: ${thread.workingDirectory}`,
  `state: ${thread.running ? "running" : "idle"}`,
  `session: ${formatSession(session)}`,
  `model: ${formatModel(thread.threadOptions)}`,
  `reasoning: ${thread.threadOptions.modelReasoningEffort ?? "auto"}`,
  `records: ${thread.records.length}`,
  `updated: ${thread.updatedAt}`,
  `usage: ${formatUsage(thread.lastUsage)}`
].join("\n");

const modelCommandMessage = (thread: ThreadState) => [
  "Model control",
  `current model: ${formatModel(thread.threadOptions)}`,
  `current reasoning: ${thread.threadOptions.modelReasoningEffort ?? "auto"}`,
  "",
  "In Web, use the Model selector. The selected model and reasoning are sent with the next Web turn.",
  "For API, Telegram, task, and session turns, pass model options with the next turn request."
].join("\n");

const slashHelpMessage = () => [
  "Supported codexhub slash commands:",
  "/status - show this thread session status",
  "/model - explain model control",
  "/help - show supported proxy commands"
].join("\n");

const formatModel = (options: ThreadOptions) => options.model ?? "auto";

const formatThreadGoalMessage = (goal: Record<string, unknown> | null) => {
  const status = typeof goal?.status === "string" ? goal.status : "active";
  const objective = typeof goal?.objective === "string" && goal.objective.trim()
    ? goal.objective.trim()
    : "Untitled goal";
  const budget = typeof goal?.tokenBudget === "number" ? ` (budget ${goal.tokenBudget} tokens)` : "";
  return `Goal ${status}: ${objective}${budget}`;
};

const formatSession = (summary: ThreadSessionSummary) => {
  const state = summary.runnable ? "runnable" : summary.online ? "online" : "offline";
  const session = summary.sessionId ? ` session:${summary.name ?? summary.sessionId.slice(0, 8)}` : "";
  return `${state}${session}`;
};

const formatUsage = (usage: Usage | undefined) => {
  const record = asRecord(usage);
  if (!record) return "n/a";
  const total = numberValue(record.total_tokens) ?? numberValue(record.totalTokens);
  const input = numberValue(record.input_tokens) ?? numberValue(record.inputTokens);
  const output = numberValue(record.output_tokens) ?? numberValue(record.outputTokens);
  if (total == null && input == null && output == null) return "n/a";
  return [
    total == null ? null : `total=${total}`,
    input == null ? null : `input=${input}`,
    output == null ? null : `output=${output}`
  ].filter(Boolean).join(", ");
};

const numberValue = (value: unknown) => typeof value === "number" ? value : undefined;

const isThreadReasoningEffort = (value: unknown): value is ThreadOptions["modelReasoningEffort"] =>
  value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";

const turnCommandTimeoutMs = () => {
  const raw = process.env.CODEX_HUB_TURN_TIMEOUT_MS?.trim();
  if (!raw) return null;
  const timeoutMs = Number(raw);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
};

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const applyThreadRunOptions = (current: ThreadOptions, options: ThreadRunOptions) => {
  const next = { ...current };
  if (hasOwn(options, "model")) {
    if (options.model) next.model = options.model;
    else delete next.model;
  }
  if (hasOwn(options, "modelReasoningEffort")) {
    if (options.modelReasoningEffort) next.modelReasoningEffort = options.modelReasoningEffort;
    else delete next.modelReasoningEffort;
  }
  return next;
};

const stringify = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
