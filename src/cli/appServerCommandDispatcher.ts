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

type AppServerThreadSettings = Pick<ThreadRunOptions, "model" | "modelReasoningEffort"> & {
  collaborationMode?: "plan" | "default" | null;
};

export type AppServerCollaborationMode = {
  mode: "plan" | "default";
  settings: {
    model: string;
    reasoning_effort: NonNullable<ThreadRunOptions["modelReasoningEffort"]> | null;
    developer_instructions: null;
  };
};

export type AppServerCommandHost = {
  defaultModel?: string;
  permissionParams: Record<string, unknown>;
  listThreads: (cwd: string, limit?: number) => Promise<unknown>;
  listModels: (includeHidden: boolean) => Promise<unknown>;
  listPermissionProfiles: (cwd: string) => Promise<unknown>;
  listCollaborationModes: () => Promise<unknown>;
  cachedThreadSettings: (threadId: string) => AppServerThreadSettings | undefined;
  readThreadSettings: (cwd: string) => Promise<AppServerThreadSettings>;
  cacheThreadCollaborationMode: (threadId: string, value: AppServerCollaborationMode) => void;
  captureThreadSettingsResponse: (threadId: string, value: unknown) => Promise<void>;
  planResetModes: Map<string, AppServerCollaborationMode>;
  listCommandPalette: (cwd: string, part: SessionCommand["commandPalettePart"]) => Promise<unknown>;
  bindThread: (threadId: string, cwd: string) => void;
  unbindThread: (threadId: string) => Promise<void>;
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
  if (command.type === "list_permission_profiles") {
    return { profiles: await host.listPermissionProfiles(command.workingDirectory) };
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
    await host.unbindThread(requireThreadId(command));
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
      return await host.request("turn/interrupt", { threadId: command.threadId, turnId: command.turnId }, command);
    }
    return {};
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
    const reviewThreadId = stringValue(result?.reviewThreadId);
    const turnId = stringValue(turn?.id);
    if (!reviewThreadId || !turnId) {
      throw new Error("Codex app-server review/start did not return reviewThreadId and turn.id");
    }
    await host.forwardThreadExecutionChanged(threadId, true, turnId);
    host.scheduleThreadSync(threadId);
    return {
      ok: true,
      reviewThreadId
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
    return await host.request("turn/steer", {
      threadId,
      expectedTurnId: command.turnId,
      input: toAppServerInput(command.input)
    }, command);
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
      ...(command.lastTurnId ? { lastTurnId: command.lastTurnId } : {}),
      cwd: command.workingDirectory,
      ...(model === undefined ? {} : { model }),
      ...threadCreationPermissionParams(command.options, host.permissionParams),
      threadSource: "user"
    }, command));
    const thread = asRecord(result?.thread);
    const threadId = stringValue(thread?.id);
    if (!threadId) throw new Error("Codex app-server thread/fork did not return thread.id");
    host.markThreadLoaded(threadId);
    await host.captureThreadSettingsResponse(threadId, result);
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
  const planTurn = command.options?.collaborationMode === "plan";
  const defaultTurn = command.options?.collaborationMode === "default";
  const cachedSettings = host.cachedThreadSettings(loadedThreadId) ?? {};
  const pendingPlanReset = host.planResetModes.get(loadedThreadId);
  if (command.options?.goalMode) {
    await host.request("thread/goal/set", {
      threadId: loadedThreadId,
      ...goalUpdateParams(undefined, command.input, command.options)
    }, { threadId: loadedThreadId });
  }
  host.markBridgeStartedThread(loadedThreadId);
  const params = turnRequestParams(command.options);
  let resetCollaborationMode = pendingPlanReset;
  let explicitDefaultMode: AppServerCollaborationMode | undefined;
  if (planTurn) {
    const clearModelOverride = command.options
      && hasOwn(command.options, "model")
      && command.options.model === null;
    const resetBaseline = pendingPlanReset
      ? {
          model: pendingPlanReset.settings.model,
          modelReasoningEffort: pendingPlanReset.settings.reasoning_effort
        }
      : cachedSettings;
    const currentSettings = await defaultThreadSettings(
      host,
      loadedThreadId,
      command.workingDirectory,
      resetBaseline,
      Boolean(clearModelOverride)
    );
    const modes = await resolveCollaborationModes(host, command.options, currentSettings);
    // A failed reset belongs to the previous Plan turn. Rebuild it so this
    // turn's explicit model/effort (including Auto/null) wins.
    resetCollaborationMode = modes.reset;
    host.planResetModes.set(loadedThreadId, resetCollaborationMode);
    delete params.model;
    delete params.effort;
    params.collaborationMode = modes.plan;
  } else if (defaultTurn) {
    const clearModelOverride = command.options
      && hasOwn(command.options, "model")
      && command.options.model === null;
    const resetBaseline = pendingPlanReset
      ? {
          model: pendingPlanReset.settings.model,
          modelReasoningEffort: pendingPlanReset.settings.reasoning_effort
        }
      : cachedSettings;
    const currentSettings = await defaultThreadSettings(
      host,
      loadedThreadId,
      command.workingDirectory,
      resetBaseline,
      Boolean(clearModelOverride)
    );
    explicitDefaultMode = (await resolveCollaborationModes(
      host,
      command.options,
      currentSettings
    )).reset;
    delete params.model;
    delete params.effort;
    params.collaborationMode = explicitDefaultMode;
  } else if (!resetCollaborationMode && cachedSettings.collaborationMode === "plan") {
    const currentSettings = await defaultThreadSettings(
      host,
      loadedThreadId,
      command.workingDirectory,
      cachedSettings
    );
    const latestSettings = host.cachedThreadSettings(loadedThreadId);
    if (!latestSettings || latestSettings.collaborationMode === "plan") {
      resetCollaborationMode = (await resolveCollaborationModes(
        host,
        command.options,
        currentSettings
      )).reset;
      host.planResetModes.set(loadedThreadId, resetCollaborationMode);
    }
  }
  if (!planTurn && !defaultTurn && resetCollaborationMode) {
    await applyPlanReset(host, loadedThreadId, resetCollaborationMode);
  }
  await host.request("turn/start", {
    threadId: loadedThreadId,
    cwd: command.workingDirectory,
    input: toAppServerInput(command.input),
    ...params
  }, command);
  if (explicitDefaultMode) {
    host.cacheThreadCollaborationMode(loadedThreadId, explicitDefaultMode);
    if (host.planResetModes.get(loadedThreadId) === pendingPlanReset) {
      host.planResetModes.delete(loadedThreadId);
    }
  }
  if (planTurn && resetCollaborationMode) {
    // Plan is a one-turn composer mode, while app-server collaboration mode is
    // sticky. Reset only subsequent turns after the Plan turn has started.
    try {
      await applyPlanReset(host, loadedThreadId, resetCollaborationMode);
    } catch (error) {
      // turn/start already succeeded. Keep the command successful; the next
      // non-Plan turn retries this exact Default mode before starting.
      console.error(`codexhub failed to reset Plan collaboration mode: ${errorText(error)}`);
    }
  }
};

