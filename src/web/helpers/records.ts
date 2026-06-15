import { threadUsageFromRecord } from "../../core/threadUsage.js";
import { asRecord, type CodexRecord, type CodexRecordView } from "../../shared/recordTypes.js";
import { isVscodeSurface, reasoningOptions } from "../appConfig.js";
import type { ActivityStatusFile, ActivityStatusView, ModelSelection, RateLimitWindow, ReasoningEffort, ReasoningSelection, ServiceTierSelection, SessionRateLimits, StreamEvent, TaskCompleteNotification, ThreadDetail, ThreadGoalView, ThreadSummary, ThreadUsage, TurnUiState, Usage } from "../types.js";
import { fileChangePreviewFiles } from "./fileChanges.js";
import { compactLine, rawModelLabel, turnIdFromAppRecordId } from "./core.js";
import { formatDate, shortId, stringifyInspectJson } from "./common.js";

export const latestThreadUsageFromRecords = (records: CodexRecord[]): ThreadUsage | null => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const usage = threadUsageFromRecord(records[index]);
    if (usage) return usage;
  }
  return null;
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

export const recordTimestampMs = (record: CodexRecord) => {
  const timestamp = Date.parse(record.timestamp ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
};

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
  if (typeof value !== "string") return undefined;
  return reasoningOptions.some((option) => option.value === value && option.value !== "auto")
    ? value as ReasoningEffort
    : undefined;
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
  `draft thinking ${reasoningDraft === "auto" ? "Auto" : reasoningDraft}`,
  threadReasoning ? `thread thinking ${threadReasoning}` : null,
  `draft tier ${serviceTierDraft === "auto" ? "Auto" : serviceTierDraft}`,
  threadServiceTier ? `thread tier ${threadServiceTier}` : null
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
  return [reasoning ? `${label}:${reasoning}` : label, serviceTier].filter(Boolean).join(" · ");
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

export const formatCompactNumber = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
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

export const formatMessageTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  if (existingIndex === -1) {
    return orderRecords([
      ...records.filter((record) => !isMatchingAppServerTranscriptRecord(record, incoming)),
      incoming
    ]);
  }
  return orderRecords(records.map((record, index) => index === existingIndex ? incoming : record));
};

export const combineRecordSources = (left: CodexRecord[], right: CodexRecord[]) => {
  if (!left.length) return right;
  if (!right.length) return left;
  const byId = new Map<string, CodexRecord>();
  for (const record of left) byId.set(record.id, record);
  for (const record of right) byId.set(record.id, record);
  return orderRecords([...byId.values()]);
};

export const threadDisplayRecords = (
  _threadId: string,
  thread: Pick<ThreadDetail, "records"> | undefined
) => thread?.records ?? [];

export const recordSortValue = (record: CodexRecord) => {
  const timestamp = Date.parse(record.timestamp ?? "");
  if (Number.isFinite(timestamp)) return timestamp;
  if (typeof record.order === "number") return record.order;
  return 0;
};

const orderRecords = (records: CodexRecord[]) =>
  records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => compareRecords(left.record, right.record) || left.index - right.index)
    .map((entry) => entry.record);

const compareRecords = (left: CodexRecord, right: CodexRecord) => {
  const leftTime = recordTimestampMs(left);
  const rightTime = recordTimestampMs(right);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
  if (leftTime !== null && rightTime === null) return -1;
  if (leftTime === null && rightTime !== null) return 1;
  const leftOrder = typeof left.order === "number" ? left.order : Number.MAX_SAFE_INTEGER;
  const rightOrder = typeof right.order === "number" ? right.order : Number.MAX_SAFE_INTEGER;
  return leftOrder === rightOrder ? 0 : leftOrder - rightOrder;
};

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

export const isTaskCompleteRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return record.type === "event_msg" && payload?.type === "task_complete";
};

export const taskCompletionNotificationKey = (threadId: string, record: CodexRecord) => {
  const payload = asRecord(record.payload);
  const turnId = stringField(payload, "turn_id") ?? stringField(payload, "turnId");
  return turnId ? `${threadId}:${turnId}` : `${threadId}:${record.id}`;
};

export const taskCompleteNotification = (
  thread: ThreadSummary,
  record: CodexRecord,
  records: CodexRecord[]
): TaskCompleteNotification => {
  const payload = asRecord(record.payload);
  const durationMs = typeof payload?.duration_ms === "number" ? payload.duration_ms : undefined;
  const duration = typeof durationMs === "number" ? formatStatusDuration(durationMs) : undefined;
  const message = usefulTaskCompleteMessage(payload)
    ?? latestFinalAnswerText(records, record)
    ?? "Task completed.";
  return {
    title: duration ? `Codex task complete · 运行时间 ${duration}` : "Codex task complete",
    body: notificationText(message),
    threadId: thread.threadId,
    duration
  };
};

