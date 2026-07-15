import type { ProxyInput } from "../shared/inputTypes.js";
import type {
  AppServerApprovalDecision,
  AppServerUserInputAnswers,
  SessionCommand,
  ThreadGoalUpdate,
  ThreadRunOptions
} from "../shared/threadTypes.js";

type CommandContext = { commandId?: string; threadId?: string };

type LoadedThread = {
  threadId: string;
  thread?: Record<string, unknown>;
};

export type AppServerCommandHost = {
  defaultModel?: string;
  permissionParams: Record<string, unknown>;
  listThreads: (cwd: string, limit?: number) => Promise<unknown>;
  listModels: (includeHidden: boolean) => Promise<unknown>;
  listCommandPalette: (cwd: string, part: SessionCommand["commandPalettePart"]) => Promise<unknown>;
  bindThread: (threadId: string, cwd: string) => void;
  unbindThread: (threadId: string) => void;
  syncThreadTurns: (threadId: string) => Promise<void>;
  startThread: (cwd: string, model: string | null | undefined, command: CommandContext) => Promise<unknown>;
  loadThread: (
    threadId: string,
    cwd: string,
    model: string | null | undefined,
    command?: CommandContext,
    options?: { markBridgeStarted?: boolean }
  ) => Promise<LoadedThread>;
  ensureThreadLoaded: (
    threadId: string,
    cwd: string,
    model?: string | null,
    command?: CommandContext,
    options?: { markBridgeStarted?: boolean }
  ) => Promise<string>;
  rememberDefaultThread: (threadId: string) => Promise<void>;
  request: (method: string, params: unknown, command?: CommandContext) => Promise<unknown>;
  scheduleThreadSync: (threadId: string) => void;
  forwardThreadExecutionChanged: (threadId: string, running: boolean, turnId?: string) => Promise<void>;
  resolveApprovalRequest: (approvalId: string, decision: AppServerApprovalDecision) => void;
  resolveUserInputRequest: (userInputId: string, answers: AppServerUserInputAnswers) => void;
  markBridgeStartedUnknownThread: () => void;
  markThreadLoaded: (threadId: string) => void;
  markBridgeStartedThread: (threadId: string) => void;
};

