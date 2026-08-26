import { threadUsageFromRecords } from "../../core/threadUsage.js";
export {
  isTaskCompleteRecord,
  taskActivityTitle,
  taskCompleteNotification,
  taskCompleteRecordIsForLatestUserInput,
  taskCompleteNotificationShouldPersist,
  taskCompletionNotificationKey
} from "../../shared/taskNotifications.js";
import { asRecord, type CodexRecord, type CodexRecordView } from "../../shared/recordTypes.js";
import { compareCodexRecords, orderCodexRecords, recordTimestampMs } from "../../shared/recordIdentity.js";
import { formatCompactNumber } from "../../shared/toolFormatting.js";
import { isModelReasoningEffort } from "../../shared/usageTypes.js";
export { formatCompactNumber } from "../../shared/toolFormatting.js";
import { isVscodeSurface } from "../appConfig.js";
import type { ActivityStatusFile, ActivityStatusPlanStep, ActivityStatusSnapshot, ActivityStatusView, BackgroundTerminalView, ModelSelection, RateLimitWindow, ReasoningEffort, ReasoningSelection, ServiceTierSelection, SessionRateLimits, StreamEvent, ThreadDetail, ThreadGoalView, ThreadUsage, Usage, WebRecordView } from "../types.js";
import { formatPlanProgress, planProgressFromPlan } from "../../shared/planProgress.js";
import { fileChangePreviewFiles } from "./fileChanges.js";
import { compactLine, isFastServiceTier, rawModelLabel, reasoningDisplayLabel, serviceTierDisplayLabel, turnIdFromAppRecordId } from "./core.js";
import { formatDate, shortId, stringifyInspectJson } from "./common.js";
import { turnDurationMsForTurn } from "./turnDurations.js";

export const latestThreadUsageFromRecords = (records: CodexRecord[]): ThreadUsage | null => {
  const usage = threadUsageFromRecords(records);
  return usage.context || usage.primaryRateLimit || usage.secondaryRateLimit ? usage : null;
};

export const backgroundTerminalViewsFromThread = (
  thread: Pick<ThreadDetail, "backgroundTerminals" | "records">
): BackgroundTerminalView[] => (thread.backgroundTerminals ?? []).map((terminal) => ({
  ...terminal,
  startedAt: backgroundTerminalStartedAt(thread.records, terminal.itemId)
}));

