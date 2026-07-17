import { threadUsageFromRecords } from "../../core/threadUsage.js";
export {
  isTaskCompleteRecord,
  taskCompleteNotification,
  taskCompletionNotificationKey
} from "../../shared/taskNotifications.js";
import { asRecord, type CodexRecord, type CodexRecordView } from "../../shared/recordTypes.js";
import { compareCodexRecords, orderCodexRecords, recordTimestampMs } from "../../shared/recordIdentity.js";
import { formatCompactNumber } from "../../shared/toolFormatting.js";
import { isModelReasoningEffort } from "../../shared/usageTypes.js";
export { formatCompactNumber } from "../../shared/toolFormatting.js";
import { isTheiaSurface, isTheiaVscodeHost, isVscodeSurface } from "../appConfig.js";
import type { ActivityStatusFile, ActivityStatusSnapshot, ActivityStatusView, ModelSelection, RateLimitWindow, ReasoningEffort, ReasoningSelection, ServiceTierSelection, SessionRateLimits, StreamEvent, ThreadDetail, ThreadGoalView, ThreadUsage, Usage, WebRecordView } from "../types.js";
import { fileChangePreviewFiles } from "./fileChanges.js";
import { compactLine, rawModelLabel, reasoningDisplayLabel, serviceTierDisplayLabel, turnIdFromAppRecordId } from "./core.js";
import { formatDate, shortId, stringifyInspectJson } from "./common.js";

export const latestThreadUsageFromRecords = (records: CodexRecord[]): ThreadUsage | null => {
  const usage = threadUsageFromRecords(records);
  return usage.context || usage.primaryRateLimit || usage.secondaryRateLimit ? usage : null;
};

export const mergeThreadUsage = (latest: ThreadUsage | null, fallback: ThreadUsage | null): ThreadUsage | null => {
  if (!latest) return fallback;
  if (!fallback) return latest;
  return {
    context: latest.context ?? fallback.context,
    primaryRateLimit: latest.primaryRateLimit ?? fallback.primaryRateLimit,
    secondaryRateLimit: latest.secondaryRateLimit ?? fallback.secondaryRateLimit,
    observedAt: latest.observedAt ?? fallback.observedAt
  };
};

export const threadUsageFromSessionRateLimits = (rateLimits: SessionRateLimits | null | undefined): ThreadUsage | null => {
  if (!rateLimits?.primaryRateLimit && !rateLimits?.secondaryRateLimit) return null;
  return {
    context: null,
    primaryRateLimit: rateLimits.primaryRateLimit,
    secondaryRateLimit: rateLimits.secondaryRateLimit,
    observedAt: rateLimits.observedAt
  };
};

export const latestThreadConfigFromRecords = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const config = threadConfigFromRecord(records[index]);
    if (config.model || config.reasoning) return config;
  }
  return null;
};

export const latestThreadGoalFromRecords = (records: CodexRecord[], threadId?: string): ThreadGoalView | null => {
  const clearedAt = latestThreadGoalClearedAt(records, threadId);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = asRecord(records[index].payload);
    const type = typeof payload?.type === "string" ? payload.type : "";
    if (type === "thread_goal_cleared") {
      if (goalRecordMatchesThread(payload, null, threadId)) return null;
      continue;
    }
    if (type !== "thread_goal_updated") continue;
    if (!payload) return null;
    const goal = asRecord(payload.goal);
    if (!goalRecordMatchesThread(payload, goal, threadId)) continue;
    if (clearedAt !== null) {
      const goalCreatedAt = goalTimeMs(goal?.createdAt) ?? goalTimeMs(goal?.created_at);
      const recordTime = recordTimestampMs(records[index]);
      const isOldGoal = goalCreatedAt !== null ? goalCreatedAt <= clearedAt : recordTime !== null && recordTime <= clearedAt;
      if (isOldGoal) continue;
    }
    const objective = typeof goal?.objective === "string" ? compactLine(goal.objective) : "";
    if (!objective) return null;
    const status = threadGoalStatusFromValue(goal?.status);
    if (status === "complete") return null;
    const tokenBudget = typeof goal?.tokenBudget === "number"
      ? goal.tokenBudget
      : typeof goal?.token_budget === "number"
        ? goal.token_budget
        : undefined;
    const updatedAt = records[index].timestamp
      ?? (typeof goal?.updatedAt === "number" ? new Date(goal.updatedAt * 1000).toISOString() : undefined)
      ?? (typeof goal?.updated_at === "number" ? new Date(goal.updated_at * 1000).toISOString() : undefined);
    return { objective, status, tokenBudget, updatedAt };
  }
  return null;
};