export const usefulTaskCompleteMessage = (payload: Record<string, unknown> | null | undefined) => {
  const lastAgentMessage = stringField(payload, "last_agent_message") ?? stringField(payload, "lastAgentMessage");
  if (lastAgentMessage) return lastAgentMessage;
  const message = stringField(payload, "message");
  if (!message || /^(task|turn)?\s*completed\.?$/i.test(message.trim())) return null;
  return message;
};

export const latestFinalAnswerText = (records: CodexRecord[], taskRecord: CodexRecord) => {
  const taskPayload = asRecord(taskRecord.payload);
  const taskTurnId = stringField(taskPayload, "turn_id") ?? stringField(taskPayload, "turnId");
  const taskOrder = recordSortValue(taskRecord);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const recordTurnId = turnIdFromRecord(record);
    if (recordSortValue(record) > taskOrder) continue;
    if (taskTurnId && recordTurnId && recordTurnId !== taskTurnId) continue;
    const text = finalAnswerTextFromRecord(record);
    if (text) return text;
  }
  return null;
};

export const finalAnswerTextFromRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  if (!payload) return null;
  if (
    record.type === "event_msg"
    && payload.type === "agent_message"
    && payload.phase === "final_answer"
  ) {
    return stringField(payload, "message") ?? null;
  }
  if (
    record.type === "response_item"
    && payload.type === "message"
    && payload.role === "assistant"
    && payload.phase === "final_answer"
  ) {
    return messageTextFromPayload(payload);
  }
  return null;
};

export const messageTextFromPayload = (payload: Record<string, unknown>) => {
  const direct = stringField(payload, "message") ?? stringField(payload, "text");
  if (direct) return direct;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const parts = content.flatMap((item) => {
    const record = asRecord(item);
    return stringField(record, "text")
      ?? stringField(record, "input_text")
      ?? stringField(record, "output_text")
      ?? [];
  });
  return parts.length ? parts.join("\n") : null;
};

export const turnIdFromRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return stringField(payload, "turn_id")
    ?? stringField(payload, "turnId")
    ?? (typeof record.id === "string" ? record.id.match(/^app:[^:]+:([^:]+):/)?.[1] : undefined);
};

export const notificationText = (value: string) => {
  const text = compactLine(value);
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
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
      || isContextCompactionType(payload?.type)
    );
};

export const isSimpleMainView = (view: CodexRecordView) => {
  if (view.role === "error") return true;
  if (view.role === "user" || view.role === "codex") return true;
  const payload = asRecord(view.record.payload);
  if (view.record.type === "event_msg" && isContextCompactionType(payload?.type)) return true;
  if (view.record.type !== "response_item") return false;
  if (payload?.type === "file_change") return false;
  if (payload?.type !== "message") return true;
  return payload.role === "user" || payload.role === "assistant";
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

export const latestUserTurnStatusScope = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (!isUserInputRecord(records[index])) continue;
    const record = records[index];
    return {
      key: record.id,
      label: `after ${formatStatusScopeTime(record.timestamp)}`,
      records: records.slice(index + 1)
    };
  }
  return {
    key: "thread",
    label: "thread status",
    records
  };
};

export const isUserInputRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  if (!payload) return false;
  if (record.type === "event_msg") return payload.type === "user_message";
  return record.type === "response_item" && payload.type === "message" && payload.role === "user";
};

export const formatStatusScopeTime = (timestamp: string | undefined) =>
  timestamp ? `user message at ${formatDate(timestamp)}` : "latest user message";

export const activityStatusesFromRecords = (records: CodexRecord[]): ActivityStatusView[] => {
  const statuses = new Map<string, ActivityStatusView>();
  let fileStatus: ActivityStatusView | null = null;
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (record.type === "response_item" && payload?.type === "file_change") {
      fileStatus = mergeFileChangeStatus(fileStatus, fileChangeActivityStatus(record, payload));
      continue;
    }
    const status = activityStatusFromRecord(record);
    if (status) statuses.set(status.key, status);
  }
  if (fileStatus) statuses.set(fileStatus.key, fileStatus);
  return [...statuses.values()].sort((left, right) => activityStatusPriority(left.key) - activityStatusPriority(right.key));
};

