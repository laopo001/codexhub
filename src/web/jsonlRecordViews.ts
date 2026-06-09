import { asRecord, type CodexRecord } from "../core/codexRecord.js";

export type JsonlLine = {
  line: number;
  text: string;
};

export type ThreadJsonl = {
  path?: string;
  lastLine: number;
  lines: JsonlLine[];
};

type ParsedJsonlLine = {
  line: JsonlLine;
  object: Record<string, unknown>;
  payload: Record<string, unknown> | null;
};

export const jsonlLinesToRecords = (threadId: string, jsonl: ThreadJsonl | undefined): CodexRecord[] => {
  if (!jsonl?.lines.length) return [];
  const parsedLines = jsonl.lines
    .slice()
    .sort((left, right) => left.line - right.line)
    .map(parseJsonlLine)
    .filter((line): line is ParsedJsonlLine => Boolean(line));

  const records: CodexRecord[] = [];
  let currentTurnId: string | undefined;

  for (const parsed of parsedLines) {
    const topType = typeof parsed.object.type === "string" ? parsed.object.type : "";
    if (topType === "turn_context") {
      currentTurnId = stringField(parsed.payload, "turn_id") ?? currentTurnId;
      records.push(topLevelRecord(recordBase(threadId, parsed, currentTurnId, topType), parsed, topType));
      continue;
    }

    const payloadType = typeof parsed.payload?.type === "string" ? parsed.payload.type : "";
    const turnId = stringField(parsed.payload, "turn_id")
      ?? stringField(parsed.payload, "turnId")
      ?? currentTurnId;
    const base = recordBase(threadId, parsed, turnId, payloadType || topType);

    if (topType === "event_msg") {
      const record = eventMsgRecord(base, parsed, payloadType);
      if (record) records.push(record);
      continue;
    }

    if (topType === "response_item") {
      const record = responseItemRecord(base, parsed, payloadType);
      if (record) records.push(record);
      continue;
    }

    if (topType === "compacted") {
      records.push({
        ...base,
        type: "event_msg",
        payload: {
          type: "compacted",
          message: "Context compacted"
        }
      });
      continue;
    }

    records.push(topLevelRecord(base, parsed, topType || "jsonl"));
  }

  return records;
};

const parseJsonlLine = (line: JsonlLine): ParsedJsonlLine | null => {
  try {
    const object = asRecord(JSON.parse(line.text));
    if (!object) return null;
    return {
      line,
      object,
      payload: asRecord(object.payload)
    };
  } catch {
    return null;
  }
};

const recordBase = (
  threadId: string,
  parsed: ParsedJsonlLine,
  turnId: string | undefined,
  kind: string
): Omit<CodexRecord, "type" | "payload"> => ({
  id: turnId
    ? `app:${threadId}:${turnId}:jsonl:${parsed.line.line}:${safeRecordKind(kind)}`
    : `jsonl:${threadId}:${parsed.line.line}:${safeRecordKind(kind)}`,
  timestamp: typeof parsed.object.timestamp === "string" ? parsed.object.timestamp : undefined,
  order: parsed.line.line,
  sourceThreadId: threadId,
  line: parsed.line.line,
  rawJsonl: parsed.object,
  rawLineText: parsed.line.text
});

const eventMsgRecord = (
  base: Omit<CodexRecord, "type" | "payload">,
  parsed: ParsedJsonlLine,
  payloadType: string
): CodexRecord | null => {
  if (!parsed.payload) return null;
  if (payloadType === "user_message" || payloadType === "agent_message" || payloadType === "token_count") {
    return {
      ...base,
      type: "event_msg",
      payload: { ...parsed.payload }
    };
  }

  if (payloadType === "patch_apply_end") {
    return {
      ...base,
      type: "response_item",
      payload: patchApplyEndPayload(parsed.payload)
    };
  }

  if (payloadType === "context_compacted") {
    return {
      ...base,
      type: "event_msg",
      payload: {
        ...parsed.payload,
        type: "context_compaction",
        message: "Context compacted"
      }
    };
  }

  if (payloadType === "thread_goal_updated") {
    return {
      ...base,
      type: "event_msg",
      payload: {
        ...parsed.payload,
        type: "thread_goal_updated",
        message: formatThreadGoalMessage(asRecord(parsed.payload.goal))
      }
    };
  }

  if (payloadType === "thread_goal_cleared") {
    return {
      ...base,
      type: "event_msg",
      payload: {
        ...parsed.payload,
        type: "thread_goal_cleared",
        message: typeof parsed.payload.message === "string" ? parsed.payload.message : "Goal cleared"
      }
    };
  }

  return {
    ...base,
    type: "event_msg",
    payload: {
      ...parsed.payload,
      message: formatEventMessage(parsed.payload, payloadType)
    }
  };
};

const responseItemRecord = (
  base: Omit<CodexRecord, "type" | "payload">,
  parsed: ParsedJsonlLine,
  payloadType: string
): CodexRecord | null => {
  if (!parsed.payload) return null;
  if (
    payloadType === "function_call"
    || payloadType === "function_call_output"
    || payloadType === "local_shell_call"
    || payloadType === "web_search_call"
    || payloadType === "image_generation_call"
    || payloadType === "reasoning"
  ) {
    return {
      ...base,
      type: "response_item",
      payload: { ...parsed.payload }
    };
  }

  if (payloadType === "custom_tool_call") {
    return {
      ...base,
      type: "response_item",
      payload: customToolCallPayload(parsed.payload)
    };
  }

  if (payloadType === "custom_tool_call_output") {
    return {
      ...base,
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: stringField(parsed.payload, "call_id"),
        output: typeof parsed.payload.output === "string" ? parsed.payload.output : stringify(parsed.payload.output)
      }
    };
  }

  return {
    ...base,
    type: "response_item",
    payload: { ...parsed.payload }
  };
};