const threadGoalStatusFromValue = (value: unknown): ThreadGoalView["status"] => {
  if (
    value === "active"
    || value === "paused"
    || value === "blocked"
    || value === "usageLimited"
    || value === "budgetLimited"
    || value === "complete"
  ) return value;
  return "active";
};

export const latestThreadGoalClearedAt = (records: CodexRecord[], threadId?: string) => {
  let latest: number | null = null;
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (payload?.type !== "thread_goal_cleared" || !goalRecordMatchesThread(payload, null, threadId)) continue;
    const time = recordTimestampMs(record);
    if (time !== null && (latest === null || time > latest)) latest = time;
  }
  return latest;
};

export const goalRecordMatchesThread = (
  payload: Record<string, unknown> | null,
  goal: Record<string, unknown> | null,
  threadId: string | undefined
) => {
  if (!threadId) return true;
  const payloadThreadId = stringField(payload, "threadId") ?? stringField(payload, "thread_id");
  const goalThreadId = stringField(goal, "threadId") ?? stringField(goal, "thread_id");
  return payloadThreadId === threadId || goalThreadId === threadId || (!payloadThreadId && !goalThreadId);
};

export { recordTimestampMs } from "../../shared/recordIdentity.js";

export const goalTimeMs = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export const threadConfigFromRecord = (record: CodexRecord): { model?: string; reasoning?: ReasoningEffort; serviceTier?: string } => {
  const payload = asRecord(record.payload);
  const payloadType = stringField(payload, "type");
  // Tool records can carry a child agent's model/effort. Only transcript
  // context records describe the parent thread configuration.
  if (payloadType && payloadType !== "turn_context" && payloadType !== "session_meta") return {};
  const settings = asRecord(asRecord(payload?.collaboration_mode)?.settings);
  return {
    model: stringField(payload, "model")
      ?? stringField(settings, "model"),
    reasoning: normalizeReasoningEffort(
      stringField(payload, "effort")
      ?? stringField(payload, "reasoning_effort")
      ?? stringField(payload, "model_reasoning_effort")
      ?? stringField(settings, "reasoning_effort")
      ?? stringField(settings, "model_reasoning_effort")
    ),
    serviceTier: stringField(payload, "serviceTier")
      ?? stringField(payload, "service_tier")
      ?? stringField(settings, "serviceTier")
      ?? stringField(settings, "service_tier")
  };
};

export const normalizeReasoningEffort = (value: unknown): ReasoningEffort | undefined => {
  return isModelReasoningEffort(value) ? value : undefined;
};

export const formatComposerModelTitle = (
  modelDraft: ModelSelection,
  reasoningDraft: ReasoningSelection,
  serviceTierDraft: ServiceTierSelection,
  threadModel: string | null,
  threadReasoning: ReasoningEffort | null,
  threadServiceTier: string | null
) => [
  `draft model ${rawModelLabel(modelDraft)}`,
  threadModel ? `thread model ${rawModelLabel(threadModel)}` : null,
  `draft thinking ${reasoningDisplayLabel(reasoningDraft)}`,
  threadReasoning ? `thread thinking ${reasoningDisplayLabel(threadReasoning)}` : null,
  `draft tier ${serviceTierDraft === "auto" ? "Auto" : serviceTierDisplayLabel(serviceTierDraft)}`,
  threadServiceTier ? `thread tier ${serviceTierDisplayLabel(threadServiceTier)}` : null
].filter(Boolean).join(" · ");

export const formatComposerModelButtonLabel = (
  modelDraft: ModelSelection,
  reasoningDraft: ReasoningSelection,
  serviceTierDraft: ServiceTierSelection,
  threadModel: string | null,
  threadReasoning: ReasoningEffort | null,
  threadServiceTier: string | null
) => {
  const model = modelDraft === "auto" && threadModel ? threadModel : modelDraft;
  const reasoning = reasoningDraft === "auto" ? threadReasoning : reasoningDraft;
  const serviceTier = serviceTierDraft === "auto" ? threadServiceTier : serviceTierDraft;
  const label = rawModelLabel(model);
  const visibleServiceTier = serviceTier && serviceTier !== "default" && serviceTier !== "priority"
    ? serviceTierDisplayLabel(serviceTier)
    : null;
  return [reasoning ? `${label}:${reasoningDisplayLabel(reasoning)}` : label, visibleServiceTier].filter(Boolean).join(" · ");
};

export const formatContextUsage = (threadUsage: ThreadUsage | null) => {
  const context = threadUsage?.context;
  if (!context) return "--";
  return `${Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100))}%`;
};