export const latestTurnStatusFromRecords = (records: CodexRecord[]): ActivityStatusView | null => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const status = activityStatusFromRecord(records[index]);
    if (status?.key === "turn") return status;
  }
  return null;
};

export const activityStatusFromRecord = (record: CodexRecord): ActivityStatusView | null => {
  const payload = asRecord(record.payload);
  const type = typeof payload?.type === "string" ? payload.type : "";
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

  if (type === "thread_rolled_back") {
    const turns = typeof payload.num_turns === "number" ? payload.num_turns : undefined;
    return {
      key: "rollback",
      label: "Rollback",
      status: "completed",
      at: record.timestamp,
      text: turns ? `Rolled back ${turns} turn${turns === 1 ? "" : "s"}` : "Thread rolled back"
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
      typeof payload.status === "string" ? payload.status : "completed",
      changed ? `${changed} file${changed === 1 ? "" : "s"}` : "files changed",
      fileChangeTotalsText(added, removed)
    ].filter(Boolean).join(" · "),
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
      failed ? "failed" : "completed",
      files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "files changed",
      fileChangeTotalsText(added, removed)
    ].filter(Boolean).join(" · "),
    files
  };
};

export const fileChangeTotalsText = (added: number, removed: number) => [
  `+${added}`,
  `-${removed}`
].filter(Boolean).join(" ");

export const activityStatusPriority = (key: string) => {
  const order: Record<string, number> = {
    turn: 0,
    goal: 1,
    usage: 2,
    files: 3,
    context: 4,
    rollback: 5,
    item: 6
  };
  return order[key] ?? 10;
};

export const activityStatusOverlayClass = (statuses: ActivityStatusView[]) => {
  if (statuses.some((status) => status.status === "failed")) return "failed";
  if (statuses.some((status) => status.status === "in_progress")) return "in_progress";
  if (statuses.some((status) => status.status === "pending")) return "pending";
  if (statuses.some((status) => status.status === "completed")) return "completed";
  return "idle";
};

export const activityStatusTitle = (statuses: ActivityStatusView[]) =>
  statuses.map((status) => `${status.label}: ${status.text}`).join("\n");

export const turnUiStateFromStatus = (
  turnStatus: ActivityStatusView | null,
  running: boolean
): TurnUiState => {
  if (running) {
    return {
      kind: "running",
      label: "Running",
      title: turnStatus
        ? `Running · ${turnStatus.text}`
        : "Running current turn"
    };
  }

  if (turnStatus) {
    if (turnStatus.label.toLowerCase().includes("abort")) {
      return {
        kind: "aborted",
        label: "Aborted",
        title: `${turnStatus.label} · ${turnStatus.text}`
      };
    }
    if (turnStatus.status === "failed") {
      return {
        kind: "failed",
        label: turnStatus.label || "Failed",
        title: `${turnStatus.label || "Failed"} · ${turnStatus.text}`
      };
    }
    if (turnStatus.status === "pending" || turnStatus.status === "in_progress") {
      return {
        kind: "running",
        label: turnStatus.label || "Running",
        title: `${turnStatus.label || "Running"} · ${turnStatus.text}`
      };
    }
    if (turnStatus.status === "completed") {
      return {
        kind: "completed",
        label: turnStatus.label || "Done",
        title: `${turnStatus.label || "Done"} · ${turnStatus.text}`
      };
    }
  }

  return {
    kind: "idle",
    label: "Idle",
    title: "Idle"
  };
};

export const formatTokenStatus = (payload: Record<string, unknown>) => {
  const info = asRecord(payload.info);
  const usage = asRecord(info?.last_token_usage);
  if (!usage) return "Token usage updated";
  const total = typeof usage.total_tokens === "number" ? `total ${formatCompactNumber(usage.total_tokens)}` : null;
  const input = typeof usage.input_tokens === "number" ? `input ${formatCompactNumber(usage.input_tokens)}` : null;
  const output = typeof usage.output_tokens === "number" ? `output ${formatCompactNumber(usage.output_tokens)}` : null;
  const context = typeof info?.model_context_window === "number" ? `window ${formatCompactNumber(info.model_context_window)}` : null;
  return [total, input, output, context].filter(Boolean).join(" · ") || "Token usage updated";
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
  if (normalized === "pending" || normalized === "queued") return "pending";
  if (normalized === "failed" || normalized === "error" || normalized === "errored" || normalized === "aborted") return "failed";
  if (normalized === "completed" || normalized === "complete" || normalized === "success" || normalized === "succeeded") return "completed";
  return undefined;
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
