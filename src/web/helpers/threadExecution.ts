import { formatThreadDuration } from "./liveTime.js";
import {
  recordsHavePendingInteraction,
  threadExecutionIsRunning,
  type TurnActivityScope
} from "./records.js";
import type { OpenThreadState, ThreadExecutionMeta } from "../types.js";

export const threadExecutionMeta = (
  thread: OpenThreadState,
  activityScope: TurnActivityScope
): ThreadExecutionMeta => {
  const waiting = thread.status === "waiting";
  const running = !waiting && threadExecutionIsRunning(thread.running, activityScope.turnStatus);
  const needsInput = running && recordsHavePendingInteraction(activityScope.records);
  const startedAt = running
    ? activityScope.startedAt
    : activityScope.startedAt ?? activityScope.turnStatus?.at;
  const durationMs = running || waiting ? undefined : activityScope.durationMs;
  const status = waiting ? "waiting" : running ? "running" : "idle";
  const label = waiting ? "Waiting" : needsInput ? "Needs input" : running ? "Running" : "Idle";
  const duration = durationMs == null ? "" : formatThreadDuration(durationMs);
  return {
    status,
    label,
    duration,
    text: [label, duration].filter(Boolean).join(" · "),
    ...(running && startedAt ? { startedAt } : {})
  };
};