export const formatContextTitle = (threadUsage: ThreadUsage | null) => {
  const context = threadUsage?.context;
  if (!context) return undefined;
  return [
    `${formatCompactNumber(context.usedTokens)} / ${formatCompactNumber(context.windowTokens)} input tokens`,
    threadUsage.observedAt ? `observed ${formatDate(threadUsage.observedAt)}` : null
  ].filter(Boolean).join(" · ");
};

export const formatMessageMeta = (message: CodexRecordView, options: { showTimestamp?: boolean } = {}) => [
  options.showTimestamp === false ? null : message.at ? formatMessageTime(message.at) : null,
  message.usage ? `${formatCompactNumber(usageTotal(message.usage))} tokens` : null
].filter(Boolean).join(" · ");

export const formatMessageMetaTitle = (message: CodexRecordView, options: { showTimestamp?: boolean } = {}) => {
  const timestamp = options.showTimestamp === false ? null : message.at;
  if (!message.usage) return timestamp ? formatDate(timestamp) : undefined;
  return [
    timestamp ? formatDate(timestamp) : null,
    `input ${formatCompactNumber(message.usage.input_tokens)}`,
    `cached ${formatCompactNumber(message.usage.cached_input_tokens)}`,
    `output ${formatCompactNumber(message.usage.output_tokens)}`,
    `reasoning ${formatCompactNumber(message.usage.reasoning_output_tokens)}`
  ].filter(Boolean).join(" · ");
};

const messageTimeFormatter = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });

export const formatMessageTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return messageTimeFormatter.format(date);
};

export const usageTotal = (usage: Usage) =>
  usage.total_tokens
    ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0);

export const formatRateLimitRemaining = (window: RateLimitWindow | null | undefined) => {
  if (!window) return "--";
  return `${formatPercent(100 - window.usedPercent)}`;
};

export const formatPercent = (value: number) => {
  if (!Number.isFinite(value)) return "--";
  const normalized = Math.max(0, Math.min(100, value));
  return `${Number.isInteger(normalized) ? normalized : normalized.toFixed(1)}%`;
};

export const formatResetTitle = (window: RateLimitWindow | null | undefined) => {
  if (!window) return undefined;
  const resetAt = new Date(window.resetsAt * 1000);
  if (Number.isNaN(resetAt.getTime())) return undefined;
  return [
    `${formatPercent(100 - window.usedPercent)} remaining`,
    `${formatPercent(window.usedPercent)} used`,
    `${window.windowMinutes}m window`,
    `resets ${resetAt.toLocaleString()}`
  ].join(", ");
};

export const mergeRecord = (records: CodexRecord[], incoming: CodexRecord) => {
  const existingIndex = records.findIndex((record) => record.id === incoming.id);
  if (existingIndex !== -1) {
    if (records[existingIndex] === incoming) return records;
    const next = records.slice();
    next[existingIndex] = incoming;
    const previous = next[existingIndex - 1];
    const following = next[existingIndex + 1];
    if (
      (!previous || compareCodexRecords(previous, incoming) <= 0)
      && (!following || compareCodexRecords(incoming, following) <= 0)
    ) return next;
    next.splice(existingIndex, 1);
    return insertOrderedRecord(next, incoming);
  }
  const withoutTranscriptDuplicate = records.filter((record) => !isMatchingAppServerTranscriptRecord(record, incoming));
  return insertOrderedRecord(withoutTranscriptDuplicate, incoming);
};

const insertOrderedRecord = (records: CodexRecord[], incoming: CodexRecord) => {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareCodexRecords(records[middle], incoming) <= 0) low = middle + 1;
    else high = middle;
  }
  return [...records.slice(0, low), incoming, ...records.slice(low)];
};

export const combineRecordSources = (left: CodexRecord[], right: CodexRecord[]) => {
  if (!left.length) return right;
  if (!right.length) return left;
  const byId = new Map<string, CodexRecord>();
  for (const record of left) byId.set(record.id, record);
  for (const record of right) byId.set(record.id, record);
  return orderCodexRecords([...byId.values()]);
};

export const threadDisplayRecords = (
  _threadId: string,
  thread: Pick<ThreadDetail, "records"> | undefined
) => thread?.records ?? [];

export const threadRecordsForNotifications = (_threadId: string, thread: ThreadDetail) =>
  thread.records;

export const streamEventRecords = (event: StreamEvent): CodexRecord[] => {
  if (event.record) return [event.record];
  return [];
};

export const mergeNotificationRecords = (
  current: CodexRecord[],
  _event: StreamEvent,
  incomingRecords: CodexRecord[]
) => {
  return incomingRecords.reduce((records, record) => mergeRecord(records, record), current);
};