const defaultThreadSettings = async (
  host: AppServerCommandHost,
  threadId: string,
  cwd: string,
  cached: AppServerThreadSettings,
  preferConfig = false
) => {
  if (!preferConfig && cached.collaborationMode !== "plan" && Object.keys(cached).length) return cached;
  const fallback = await host.readThreadSettings(cwd);
  if (preferConfig) {
    return cached.collaborationMode === "plan"
      ? fallback
      : { ...cached, model: fallback.model };
  }
  const latest = host.cachedThreadSettings(threadId);
  return latest?.collaborationMode === "plan" ? fallback : latest ?? fallback;
};

const applyPlanReset = async (
  host: AppServerCommandHost,
  threadId: string,
  reset: AppServerCollaborationMode
) => {
  await host.request("thread/settings/update", { threadId, collaborationMode: reset });
  host.cacheThreadCollaborationMode(threadId, reset);
  if (host.planResetModes.get(threadId) === reset) host.planResetModes.delete(threadId);
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
  approvalPolicy?: "untrusted" | "on-request" | "never";
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
  if (hasOwn(options, "approvalsReviewer")) params.approvalsReviewer = options.approvalsReviewer;
  if (hasOwn(options, "permissions")) {
    params.permissions = options.permissions;
  } else if (hasOwn(options, "sandboxPolicy")) {
    params.sandboxPolicy = options.sandboxPolicy;
  }
  return params;
};

const threadCreationPermissionParams = (
  options: ThreadRunOptions | undefined,
  defaults: Record<string, unknown>
) => {
  const params = { ...defaults };
  if (!options) return params;
  if (hasOwn(options, "approvalPolicy")) params.approvalPolicy = options.approvalPolicy;
  if (hasOwn(options, "approvalsReviewer")) params.approvalsReviewer = options.approvalsReviewer;
  if (hasOwn(options, "permissions")) {
    delete params.sandbox;
    params.permissions = options.permissions;
  }
  return params;
};

const resolveCollaborationModes = async (
  host: AppServerCommandHost,
  options: ThreadRunOptions | undefined,
  currentSettings: AppServerThreadSettings
) => {
  const result = asRecord(await host.listCollaborationModes());
  const masks = (Array.isArray(result?.data) ? result.data : []).map(asRecord);
  const mask = (mode: AppServerCollaborationMode["mode"]) => {
    const selected = masks.find((candidate) => candidate?.mode === mode);
    if (!selected) throw new Error(`Codex app-server collaborationMode/list did not provide ${mode} mode.`);
    return selected;
  };
  const defaultMask = mask("default");
  const planMask = mask("plan");
  const fallbackModel = stringValue(options?.model)
    ?? stringValue(currentSettings.model)
    ?? stringValue(host.defaultModel);
  const models = fallbackModel || [defaultMask, planMask].every((item) => stringValue(item.model))
    ? undefined
    : await host.listModels(false);
  const selectedEffort = options && hasOwn(options, "modelReasoningEffort")
    ? options.modelReasoningEffort
    : currentSettings.modelReasoningEffort;
  const build = (
    mode: AppServerCollaborationMode["mode"],
    selectedMask: Record<string, unknown>
  ): AppServerCollaborationMode => {
    const model = stringValue(selectedMask.model) ?? fallbackModel ?? catalogModel(models);
    if (!model) throw new Error(`${mode} mode requires an app-server mask, selected model, or live default model.`);
    const maskEffort = stringValue(selectedMask.reasoning_effort);
    return {
      mode,
      settings: {
        model,
        reasoning_effort: mode === "plan"
          ? maskEffort ?? selectedEffort ?? null
          : selectedEffort === undefined ? maskEffort ?? null : selectedEffort,
        developer_instructions: null
      }
    };
  };
  return {
    reset: build("default", defaultMask),
    plan: build("plan", planMask)
  };
};

const catalogModel = (value: unknown) => {
  const items = (Array.isArray(value) ? value : [])
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item));
  const selected = items.find((item) => item.isDefault === true) ?? items[0];
  return stringValue(selected?.model);
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
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
