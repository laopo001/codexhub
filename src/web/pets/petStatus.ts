import { asRecord, type CodexRecord } from "../../shared/recordTypes.js";
import type { OpenThreadState } from "../types.js";
import type { PetAnimationState } from "./petAtlas.js";

export type PetActivityStatus = "needs_input" | "blocked" | "running" | "idle";

export type PetActivity = {
  threadId: string;
  title: string;
  workingDirectory: string;
  updatedAt: string;
  status: PetActivityStatus;
};

export const petCompletionJumpDurationMs = 3_000;

export type PetCompletionPhase = "none" | "jumping" | "waving";

export type PetCompletionState = {
  phase: PetCompletionPhase;
  jumpingUntilMs: number | null;
};

export type PetCompletionEvent =
  | { type: "completed"; nowMs: number }
  | { type: "sync"; nowMs: number; hasRunningThreads: boolean };

export const initialPetCompletionState = (): PetCompletionState => ({
  phase: "none",
  jumpingUntilMs: null,
});

export const transitionPetCompletionState = (
  state: PetCompletionState,
  event: PetCompletionEvent
): PetCompletionState => {
  if (event.type === "completed") {
    return {
      phase: "jumping",
      jumpingUntilMs: event.nowMs + petCompletionJumpDurationMs,
    };
  }
  if (state.phase === "jumping") {
    if (state.jumpingUntilMs !== null && event.nowMs < state.jumpingUntilMs) return state;
    return event.hasRunningThreads
      ? { phase: "waving", jumpingUntilMs: null }
      : initialPetCompletionState();
  }
  if (state.phase === "waving" && !event.hasRunningThreads) return initialPetCompletionState();
  return state;
};

export const hasRunningPetThreads = (threads: OpenThreadState[]) =>
  threads.some((thread) => thread.running || thread.status === "running");

const statusPriority: Record<PetActivityStatus, number> = {
  needs_input: 0,
  blocked: 1,
  running: 2,
  idle: 3,
};

const normalizedStatus = (value: unknown) =>
  typeof value === "string" ? value.trim().replace(/[-\s]+/g, "_").toLowerCase() : "";

const payloadType = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return typeof payload?.type === "string" ? payload.type : "";
};

const pendingInteraction = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  if (!payload) return false;
  const approval = asRecord(payload.approval);
  if (approval?.status === "pending") return true;
  const userInput = asRecord(payload.userInput);
  return payload.type === "user_input_request"
    && (userInput?.status === "pending" || normalizedStatus(payload.status) === "pending_user_input");
};

const userMessage = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  if (!payload) return false;
  if (payload.type === "user_message") return true;
  return payload.type === "message" && payload.role === "user";
};

const threadHasPendingInteraction = (records: CodexRecord[]) =>
  records.some(pendingInteraction);

const threadLatestTurnFailed = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (userMessage(record)) return false;
    const type = payloadType(record);
    if (type === "task_complete") return false;
    if (type === "turn_aborted") {
      const payload = asRecord(record.payload);
      return payload?.status !== "interrupted";
    }
    if (record.type === "error") return true;
  }
  return false;
};

export const petStatusForThread = (thread: OpenThreadState): PetActivityStatus => {
  if (threadHasPendingInteraction(thread.records)) return "needs_input";
  if (!thread.running && threadLatestTurnFailed(thread.records)) return "blocked";
  if (thread.running || thread.status === "running") return "running";
  return "idle";
};

export const derivePetActivities = (threads: OpenThreadState[]) =>
  threads
    .map<PetActivity>((thread) => ({
      threadId: thread.threadId,
      title: thread.title || thread.workingDirectory.split(/[\\/]/).filter(Boolean).pop() || thread.threadId,
      workingDirectory: thread.workingDirectory,
      updatedAt: thread.updatedAt,
      status: petStatusForThread(thread),
    }))
    .sort((left, right) => statusPriority[left.status] - statusPriority[right.status]
      || right.updatedAt.localeCompare(left.updatedAt));

export const headlinePetStatus = (activities: PetActivity[]): PetActivityStatus =>
  activities.find((activity) => activity.status !== "idle")?.status ?? "idle";

export const petAnimationForStatus = (status: PetActivityStatus): PetAnimationState => {
  if (status === "needs_input") return "waiting";
  if (status === "blocked") return "failed";
  if (status === "running") return "running";
  return "idle";
};

export const petAnimationForPresentation = (
  status: PetActivityStatus,
  options: {
    composerRecentlyChanged?: boolean;
    completionPhase?: PetCompletionPhase;
    dragDirection?: "left" | "right" | null;
  } = {}
): PetAnimationState => {
  if (options.dragDirection) return `running-${options.dragDirection}`;
  if (options.composerRecentlyChanged) return "waiting";
  if (options.completionPhase === "jumping") return "jumping";
  if (status === "needs_input" || status === "blocked") return petAnimationForStatus(status);
  if (options.completionPhase === "waving") return "waving";
  return petAnimationForStatus(status);
};

export const petStatusLabel = (status: PetActivityStatus) => {
  if (status === "needs_input") return "Needs input";
  if (status === "blocked") return "Blocked";
  if (status === "running") return "Running";
  return "Idle";
};
