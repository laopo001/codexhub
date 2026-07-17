import { randomUUID } from "node:crypto";
import { recordsToViews } from "./codexRecordView.js";
import {
  emptyThreadUsage,
  rateLimitUsageForWindowMinutes,
  sevenDayRateLimitWindowMinutes,
  threadRateLimitsFromValue,
  threadUsageFromRecords
} from "./threadUsage.js";
import { localCommandMessage, parseLocalSlashCommand } from "./threadLocalCommands.js";
import {
  appServerGoalUpdate,
  formatPercent,
  formatThreadGoalMessage,
  goalRunPolicyStatusCanRun,
  goalUpdateCanStartRunPolicy,
  goalUpdateFromInput,
  hasThreadGoalPatch,
  normalizeThreadGoalRunPolicy,
  threadGoalRecordMatchesThread,
  threadGoalsEqual,
  threadGoalThreadId,
  threadGoalTimestamp,
  weeklyGoalWrapUpObjective
} from "./threadGoalPolicy.js";
import {
  clampSessionCommandCursor as clampCommandCursor,
  enqueueSessionCommand as enqueueCommand,
  waitForSessionCommands
} from "./sessionCommandQueue.js";
import type { ProxyInput } from "../shared/inputTypes.js";
import { turnIdFromAppRecordId } from "../shared/recordIdentity.js";
import { asRecord, type CodexRecord } from "../shared/recordTypes.js";
import {
  isModelReasoningEffort,
  type ThreadOptions,
  type ThreadRateLimits,
  type ThreadUsage
} from "../shared/usageTypes.js";
import type {
  InternalSessionRegistration,
  PendingCommand,
  QueuedTurn,
  SessionState,
  ThreadState
} from "./threadHubState.js";
import {
  approvalDecisionStatus,
  approvalRecord,
  userInputRecord,
  type PendingApproval,
  type PendingUserInput
} from "./threadApprovalRecords.js";
import {
  codexRecordFromAppServerItem,
  codexRecordFromAppServerUsage,
  codexRecordFromRawResponseItem,
  codexRecordsFromAppServerTurnLifecycle,
  isStatusUsageRecord,
  isTaskCompleteRecord,
  isTaskStartedRecord,
  latestRecordTimestamp,
  latestUsage,
  orderThreadRecords,
  recordsEqual,
  remapAppRecordThreadId,
  repositionStatusUsageRecords,
  statusUsageRecordFromAppServerUsage,
  timestampFromMillis,
  timestampFromSeconds,
  withAppServerItemRecordTiming
} from "./threadAppServerRecords.js";
import type {
  AppServerApprovalDecision,
  AppServerUserInputAnswers,
  CommandPalettePart,
  SessionCommand,
  SessionCommandPaletteResult,
  SessionEventInput,
  SessionModelCatalogResult,
  SessionOfflineReason,
  SessionRegistration,
  SessionStreamEvent,
  SessionSummary,
  SessionThreadCandidatesResult,
  ThreadDetail,
  ThreadGoalStatus,
  ThreadGoalUpdate,
  ThreadRunOptions,
  ThreadStreamEvent,
  ThreadSummary,
  ThreadSessionSummary
} from "../shared/threadTypes.js";

export class ThreadHub {
  private readonly threads = new Map<string, ThreadState>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();
  private readonly activeTurnCommands = new Map<string, string>();
  private readonly queuedTurns = new Map<string, QueuedTurn[]>();
  private readonly threadSettingsRevisions = new Map<string, number>();
  private readonly pendingTurnSettingsCommits = new Map<string, {
    thread: ThreadState;
    options: ThreadRunOptions;
    threadOptionsAtStart: ThreadOptions;
    settingsRevisionAtStart: number;
  }>();
  private readonly sessionEvents: SessionStreamEvent[] = [];
  private readonly sessionSubscribers = new Set<(event: SessionStreamEvent) => void>();
  private lastSessionSnapshotKey = "";
  private sessionSeq = 0;

  constructor(
    private readonly defaultThreadOptions: ThreadOptions = {},
    private readonly options: {
      onCatalogChange?: () => void;
      onThreadChange?: () => void;
      onThreadEvent?: (event: ThreadStreamEvent, records: CodexRecord[]) => void;
    } = {}
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
      const resultThread = asRecord(asRecord(result)?.thread);
      const thread = this.ensureThread(threadId, session, {
        result: { thread: resultThread ?? { id: threadId, cwd: pending.workingDirectory ?? session.workingDirectory } }
      });
      if (resultThread) this.applyAppServerThread(thread, resultThread);
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
    return waitForSessionCommands(this.sessions.get(sessionId), sessionId, after, timeoutMs);
  }

  clampSessionCommandCursor(sessionId: string, requestedCursor: number) {
    return clampCommandCursor(this.sessions.get(sessionId), requestedCursor);
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

    if (input.type === "approval_request") {
      const thread = this.ensureThread(input.threadId, session, {
        params: { threadId: input.threadId, cwd: session.workingDirectory }
      });
      const approval: PendingApproval = {
        ...input.approval,
        sessionId,
        status: "pending"
      };
      this.pendingApprovals.set(approval.approvalId, approval);
      this.upsertRecord(thread, approvalRecord(approval));
      return { ok: true, thread: this.summary(thread) };
    }

    if (input.type === "user_input_request") {
      const thread = this.ensureThread(input.threadId, session, {
        params: { threadId: input.threadId, cwd: session.workingDirectory }
      });
      const userInput: PendingUserInput = {
        ...input.userInput,
        sessionId,
        status: "pending"
      };
      this.pendingUserInputs.set(userInput.userInputId, userInput);
      this.upsertRecord(thread, userInputRecord(userInput));
      return { ok: true, thread: this.summary(thread) };
    }

    if (input.type === "thread_execution_changed") {
      const thread = this.ensureThread(input.threadId, session, {
        params: { threadId: input.threadId, cwd: session.workingDirectory }
      });
      this.applyThreadExecutionState(thread, input.running, input.turnId);
      return { ok: true, thread: this.summary(thread) };
    }

    if (input.type === "thread_settings_changed") {
      const thread = this.ensureThread(input.threadId, session, {
        params: { threadId: input.threadId, cwd: session.workingDirectory }
      });
      this.threadSettingsRevisions.set(
        thread.threadId,
        (this.threadSettingsRevisions.get(thread.threadId) ?? 0) + 1
      );
      this.applyThreadSettings(
        thread,
        input.model,
        input.modelReasoningEffort,
        input.serviceTier,
        input.approvalPolicy,
        input.sandboxPolicy
      );
      return { ok: true, thread: this.summary(thread) };
    }

    if (input.type === "thread_turns_snapshot") {
      const thread = this.ensureThread(input.threadId, session, {
        params: { threadId: input.threadId, cwd: session.workingDirectory }
      });
      // 这里用 snapshot 替换历史 app-server turn records；实时事件继续走 upsert。
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
      // 执行 fork 时返回的是新 thread，只复制被保留的历史 records，后续 records 继续来自 app-server。
      const source = this.threads.get(pending.threadId);
      if (source && source.threadId !== thread.threadId) this.seedForkedThreadRecords(source, thread, pending.keepTurns);
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
    if (workingDirectory && thread.workingDirectory !== workingDirectory) {
      thread.workingDirectory = workingDirectory;
    }
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
    return this.summary(thread);
  }

  subscribeThreadRecords(threadId: string) {
    const thread = this.requireThread(threadId);
    const session = this.requireThreadSession(thread);
    // 请求拥有该 thread 的 session bridge 去镜像官方 app-server turns。
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

  async listSessionModels(sessionId: string, includeHidden = false): Promise<SessionModelCatalogResult> {
    const session = this.requireOnlineSession(sessionId);
    const commandId = randomUUID();
    const promise = this.waitForCommand<SessionModelCatalogResult>(
      commandId,
      "list_models",
      undefined,
      60_000,
      session.workingDirectory
    );
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "list_models",
      workingDirectory: session.workingDirectory,
      createdAt: new Date().toISOString(),
      includeHidden
    });
    return await promise;
  }