const backgroundTerminalStartedAt = (records: CodexRecord[], itemId: string) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = asRecord(records[index].payload);
    if (payload?.type !== "local_shell_call" || payload.call_id !== itemId) continue;
    if (typeof payload.started_at === "string" && payload.started_at) return payload.started_at;
    return records[index].timestamp;
  }
  return undefined;
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
      const goalCreatedAt = goalTimeMs(goal?.createdAt);
      const recordTime = recordTimestampMs(records[index]);
      const isOldGoal = goalCreatedAt !== null ? goalCreatedAt <= clearedAt : recordTime !== null && recordTime <= clearedAt;
      if (isOldGoal) continue;
    }
    const objective = typeof goal?.objective === "string" ? compactLine(goal.objective) : "";
    if (!objective) return null;
    const status = threadGoalStatusFromValue(goal?.status);
    if (status === "complete") return null;
    const tokenBudget = typeof goal?.tokenBudget === "number" ? goal.tokenBudget : undefined;
    const timeUsedSeconds = typeof goal?.timeUsedSeconds === "number" && Number.isFinite(goal.timeUsedSeconds)
      ? goal.timeUsedSeconds
      : undefined;
    const updatedAt = records[index].timestamp
      ?? (typeof goal?.updatedAt === "number" ? new Date(goal.updatedAt * 1000).toISOString() : undefined);
    return { objective, status, tokenBudget, timeUsedSeconds, updatedAt };
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
  const payloadThreadId = stringField(payload, "threadId");
  const goalThreadId = stringField(goal, "threadId");
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
  threadReasoning: ReasoningEffort | null
) => {
  const model = modelDraft === "auto" && threadModel ? threadModel : modelDraft;
  const reasoning = reasoningDraft === "auto" ? threadReasoning : reasoningDraft;
  const serviceTier = serviceTierDraft === "auto" ? null : serviceTierDraft;
  const label = rawModelLabel(model);
  const visibleServiceTier = serviceTier
    && serviceTier !== "default"
    && !isFastServiceTier(serviceTier)
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
  const resetAt = window.resetsAt === null ? null : new Date(window.resetsAt * 1000);
  return [
    `${formatPercent(100 - window.usedPercent)} remaining`,
    `${formatPercent(window.usedPercent)} used`,
    ...(window.windowMinutes === null ? [] : [`${window.windowMinutes}m window`]),
    ...(resetAt && !Number.isNaN(resetAt.getTime()) ? [`resets ${resetAt.toLocaleString()}`] : [])
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
  const byId = new Map<string, CodexRecord>();
  const idByTranscriptKey = new Map<string, string>();
  const put = (record: CodexRecord) => {
    const sameId = byId.get(record.id);
    const sameIdKey = sameId ? appServerTranscriptRecordKey(sameId) : null;
    if (sameIdKey && idByTranscriptKey.get(sameIdKey) === record.id) {
      idByTranscriptKey.delete(sameIdKey);
    }
    const transcriptKey = appServerTranscriptRecordKey(record);
    const semanticDuplicateId = transcriptKey ? idByTranscriptKey.get(transcriptKey) : undefined;
    if (semanticDuplicateId && semanticDuplicateId !== record.id) {
      byId.delete(semanticDuplicateId);
    }
    byId.set(record.id, record);
    if (transcriptKey) idByTranscriptKey.set(transcriptKey, record.id);
  };
  for (const record of left) put(record);
  for (const record of right) put(record);
  return orderCodexRecords([...byId.values()]);
};

export const applyThreadRecordDelta = (
  records: CodexRecord[],
  delta: NonNullable<StreamEvent["delta"]>
) => {
  const index = records.findIndex((record) => record.id === delta.recordId);
  if (index === -1) return records;
  const record = records[index];
  const payload = asRecord(record.payload);
  if (!payload) return records;
  const current = typeof payload[delta.field] === "string" ? payload[delta.field] : "";
  const next = records.slice();
  next[index] = {
    ...record,
    payload: {
      ...payload,
      [delta.field]: current + delta.append
    }
  };
  return next;
};

export const threadDisplayRecords = (
  _threadId: string,
  thread: Pick<ThreadDetail, "records"> | undefined
) => thread?.records ?? [];

export const threadRecordsForNotifications = (_threadId: string, thread: ThreadDetail) =>
  thread.records;

export const streamEventRecords = (event: StreamEvent): CodexRecord[] => {
  if (event.records?.length) return event.records;
  if (event.record) return [event.record];
  return [];
};

export const mergeNotificationRecords = (
  current: CodexRecord[],
  _event: StreamEvent,
  incomingRecords: CodexRecord[]
) => {
  if (incomingRecords.length > 1) return combineRecordSources(current, incomingRecords);
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
      || payload?.type === "plan"
      || payload?.type === "thread_goal_updated"
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

const normalizedInteractionStatus = (value: unknown) =>
  typeof value === "string" ? value.trim().replace(/[-\s]+/g, "_").toLowerCase() : "";

export const recordHasPendingInteraction = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  if (!payload) return false;
  if (isPendingApprovalPayload(payload)) return true;
  const userInput = asRecord(payload.userInput);
  return payload.type === "user_input_request"
    && (userInput?.status === "pending" || normalizedInteractionStatus(payload.status) === "pending_user_input");
};

export const recordsHavePendingInteraction = (records: CodexRecord[]) =>
  records.some(recordHasPendingInteraction);

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
  durationMs?: number;
  turnStatus: ActivityStatusView | null;
};

export type GoalActivityScope = {
  key: string;
  records: CodexRecord[];
  turnIds: string[];
};

type GoalActivitySpan = GoalActivityScope & {
  ranges: GoalActivityRange[];
  active: boolean;
  closed: boolean;
};

type GoalActivityRange = {
  startAtMs: number | null;
  endAtMs: number | null;
  startIndex: number;
  endIndex: number | null;
};

type TurnActivityGroup = {
  turnId: string;
  records: CodexRecord[];
  firstIndex: number;
  lastIndex: number;
  startedAtMs: number | null;
  endedAtMs: number | null;
  firstAtMs: number | null;
  lastAtMs: number | null;
};