export const primeTaskCompletionSound = (audioContextRef: React.MutableRefObject<AudioContext | null>) => {
  const context = ensureNotificationAudioContext(audioContextRef);
  if (!context || context.state === "closed") return;
  if (context.state === "suspended") void context.resume().catch(() => undefined);
};

export const playTaskCompletionSound = (audioContextRef: React.MutableRefObject<AudioContext | null>) => {
  const context = ensureNotificationAudioContext(audioContextRef);
  if (!context || context.state === "closed") return;
  const play = () => {
    const now = context.currentTime;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);

    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, now);
    oscillator.frequency.setValueAtTime(1174.66, now + 0.13);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.36);
  };

  if (context.state === "suspended") {
    void context.resume().then(play).catch(() => undefined);
    return;
  }
  play();
};

export const ensureNotificationAudioContext = (audioContextRef: React.MutableRefObject<AudioContext | null>) => {
  if (audioContextRef.current && audioContextRef.current.state !== "closed") return audioContextRef.current;
  const AudioContextConstructor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  audioContextRef.current = new AudioContextConstructor();
  return audioContextRef.current;
};

export const primeTaskNotificationPermission = () => {
  if (isTheiaSurface || isTheiaVscodeHost) {
    window.parent?.postMessage({ type: "codexhub.requestNotificationPermission" }, "*");
    return;
  }
  if (isVscodeSurface) return;
  const NotificationApi = window.Notification;
  if (!NotificationApi || NotificationApi.permission !== "default") return;
  void NotificationApi.requestPermission().catch(() => undefined);
};

export const isSimpleRecord = (record: CodexRecord) => {
  if (record.type === "error") return true;
  if (record.type === "response_item") return true;
  const payload = asRecord(record.payload);
  return record.type === "event_msg"
    && (
      payload?.type === "token_count"
      || payload?.type === "user_message"
      || payload?.type === "agent_message"
      || isContextCompactionType(payload?.type)
    );
};

export const isSimpleMainView = (view: CodexRecordView) => {
  if (view.role === "error") return true;
  if (view.role === "user" || view.role === "codex") return true;
  const payload = asRecord(view.record.payload);
  if (view.record.type === "event_msg" && isContextCompactionType(payload?.type)) return true;
  if (view.record.type !== "response_item") return false;
  if (payload?.type === "file_change") return isPendingApprovalPayload(payload);
  if (payload?.type !== "message") return true;
  return payload.role === "user" || payload.role === "assistant";
};

const isPendingApprovalPayload = (payload: Record<string, unknown> | null) => {
  const approval = asRecord(payload?.approval);
  return approval?.status === "pending";
};

export const hideSupersededSimpleThinkingViews = (views: CodexRecordView[]) => {
  let hasLaterView = false;
  const nextViews: CodexRecordView[] = [];
  for (let index = views.length - 1; index >= 0; index -= 1) {
    const view = views[index];
    if (!(view.role === "thinking" && hasLaterView)) nextViews.push(view);
    hasLaterView = true;
  }
  return nextViews.reverse();
};

export type TurnActivityScope = {
  key: string;
  label: string;
  records: CodexRecord[];
  turnId?: string;
  userRecordId?: string;
  startedAt?: string;
  endedAt?: string;
  turnStatus: ActivityStatusView | null;
};

export const latestTurnActivityScope = (records: CodexRecord[]): TurnActivityScope => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (!isUserInputRecord(records[index])) continue;
    const record = records[index];
    const turnId = recordTurnId(record);
    const turnStartedAt = turnId ? turnStartedAtFromRecords(records, turnId) : undefined;
    const startedAt = turnStartedAt ?? record.timestamp;
    const scopeRecords = records.slice(index + 1);
    return {
      key: turnId ? `turn:${turnId}` : record.id,
      label: turnStartedAt ? `after ${formatTurnActivityScopeTime(turnStartedAt, "turn")}` : `after ${formatTurnActivityScopeTime(record.timestamp, "user")}`,
      records: scopeRecords,
      ...(turnId ? { turnId } : {}),
      userRecordId: record.id,
      startedAt,
      ...(turnId ? { endedAt: turnEndedAtFromRecords(records, turnId) } : {}),
      turnStatus: latestTurnStatusFromRecords(scopeRecords) ?? (turnId ? latestTurnStatusForTurn(records, turnId) : null)
    };
  }
  const turnStatus = latestTurnStatusFromRecords(records);
  const turnId = latestLifecycleTurnId(records);
  return {
    key: turnId ? `turn:${turnId}` : "thread",
    label: "thread status",
    records,
    ...(turnId ? { turnId } : {}),
    ...(turnId ? { startedAt: turnStartedAtFromRecords(records, turnId) } : {}),
    ...(turnId ? { endedAt: turnEndedAtFromRecords(records, turnId) } : {}),
    turnStatus
  };
};

