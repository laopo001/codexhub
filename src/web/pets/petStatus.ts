import { asRecord, type CodexRecord } from "../../shared/recordTypes.js";
import type { MachineSummary, OpenThreadState, RuntimeSummary } from "../types.js";
import type { PetAnimationState } from "./petAtlas.js";

export type PetActivityStatus = "needs_input" | "blocked" | "running" | "idle";

export type PetActivity = {
  threadId: string;
  title: string;
  workingDirectory: string;
  updatedAt: string;
  status: PetActivityStatus;
  machineId?: string;
  machineLabel?: string;
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

export const hasRunningPetThreads = (
  threads: OpenThreadState[],
  runtimeList: RuntimeSummary[] = [],
  dialogThreads: OpenThreadState[] = [],
  machines: MachineSummary[] = []
) => threads.some((thread) => thread.running || thread.status === "running")
  || dialogThreads.some((thread) => thread.running || thread.status === "running")
  || runtimeList.some((runtime) => runtime.online && runtime.threads.some((thread) =>
    thread.running || thread.status === "running"
  ))
  || machines.some((machine) => machine.online && machine.activities?.some((activity) => activity.status === "running"));

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

type RuntimeThreadSummary = RuntimeSummary["threads"][number];
type MachinePetActivitySummary = NonNullable<MachineSummary["activities"]>[number];

type PetActivityCandidate = {
  detail?: OpenThreadState;
  activity?: MachinePetActivitySummary;
  machine?: MachineSummary;
  runtime?: RuntimeSummary;
  summary?: RuntimeThreadSummary;
};

const threadTitle = (title: string | undefined, workingDirectory: string, threadId: string) =>
  title || workingDirectory.split(/[\\/]/).filter(Boolean).pop() || threadId;

const machineTypeLabel = (type: MachineSummary["type"]) => {
  if (type === "registered") return "Registered";
  if (type === "ssh") return "SSH";
  return "Local";
};

const petMachineLabel = (machine: MachineSummary | undefined, runtime: RuntimeSummary | undefined) => {
  const name = machine?.name || machine?.hostname || runtime?.name || runtime?.hostname;
  if (!name) return undefined;
  return machine ? `${machineTypeLabel(machine.type)} · ${name}` : name;
};

/**
 * Build the pet feed from the current window plus every runtime snapshot.
 *
 * Runtime summaries deliberately do not carry records, so an unopened
 * remote thread can be classified as running/idle. Detailed open or dialog
 * threads overlay that summary and retain the richer needs-input/blocked
 * classification based on their records.
 */
export const derivePetActivities = (
  threads: OpenThreadState[],
  runtimeList: RuntimeSummary[] = [],
  machines: MachineSummary[] = [],
  dialogThreads: OpenThreadState[] = []
) => {
  const candidates = new Map<string, PetActivityCandidate>();
  const machineById = new Map(machines.map((machine) => [machine.machineId, machine]));
  for (const machine of machines) {
    for (const activity of machine.activities ?? []) {
      candidates.set(activity.threadId, { activity, machine });
    }
  }
  for (const runtime of runtimeList) {
    for (const summary of runtime.threads) {
      const current = candidates.get(summary.threadId);
      candidates.set(summary.threadId, {
        ...current,
        machine: machineById.get(runtime.machineId) ?? current?.machine,
        runtime,
        summary
      });
    }
  }
  for (const detail of [...threads, ...dialogThreads]) {
    const current = candidates.get(detail.threadId);
    candidates.set(detail.threadId, { ...current, detail });
  }

  return [...candidates.values()]
    .map<PetActivity>(({ activity, detail, machine: candidateMachine, runtime, summary }) => {
      const machineId = detail?.runtime.machineId
        ?? summary?.runtime.machineId
        ?? runtime?.machineId
        ?? candidateMachine?.machineId;
      const machine = machineById.get(machineId ?? "") ?? candidateMachine;
      const workingDirectory = detail?.workingDirectory
        ?? summary?.workingDirectory
        ?? activity?.workingDirectory
        ?? runtime?.workingDirectory
        ?? "";
      const status = detail
        ? petStatusForThread(detail)
        : runtime?.online && summary && (summary.running || summary.status === "running")
          ? "running"
          : activity?.status ?? "idle";
      const machineLabel = petMachineLabel(machine, runtime);
      return {
        threadId: detail?.threadId ?? summary?.threadId ?? activity?.threadId ?? "",
        title: threadTitle(
          detail?.title ?? summary?.title ?? activity?.title,
          workingDirectory,
          detail?.threadId ?? summary?.threadId ?? activity?.threadId ?? ""
        ),
        workingDirectory,
        updatedAt: detail?.updatedAt ?? summary?.updatedAt ?? activity?.updatedAt ?? runtime?.lastSeenAt ?? "",
        status,
        ...(machineId ? { machineId } : {}),
        ...(machineLabel ? { machineLabel } : {})
      };
    })
    .filter((activity) => activity.threadId.length > 0)
    .sort((left, right) => statusPriority[left.status] - statusPriority[right.status]
      || right.updatedAt.localeCompare(left.updatedAt));
};

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