const activityScopeForTurn = (records: CodexRecord[], turnId: string): TurnActivityScope => {
  const scopeRecords = records.filter((record) => recordTurnId(record) === turnId);
  const userRecord = scopeRecords.find(isUserInputRecord);
  const startedAt = turnStartedAtFromRecords(records, turnId);
  const endedAt = turnEndedAtFromRecords(records, turnId);
  return {
    key: `turn:${turnId}`,
    label: startedAt ? `after ${formatTurnActivityScopeTime(startedAt, "turn")}` : `turn ${turnId}`,
    records: scopeRecords,
    turnId,
    ...(userRecord ? { userRecordId: userRecord.id } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...optionalDuration(turnDurationMsForTurn(records, turnId)),
    turnStatus: latestTurnStatusForTurn(records, turnId)
  };
};

export const activeGoalActivityScopeFromRecords = (
  records: CodexRecord[],
  threadId?: string
): GoalActivityScope | null => {
  const spans = goalActivitySpansFromRecords(records, threadId);
  let span: GoalActivitySpan | undefined;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    if (!spans[index].closed && spans[index].active) {
      span = spans[index];
      break;
    }
  }
  if (!span) return null;
  return {
    key: span.key,
    records: span.records,
    turnIds: span.turnIds
  };
};

export const latestTurnActivityScope = (
  records: CodexRecord[],
  preferredTurnId?: string
): TurnActivityScope => {
  const lifecycleTurnId = preferredTurnId ?? latestLifecycleTurnId(records);
  if (lifecycleTurnId) return activityScopeForTurn(records, lifecycleTurnId);

  // Legacy/unscoped records have no app-server Turn identity. Keep a narrow
  // fallback so old transcripts remain readable without influencing current protocol records.
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (!isUserInputRecord(records[index])) continue;
    const record = records[index];
    const turnId = recordTurnId(record);
    const scopeStartIndex = turnId
      ? records.findIndex((candidate) => isUserInputRecord(candidate) && recordTurnId(candidate) === turnId)
      : index;
    const scopeStartRecord = records[scopeStartIndex] ?? record;
    const turnStartedAt = turnId ? turnStartedAtFromRecords(records, turnId) : undefined;
    const startedAt = turnStartedAt ?? scopeStartRecord.timestamp;
    const scopeRecords = records.slice(scopeStartIndex + 1);
    return {
      key: turnId ? `turn:${turnId}` : record.id,
      label: turnStartedAt ? `after ${formatTurnActivityScopeTime(turnStartedAt, "turn")}` : `after ${formatTurnActivityScopeTime(scopeStartRecord.timestamp, "user")}`,
      records: scopeRecords,
      ...(turnId ? { turnId } : {}),
      userRecordId: scopeStartRecord.id,
      startedAt,
      ...(turnId ? { endedAt: turnEndedAtFromRecords(records, turnId) } : {}),
      ...(turnId ? optionalDuration(turnDurationMsForTurn(records, turnId)) : {}),
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
    ...(turnId ? optionalDuration(turnDurationMsForTurn(records, turnId)) : {}),
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
  let scopedUsage: Record<string, number> | null = null;
  let scopedUsageAt: string | undefined;
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (record.type === "event_msg" && payload?.type === "status_usage") {
      scopedUsage = addStatusUsage(scopedUsage, asRecord(payload.usage));
      scopedUsageAt = record.timestamp ?? scopedUsageAt;
      continue;
    }
    if (record.type === "response_item" && asRecord(payload?.approval)) continue;
    if (record.type === "response_item" && payload?.type === "file_change") {
      fileStatus = mergeFileChangeStatus(fileStatus, fileChangeActivityStatus(record, payload));
      continue;
    }
    const status = activityStatusFromRecord(record);
    if (status && isActivityStatusDetail(status)) statuses.set(status.key, status);
  }
  if (fileStatus) statuses.set(fileStatus.key, fileStatus);
  if (scopedUsage) {
    statuses.set("usage", {
      key: "usage",
      label: "Usage",
      status: "completed",
      at: scopedUsageAt,
      text: formatUsageBreakdown(scopedUsage),
      summaryText: formatUsageSummary(scopedUsage)
    });
  }
  return [...statuses.values()]
    .filter(isActivityStatusDetail)
    .sort((left, right) => activityStatusPriority(left.key) - activityStatusPriority(right.key));
};