const topLevelRecord = (
  base: Omit<CodexRecord, "type" | "payload">,
  parsed: ParsedJsonlLine,
  topType: string
): CodexRecord => ({
  ...base,
  type: "event_msg",
  payload: {
    type: topType,
    message: formatTopLevelMessage(parsed.payload, topType)
  }
});

const customToolCallPayload = (payload: Record<string, unknown>) => {
  const name = stringField(payload, "name") ?? "tool";
  const input = typeof payload.input === "string" ? payload.input : stringify(payload.input);
  return {
    type: "function_call",
    name,
    call_id: stringField(payload, "call_id"),
    status: stringField(payload, "status"),
    arguments: JSON.stringify({ input })
  };
};

const patchApplyEndPayload = (payload: Record<string, unknown>) => ({
  type: "file_change",
  call_id: stringField(payload, "call_id"),
  status: payload.success === false ? "failed" : "completed",
  stdout: typeof payload.stdout === "string" ? payload.stdout : "",
  stderr: typeof payload.stderr === "string" ? payload.stderr : "",
  changes: patchApplyChanges(payload.changes)
});

const patchApplyChanges = (value: unknown) => {
  const changes = asRecord(value);
  if (!changes) return [];
  return Object.entries(changes).map(([filePath, change]) => {
    const record = asRecord(change);
    return {
      path: filePath,
      kind: stringField(record, "type") ?? stringField(record, "kind") ?? "update",
      diff: typeof record?.unified_diff === "string" ? record.unified_diff : undefined
    };
  });
};

const formatThreadGoalMessage = (goal: Record<string, unknown> | null) => {
  const status = typeof goal?.status === "string" ? goal.status : "active";
  const objective = typeof goal?.objective === "string" && goal.objective.trim()
    ? goal.objective.trim()
    : "Untitled goal";
  const budget = typeof goal?.tokenBudget === "number" ? ` (budget ${goal.tokenBudget} tokens)` : "";
  return `Goal ${status}: ${objective}${budget}`;
};

const stringField = (record: Record<string, unknown> | null | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === "string" && value ? value : undefined;
};

const formatEventMessage = (payload: Record<string, unknown>, payloadType: string) => {
  if (typeof payload.message === "string" && payload.message.trim()) return payload.message;
  if (payloadType === "task_started") {
    return [
      "Turn started",
      stringField(payload, "turn_id") ? `turn: ${stringField(payload, "turn_id")}` : null,
      typeof payload.model_context_window === "number" ? `context: ${payload.model_context_window}` : null,
      typeof payload.collaboration_mode_kind === "string" ? `mode: ${payload.collaboration_mode_kind}` : null
    ].filter(Boolean).join("\n");
  }
  if (payloadType === "task_complete") {
    return [
      "Turn completed",
      typeof payload.duration_ms === "number" ? `duration: ${formatMilliseconds(payload.duration_ms)}` : null,
      typeof payload.time_to_first_token_ms === "number" ? `first token: ${formatMilliseconds(payload.time_to_first_token_ms)}` : null
    ].filter(Boolean).join("\n");
  }
  if (payloadType === "turn_aborted") {
    return [
      "Turn aborted",
      typeof payload.reason === "string" ? `reason: ${payload.reason}` : null,
      typeof payload.duration_ms === "number" ? `duration: ${formatMilliseconds(payload.duration_ms)}` : null
    ].filter(Boolean).join("\n");
  }
  if (payloadType === "thread_rolled_back") {
    const count = typeof payload.num_turns === "number" ? payload.num_turns : undefined;
    return count ? `Rolled back ${count} turn${count === 1 ? "" : "s"}` : "Thread rolled back";
  }
  if (payloadType === "item_completed") {
    const item = asRecord(payload.item);
    const itemType = typeof item?.type === "string" ? item.type : "item";
    return `Item completed: ${itemType}`;
  }
  return payloadType || "event";
};

const formatTopLevelMessage = (payload: Record<string, unknown> | null, topType: string) => {
  if (topType === "session_meta") {
    return [
      "Session metadata",
      typeof payload?.id === "string" ? `id: ${payload.id}` : null,
      typeof payload?.cwd === "string" ? `cwd: ${payload.cwd}` : null,
      typeof payload?.cli_version === "string" ? `cli: ${payload.cli_version}` : null,
      typeof payload?.source === "string" ? `source: ${payload.source}` : null
    ].filter(Boolean).join("\n");
  }
  if (topType === "turn_context") {
    return [
      "Turn context",
      stringField(payload, "turn_id") ? `turn: ${stringField(payload, "turn_id")}` : null,
      typeof payload?.cwd === "string" ? `cwd: ${payload.cwd}` : null,
      typeof payload?.model === "string" ? `model: ${payload.model}` : null
    ].filter(Boolean).join("\n");
  }
  return topType || "JSONL record";
};

const formatMilliseconds = (value: number) => {
  if (value >= 60_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.round((value % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
};

const safeRecordKind = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, "_") || "jsonl";

const stringify = (value: unknown) => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
