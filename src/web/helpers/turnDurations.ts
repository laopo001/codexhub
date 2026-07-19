import { asRecord, type CodexRecord, type CodexRecordView } from "../../shared/recordTypes.js";

export const finalAnswerViewsWithTurnDurations = <T extends CodexRecordView>(
  views: T[],
  turnDurations: Map<string, number>
): T[] =>
  views.map((view) => {
    if (!isFinalAnswerView(view)) return view;
    if (view.status !== "completed" && view.status !== "failed") return view;
    const turnId = turnIdFromRecordView(view);
    const turnDurationMs = turnId ? turnDurations.get(turnId) : undefined;
    if (turnDurationMs == null) return view;
    return {
      ...view,
      statusDurationMs: turnDurationMs
    };
  });

export const turnDurationMapFromRecords = (records: CodexRecord[]) => {
  const durationByTurn = new Map<string, number>();
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (record.type !== "event_msg" || !payload) continue;
    const turnId = typeof payload.turn_id === "string"
      ? payload.turn_id
      : typeof payload.turnId === "string" ? payload.turnId : "";
    if (!turnId) continue;
    if (payload.type !== "task_complete" && payload.type !== "turn_aborted") continue;
    const direct = typeof payload.duration_ms === "number" && Number.isFinite(payload.duration_ms)
      ? Math.max(0, payload.duration_ms)
      : undefined;
    if (direct != null) durationByTurn.set(turnId, direct);
  }
  return durationByTurn;
};

export const turnDurationMsForTurn = (records: CodexRecord[], turnId: string) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const payload = asRecord(record.payload);
    if (record.type !== "event_msg") continue;
    if (payload?.type !== "task_complete" && payload?.type !== "turn_aborted") continue;
    const recordTurnId = typeof payload.turn_id === "string"
      ? payload.turn_id
      : typeof payload.turnId === "string" ? payload.turnId : "";
    if (recordTurnId !== turnId) continue;
    return typeof payload.duration_ms === "number" && Number.isFinite(payload.duration_ms)
      ? Math.max(0, payload.duration_ms)
      : undefined;
  }
  return undefined;
};

const isFinalAnswerView = (view: CodexRecordView) =>
  view.role === "codex" && view.label === "final_answer";

const turnIdFromRecordView = (view: CodexRecordView) => {
  const parts = view.record.id.split(":");
  return parts[0] === "app" && parts.length >= 3 ? parts[2] : "";
};