export const dispatchAppServerCommand = async (command: SessionCommand, host: AppServerCommandHost) => {
  if (command.type === "list_threads") {
    return { threads: await host.listThreads(command.workingDirectory, command.limit) };
  }
  if (command.type === "list_models") {
    return { models: await host.listModels(Boolean(command.includeHidden)) };
  }
  if (command.type === "list_command_palette") {
    return { palette: await host.listCommandPalette(command.workingDirectory, command.commandPalettePart) };
  }
  if (command.type === "subscribe_thread_records") {
    const threadId = requireThreadId(command);
    host.bindThread(threadId, command.workingDirectory);
    await host.syncThreadTurns(threadId);
    return;
  }
  if (command.type === "unsubscribe_thread_records") {
    host.unbindThread(requireThreadId(command));
    return;
  }
  if (command.type === "start_thread") {
    return await host.startThread(command.workingDirectory, modelForCommand(command, host.defaultModel), command);
  }
  if (command.type === "resume_thread") {
    const resumed = await host.loadThread(
      requireThreadId(command),
      command.workingDirectory,
      modelForCommand(command, host.defaultModel),
      command,
      { markBridgeStarted: true }
    );
    await host.rememberDefaultThread(resumed.threadId);
    return resumed;
  }
  if (command.type === "stop") {
    if (command.threadId && command.turnId) {
      await host.ensureThreadLoaded(
        command.threadId,
        command.workingDirectory,
        modelForCommand(command, host.defaultModel),
        undefined,
        { markBridgeStarted: true }
      );
      await host.request("turn/interrupt", { threadId: command.threadId, turnId: command.turnId }, command);
    }
    return;
  }
  if (command.type === "rename_thread") {
    const threadId = requireThreadId(command);
    const name = typeof command.title === "string" ? command.title.trim() : "";
    if (!name) throw new Error("rename_thread command requires title");
    await host.request("thread/name/set", { threadId, name }, command);
    return;
  }
  if (command.type === "compact_thread") {
    const threadId = await ensureCommandThread(command, host);
    await host.request("thread/compact/start", { threadId }, command);
    host.scheduleThreadSync(threadId);
    return { ok: true };
  }
  if (command.type === "review_thread") {
    const threadId = await ensureCommandThread(command, host);
    const result = asRecord(await host.request("review/start", {
      threadId,
      target: command.reviewTarget ?? { type: "uncommittedChanges" },
      delivery: "inline"
    }, command));
    const turn = asRecord(result?.turn);
    await host.forwardThreadExecutionChanged(threadId, true, stringValue(turn?.id));
    host.scheduleThreadSync(threadId);
    return {
      ok: true,
      reviewThreadId: stringValue(result?.reviewThreadId) ?? threadId
    };
  }
  if (command.type === "approval_decision") {
    if (!command.approvalId) throw new Error("approval_decision command requires approvalId");
    if (!command.approvalDecision) throw new Error("approval_decision command requires approvalDecision");
    host.resolveApprovalRequest(command.approvalId, command.approvalDecision);
    return { ok: true };
  }
  if (command.type === "user_input_response") {
    if (!command.userInputId) throw new Error("user_input_response command requires userInputId");
    host.resolveUserInputRequest(command.userInputId, command.userInputAnswers ?? {});
    return { ok: true };
  }
  if (command.type === "steer") {
    if (!command.turnId) throw new Error("steer command requires active turnId");
    if (!command.input) throw new Error("steer command requires input");
    const threadId = await ensureCommandThread(command, host, { passCommand: false });
    await host.request("turn/steer", {
      threadId,
      expectedTurnId: command.turnId,
      input: toAppServerInput(command.input)
    }, command);
    return;
  }
  if (command.type === "set_goal") {
    const threadId = await ensureCommandThread(command, host);
    await host.request("thread/goal/set", {
      threadId,
      ...goalUpdateParams(command.goal, command.input, command.options)
    }, command);
    return;
  }
  if (command.type === "clear_goal") {
    const threadId = await ensureCommandThread(command, host);
    await host.request("thread/goal/clear", { threadId }, command);
    return;
  }
  if (command.type === "fork_thread") {
    const sourceThreadId = requireThreadId(command);
    const model = modelForCommand(command, host.defaultModel);
    await host.ensureThreadLoaded(sourceThreadId, command.workingDirectory, model, undefined, {
      markBridgeStarted: true
    });
    host.markBridgeStartedUnknownThread();
    const result = asRecord(await host.request("thread/fork", {
      threadId: sourceThreadId,
      cwd: command.workingDirectory,
      ...(model === undefined ? {} : { model }),
      ...host.permissionParams,
      threadSource: "user"
    }, command));
    const thread = asRecord(result?.thread);
    const threadId = stringValue(thread?.id);
    if (!threadId) throw new Error("Codex app-server thread/fork did not return thread.id");
    host.markThreadLoaded(threadId);
    return;
  }
  if (command.type === "rollback_thread") {
    const threadId = requireThreadId(command);
    if (!command.numTurns || command.numTurns < 1) {
      throw new Error("rollback_thread command requires numTurns >= 1");
    }
    await host.ensureThreadLoaded(
      threadId,
      command.workingDirectory,
      modelForCommand(command, host.defaultModel),
      undefined,
      { markBridgeStarted: true }
    );
    await host.request("thread/rollback", { threadId, numTurns: command.numTurns }, command);
    host.scheduleThreadSync(threadId);
    return;
  }

  if (!command.input || !command.threadId) return;
  const loadedThreadId = await host.ensureThreadLoaded(
    command.threadId,
    command.workingDirectory,
    modelForCommand(command, host.defaultModel),
    command,
    { markBridgeStarted: true }
  );
  if (command.options?.goalMode) {
    await host.request("thread/goal/set", {
      threadId: loadedThreadId,
      ...goalUpdateParams(undefined, command.input, command.options)
    }, { threadId: loadedThreadId });
  }
  host.markBridgeStartedThread(loadedThreadId);
  await host.request("turn/start", {
    threadId: loadedThreadId,
    cwd: command.workingDirectory,
    input: toAppServerInput(inputForCollaborationMode(command.input, command.options)),
    ...turnRequestParams(command.options)
  }, command);
};