export const isUserInputRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  if (!payload) return false;
  if (record.type === "event_msg") return payload.type === "user_message";
  return record.type === "response_item" && payload.type === "message" && payload.role === "user";
};

const formatTurnActivityScopeTime = (timestamp: string | undefined, source: "turn" | "user" = "user") => {
  if (!timestamp) return source === "turn" ? "latest turn" : "latest user message";
  return source === "turn" ? `turn started at ${formatDate(timestamp)}` : `user message at ${formatDate(timestamp)}`;
};

export const activityStatusesFromRecords = (records: CodexRecord[]): ActivityStatusView[] => {
  const statuses = new Map<string, ActivityStatusView>();
  let fileStatus: ActivityStatusView | null = null;
  let scopedUsageStatus: ActivityStatusView | null = null;
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (record.type === "event_msg" && payload?.type === "status_usage") {
      scopedUsageStatus = activityStatusFromRecord(record);
      continue;
    }
    if (record.type === "response_item" && asRecord(payload?.approval)) {
      statuses.set("approval", approvalActivityStatus(record, payload));
      continue;
    }
    if (record.type === "response_item" && payload?.type === "file_change") {
      fileStatus = mergeFileChangeStatus(fileStatus, fileChangeActivityStatus(record, payload));
      continue;
    }
    const status = activityStatusFromRecord(record);
    if (status && isActivityStatusDetail(status)) statuses.set(status.key, status);
  }
  if (fileStatus) statuses.set(fileStatus.key, fileStatus);
  if (scopedUsageStatus) statuses.set(scopedUsageStatus.key, scopedUsageStatus);
  return [...statuses.values()]
    .filter(isActivityStatusDetail)
    .sort((left, right) => activityStatusPriority(left.key) - activityStatusPriority(right.key));
};

export const activityStatusSnapshotsFromRecords = (
  records: CodexRecord[],
  currentScopeRunning: boolean
): ActivityStatusSnapshot[] => {
  const userRecordIndexes = records.flatMap((record, index) => isUserInputRecord(record) ? [index] : []);
  return userRecordIndexes.flatMap((userRecordIndex, scopeIndex) => {
    const isCurrentScope = scopeIndex === userRecordIndexes.length - 1;
    if (isCurrentScope && currentScopeRunning) return [];
    const nextUserRecordIndex = userRecordIndexes[scopeIndex + 1] ?? records.length;
    const scopeRecords = records.slice(userRecordIndex + 1, nextUserRecordIndex);
    const targetRecordId = activityStatusSnapshotTargetRecordId(scopeRecords);
    if (!targetRecordId) return [];
    const statuses = activityStatusesFromRecords(scopeRecords);
    if (!statuses.length) return [];
    return [{
      targetRecordId,
      statuses: statuses.map((status) => ({
        ...status,
        files: status.files?.map((file) => ({ ...file }))
      }))
    }];
  });
};

export const withActivityStatusSnapshots = (
  views: WebRecordView[],
  snapshots: ActivityStatusSnapshot[]
): WebRecordView[] => {
  if (!snapshots.length) return views;
  const statusesByRecordId = new Map(
    snapshots.map((snapshot) => [snapshot.targetRecordId, snapshot.statuses] as const)
  );
  return views.map((view) => {
    const activityStatuses = statusesByRecordId.get(view.record.id);
    return activityStatuses ? { ...view, activityStatuses } : view;
  });
};

const activityStatusSnapshotTargetRecordId = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const payload = asRecord(record.payload);
    if (record.type === "error") return record.id;
    if (record.type === "event_msg" && payload?.type === "agent_message") return record.id;
    if (record.type === "response_item" && payload?.type === "message" && payload.role === "assistant") {
      return record.id;
    }
  }
  return null;
};

const isActivityStatusDetail = (status: ActivityStatusView) => {
  if (status.key === "approval" || status.key === "userInput") return status.status !== "completed";
  return status.key === "files" || status.key === "usage" || status.key === "context";
};

export const latestTurnStatusFromRecords = (records: CodexRecord[]): ActivityStatusView | null => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const status = activityStatusFromRecord(records[index]);
    if (status?.key === "turn" || status?.key === "userInput") return status;
  }
  return null;
};

const latestTurnStatusForTurn = (records: CodexRecord[], turnId: string): ActivityStatusView | null => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (recordTurnId(records[index]) !== turnId) continue;
    const status = activityStatusFromRecord(records[index]);
    if (status?.key === "turn" || status?.key === "userInput") return status;
  }
  return null;
};

