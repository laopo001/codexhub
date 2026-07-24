import { recordsToViews } from "./codexRecordView.js";
import type { ThreadState } from "./threadHubState.js";
import { fileChanges } from "./threadApprovalRecords.js";
import { orderCodexRecords, turnIdFromAppRecordId } from "../shared/recordIdentity.js";
import { asRecord, type CodexRecord } from "../shared/recordTypes.js";

export const codexRecordFromAppServerItem = (
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
        content: stringArray(item.content).join("\n"),
        ...(status ? { status } : {})
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
        appContext: item.appContext,
        pluginId: item.pluginId,
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
        status: appServerStatus(item.status),
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
        message: typeof item.text === "string" ? item.text : stringify(item),
        ...(status ? { status } : {})
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
        message: compactionStatus === "completed"
          ? "Compaction complete"
          : compactionStatus === "failed"
            ? "Compaction failed"
            : compactionStatus === "interrupted"
              ? "Compaction interrupted"
              : "Compacting"
      }
    };
  }

  if (!itemType) return null;

  // Preserve new app-server ThreadItem variants until they receive a richer
  // normalized representation. Dropping them would make the transcript lossy.
  return {
    ...base,
    type: "response_item",
    payload: {
      ...item,
      ...(status ? { status } : {})
    }
  };
};

export const withAppServerItemRecordTiming = (
  record: CodexRecord | null,
  options: { item?: Record<string, unknown>; existing?: CodexRecord } = {}
): CodexRecord | null => {
  if (!record) return null;
  const payload = asRecord(record.payload);
  if (!payload) return record;

  const itemTiming = appServerItemTiming(options.item);
  const existingPayload = asRecord(options.existing?.payload);
  const existingStatus = typeof existingPayload?.status === "string" ? existingPayload.status : undefined;
  const preservedStatus = existingStatus && (
    payload.status === undefined
    || (isFinishedTimingPayload(existingPayload ?? {}) && isActiveTimingPayload(payload))
  ) ? existingStatus : undefined;
  const startedAt = stringValue(payload.started_at)
    ?? stringValue(existingPayload?.started_at)
    ?? (isActiveTimingPayload(payload) ? record.timestamp : options.existing?.timestamp);
  const completedAt = stringValue(payload.completed_at)
    ?? stringValue(existingPayload?.completed_at)
    ?? (isFinishedTimingPayload(payload) ? record.timestamp : undefined);
  const durationMs = numberValue(payload.duration_ms)
    ?? itemTiming.durationMs
    ?? (startedAt && completedAt ? timestampDeltaMs(startedAt, completedAt) : undefined);

  if (!preservedStatus && !startedAt && !completedAt && durationMs == null) return record;
  return {
    ...record,
    payload: {
      ...payload,
      ...(preservedStatus ? { status: preservedStatus } : {}),
      ...(startedAt ? { started_at: startedAt } : {}),
      ...(completedAt ? { completed_at: completedAt } : {}),
      ...(durationMs == null ? {} : { duration_ms: durationMs })
    }
  };
};

const appServerItemTiming = (item: Record<string, unknown> | undefined) => {
  if (!item) return {};
  const durationMs = numberValue(item.durationMs);
  return {
    ...(durationMs == null ? {} : { durationMs: Math.max(0, durationMs) })
  };
};

const isActiveTimingPayload = (payload: Record<string, unknown>) => {
  const status = normalizedTimingStatus(payload.status);
  return status === "pending_approval"
    || status === "pending_user_input"
    || status === "in_progress";
};

const isFinishedTimingPayload = (payload: Record<string, unknown>) => {
  if (typeof payload.exit_code === "number") return true;
  const status = normalizedTimingStatus(payload.status);
  return status === "completed"
    || status === "approved"
    || status === "failed"
    || status === "declined"
    || status === "denied"
    || status === "interrupted"
    || status === "cancelled";
};

const normalizedTimingStatus = (status: unknown) =>
  typeof status === "string" ? status.trim().replace(/[-\s]+/g, "_").toLowerCase() : "";

export const codexRecordFromRawResponseItem = (
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

export const codexRecordFromAppServerUsage = (
  threadId: string,
  turnId: string,
  usage: Record<string, unknown>
): CodexRecord | null => {
  const last = asRecord(usage.last);
  if (!last) return null;
  const total = asRecord(usage.total);
  const normalizedLast = appServerTokenUsageBreakdown(last);
  const normalizedTotal = total ? appServerTokenUsageBreakdown(total) : null;
  const modelContextWindow = tokenUsageNumber(usage.modelContextWindow);
  return {
    id: `app:${threadId}:${turnId}:usage:${tokenUsageRecordKey(normalizedTotal ?? normalizedLast)}`,
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: normalizedLast,
        ...(normalizedTotal ? { total_token_usage: normalizedTotal } : {}),
        model_context_window: modelContextWindow
      }
    },
    sourceThreadId: threadId
  };
};

