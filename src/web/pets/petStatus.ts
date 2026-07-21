import { asRecord, type CodexRecord } from "../../shared/recordTypes.js";
import type { OpenThreadState } from "../types.js";
import type { PetAnimationState } from "./petAtlas.js";

export type PetActivityStatus = "needs_input" | "blocked" | "ready" | "running" | "idle";

export type PetActivity = {
  threadId: string;
  title: string;
  workingDirectory: string;
  updatedAt: string;
  status: PetActivityStatus;
};

const statusPriority: Record<PetActivityStatus, number> = {
  needs_input: 0,
  blocked: 1,
  ready: 2,
  running: 3,
  idle: 4,
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

const failedRecord = (record: CodexRecord) => {
  if (record.type === "error") return true;
  const payload = asRecord(record.payload);
  if (!payload) return false;
  const type = payloadType(record);
  if (type === "turn_aborted") return true;
  if (asRecord(payload.error)?.message) return true;
  return normalizedStatus(payload.status) === "failed"
    && type !== "file_change"
    && type !== "user_input_request";
};

const threadHasPendingInteraction = (records: CodexRecord[]) =>
  records.some(pendingInteraction);

const threadLatestTurnFailed = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (failedRecord(record)) return true;
    if (userMessage(record)) return false;
  }
  return false;
};

export const petStatusForThread = (thread: OpenThreadState, ready: boolean): PetActivityStatus => {
  if (threadHasPendingInteraction(thread.records)) return "needs_input";
  if (!thread.running && threadLatestTurnFailed(thread.records)) return "blocked";
  if (ready) return "ready";
  if (thread.running || thread.status === "running") return "running";
  return "idle";
};

export const derivePetActivities = (threads: OpenThreadState[], readyThreadIds: ReadonlySet<string>) =>
  threads
    .map<PetActivity>((thread) => ({
      threadId: thread.threadId,
      title: thread.title || thread.workingDirectory.split(/[\\/]/).filter(Boolean).pop() || thread.threadId,
      workingDirectory: thread.workingDirectory,
      updatedAt: thread.updatedAt,
      status: petStatusForThread(thread, readyThreadIds.has(thread.threadId)),
    }))
    .sort((left, right) => statusPriority[left.status] - statusPriority[right.status]
      || right.updatedAt.localeCompare(left.updatedAt));

export const headlinePetStatus = (activities: PetActivity[]): PetActivityStatus =>
  activities.find((activity) => activity.status !== "idle")?.status ?? "idle";

export const petAnimationForStatus = (status: PetActivityStatus): PetAnimationState => {
  if (status === "needs_input") return "waiting";
  if (status === "blocked") return "failed";
  if (status === "ready") return "waving";
  if (status === "running") return "running";
  return "idle";
};

export const petStatusLabel = (status: PetActivityStatus) => {
  if (status === "needs_input") return "Needs input";
  if (status === "blocked") return "Blocked";
  if (status === "ready") return "Ready";
  if (status === "running") return "Running";
  return "Idle";
};