export const activityStatusSnapshotsFromRecords = (
  records: CodexRecord[],
  currentTurnId?: string,
  threadId?: string
): ActivityStatusSnapshot[] => {
  const turnGroups = turnActivityGroupsFromRecords(records);
  if (turnGroups.length) {
    const goalSpans = goalActivitySpansFromRecords(records, threadId, turnGroups);
    const goalByTurnId = new Map(goalSpans.flatMap((span) =>
      span.turnIds.map((turnId) => [turnId, span] as const)
    ));
    const snapshots: ActivityStatusSnapshot[] = [];
    for (const group of turnGroups) {
      if (goalByTurnId.has(group.turnId) || group.turnId === currentTurnId) continue;
      const targetRecordId = activityStatusSnapshotTargetRecordId(group.records);
      if (!targetRecordId) continue;
      const statuses = activityStatusesFromRecords(group.records);
      if (!statuses.length) continue;
      snapshots.push({
        targetRecordId,
        statuses: cloneActivityStatuses(statuses)
      });
    }
    for (const span of goalSpans) {
      if (!span.closed || !span.turnIds.length) continue;
      const lastTurnId = span.turnIds.at(-1);
      if (!lastTurnId || lastTurnId === currentTurnId) continue;
      const lastTurn = turnGroups.find((group) => group.turnId === lastTurnId);
      const targetRecordId = lastTurn ? activityStatusSnapshotTargetRecordId(lastTurn.records) : null;
      if (!targetRecordId) continue;
      const statuses = activityStatusesFromRecords(span.records);
      if (!statuses.length) continue;
      snapshots.push({
        targetRecordId,
        statuses: cloneActivityStatuses(statuses)
      });
    }
    return snapshots;
  }

  // Legacy records without Turn ids remain grouped by their user-input boundary.
  const userRecordIndexes = records.flatMap((record, index) => isUserInputRecord(record) ? [index] : []);
  return userRecordIndexes.flatMap((userRecordIndex, scopeIndex) => {
    const isCurrentScope = scopeIndex === userRecordIndexes.length - 1;
    if (isCurrentScope && currentTurnId === "legacy-current") return [];
    const nextUserRecordIndex = userRecordIndexes[scopeIndex + 1] ?? records.length;
    const scopeRecords = records.slice(userRecordIndex + 1, nextUserRecordIndex);
    const targetRecordId = activityStatusSnapshotTargetRecordId(scopeRecords);
    if (!targetRecordId) return [];
    const statuses = activityStatusesFromRecords(scopeRecords);
    if (!statuses.length) return [];
    return [{
      targetRecordId,
      statuses: cloneActivityStatuses(statuses)
    }];
  });
};

const cloneActivityStatuses = (statuses: ActivityStatusView[]) =>
  statuses.map((status) => ({
    ...status,
    files: status.files?.map((file) => ({ ...file })),
    steps: status.steps?.map((step) => ({ ...step }))
  }));

const statusUsageFields = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
] as const;

const addStatusUsage = (
  current: Record<string, number> | null,
  incoming: Record<string, unknown> | null
) => {
  if (!incoming) return current;
  const next = { ...(current ?? {}) };
  let found = false;
  for (const field of statusUsageFields) {
    const value = incoming[field];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    next[field] = (next[field] ?? 0) + value;
    found = true;
  }
  return found ? next : current;
};

const turnActivityGroupsFromRecords = (records: CodexRecord[]): TurnActivityGroup[] => {
  const groups = new Map<string, TurnActivityGroup>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const turnId = recordTurnId(record);
    if (!turnId) continue;
    const payload = asRecord(record.payload);
    const atMs = recordTimestampMs(record);
    const existing = groups.get(turnId);
    const group = existing ?? {
      turnId,
      records: [],
      firstIndex: index,
      lastIndex: index,
      startedAtMs: null,
      endedAtMs: null,
      firstAtMs: atMs,
      lastAtMs: atMs
    };
    group.records.push(record);
    group.lastIndex = index;
    if (atMs !== null) {
      group.firstAtMs = group.firstAtMs === null ? atMs : Math.min(group.firstAtMs, atMs);
      group.lastAtMs = group.lastAtMs === null ? atMs : Math.max(group.lastAtMs, atMs);
      if (payload?.type === "task_started") group.startedAtMs = atMs;
      if (isTurnTerminalType(payload?.type)) group.endedAtMs = atMs;
    }
    if (!existing) groups.set(turnId, group);
  }
  return [...groups.values()];
};

