import { asRecord } from "./recordTypes.js";

export type PlanProgress = {
  currentStep: number;
  totalSteps: number;
  currentIndex: number;
  allCompleted: boolean;
};

export type PlanProgressSummary = Pick<PlanProgress, "currentStep" | "totalSteps">;

const normalizePlanStatus = (status: unknown) => {
  if (typeof status !== "string") return undefined;
  const normalized = status.trim().replace(/[-\s]+/g, "_").toLowerCase();
  if (normalized === "completed" || normalized === "complete" || normalized === "success" || normalized === "succeeded") {
    return "completed" as const;
  }
  if (normalized === "inprogress" || normalized === "in_progress" || normalized === "running") {
    return "in_progress" as const;
  }
  if (normalized === "pending" || normalized === "queued") return "pending" as const;
  return undefined;
};

export const planProgressFromStatuses = (statuses: readonly unknown[]): PlanProgress | undefined => {
  const normalizedStatuses = statuses.flatMap((status) => {
    const normalized = normalizePlanStatus(status);
    return normalized ? [normalized] : [];
  });
  if (!normalizedStatuses.length) return undefined;

  const completed = normalizedStatuses.filter((status) => status === "completed").length;
  const activeIndex = normalizedStatuses.findIndex((status) => status === "in_progress");
  const pendingIndex = normalizedStatuses.findIndex((status) => status === "pending");
  const currentIndex = activeIndex >= 0
    ? activeIndex
    : pendingIndex >= 0
      ? pendingIndex
      : normalizedStatuses.length - 1;
  const allCompleted = completed === normalizedStatuses.length;

  return {
    currentStep: allCompleted ? normalizedStatuses.length : currentIndex + 1,
    totalSteps: normalizedStatuses.length,
    currentIndex,
    allCompleted
  };
};

export const planProgressFromPlan = (plan: unknown): PlanProgress | undefined => {
  if (!Array.isArray(plan)) return undefined;
  const statuses = plan.flatMap((item) => {
    const step = asRecord(item);
    return typeof step?.step === "string" && step.step.trim() ? [step.status] : [];
  });
  return planProgressFromStatuses(statuses);
};

export const planProgressSummary = (progress: PlanProgress): PlanProgressSummary => ({
  currentStep: progress.currentStep,
  totalSteps: progress.totalSteps
});

export const formatPlanProgress = (progress: Pick<PlanProgress, "currentStep" | "totalSteps">) =>
  `${progress.currentStep}/${progress.totalSteps}`;