const tokenUsageRecordKey = (usage: NormalizedTokenUsage) => [
  usage.input_tokens,
  usage.cached_input_tokens,
  usage.output_tokens,
  usage.reasoning_output_tokens,
  usage.total_tokens
].join(":");

export const statusUsageRecordFromAppServerUsage = (
  thread: ThreadState,
  turnId: string,
  usage: Record<string, unknown>
): CodexRecord | null => {
  const last = asRecord(usage.last);
  if (!last) return null;
  const normalizedLast = appServerTokenUsageBreakdown(last);
  const total = asRecord(usage.total);
  const normalizedTotal = total ? appServerTokenUsageBreakdown(total) : null;
  const scopeRecord = latestUserMessageRecord(thread.records);
  const previousStatusRecord = latestStatusUsageRecord(thread.records);
  const previousStatusPayload = asRecord(previousStatusRecord?.payload);
  const previousScopeKey = typeof previousStatusPayload?.scope_key === "string"
    ? previousStatusPayload.scope_key
    : null;
  const scopeKey = scopeRecord?.id ?? previousScopeKey ?? `turn:${turnId}`;
  const scopeTurnId = scopeRecord
    ? turnIdFromAppRecordId(thread.threadId, scopeRecord.id) ?? turnId
    : previousStatusRecord
      ? turnIdFromAppRecordId(thread.threadId, previousStatusRecord.id) ?? turnId
      : turnId;
  const id = `app:${thread.threadId}:${scopeTurnId}:statusUsage:${stablePayloadKey(scopeKey)}`;
  const existing = thread.records.find((record) => record.id === id);
  const existingPayload = asRecord(existing?.payload);
  const existingUsage = internalTokenUsageBreakdown(asRecord(existingPayload?.usage) ?? {});
  const previousTotal = asRecord(existingPayload?.cumulative_usage)
    ?? asRecord(previousStatusPayload?.cumulative_usage);
  // App-server total usage is monotonic across model calls and compaction.
  // A fresh user scope has no existing record yet, so use the previous scope's
  // cumulative total as its baseline instead of counting the full prompt in `last`.
  const increment = normalizedTotal && previousTotal
    ? tokenUsageDelta(normalizedTotal, internalTokenUsageBreakdown(previousTotal), normalizedLast)
    : normalizedLast;
  const scopedUsage = tokenUsageAdd(existingUsage, increment);
  return {
    id,
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "status_usage",
      scope_key: scopeKey,
      usage: scopedUsage,
      ...(normalizedTotal ? { cumulative_usage: normalizedTotal } : {})
    },
    sourceThreadId: thread.threadId
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

const appServerTokenUsageBreakdown = (value: Record<string, unknown>) => ({
  input_tokens: tokenUsageNumber(value.inputTokens),
  cached_input_tokens: tokenUsageNumber(value.cachedInputTokens),
  output_tokens: tokenUsageNumber(value.outputTokens),
  reasoning_output_tokens: tokenUsageNumber(value.reasoningOutputTokens),
  total_tokens: tokenUsageNumber(value.totalTokens)
});

const internalTokenUsageBreakdown = (value: Record<string, unknown>) => ({
  input_tokens: tokenUsageNumber(value.input_tokens),
  cached_input_tokens: tokenUsageNumber(value.cached_input_tokens),
  output_tokens: tokenUsageNumber(value.output_tokens),
  reasoning_output_tokens: tokenUsageNumber(value.reasoning_output_tokens),
  total_tokens: tokenUsageNumber(value.total_tokens)
});

type NormalizedTokenUsage = ReturnType<typeof appServerTokenUsageBreakdown>;

const tokenUsageDelta = (
  current: NormalizedTokenUsage,
  previous: NormalizedTokenUsage,
  fallback: NormalizedTokenUsage
): NormalizedTokenUsage => {
  if (current.input_tokens < previous.input_tokens || current.output_tokens < previous.output_tokens) return fallback;
  return {
    input_tokens: current.input_tokens - previous.input_tokens,
    cached_input_tokens: Math.max(0, current.cached_input_tokens - previous.cached_input_tokens),
    output_tokens: current.output_tokens - previous.output_tokens,
    reasoning_output_tokens: Math.max(0, current.reasoning_output_tokens - previous.reasoning_output_tokens),
    total_tokens: Math.max(0, current.total_tokens - previous.total_tokens)
  };
};

const tokenUsageAdd = (left: NormalizedTokenUsage, right: NormalizedTokenUsage): NormalizedTokenUsage => {
  const inputTokens = left.input_tokens + right.input_tokens;
  const outputTokens = left.output_tokens + right.output_tokens;
  return {
    input_tokens: inputTokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: left.reasoning_output_tokens + right.reasoning_output_tokens,
    total_tokens: inputTokens + outputTokens
  };
};

const latestUserMessageRecord = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = asRecord(records[index].payload);
    if (records[index].type === "event_msg" && payload?.type === "user_message") return records[index];
  }
  return null;
};

