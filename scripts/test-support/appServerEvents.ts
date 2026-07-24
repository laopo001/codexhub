import type { SessionEventInput } from "../../src/shared/threadTypes.js";

export type TestTurnStatus = "completed" | "failed" | "interrupted" | "inProgress";

type TestTurnOptions = {
  status?: TestTurnStatus;
  error?: unknown;
  errorMessage?: string;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  items?: unknown[];
};

export const appServerTurn = (
  id: string,
  {
    status = "completed",
    error,
    errorMessage,
    startedAt = 1,
    completedAt = status === "inProgress" ? null : 2,
    durationMs = status === "inProgress" ? null : 1000,
    items = []
  }: TestTurnOptions = {}
) => ({
  id,
  status,
  itemsView: "full",
  error: error ?? (status === "failed" ? { message: errorMessage ?? "Turn failed" } : null),
  startedAt,
  completedAt,
  durationMs,
  items
});

export const executionChanged = (
  threadId: string,
  running: boolean,
  turnId?: string
): SessionEventInput => ({
  type: "thread_execution_changed",
  threadId,
  running,
  ...(turnId ? { turnId } : {}),
  heartbeat: false
});

export const turnCompleted = (
  threadId: string,
  turnId: string,
  options: TestTurnOptions = {}
): SessionEventInput => ({
  type: "thread_event",
  threadId,
  heartbeat: false,
  message: {
    method: "turn/completed",
    params: {
      threadId,
      turn: appServerTurn(turnId, options)
    }
  }
});

export const turnSnapshot = (
  threadId: string,
  turns: unknown[]
): SessionEventInput => ({
  type: "thread_turns_snapshot",
  threadId,
  heartbeat: false,
  turns
});
