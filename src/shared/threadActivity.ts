import { asRecord, type CodexRecord } from "./recordTypes.js";

/** Maximum amount of transcript text allowed in a compact activity title. */
export const threadActivityTitleMaxLength = 160;

/**
 * Derive the small, cross-authority title used by the desktop activity feed.
 *
 * A Goal is thread-level state, so it wins over the latest ordinary user
 * message. The returned value is intentionally a compact display hint rather
 * than transcript data.
 */
export const threadActivityTitleFromRecords = (records: CodexRecord[], threadId?: string) => {
  const goalTitle = latestGoalActivityTitle(records, threadId);
  if (goalTitle) return goalTitle;

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const text = userInputText(records[index]);
    const compacted = compactActivityText(text);
    if (compacted) return compacted;
  }

  return undefined;
};

/**
 * Return the newest visible Agent message for compact activity consumers.
 * Commentary and final answers share one timeline; whichever record appears
 * last in the canonical record order wins.
 */
export const latestAgentMessageFromRecords = (records: CodexRecord[]) => {
  let latest: string | undefined;
  for (const record of records) {
    const text = agentMessageText(record);
    if (text) latest = compactActivityText(text);
  }
  return latest;
};

export const isAgentActivityRecord = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  if (!payload) return false;
  if (record.type === "event_msg") {
    return (
      (payload.type === "agent_message"
        || (payload.type === "message" && payload.role === "assistant"))
      && (payload.phase === "commentary" || payload.phase === "final_answer")
    );
  }
  return record.type === "response_item"
    && payload.type === "message"
    && payload.role === "assistant"
    && (payload.phase === "commentary" || payload.phase === "final_answer");
};

const latestGoalActivityTitle = (records: CodexRecord[], threadId?: string) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = asRecord(records[index].payload);
    if (!payload) continue;
    const type = typeof payload?.type === "string" ? payload.type : "";
    if (type !== "thread_goal_updated" && type !== "thread_goal_cleared") continue;

    const goal = asRecord(payload?.goal);
    if (!goalRecordMatchesThread(payload, goal, threadId)) continue;
    if (type === "thread_goal_cleared") return undefined;

    const objective = typeof goal?.objective === "string" ? compactActivityText(goal.objective) : "";
    const status = typeof goal?.status === "string" && goal.status ? goal.status : "active";
    if (!objective || status === "complete") return undefined;
    return compactActivityText(`Goal: ${objective}`);
  }

  return undefined;
};

const userInputText = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  if (!payload) return "";

  if (payload.type === "user_message") {
    if (typeof payload.message === "string") return payload.message;
    return hasImages(payload.images) ? "[image]" : "";
  }

  if (payload.type !== "message" || payload.role !== "user") return "";
  if (typeof payload.message === "string") return payload.message;

  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .map((item) => {
      const block = asRecord(item);
      if (!block) return null;
      if (typeof block.text === "string") return block.text;
      if (typeof block.input_text === "string") return block.input_text;
      if (typeof block.output_text === "string") return block.output_text;
      return null;
    })
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
  if (text) return text;
  return hasImages(payload.images) || content.some(isImageContent) ? "[image]" : "";
};

const agentMessageText = (record: CodexRecord) => {
  if (!isAgentActivityRecord(record)) return "";
  const payload = asRecord(record.payload);
  if (!payload) return "";
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.text === "string") return payload.text;

  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .map((item) => {
      const block = asRecord(item);
      if (!block) return null;
      if (typeof block.text === "string") return block.text;
      if (typeof block.output_text === "string") return block.output_text;
      if (typeof block.input_text === "string") return block.input_text;
      return null;
    })
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
};

const compactActivityText = (value: string) => {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (!compacted) return "";
  if (compacted.length <= threadActivityTitleMaxLength) return compacted;
  return `${compacted.slice(0, threadActivityTitleMaxLength - 1).trimEnd()}…`;
};

const hasImages = (value: unknown) => Array.isArray(value) && value.length > 0;

const isImageContent = (value: unknown) => {
  const content = asRecord(value);
  return content?.type === "input_image"
    || content?.type === "output_image"
    || content?.type === "image";
};

const goalRecordMatchesThread = (
  payload: Record<string, unknown>,
  goal: Record<string, unknown> | null,
  threadId?: string
) => {
  if (!threadId) return true;
  const payloadThreadId = typeof payload.threadId === "string" ? payload.threadId : undefined;
  const goalThreadId = typeof goal?.threadId === "string" ? goal.threadId : undefined;
  return payloadThreadId === threadId || goalThreadId === threadId || (!payloadThreadId && !goalThreadId);
};