const goalActivitySpansFromRecords = (
  records: CodexRecord[],
  threadId?: string,
  turnGroups = turnActivityGroupsFromRecords(records)
): GoalActivitySpan[] => {
  type MutableGoalSpan = GoalActivitySpan & {
    createdAtMs: number | null;
    startRecordId: string;
  };
  const spans: MutableGoalSpan[] = [];
  let current: MutableGoalSpan | null = null;

  const closeActiveRange = (span: MutableGoalSpan, endAtMs: number | null, endIndex: number) => {
    const range = span.ranges.at(-1);
    if (!range || range.endIndex !== null) return;
    range.endAtMs = endAtMs;
    range.endIndex = endIndex;
    span.active = false;
  };

  const openActiveRange = (span: MutableGoalSpan, startAtMs: number | null, startIndex: number) => {
    const range = span.ranges.at(-1);
    if (range && range.endIndex === null) {
      span.active = true;
      return;
    }
    span.ranges.push({
      startAtMs,
      endAtMs: null,
      startIndex,
      endIndex: null
    });
    span.active = true;
  };

  const closeCurrent = (endAtMs: number | null, endIndex: number) => {
    if (!current || current.closed) return;
    closeActiveRange(current, endAtMs, endIndex);
    current.closed = true;
    current.active = false;
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const payload = asRecord(record.payload);
    const type = typeof payload?.type === "string" ? payload.type : "";
    if (type === "thread_goal_cleared") {
      if (goalRecordMatchesThread(payload, null, threadId)) {
        closeCurrent(recordTimestampMs(record), index);
      }
      continue;
    }
    if (type !== "thread_goal_updated") continue;
    const goal = asRecord(payload?.goal);
    if (!goal || !goalRecordMatchesThread(payload, goal, threadId)) continue;
    const createdAtMs = goalTimeMs(goal.createdAt);
    const sameGoal = Boolean(
      current
      && !current.closed
      && (
        (createdAtMs !== null && current.createdAtMs === createdAtMs)
        || (
          createdAtMs === null
          || current.createdAtMs === null
        )
      )
    );
    if (!sameGoal) {
      closeCurrent(createdAtMs ?? recordTimestampMs(record), index);
      const goalThreadId = stringField(payload, "threadId")
        ?? stringField(goal, "threadId")
        ?? threadId
        ?? "thread";
      current = {
        key: goalActivityKey(goalThreadId, createdAtMs, record.id),
        records: [],
        turnIds: [],
        ranges: [],
        active: false,
        closed: false,
        createdAtMs,
        startRecordId: record.id
      };
      spans.push(current);
    } else if (current) {
      if (current.createdAtMs === null && createdAtMs !== null) {
        current.createdAtMs = createdAtMs;
        current.key = goalActivityKey(
          stringField(payload, "threadId") ?? stringField(goal, "threadId") ?? threadId ?? "thread",
          createdAtMs,
          current.startRecordId
        );
      }
    }
    if (!current) continue;
    const recordAtMs = recordTimestampMs(record);
    if (goal.status === "active") {
      const firstRangeStartAtMs = current.ranges.length ? recordAtMs : createdAtMs ?? recordAtMs;
      openActiveRange(current, firstRangeStartAtMs, index);
      continue;
    }
    closeActiveRange(current, recordAtMs, index);
    if (goal.status === "complete") closeCurrent(recordAtMs, index);
  }

  for (const group of turnGroups) {
    const span = matchingGoalSpan(group, spans);
    if (!span) continue;
    span.turnIds.push(group.turnId);
    span.records.push(...group.records);
  }
  return spans;
};

const matchingGoalSpan = <T extends GoalActivitySpan>(
  group: TurnActivityGroup,
  spans: T[]
) => {
  const turnStartAtMs = group.startedAtMs ?? group.firstAtMs;
  const turnEndAtMs = group.endedAtMs ?? group.lastAtMs ?? turnStartAtMs;
  let match: T | null = null;
  let matchRangeStartAtMs = Number.NEGATIVE_INFINITY;
  let matchRangeStartIndex = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    for (const range of span.ranges) {
      const overlapsByTime = (
        turnStartAtMs !== null
        && turnEndAtMs !== null
        && range.startAtMs !== null
      ) ? !(
          turnEndAtMs < range.startAtMs
          || (
            turnEndAtMs === range.startAtMs
            && group.lastIndex < range.startIndex
          )
          || (
            range.endAtMs !== null
            && (
              turnStartAtMs > range.endAtMs
              || (
                turnStartAtMs === range.endAtMs
                && range.endIndex !== null
                && group.firstIndex > range.endIndex
              )
            )
          )
        )
        : group.firstIndex <= (range.endIndex ?? Number.POSITIVE_INFINITY)
          && group.lastIndex >= range.startIndex;
      if (!overlapsByTime) continue;
      const rangeStartAtMs = range.startAtMs ?? Number.NEGATIVE_INFINITY;
      if (
        !match
        || rangeStartAtMs > matchRangeStartAtMs
        || (
          rangeStartAtMs === matchRangeStartAtMs
          && range.startIndex > matchRangeStartIndex
        )
      ) {
        match = span;
        matchRangeStartAtMs = rangeStartAtMs;
        matchRangeStartIndex = range.startIndex;
      }
    }
  }
  return match;
};