export const toAppServerInput = (input: ProxyInput) => {
  if (typeof input === "string") return [{ type: "text", text: input, text_elements: [] }];
  return input.map((item) => item.type === "text"
    ? { type: "text", text: item.text, text_elements: [] }
    : { type: "image", url: item.url, ...(item.detail ? { detail: item.detail } : {}) });
};

export const modelForCommand = (command: Pick<SessionCommand, "options">, fallback?: string) => {
  if (command.options && hasOwn(command.options, "model")) return command.options.model;
  return fallback;
};

export const permissionParams = (options: {
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
}) => ({
  ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
  ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox })
});

export const turnRequestParams = (options: ThreadRunOptions | undefined) => {
  const params: Record<string, unknown> = {};
  if (!options) return params;
  if (hasOwn(options, "model")) params.model = options.model;
  if (hasOwn(options, "modelReasoningEffort")) params.effort = options.modelReasoningEffort;
  if (hasOwn(options, "serviceTier")) params.serviceTier = options.serviceTier;
  if (hasOwn(options, "approvalPolicy")) params.approvalPolicy = options.approvalPolicy;
  if (hasOwn(options, "sandboxPolicy")) params.sandboxPolicy = options.sandboxPolicy;
  return params;
};

const ensureCommandThread = async (
  command: SessionCommand,
  host: AppServerCommandHost,
  options: { passCommand?: boolean } = {}
) => host.ensureThreadLoaded(
  requireThreadId(command),
  command.workingDirectory,
  modelForCommand(command, host.defaultModel),
  options.passCommand === false ? undefined : command,
  { markBridgeStarted: true }
);

const requireThreadId = (command: SessionCommand) => {
  if (!command.threadId) throw new Error(`${command.type} command requires threadId`);
  return command.threadId;
};

const inputForCollaborationMode = (input: ProxyInput, options: ThreadRunOptions | undefined): ProxyInput => {
  if (options?.collaborationMode !== "plan") return input;
  const prefix = "Plan mode is active for this turn.";
  if (typeof input === "string") return `${prefix}\n\nUser request:\n${input}`;
  return [{ type: "text", text: prefix }, ...input];
};

const goalUpdateParams = (
  goal: ThreadGoalUpdate | undefined,
  input: ProxyInput | undefined,
  options: ThreadRunOptions | undefined
) => {
  const params: ThreadGoalUpdate = {};
  if (goal && hasOwn(goal, "objective")) params.objective = goal.objective;
  if (goal && hasOwn(goal, "status")) params.status = goal.status;
  if (goal && hasOwn(goal, "tokenBudget")) params.tokenBudget = goal.tokenBudget;
  if (params.objective === undefined && input && options) params.objective = goalObjective(input, options);
  if (params.status === undefined && options?.goalMode) params.status = "active";
  if (params.tokenBudget === undefined && options && hasOwn(options, "goalTokenBudget")) {
    params.tokenBudget = options.goalTokenBudget;
  }
  return params;
};

const goalObjective = (input: ProxyInput, options: ThreadRunOptions) => {
  if (typeof options.goalObjective === "string" && options.goalObjective.trim()) {
    return options.goalObjective.trim();
  }
  const text = typeof input === "string"
    ? input
    : input.filter((item) => item.type === "text").map((item) => item.text).join("\n\n");
  const objective = text.trim();
  return objective ? objective.slice(0, 4000) : "Pursue the attached user request.";
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const stringValue = (value: unknown) => typeof value === "string" ? value : undefined;
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