  async listSessionCommandPalette(
    sessionId: string,
    workingDirectory?: string,
    part: CommandPalettePart = "all"
  ): Promise<SessionCommandPaletteResult> {
    const session = this.requireOnlineSession(sessionId);
    const cwd = workingDirectory || session.workingDirectory;
    const commandId = randomUUID();
    const promise = this.waitForCommand<SessionCommandPaletteResult>(
      commandId,
      "list_command_palette",
      undefined,
      60_000,
      cwd
    );
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "list_command_palette",
      workingDirectory: cwd,
      commandPalettePart: part,
      createdAt: new Date().toISOString()
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
    const forkTarget = recordId ? forkTargetAfterRecord(source, recordId) : undefined;
    const forkSeedTurns = forkTarget?.keepTurns ?? appServerTurnIds(source).length;
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
      ...(forkTarget ? { lastTurnId: forkTarget.lastTurnId } : {}),
      options: { ...source.threadOptions }
    });
    return await promise;
  }

  async rollbackThreadAfterRecord(threadId: string, recordId: string): Promise<ThreadDetail> {
    // app-server 的 thread/rollback 已废弃且会原地改历史；Rewind 改为 fork through turn。
    return await this.forkThread(threadId, recordId);
  }

  async renameThread(threadId: string, title: string): Promise<ThreadDetail> {
    const thread = this.requireThread(threadId);
    const session = this.requireThreadSession(thread);
    const nextTitle = compactThreadTitle(title);
    if (!nextTitle) throw new Error("Thread title must not be empty");
    const commandId = randomUUID();
    const promise = this.waitForCommand<void>(commandId, "rename_thread", thread.threadId, undefined, thread.workingDirectory);
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "rename_thread",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId,
      title: nextTitle
    });
    await promise;
    this.applyThreadTitle(thread, nextTitle);
    return this.detail(thread);
  }

  async deleteThread(threadId: string) {
    const thread = this.requireThread(threadId);
    thread.running = false;
    thread.activeTurnStartedAt = undefined;
    this.rejectQueuedTurns(thread.threadId, new Error(`Thread deleted: ${thread.threadId}`));
    this.threads.delete(threadId);
    this.threadSettingsRevisions.delete(threadId);
    this.publish(thread, "done");
    this.publishThreadCatalog();
    return { deleted: true };
  }

  stopTurn(threadId: string) {
    const thread = this.requireThread(threadId);
    if (!thread.running) return { stopped: false };
    const session = this.requireThreadSession(thread);
    thread.skipNextGoalRunPolicyRun = true;
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

  async compactThread(threadId: string) {
    const thread = this.requireThread(threadId);
    if (thread.running) throw new Error(`Thread is running: ${threadId}`);
    const session = this.requireThreadSession(thread);
    const commandId = randomUUID();
    const promise = this.waitForCommand<{ ok?: boolean }>(
      commandId,
      "compact_thread",
      thread.threadId,
      undefined,
      thread.workingDirectory
    );
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "compact_thread",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId
    });
    return await promise;
  }

  async reviewThread(threadId: string) {
    const thread = this.requireThread(threadId);
    if (thread.running) throw new Error(`Thread is already running: ${thread.threadId}`);
    const session = this.requireThreadSession(thread);
    const commandId = randomUUID();
    const promise = this.waitForCommand<{ ok?: boolean; reviewThreadId?: string }>(
      commandId,
      "review_thread",
      thread.threadId,
      undefined,
      thread.workingDirectory
    );
    this.activeTurnCommands.set(thread.threadId, commandId);
    if (thread.title === thread.threadId) thread.title = "Review changes";
    const startedAt = new Date().toISOString();
    thread.running = true;
    thread.activeTurnStartedAt = startedAt;
    thread.updatedAt = startedAt;
    this.publish(thread, "thread");
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "review_thread",
      workingDirectory: thread.workingDirectory,
      createdAt: startedAt,
      threadId: thread.threadId,
      reviewTarget: { type: "uncommittedChanges" }
    });
    return await promise;
  }

  async respondToApproval(
    threadId: string,
    approvalId: string,
    decision: AppServerApprovalDecision
  ) {
    const thread = this.requireThread(threadId);
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval || approval.threadId !== thread.threadId || approval.status !== "pending") {
      throw new Error(`Approval not found: ${approvalId}`);
    }
    const session = this.requireOnlineSession(approval.sessionId);
    if (thread.sessionId !== session.sessionId) {
      throw new Error(`Approval belongs to a different session: ${approvalId}`);
    }

    const commandId = randomUUID();
    const promise = this.waitForCommand<{ ok?: boolean }>(
      commandId,
      "approval_decision",
      thread.threadId,
      30_000,
      thread.workingDirectory
    );
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "approval_decision",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId,
      approvalId,
      approvalDecision: decision
    });

    try {
      await promise;
      const status = approvalDecisionStatus(decision);
      const nextApproval: PendingApproval = { ...approval, status, decision };
      this.pendingApprovals.delete(approvalId);
      this.upsertRecord(thread, approvalRecord(nextApproval));
      return { status, decision, thread: this.detail(thread) };
    } catch (error) {
      const failedApproval: PendingApproval = { ...approval, status: "failed" };
      this.pendingApprovals.delete(approvalId);
      this.upsertRecord(thread, approvalRecord(failedApproval, errorText(error)));
      throw error;
    }
  }

  async respondToUserInput(
    threadId: string,
    userInputId: string,
    answers: AppServerUserInputAnswers
  ) {
    const thread = this.requireThread(threadId);
    const userInput = this.pendingUserInputs.get(userInputId);
    if (!userInput || userInput.threadId !== thread.threadId || userInput.status !== "pending") {
      throw new Error(`User input not found: ${userInputId}`);
    }
    const session = this.requireOnlineSession(userInput.sessionId);
    if (thread.sessionId !== session.sessionId) {
      throw new Error(`User input belongs to a different session: ${userInputId}`);
    }

    const commandId = randomUUID();
    const promise = this.waitForCommand<{ ok?: boolean }>(
      commandId,
      "user_input_response",
      thread.threadId,
      30_000,
      thread.workingDirectory
    );
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "user_input_response",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId,
      userInputId,
      userInputAnswers: answers
    });

    try {
      await promise;
      const nextUserInput: PendingUserInput = { ...userInput, status: "answered", answers };
      this.pendingUserInputs.delete(userInputId);
      this.upsertRecord(thread, userInputRecord(nextUserInput));
      return { status: "answered" as const, thread: this.detail(thread) };
    } catch (error) {
      const failedUserInput: PendingUserInput = { ...userInput, status: "failed" };
      this.pendingUserInputs.delete(userInputId);
      this.upsertRecord(thread, userInputRecord(failedUserInput, errorText(error)));
      throw error;
    }
  }

  runLocalCommand(threadId: string, input: ProxyInput, _source: "web" | "telegram" | "task" = "web") {
    const parsed = parseLocalSlashCommand(input);
    if (!parsed) return { handled: false };

    const thread = this.requireThread(threadId);
    this.appendUserInputRecord(thread, input);
    this.appendHubRecord(thread, "event_msg", {
      type: "agent_message",
      message: localCommandMessage(
        thread,
        this.threadSessionSummary(thread),
        this.threadAccountRateLimits(thread),
        parsed.command,
        parsed.args
      ),
      phase: "final_answer"
    });
    return { handled: true, command: parsed.command };
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
    const threadOptionsAtStart = thread.threadOptions;
    const settingsRevisionAtStart = this.threadSettingsRevisions.get(thread.threadId) ?? 0;
    const commandId = randomUUID();
    const promise = this.waitForCommand<void>(commandId, "turn", thread.threadId, turnCommandTimeoutMs(), thread.workingDirectory);
    this.activeTurnCommands.set(thread.threadId, commandId);
    if (options && hasStickyThreadRunOptions(options)) {
      this.pendingTurnSettingsCommits.set(commandId, {
        thread,
        options: commandOptions,
        threadOptionsAtStart,
        settingsRevisionAtStart
      });
    }

    const userText = summarizeInput(input);
    const userTitle = compactThreadTitle(userText);
    if (userTitle && thread.title === thread.threadId) thread.title = userTitle;
    const startedAt = new Date().toISOString();
    thread.running = true;
    thread.activeTurnStartedAt = startedAt;
    thread.updatedAt = startedAt;
    this.publish(thread, "thread");

    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "turn",
      workingDirectory: thread.workingDirectory,
      createdAt: startedAt,
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
    const previousPolicy = thread.goalRunPolicy ?? null;
    const previousPolicyObjective = thread.goalRunPolicyObjective;
    const previousPolicyStatus = thread.goalRunPolicyStatus;
    const previousSkipNextPolicyRun = thread.skipNextGoalRunPolicyRun;
    thread.goalRunPolicy = null;
    thread.goalRunPolicyObjective = undefined;
    thread.goalRunPolicyStatus = undefined;
    thread.skipNextGoalRunPolicyRun = false;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "clear_goal",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId
    });
    return promise.catch((error) => {
      thread.goalRunPolicy = previousPolicy;
      thread.goalRunPolicyObjective = previousPolicyObjective;
      thread.goalRunPolicyStatus = previousPolicyStatus;
      thread.skipNextGoalRunPolicyRun = previousSkipNextPolicyRun;
      thread.updatedAt = new Date().toISOString();
      this.publish(thread, "thread");
      throw error;
    });
  }

  private setThreadGoal(thread: ThreadState, goal: ThreadGoalUpdate) {
    const session = this.requireThreadSession(thread);
    const commandId = randomUUID();
    const appServerGoal = appServerGoalUpdate(goal);
    const shouldSendGoal = hasThreadGoalPatch(appServerGoal);
    const promise = shouldSendGoal
      ? this.waitForCommand<void>(commandId, "set_goal", thread.threadId, undefined, thread.workingDirectory)
      : Promise.resolve();
    const previousPolicy = thread.goalRunPolicy ?? null;
    const previousPolicyObjective = thread.goalRunPolicyObjective;
    const previousPolicyStatus = thread.goalRunPolicyStatus;
    const previousSkipNextPolicyRun = thread.skipNextGoalRunPolicyRun;
    const policyCacheChanged = hasOwn(goal, "runPolicy") || hasOwn(goal, "objective") || hasOwn(goal, "status");
    if (hasOwn(goal, "runPolicy")) {
      thread.goalRunPolicy = normalizeThreadGoalRunPolicy(goal.runPolicy);
      thread.skipNextGoalRunPolicyRun = false;
      if (!thread.goalRunPolicy) {
        thread.goalRunPolicyObjective = undefined;
        thread.goalRunPolicyStatus = undefined;
      }
    }
    if (typeof goal.objective === "string" && goal.objective.trim()) {
      thread.goalRunPolicyObjective = goal.objective.trim();
    }
    if (typeof goal.status === "string" && goal.status) {
      thread.goalRunPolicyStatus = goal.status;
    }
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
    if (shouldSendGoal) {
      this.enqueueSessionCommand(session.sessionId, {
        commandId,
        type: "set_goal",
        workingDirectory: thread.workingDirectory,
        createdAt: new Date().toISOString(),
        threadId: thread.threadId,
        goal: appServerGoal
      });
    }
    return promise.then(() => {
      if (thread.goalRunPolicy && goalUpdateCanStartRunPolicy(goal)) {
        this.maybeStartGoalRunPolicyTurn(thread, {
          allowUnknownUsage: true,
          fallbackObjective: typeof appServerGoal.objective === "string" ? appServerGoal.objective : undefined,
          statusOverride: goal.status === "active" ? "active" : undefined
        });
      }
    }, (error) => {
      if (policyCacheChanged) {
        thread.goalRunPolicy = previousPolicy;
        thread.goalRunPolicyObjective = previousPolicyObjective;
        thread.goalRunPolicyStatus = previousPolicyStatus;
        thread.skipNextGoalRunPolicyRun = previousSkipNextPolicyRun;
        thread.updatedAt = new Date().toISOString();
        this.publish(thread, "thread");
      }
      throw error;
    });
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
    // 这里的 command 只入队到 session；真正执行发生在 machine/session bridge。
    return enqueueCommand(session, command);
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
          this.pendingTurnSettingsCommits.delete(commandId);
          if (threadId && this.activeTurnCommands.get(threadId) === commandId) {
            this.activeTurnCommands.delete(threadId);
            const thread = this.threads.get(threadId);
            if (thread) {
              thread.running = false;
              thread.activeTurnStartedAt = undefined;
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
    if (pending.type === "fork_thread" && thread) {
      this.resolveCommand(commandId, this.detail(thread));
      return;
    }
    if (pending.type === "set_goal" || pending.type === "clear_goal") {
      if (pending.type === "clear_goal" && thread) this.appendThreadGoalClearedRecord(thread);
      this.resolveCommand(commandId);
    }
    if (pending.type === "rename_thread") this.resolveCommand(commandId);
  }

  private resolveCommand(commandId: string, value?: unknown) {
    const pending = this.pendingCommands.get(commandId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingCommands.delete(commandId);
    this.commitPendingTurnSettings(commandId);
    pending.resolve(value);
  }

  private rejectCommand(commandId: string | undefined, error: Error) {
    if (!commandId) return;
    this.pendingTurnSettingsCommits.delete(commandId);
    const pending = this.pendingCommands.get(commandId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingCommands.delete(commandId);
    pending.reject(error);
  }

  private commitPendingTurnSettings(commandId: string) {
    const pending = this.pendingTurnSettingsCommits.get(commandId);
    if (!pending) return;
    this.pendingTurnSettingsCommits.delete(commandId);
    const { thread, options, threadOptionsAtStart, settingsRevisionAtStart } = pending;
    // A successful command may settle either through an explicit command result
    // or through turn completion. Commit before resolving its promise so queued
    // turns cannot snapshot stale settings, while newer authoritative/local state wins.
    if (
      this.threads.get(thread.threadId) !== thread
      || thread.threadOptions !== threadOptionsAtStart
      || (this.threadSettingsRevisions.get(thread.threadId) ?? 0) !== settingsRevisionAtStart
    ) {
      return;
    }
    thread.threadOptions = applyThreadRunOptions(thread.threadOptions, options);
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
  }

  private failSessionApprovals(sessionId: string, message: string) {
    for (const approval of [...this.pendingApprovals.values()]) {
      if (approval.sessionId !== sessionId || approval.status !== "pending") continue;
      this.pendingApprovals.delete(approval.approvalId);
      const thread = this.threads.get(approval.threadId);
      if (!thread) continue;
      this.upsertRecord(thread, approvalRecord({ ...approval, status: "failed" }, message));
    }
  }

  private failSessionUserInputs(sessionId: string, message: string) {
    for (const userInput of [...this.pendingUserInputs.values()]) {
      if (userInput.sessionId !== sessionId || userInput.status !== "pending") continue;
      this.pendingUserInputs.delete(userInput.userInputId);
      const thread = this.threads.get(userInput.threadId);
      if (!thread) continue;
      this.upsertRecord(thread, userInputRecord({ ...userInput, status: "failed" }, message));
    }
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
    this.failSessionApprovals(session.sessionId, message);
    this.failSessionUserInputs(session.sessionId, message);
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
    this.failSessionApprovals(session.sessionId, message);
    this.failSessionUserInputs(session.sessionId, message);
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
    const title = appThread ? appServerThreadTitle(appThread) ?? threadId : threadId;
    const thread: ThreadState = {
      threadId,
      workingDirectory,
      sessionId: session.sessionId,
      threadOptions: { ...this.defaultThreadOptions },
      goalRunPolicy: null,
      goalRunPolicyObjective: undefined,
      goalRunPolicyStatus: undefined,
      goalRunPolicyTurnActive: false,
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

    // 这里把 JSON-RPC 响应和 app-server 通知都归一成 CodexHub records。
    const result = asRecord(record.result);
    const resultThread = asRecord(result?.thread);
    if (resultThread) {
      this.applyAppServerThread(thread, resultThread);
      this.applyAppServerThreadTurns(thread, resultThread, { historicalRecords: true });
    }
    const resultGoal = asRecord(result?.goal);
    if (resultGoal) this.appendThreadGoalUpdatedRecord(thread, { threadId: thread.threadId, goal: resultGoal });

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

    if (method === "thread/name/updated") {
      const title = typeof params.threadName === "string" ? params.threadName : "";
      this.applyThreadTitle(thread, title);
      return;
    }

    if (method === "thread/goal/updated") {
      this.appendThreadGoalUpdatedRecord(thread, params);
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
      if (thread.goalRunPolicyTurnActive) this.pauseGoalRunPolicy(thread);
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
    const previousTurnRecords = new Map<string, CodexRecord>();
    thread.records = thread.records.filter((record) => {
      const turnId = turnIdFromAppRecordId(thread.threadId, record.id);
      if (!turnId || !turnIds.has(turnId) || isStatusUsageRecord(record)) return true;
      previousTurnRecords.set(record.id, record);
      return false;
    });
    thread.recordSeq = thread.records.reduce((max, record) => (
      typeof record.order === "number" && record.order > max ? record.order : max
    ), 0);
    for (const turnRecord of turnRecords) {
      this.applyAppServerTurn(thread, turnRecord, { historicalRecords: true, previousTurnRecords });
    }
    repositionStatusUsageRecords(thread);
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
    options: {
      replaceTurnRecords?: boolean;
      historicalRecords?: boolean;
      previousTurnRecords?: ReadonlyMap<string, CodexRecord>;
    } = {}
  ) {
    // 这里把 app-server turn 统一展开成 records；来源可以是历史快照或实时完成事件。
    const turnId = typeof turn.id === "string" ? turn.id : "";
    if (!turnId) return;
    let previousTurnRecords = options.previousTurnRecords;
    if (options.replaceTurnRecords) {
      let mutablePreviousTurnRecords: Map<string, CodexRecord> | undefined;
      thread.records = thread.records.filter((record) => {
        if (turnIdFromAppRecordId(thread.threadId, record.id) !== turnId) return true;
        if (isStatusUsageRecord(record)) return true;
        mutablePreviousTurnRecords ??= new Map(previousTurnRecords);
        mutablePreviousTurnRecords.set(record.id, record);
        return false;
      });
      if (mutablePreviousTurnRecords) previousTurnRecords = mutablePreviousTurnRecords;
      thread.recordSeq = thread.records.reduce((max, record) => (
        typeof record.order === "number" && record.order > max ? record.order : max
      ), 0);
    }
    const lifecycleRecords = codexRecordsFromAppServerTurnLifecycle(thread.threadId, turnId, turn);
    for (const record of lifecycleRecords.filter(isTaskStartedRecord)) {
      this.upsertRecord(thread, record, { historical: options.historicalRecords });
    }
    const timestamp = timestampFromSeconds(turn.completedAt) ?? timestampFromSeconds(turn.startedAt);
    const turnStatus = typeof turn.status === "string"
      ? turn.status
      : timestampFromSeconds(turn.completedAt) ? "completed" : undefined;
    if (Array.isArray(turn.items)) {
      for (const item of turn.items) {
        const itemRecord = asRecord(item);
        const rawRecord = itemRecord
          ? codexRecordFromAppServerItem(thread.threadId, turnId, itemRecord, timestamp, turnStatus)
          : null;
        const record = itemRecord
          ? withAppServerItemRecordTiming(rawRecord, { item: itemRecord, existing: rawRecord ? previousTurnRecords?.get(rawRecord.id) : undefined })
          : null;
        if (record) this.upsertRecord(thread, record, { historical: options.historicalRecords });
      }
    }
    for (const record of lifecycleRecords.filter(isTaskCompleteRecord)) {
      this.upsertRecord(thread, record, { historical: options.historicalRecords });
    }
    if (options.replaceTurnRecords) repositionStatusUsageRecords(thread);
  }

  private applyAppServerItemEvent(thread: ThreadState, params: Record<string, unknown>, fallbackStatus?: string) {
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    const item = asRecord(params.item);
    if (!turnId || !item) return;
    const timestamp = timestampFromMillis(params.timestamp) ?? timestampFromSeconds(params.createdAt);
    const record = codexRecordFromAppServerItem(thread.threadId, turnId, item, timestamp, fallbackStatus);
    if (!record) return;
    const existing = thread.records.find((item) => item.id === record.id);
    const timedRecord = withAppServerItemRecordTiming(record, { item, existing }) ?? record;
    this.upsertRecord(thread, {
      ...timedRecord,
      timestamp: timedRecord.timestamp ?? existing?.timestamp ?? new Date().toISOString()
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
    const statusRecord = statusUsageRecordFromAppServerUsage(thread, turnId, usage);
    if (statusRecord) this.upsertRecord(thread, statusRecord);
  }

  private applyAppServerThread(thread: ThreadState, appThread: Record<string, unknown>) {
    let changed = false;
    if (typeof appThread.cwd === "string" && thread.workingDirectory !== appThread.cwd) {
      thread.workingDirectory = appThread.cwd;
      changed = true;
    }
    const title = appServerThreadTitle(appThread);
    if (title && thread.title !== title) {
      thread.title = title;
      changed = true;
    }
    if (changed) {
      thread.updatedAt = new Date().toISOString();
      this.publish(thread, "thread");
    }
    if (!hasOwn(appThread, "goal")) return;
    const goal = asRecord(appThread.goal);
    if (goal) {
      this.appendThreadGoalUpdatedRecord(thread, { threadId: thread.threadId, goal }, { historical: true });
      return;
    }
    this.appendThreadGoalClearedRecord(thread, { threadId: thread.threadId }, { ifKnownGoal: true });
  }

  private applyThreadTitle(thread: ThreadState, title: string) {
    const nextTitle = compactThreadTitle(title);
    if (!nextTitle || thread.title === nextTitle) return;
    thread.title = nextTitle;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
  }

  private applyThreadSettings(
    thread: ThreadState,
    model: string | null | undefined,
    modelReasoningEffort: ThreadOptions["modelReasoningEffort"] | null | undefined,
    serviceTier: ThreadOptions["serviceTier"] | null | undefined,
    approvalPolicy: ThreadOptions["approvalPolicy"] | null | undefined,
    sandboxPolicy: ThreadOptions["sandboxPolicy"] | null | undefined
  ) {
    let changed = false;
    const nextModel = typeof model === "string" && model ? model : undefined;
    if (thread.threadOptions.model !== nextModel) {
      thread.threadOptions = { ...thread.threadOptions, model: nextModel };
      if (!nextModel) delete thread.threadOptions.model;
      changed = true;
    }
    const nextEffort = isModelReasoningEffort(modelReasoningEffort) ? modelReasoningEffort : undefined;
    if (thread.threadOptions.modelReasoningEffort !== nextEffort) {
      thread.threadOptions = { ...thread.threadOptions, modelReasoningEffort: nextEffort };
      if (!nextEffort) delete thread.threadOptions.modelReasoningEffort;
      changed = true;
    }
    const nextServiceTier = typeof serviceTier === "string" && serviceTier ? serviceTier : undefined;
    if (thread.threadOptions.serviceTier !== nextServiceTier) {
      thread.threadOptions = { ...thread.threadOptions, serviceTier: nextServiceTier };
      if (!nextServiceTier) delete thread.threadOptions.serviceTier;
      changed = true;
    }
    if (approvalPolicy !== undefined) {
      const nextApprovalPolicy = isThreadApprovalPolicy(approvalPolicy) ? approvalPolicy : undefined;
      if (thread.threadOptions.approvalPolicy !== nextApprovalPolicy) {
        thread.threadOptions = { ...thread.threadOptions, approvalPolicy: nextApprovalPolicy };
        if (!nextApprovalPolicy) delete thread.threadOptions.approvalPolicy;
        changed = true;
      }
    }
    if (sandboxPolicy !== undefined) {
      const nextSandboxPolicy = isThreadSandboxPolicy(sandboxPolicy) ? sandboxPolicy : undefined;
      if (JSON.stringify(thread.threadOptions.sandboxPolicy) !== JSON.stringify(nextSandboxPolicy)) {
        thread.threadOptions = { ...thread.threadOptions, sandboxPolicy: nextSandboxPolicy };
        if (!nextSandboxPolicy) delete thread.threadOptions.sandboxPolicy;
        changed = true;
      }
    }
    if (!changed) return;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
  }

  private applyThreadExecutionState(thread: ThreadState, running: boolean, turnId?: string) {
    // 这里的 running 状态是控制面摘要；transcript records 仍由 app-server events 单独写入。
    if (!running) {
      if (thread.running || this.activeTurnCommands.has(thread.threadId)) {
        this.finishSessionTurn(thread);
        return;
      }
      if (thread.appServerTurnId !== undefined || thread.activeTurnStartedAt !== undefined) {
        thread.appServerTurnId = undefined;
        thread.activeTurnStartedAt = undefined;
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
    if (!thread.activeTurnStartedAt) {
      thread.activeTurnStartedAt = new Date().toISOString();
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

  private appendHubRecord(
    thread: ThreadState,
    type: string,
    payload: unknown,
    timestamp = new Date().toISOString(),
    options: { historical?: boolean } = {}
  ) {
    const record: CodexRecord = {
      id: `proxy:${randomUUID()}`,
      timestamp,
      type,
      payload,
      order: ++thread.recordSeq,
      sourceThreadId: thread.threadId
    };
    thread.records.push(record);
    thread.records = orderThreadRecords(thread.records);
    thread.updatedAt = record.timestamp ?? thread.updatedAt;
    this.publish(thread, "record", record, { historical: options.historical });
  }

  private appendThreadGoalUpdatedRecord(
    thread: ThreadState,
    payload: Record<string, unknown> = {},
    options: { historical?: boolean } = {}
  ) {
    const rawGoal = asRecord(payload.goal) ?? payload;
    const threadId = threadGoalThreadId(payload, rawGoal) ?? thread.threadId;
    const latest = this.latestThreadGoalRecord(thread, threadId);
    const previousGoal = latest?.type === "thread_goal_updated"
      ? asRecord(latest.payload?.goal)
      : null;
    const inheritedGoalFields: Record<string, unknown> = {};
    if (!hasOwn(rawGoal, "objective") && typeof previousGoal?.objective === "string") {
      inheritedGoalFields.objective = previousGoal.objective;
    }
    if (!hasOwn(rawGoal, "tokenBudget") && typeof previousGoal?.tokenBudget === "number") {
      inheritedGoalFields.tokenBudget = previousGoal.tokenBudget;
    }
    if (!hasOwn(rawGoal, "token_budget") && typeof previousGoal?.token_budget === "number") {
      inheritedGoalFields.token_budget = previousGoal.token_budget;
    }
    const goal: Record<string, unknown> = {
      ...inheritedGoalFields,
      ...rawGoal,
      threadId,
      ...(typeof rawGoal.status === "string" ? {} : { status: "active" })
    };
    if (thread.goalRunPolicy && threadId === thread.threadId) {
      const objective = typeof goal.objective === "string" ? goal.objective.trim() : "";
      if (objective) thread.goalRunPolicyObjective = objective;
      if (typeof goal.status === "string" && goal.status) thread.goalRunPolicyStatus = goal.status;
    }
    if (this.latestThreadGoalMatches(thread, threadId, goal)) return;
    this.appendHubRecord(thread, "event_msg", {
      ...payload,
      type: "thread_goal_updated",
      threadId,
      goal,
      message: typeof payload.message === "string" ? payload.message : formatThreadGoalMessage(goal)
    }, threadGoalTimestamp(payload, goal), { historical: options.historical });
  }

  private appendThreadGoalClearedRecord(
    thread: ThreadState,
    payload: Record<string, unknown> = {},
    options: { ifKnownGoal?: boolean } = {}
  ) {
    const threadId = threadGoalThreadId(payload, null) ?? thread.threadId;
    const latest = this.latestThreadGoalRecord(thread, threadId);
    if (options.ifKnownGoal && !latest) return;
    if (latest?.type === "thread_goal_cleared") return;
    if (threadId === thread.threadId) {
      thread.goalRunPolicy = null;
      thread.goalRunPolicyObjective = undefined;
      thread.goalRunPolicyStatus = undefined;
      thread.skipNextGoalRunPolicyRun = false;
    }
    this.appendHubRecord(thread, "event_msg", {
      ...payload,
      type: "thread_goal_cleared",
      threadId,
      message: typeof payload.message === "string" ? payload.message : "Goal cleared"
    }, threadGoalTimestamp(payload, null));
  }

  private latestThreadGoalMatches(thread: ThreadState, threadId: string, goal: Record<string, unknown>) {
    const latest = this.latestThreadGoalRecord(thread, threadId);
    if (!latest || latest.type !== "thread_goal_updated") return false;
    return threadGoalsEqual(asRecord(latest.payload?.goal), goal);
  }

  private latestThreadGoalRecord(thread: ThreadState, threadId: string) {
    for (let index = thread.records.length - 1; index >= 0; index -= 1) {
      const payload = asRecord(thread.records[index].payload);
      const type = typeof payload?.type === "string" ? payload.type : "";
      if (type !== "thread_goal_updated" && type !== "thread_goal_cleared") continue;
      const goal = asRecord(payload?.goal);
      if (!threadGoalRecordMatchesThread(payload, goal, threadId)) continue;
      return { type, payload };
    }
    return null;
  }

  private latestRunnableThreadGoal(thread: ThreadState) {
    const latest = this.latestThreadGoalRecord(thread, thread.threadId);
    if (!latest || latest.type !== "thread_goal_updated") return null;
    const goal = asRecord(latest.payload?.goal);
    const objective = typeof goal?.objective === "string" ? goal.objective.trim() : "";
    const status = typeof goal?.status === "string" ? goal.status : "active";
    if (!objective) return null;
    return { objective, status };
  }

  private weeklyRemainingPercent(thread: ThreadState) {
    const limit = rateLimitUsageForWindowMinutes(thread.threadUsage, sevenDayRateLimitWindowMinutes)
      ?? rateLimitUsageForWindowMinutes(
        this.sessions.get(thread.sessionId ?? "")?.accountRateLimits,
        sevenDayRateLimitWindowMinutes
      )
      ?? null;
    if (!limit || !Number.isFinite(limit.usedPercent)) return null;
    return Math.max(0, Math.min(100, 100 - limit.usedPercent));
  }

  private maybeRetargetGoalRunPolicyForWeeklyLimit(thread: ThreadState) {
    if (!thread.running) return false;
    const policy = thread.goalRunPolicy;
    if (!policy || policy.type !== "consumeUntilWeeklyRemainingAtOrBelow") return false;
    const goal = this.latestRunnableThreadGoal(thread);
    const status = thread.goalRunPolicyStatus ?? goal?.status ?? "active";
    const objective = thread.goalRunPolicyObjective ?? goal?.objective;
    if (!objective || !goalRunPolicyStatusCanRun(status, thread.goalRunPolicyTurnActive)) return false;
    const weeklyRemainingPercent = this.weeklyRemainingPercent(thread);
    if (weeklyRemainingPercent === null || weeklyRemainingPercent > policy.targetRemainingPercent) return false;
    return this.retargetGoalRunPolicyToWrapUp(thread, weeklyRemainingPercent, policy.targetRemainingPercent);
  }

  private retargetGoalRunPolicyToWrapUp(
    thread: ThreadState,
    weeklyRemainingPercent: number,
    targetRemainingPercent: number
  ) {
    const session = this.requireThreadSession(thread);
    const commandId = randomUUID();
    const goal: ThreadGoalUpdate = {
      objective: weeklyGoalWrapUpObjective,
      status: "active",
      runPolicy: null
    };
    const appServerGoal = appServerGoalUpdate(goal);
    const promise = this.waitForCommand<void>(commandId, "set_goal", thread.threadId, undefined, thread.workingDirectory);
    thread.goalRunPolicy = null;
    thread.goalRunPolicyObjective = undefined;
    thread.goalRunPolicyStatus = undefined;
    thread.skipNextGoalRunPolicyRun = false;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, "thread");
    this.enqueueSessionCommand(session.sessionId, {
      commandId,
      type: "set_goal",
      workingDirectory: thread.workingDirectory,
      createdAt: new Date().toISOString(),
      threadId: thread.threadId,
      goal: appServerGoal
    });
    void promise.then(() => {
      this.appendThreadGoalUpdatedRecord(thread, {
        threadId: thread.threadId,
        goal: appServerGoal,
        message: `7d remaining ${formatPercent(weeklyRemainingPercent)} reached target ${formatPercent(targetRemainingPercent)}; switching goal to wrap-up.`
      });
    }, (error) => {
      this.appendHubRecord(thread, "error", {
        type: "error",
        message: `Failed to switch 7d goal to wrap-up: ${errorText(error)}`
      });
    });
    return true;
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
    // 快照、增量和补全事件可能指向同一条记录，这里负责去重、保序和更新 usage。
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
    if (!options.historical) this.maybeRetargetGoalRunPolicyForWeeklyLimit(thread);
  }

  private finishSessionTurnByThread(threadId: string, error?: Error) {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    if (error) this.appendHubRecord(thread, "error", { type: "error", message: error.message });
    this.finishSessionTurn(thread, error);
  }

  private finishSessionTurn(thread: ThreadState, error?: Error) {
    // 每个 turn 收尾时先兑现等待中的 command，再释放同 thread 的下一条 queued turn。
    const commandId = this.activeTurnCommands.get(thread.threadId);
    const wasGoalRunPolicyTurn = Boolean(thread.goalRunPolicyTurnActive);
    thread.goalRunPolicyTurnActive = false;
    if (error && wasGoalRunPolicyTurn) this.pauseGoalRunPolicy(thread);
    if (commandId) {
      this.activeTurnCommands.delete(thread.threadId);
      if (error) this.rejectCommand(commandId, error);
      else this.resolveCommand(commandId);
    }
    const wasRunning = thread.running;
    thread.running = false;
    thread.appServerTurnId = undefined;
    thread.activeTurnStartedAt = undefined;
    thread.updatedAt = new Date().toISOString();
    this.publish(thread, wasRunning ? "done" : "thread");
    const startedQueuedTurn = this.startNextQueuedTurn(thread);
    if (!startedQueuedTurn && !error) {
      this.maybeStartGoalRunPolicyTurn(thread, { allowCompletedPolicyTurn: wasGoalRunPolicyTurn });
    }
  }

  private startNextQueuedTurn(thread: ThreadState): boolean {
    if (thread.running) return false;
    const queue = this.queuedTurns.get(thread.threadId);
    const next = queue?.shift();
    if (!queue || !next) {
      this.queuedTurns.delete(thread.threadId);
      return false;
    }
    if (!queue.length) this.queuedTurns.delete(thread.threadId);
    try {
      this.startTurn(thread, next.input, next.source, next.options).then(next.resolve, next.reject);
      return true;
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)));
      return this.startNextQueuedTurn(thread);
    }
  }

  private maybeStartGoalRunPolicyTurn(
    thread: ThreadState,
    options: {
      allowUnknownUsage?: boolean;
      fallbackObjective?: string;
      statusOverride?: ThreadGoalStatus;
      allowCompletedPolicyTurn?: boolean;
    } = {}
  ) {
    if (thread.running || thread.skipNextGoalRunPolicyRun) {
      thread.skipNextGoalRunPolicyRun = false;
      return false;
    }
    const policy = thread.goalRunPolicy;
    if (!policy || policy.type !== "consumeUntilWeeklyRemainingAtOrBelow") return false;
    const goal = this.latestRunnableThreadGoal(thread);
    const status = options.statusOverride ?? thread.goalRunPolicyStatus ?? goal?.status ?? "active";
    const objective = thread.goalRunPolicyObjective ?? goal?.objective ?? options.fallbackObjective?.trim();
    if (!objective || !goalRunPolicyStatusCanRun(status, options.allowCompletedPolicyTurn)) return false;
    if (policy.targetRemainingPercent >= 100) return false;
    const weeklyRemainingPercent = this.weeklyRemainingPercent(thread);
    if (weeklyRemainingPercent === null && !options.allowUnknownUsage) return false;
    if (weeklyRemainingPercent !== null && weeklyRemainingPercent <= policy.targetRemainingPercent) return false;
    try {
      thread.goalRunPolicyTurnActive = true;
      this.startTurn(thread, objective, "web", {
        goalMode: true,
        goalObjective: objective
      }).catch(() => {
        this.pauseGoalRunPolicy(thread);
      });
      return true;
    } catch (error) {
      thread.goalRunPolicyTurnActive = false;
      this.pauseGoalRunPolicy(thread);
      return false;
    }
  }

  private pauseGoalRunPolicy(thread: ThreadState) {
    if (!thread.goalRunPolicy) return;
    const goal = this.latestRunnableThreadGoal(thread);
    const objective = thread.goalRunPolicyObjective ?? goal?.objective;
    if (!objective) return;
    thread.goalRunPolicyStatus = "paused";
    this.appendThreadGoalUpdatedRecord(thread, {
      threadId: thread.threadId,
      goal: {
        objective,
        status: "paused"
      },
      message: "Goal paused"
    });
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
    this.options.onThreadEvent?.(streamEvent, thread.records);
    this.options.onThreadChange?.();
  }

  private summary(thread: ThreadState): ThreadSummary {
    return {
      threadId: thread.threadId,
      workingDirectory: thread.workingDirectory,
      model: thread.threadOptions.model,
      modelReasoningEffort: thread.threadOptions.modelReasoningEffort,
      serviceTier: thread.threadOptions.serviceTier,
      approvalPolicy: thread.threadOptions.approvalPolicy,
      sandboxPolicy: thread.threadOptions.sandboxPolicy,
      session: this.threadSessionSummary(thread),
      status: thread.running ? "running" : "idle",
      running: thread.running,
      ...(thread.running && thread.activeTurnStartedAt ? { activeTurnStartedAt: thread.activeTurnStartedAt } : {}),
      title: thread.title,
      updatedAt: thread.updatedAt,
      messageCount: recordsToViews(thread.records).length,
      lastUsage: thread.lastUsage,
      threadUsage: thread.threadUsage,
      goalRunPolicy: thread.goalRunPolicy ?? null
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

  private threadAccountRateLimits(thread: ThreadState): ThreadRateLimits | null {
    const session = thread.sessionId ? this.sessions.get(thread.sessionId) : null;
    if (session?.accountRateLimits) return session.accountRateLimits;
    const replacement = this.uniqueOnlineSessionForWorkspace(thread.workingDirectory);
    return replacement?.accountRateLimits ?? session?.accountRateLimits ?? null;
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
  if (typeof record?.threadId === "string") return record.threadId;
  const thread = asRecord(record?.thread);
  return typeof thread?.id === "string" ? thread.id : undefined;
};

const appServerThreadFromMessage = (message: Record<string, unknown>) => {
  const params = asRecord(message.params);
  const result = asRecord(message.result);
  return asRecord(result?.thread) ?? asRecord(params?.thread);
};

const forkTargetAfterRecord = (thread: ThreadState, recordId: string) => {
  const targetTurnId = turnIdFromAppRecordId(thread.threadId, recordId);
  if (!targetTurnId) throw new Error(`Cannot fork from record without app-server turn id: ${recordId}`);
  const turnIds = appServerTurnIds(thread);
  const targetIndex = turnIds.indexOf(targetTurnId);
  if (targetIndex === -1) throw new Error(`Cannot find fork target turn for record: ${recordId}`);
  return {
    lastTurnId: targetTurnId,
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

const summarizeInput = (input: ProxyInput) => {
  if (typeof input === "string") return input;
  return input
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
};

const compactThreadTitle = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 80);

const appServerThreadTitle = (thread: Record<string, unknown>) => {
  const name = typeof thread.name === "string" ? compactThreadTitle(thread.name) : "";
  if (name) return name;
  const preview = typeof thread.preview === "string" ? compactThreadTitle(thread.preview) : "";
  return preview || undefined;
};

const imageUrls = (input: ProxyInput) => {
  if (typeof input === "string") return [];
  return input
    .filter((item) => item.type === "image")
    .map((item) => item.url);
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const isThreadApprovalPolicy = (value: unknown): value is ThreadOptions["approvalPolicy"] =>
  value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never";

const isThreadSandboxPolicy = (value: unknown): value is ThreadOptions["sandboxPolicy"] => {
  const policy = asRecord(value);
  if (!policy || typeof policy.type !== "string") return false;
  if (policy.type === "dangerFullAccess") return true;
  if (policy.type === "readOnly") return typeof policy.networkAccess === "boolean";
  if (policy.type === "externalSandbox") return policy.networkAccess === "restricted" || policy.networkAccess === "enabled";
  if (policy.type !== "workspaceWrite") return false;
  return Array.isArray(policy.writableRoots)
    && policy.writableRoots.every((item) => typeof item === "string" && item.length > 0)
    && typeof policy.networkAccess === "boolean"
    && typeof policy.excludeTmpdirEnvVar === "boolean"
    && typeof policy.excludeSlashTmp === "boolean";
};

const turnCommandTimeoutMs = () => {
  const raw = process.env.CODEX_HUB_TURN_TIMEOUT_MS?.trim();
  if (!raw) return null;
  const timeoutMs = Number(raw);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
};

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const stickyThreadRunOptionKeys = [
  "model",
  "modelReasoningEffort",
  "serviceTier",
  "approvalPolicy",
  "sandboxPolicy"
] as const;

const hasStickyThreadRunOptions = (options: ThreadRunOptions) =>
  stickyThreadRunOptionKeys.some((key) => hasOwn(options, key));

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
  if (hasOwn(options, "serviceTier")) {
    if (options.serviceTier) next.serviceTier = options.serviceTier;
    else delete next.serviceTier;
  }
  if (hasOwn(options, "approvalPolicy")) {
    if (isThreadApprovalPolicy(options.approvalPolicy)) next.approvalPolicy = options.approvalPolicy;
    else delete next.approvalPolicy;
  }
  if (hasOwn(options, "sandboxPolicy")) {
    if (isThreadSandboxPolicy(options.sandboxPolicy)) next.sandboxPolicy = options.sandboxPolicy;
    else delete next.sandboxPolicy;
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