const goalActivityKey = (threadId: string, createdAtMs: number | null, fallbackId: string) =>
  `goal:${threadId}:${createdAtMs ?? fallbackId}`;

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
    if (record.type === "event_msg" && payload?.type === "plan") return record.id;
    if (record.type === "response_item" && payload?.type === "message" && payload.role === "assistant") {
      return record.id;
    }
  }
  return null;
};

const isActivityStatusDetail = (status: ActivityStatusView) => {
  if (status.key === "userInput") return status.status !== "completed";
  return status.key === "plan" || status.key === "files" || status.key === "usage" || status.key === "context";
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

const optionalDuration = (durationMs: number | undefined) =>
  durationMs == null ? {} : { durationMs };

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
    const interrupted = payload.status === "interrupted";
    return {
      key: "turn",
      label: interrupted ? "Interrupted" : "Failed",
      status: interrupted ? undefined : "failed",
      at: record.timestamp,
      text: [
        typeof payload.reason === "string" ? payload.reason : null,
        typeof payload.duration_ms === "number" ? `duration ${formatStatusDuration(payload.duration_ms)}` : null
      ].filter(Boolean).join(" · ") || (interrupted ? "Turn interrupted" : "Turn failed")
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

  if (type === "turn_plan_updated") {
    const steps = activityPlanSteps(payload.plan);
    const progress = planProgressFromPlan(payload.plan);
    if (!progress) return null;
    const activeStep = steps[progress.currentIndex]!;
    const text = `${progress.allCompleted ? "All steps complete" : activeStep.step} · ${formatPlanProgress(progress)}`;
    return {
      key: "plan",
      label: "Plan",
      status: progress.allCompleted ? "completed" : activeStep.status,
      at: record.timestamp,
      text,
      summaryText: text,
      steps
    };
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
    plan: 0,
    userInput: 1,
    files: 2,
    usage: 3,
    context: 4
  };
  return order[key] ?? 10;
};

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
  type === "context_compaction";

const activityRecordStatus = (status: unknown): ActivityStatusView["status"] | undefined => {
  if (typeof status !== "string") return undefined;
  const normalized = status.trim().replace(/[-\s]+/g, "_").toLowerCase();
  if (normalized === "inprogress" || normalized === "in_progress" || normalized === "running") return "in_progress";
  if (normalized === "pending" || normalized === "queued" || normalized === "pending_approval" || normalized === "pending_user_input") return "pending";
  if (normalized === "failed" || normalized === "error" || normalized === "errored" || normalized === "aborted" || normalized === "denied" || normalized === "declined") return "failed";
  if (normalized === "completed" || normalized === "complete" || normalized === "success" || normalized === "succeeded" || normalized === "approved" || normalized === "accepted" || normalized === "answered") return "completed";
  return undefined;
};

const activityPlanSteps = (value: unknown): ActivityStatusPlanStep[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const planStep = asRecord(item);
    const step = typeof planStep?.step === "string" ? planStep.step.trim() : "";
    const status = activityRecordStatus(planStep?.status);
    if (!step || !status || status === "failed") return [];
    return [{ step, status }];
  });
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
  const threadId = String(incoming.sourceThreadId ?? record.sourceThreadId ?? "");
  const recordKey = appServerTranscriptRecordKey(record, threadId);
  return recordKey !== null && recordKey === appServerTranscriptRecordKey(incoming, threadId);
};

const appServerTranscriptRecordKey = (record: CodexRecord, fallbackThreadId = "") => {
  if (record.type !== "event_msg" || !record.id.startsWith("app:")) return null;
  const payload = asRecord(record.payload);
  const type = payload?.type;
  if (!payload || (type !== "user_message" && type !== "agent_message")) return null;
  const threadId = String(record.sourceThreadId ?? fallbackThreadId);
  const turnId = turnIdFromAppRecordId(threadId, record.id);
  if (!threadId || !turnId) return null;
  return JSON.stringify([
    type,
    threadId,
    turnId,
    payload.message,
    type === "agent_message" ? payload.phase : payload.images ?? []
  ]);
};