const latestLifecycleTurnId = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = asRecord(records[index].payload);
    if (records[index].type !== "event_msg" || !isTurnLifecycleType(payload?.type)) continue;
    const turnId = recordTurnId(records[index]);
    if (turnId) return turnId;
  }
  return undefined;
};

const turnStartedAtFromRecords = (records: CodexRecord[], turnId: string) => {
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (record.type !== "event_msg" || payload?.type !== "task_started") continue;
    if (recordTurnId(record) === turnId) return record.timestamp;
  }
  return undefined;
};

const turnEndedAtFromRecords = (records: CodexRecord[], turnId: string) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const payload = asRecord(record.payload);
    if (record.type !== "event_msg" || !isTurnTerminalType(payload?.type)) continue;
    if (recordTurnId(record) === turnId) return record.timestamp;
  }
  return undefined;
};

const recordTurnId = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return stringField(payload, "turn_id")
    ?? stringField(payload, "turnId")
    ?? (record.sourceThreadId ? turnIdFromAppRecordId(record.sourceThreadId, record.id) ?? undefined : undefined);
};

const isTurnLifecycleType = (type: unknown) =>
  type === "task_started" || isTurnTerminalType(type);

const isTurnTerminalType = (type: unknown) =>
  type === "task_complete" || type === "turn_aborted";

export const threadExecutionIsRunning = (
  running: boolean,
  turnStatus: ActivityStatusView | null
) => Boolean(
  running
  || turnStatus?.status === "pending"
  || turnStatus?.status === "in_progress"
);

export const activityStatusFromRecord = (record: CodexRecord): ActivityStatusView | null => {
  const payload = asRecord(record.payload);
  const type = typeof payload?.type === "string" ? payload.type : "";
  if (record.type === "response_item" && type === "user_input_request" && payload) {
    return userInputActivityStatus(record, payload);
  }
  if (record.type !== "event_msg") return null;
  if (!payload || type === "user_message" || type === "agent_message" || type === "patch_apply_end") return null;
  if (type === "session_meta" || type === "turn_context") return null;

  if (type === "task_started") {
    return {
      key: "turn",
      label: "Running",
      status: "pending",
      at: record.timestamp,
      text: [
        stringField(payload, "turn_id") ? `turn ${shortId(stringField(payload, "turn_id") ?? "")}` : null,
        typeof payload.collaboration_mode_kind === "string" ? payload.collaboration_mode_kind : null,
        typeof payload.model_context_window === "number" ? `context ${formatCompactNumber(payload.model_context_window)}` : null
      ].filter(Boolean).join(" · ") || "Codex is running"
    };
  }

  if (type === "task_complete") {
    return {
      key: "turn",
      label: "Done",
      status: "completed",
      at: record.timestamp,
      text: [
        typeof payload.duration_ms === "number" ? `duration ${formatStatusDuration(payload.duration_ms)}` : null,
        typeof payload.time_to_first_token_ms === "number" ? `first token ${formatStatusDuration(payload.time_to_first_token_ms)}` : null
      ].filter(Boolean).join(" · ") || "Turn completed"
    };
  }

  if (type === "turn_aborted") {
    return {
      key: "turn",
      label: "Aborted",
      status: "failed",
      at: record.timestamp,
      text: [
        typeof payload.reason === "string" ? payload.reason : null,
        typeof payload.duration_ms === "number" ? `duration ${formatStatusDuration(payload.duration_ms)}` : null
      ].filter(Boolean).join(" · ") || "Turn aborted"
    };
  }

  if (type === "token_count") {
    return {
      key: "usage",
      label: "Usage",
      status: "completed",
      at: record.timestamp,
      text: formatTokenStatus(payload)
    };
  }

  if (type === "status_usage") {
    const usage = asRecord(payload.usage);
    return {
      key: "usage",
      label: "Usage",
      status: "completed",
      at: record.timestamp,
      text: formatUsageBreakdown(usage),
      summaryText: formatUsageSummary(usage)
    };
  }

  if (isContextCompactionType(type)) {
    const status = activityRecordStatus(payload.status) ?? "completed";
    return {
      key: "context",
      label: "Context",
      status,
      at: record.timestamp,
      text: typeof payload.message === "string"
        ? payload.message
        : status === "completed"
          ? "Compaction complete"
          : "Compacting"
    };
  }

  if (type === "thread_goal_updated") {
    const goal = asRecord(payload.goal);
    return {
      key: "goal",
      label: "Goal",
      status: goal?.status === "complete" ? "completed" : "pending",
      at: record.timestamp,
      text: [
        typeof goal?.status === "string" ? goal.status : "active",
        typeof goal?.objective === "string" ? goal.objective : null
      ].filter(Boolean).join(" · ") || "Goal updated"
    };
  }

  if (type === "thread_goal_cleared") {
    return { key: "goal", label: "Goal", status: "completed", at: record.timestamp, text: "Goal cleared" };
  }

  if (type === "item_completed") {
    const item = asRecord(payload.item);
    return {
      key: "item",
      label: "Item",
      status: "completed",
      at: record.timestamp,
      text: `Completed ${typeof item?.type === "string" ? item.type : "item"}`
    };
  }

  return {
    key: `event:${type || "unknown"}`,
    label: type || "Event",
    at: record.timestamp,
    text: typeof payload.message === "string" ? payload.message : stringifyInspectJson(payload)
  };
};