const latestStatusUsageRecord = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (isStatusUsageRecord(records[index])) return records[index];
  }
  return null;
};

export const isStatusUsageRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return record.type === "event_msg" && payload?.type === "status_usage";
};

export const repositionStatusUsageRecords = (thread: ThreadState) => {
  for (const record of thread.records) {
    if (!isStatusUsageRecord(record)) continue;
    const payload = asRecord(record.payload);
    const scopeKey = typeof payload?.scope_key === "string" ? payload.scope_key : "";
    const scopeRecord = scopeKey ? thread.records.find((candidate) => candidate.id === scopeKey) : null;
    if (typeof scopeRecord?.order === "number") record.order = scopeRecord.order + 0.5;
  }
  thread.records = orderThreadRecords(thread.records);
};

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
  const value = item.command;
  return typeof value === "string" && value ? [value] : [];
};

const commandExecutionOutput = (item: Record<string, unknown>) => {
  return typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
};

const commandExecutionExitCode = (item: Record<string, unknown>) => {
  const value = item.exitCode;
  return typeof value === "number" ? value : null;
};

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

export const timestampFromMillis = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined;

export const timestampFromSeconds = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;

export const codexRecordsFromAppServerTurnLifecycle = (
  threadId: string,
  turnId: string,
  turn: Record<string, unknown>,
  fallbackTimestamp = new Date(0).toISOString()
): CodexRecord[] => {
  const status = appServerTurnStatus(turn.status);
  const startedAt = timestampFromSeconds(turn.startedAt);
  const completedAt = timestampFromSeconds(turn.completedAt);
  const terminalAt = completedAt ?? startedAt ?? fallbackTimestamp;
  const durationMs = numberValue(turn.durationMs)
    ?? (startedAt && completedAt ? timestampDeltaMs(startedAt, completedAt) : undefined);
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
  if (status === "completed") {
    records.push({
      id: `app:${threadId}:${turnId}:event:task_complete`,
      timestamp: terminalAt,
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: turnId,
        status,
        ...(durationMs == null ? {} : { duration_ms: durationMs })
      },
      sourceThreadId: threadId
    });
  }
  if (status === "failed" || status === "interrupted") {
    const error = asRecord(turn.error);
    const reason = status === "failed"
      ? typeof error?.message === "string" && error.message ? error.message : "Turn failed"
      : "Turn interrupted";
    records.push({
      id: `app:${threadId}:${turnId}:event:turn_aborted`,
      timestamp: terminalAt,
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        turn_id: turnId,
        status,
        reason,
        ...(error ? { error } : {}),
        ...(durationMs == null ? {} : { duration_ms: durationMs })
      },
      sourceThreadId: threadId
    });
  }
  return records;
};

export const isTaskStartedRecord = (record: CodexRecord) =>
  asRecord(record.payload)?.type === "task_started";

export const isTaskCompleteRecord = (record: CodexRecord) =>
  asRecord(record.payload)?.type === "task_complete";

export const isTurnTerminalRecord = (record: CodexRecord) => {
  const type = asRecord(record.payload)?.type;
  return type === "task_complete" || type === "turn_aborted";
};

const timestampDeltaMs = (startedAt: string, completedAt: string) => {
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  return Number.isFinite(startedMs) && Number.isFinite(completedMs)
    ? Math.max(0, completedMs - startedMs)
    : undefined;
};

const appServerTurnStatus = (value: unknown) =>
  value === "completed" || value === "failed" || value === "interrupted" || value === "inProgress"
    ? value
    : undefined;

const tokenUsageNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export const latestUsage = (records: CodexRecord[]) => {
  const views = recordsToViews(records);
  for (let i = views.length - 1; i >= 0; i -= 1) {
    if (views[i].usage) return views[i].usage;
  }
  return undefined;
};

export const latestRecordTimestamp = (records: CodexRecord[]) => {
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

export const orderThreadRecords = orderCodexRecords;

export const recordsEqual = (left: CodexRecord, right: CodexRecord) =>
  JSON.stringify(left) === JSON.stringify(right);

export const remapAppRecordThreadId = (record: CodexRecord, sourceThreadId: string, forkedThreadId: string): CodexRecord => ({
  ...record,
  id: record.id.replace(`app:${sourceThreadId}:`, `app:${forkedThreadId}:`),
  sourceThreadId: forkedThreadId
});

const numberValue = (value: unknown) => typeof value === "number" ? value : undefined;

const stringValue = (value: unknown) => typeof value === "string" ? value : undefined;

const stringify = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
