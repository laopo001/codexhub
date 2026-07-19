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
  const startedByTurn = new Map<string, number>();
  const durationByTurn = new Map<string, number>();
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (record.type !== "event_msg" || !payload) continue;
    const turnId = typeof payload.turn_id === "string"
      ? payload.turn_id
      : typeof payload.turnId === "string" ? payload.turnId : "";
    if (!turnId) continue;
    if (payload.type === "task_started") {
      const startedMs = timestampMsFromRecord(record);
      if (startedMs != null) startedByTurn.set(turnId, startedMs);
      continue;
    }
    if (payload.type !== "task_complete" && payload.type !== "turn_aborted") continue;
    const direct = typeof payload.duration_ms === "number" && Number.isFinite(payload.duration_ms)
      ? Math.max(0, payload.duration_ms)
      : undefined;
    if (direct != null) {
      durationByTurn.set(turnId, direct);
      continue;
    }
    const startedMs = startedByTurn.get(turnId);
    const finishedMs = timestampMsFromRecord(record);
    if (startedMs != null && finishedMs != null) {
      durationByTurn.set(turnId, Math.max(0, finishedMs - startedMs));
    }
  }
  return durationByTurn;
};

const isFinalAnswerView = (view: CodexRecordView) =>
  view.role === "codex" && view.label === "final_answer";

const turnIdFromRecordView = (view: CodexRecordView) => {
  const parts = view.record.id.split(":");
  return parts[0] === "app" && parts.length >= 3 ? parts[2] : "";
};

const timestampMsFromRecord = (record: CodexRecord) => {
  const parsed = Date.parse(record.timestamp ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
};