export const approvalActivityStatus = (
  record: CodexRecord,
  payload: Record<string, unknown> | null
): ActivityStatusView => {
  const approval = asRecord(payload?.approval);
  const status = activityRecordStatus(approval?.status) ?? (
    approval?.status === "approved" ? "completed" : approval?.status === "denied" ? "failed" : "pending"
  );
  return {
    key: "approval",
    label: status === "completed" ? "Approved" : status === "failed" ? "Approval" : "Waiting approval",
    status,
    at: record.timestamp,
    text: [
      typeof approval?.kind === "string" ? approval.kind : null,
      typeof approval?.reason === "string" ? approval.reason : null
    ].filter(Boolean).join(" · ") || "User approval required"
  };
};

export const userInputActivityStatus = (
  record: CodexRecord,
  payload: Record<string, unknown>
): ActivityStatusView => {
  const userInput = asRecord(payload.userInput);
  const status = activityRecordStatus(payload.status) ?? activityRecordStatus(userInput?.status) ?? "pending";
  const question = userInputQuestionSummary(payload.questions);
  const statusText = status === "completed"
    ? "Answered"
    : status === "failed"
      ? "Failed"
      : "Waiting for answer";
  return {
    key: "userInput",
    label: "User input",
    status,
    at: record.timestamp,
    text: [statusText, question].filter(Boolean).join(" · ") || statusText
  };
};

export const fileChangeActivityStatus = (record: CodexRecord, payload: Record<string, unknown>): ActivityStatusView => {
  const files = fileChangePreviewFiles(payload);
  const changed = files.length;
  const added = files.reduce((total, file) => total + (file.added ?? 0), 0);
  const removed = files.reduce((total, file) => total + (file.removed ?? 0), 0);
  return {
    key: "files",
    label: "Files",
    status: payload.status === "failed" ? "failed" : "completed",
    at: record.timestamp,
    text: [
      payload.status === "failed" ? "failed" : null,
      changed ? `${changed} file${changed === 1 ? "" : "s"}` : "files changed",
      fileChangeTotalsText(added, removed)
    ].filter(Boolean).join(" · "),
    summaryText: fileChangeSummaryText(changed, added, removed, payload.status === "failed"),
    files
  };
};

export const mergeFileChangeStatus = (
  current: ActivityStatusView | null,
  incoming: ActivityStatusView
): ActivityStatusView => {
  if (!current) return incoming;
  const filesByPath = new Map<string, ActivityStatusFile>();
  for (const file of [...current.files ?? [], ...incoming.files ?? []]) {
    const existing = filesByPath.get(file.path);
    filesByPath.set(file.path, {
      path: file.path,
      added: (existing?.added ?? 0) + (file.added ?? 0),
      removed: (existing?.removed ?? 0) + (file.removed ?? 0)
    });
  }
  const files = [...filesByPath.values()];
  const added = files.reduce((total, file) => total + (file.added ?? 0), 0);
  const removed = files.reduce((total, file) => total + (file.removed ?? 0), 0);
  const failed = current.status === "failed" || incoming.status === "failed";
  return {
    ...incoming,
    status: failed ? "failed" : "completed",
    text: [
      failed ? "failed" : null,
      files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "files changed",
      fileChangeTotalsText(added, removed)
    ].filter(Boolean).join(" · "),
    summaryText: fileChangeSummaryText(files.length, added, removed, failed),
    files
  };
};

const fileChangeSummaryText = (changed: number, added: number, removed: number, failed: boolean) => [
  failed ? "failed" : null,
  changed || "changed",
  fileChangeTotalsText(added, removed)
].filter(Boolean).join(" · ");

export const fileChangeTotalsText = (added: number, removed: number) => [
  `+${added}`,
  `-${removed}`
].filter(Boolean).join(" ");

export const activityStatusPriority = (key: string) => {
  const order: Record<string, number> = {
    approval: 0,
    userInput: 1,
    files: 2,
    usage: 3,
    context: 4
  };
  return order[key] ?? 10;
};

export const activityStatusTitle = (statuses: ActivityStatusView[]) =>
  statuses.map((status) => `${status.label}: ${status.text}`).join("\n");

export const formatTokenStatus = (payload: Record<string, unknown>) => {
  const info = asRecord(payload.info);
  const usage = asRecord(info?.last_token_usage);
  if (!usage) return "Token usage updated";
  return formatUsageBreakdown(usage);
};

const formatUsageBreakdown = (usage: Record<string, unknown> | null) => {
  if (!usage) return "Token usage updated";
  const total = typeof usage.total_tokens === "number" ? `total ${formatCompactNumber(usage.total_tokens)}` : null;
  const input = typeof usage.input_tokens === "number" ? `input ${formatCompactNumber(usage.input_tokens)}` : null;
  const output = typeof usage.output_tokens === "number" ? `output ${formatCompactNumber(usage.output_tokens)}` : null;
  return [total, input, output].filter(Boolean).join(" · ") || "Token usage updated";
};

const formatUsageSummary = (usage: Record<string, unknown> | null) => {
  if (!usage) return "updated";
  const total = typeof usage.total_tokens === "number" ? formatCompactNumber(usage.total_tokens) : null;
  const input = typeof usage.input_tokens === "number" ? `in ${formatCompactNumber(usage.input_tokens)}` : null;
  const output = typeof usage.output_tokens === "number" ? `out ${formatCompactNumber(usage.output_tokens)}` : null;
  return [total, input, output].filter(Boolean).join(" · ") || "updated";
};

export const formatStatusDuration = (value: number) => {
  if (value >= 60_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.round((value % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
};

export const stringField = (record: Record<string, unknown> | null | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === "string" && value ? value : undefined;
};

const isContextCompactionType = (type: unknown) =>
  type === "context_compaction" || type === "context_compacted" || type === "compacted";

const activityRecordStatus = (status: unknown): ActivityStatusView["status"] | undefined => {
  if (typeof status !== "string") return undefined;
  const normalized = status.trim().replace(/[-\s]+/g, "_").toLowerCase();
  if (normalized === "inprogress" || normalized === "in_progress" || normalized === "running") return "in_progress";
  if (normalized === "pending" || normalized === "queued" || normalized === "pending_approval" || normalized === "pending_user_input") return "pending";
  if (normalized === "failed" || normalized === "error" || normalized === "errored" || normalized === "aborted" || normalized === "denied" || normalized === "declined") return "failed";
  if (normalized === "completed" || normalized === "complete" || normalized === "success" || normalized === "succeeded" || normalized === "approved" || normalized === "accepted" || normalized === "answered") return "completed";
  return undefined;
};

const userInputQuestionSummary = (value: unknown) => {
  if (!Array.isArray(value)) return "";
  const labels = value.flatMap((item) => {
    const question = asRecord(item);
    const text = typeof question?.question === "string" && question.question.trim()
      ? question.question
      : typeof question?.header === "string" && question.header.trim()
        ? question.header
        : typeof question?.id === "string" && question.id.trim()
          ? question.id
          : "";
    return text ? [compactLine(text)] : [];
  });
  return labels[0] ?? (value.length ? `${value.length} questions` : "");
};

export const isMatchingAppServerTranscriptRecord = (record: CodexRecord, incoming: CodexRecord) => {
  if (
    incoming.type !== "event_msg"
    || record.type !== "event_msg"
    || !incoming.id.startsWith("app:")
    || !record.id.startsWith("app:")
  ) return false;
  const recordPayload = asRecord(record.payload);
  const incomingPayload = asRecord(incoming.payload);
  if (!incomingPayload) return false;
  const incomingType = incomingPayload?.type;
  if (incomingType !== "user_message" && incomingType !== "agent_message") return false;
  if (!recordPayload || recordPayload.type !== incomingType) return false;
  const threadId = String(incoming.sourceThreadId ?? record.sourceThreadId ?? "");
  const incomingTurnId = turnIdFromAppRecordId(threadId, incoming.id);
  const recordTurnId = turnIdFromAppRecordId(threadId, record.id);
  if ((incomingTurnId || recordTurnId) && (incomingTurnId !== recordTurnId || recordTurnId === null)) return false;
  if (recordPayload.message !== incomingPayload.message) return false;
  if (incomingType === "agent_message") return recordPayload.phase === incomingPayload.phase;
  return JSON.stringify(recordPayload.images ?? []) === JSON.stringify(incomingPayload.images ?? []);
};
