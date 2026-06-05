import { asRecord } from "../core/codexRecord.js";

export type UpdatePlanStatus = "completed" | "in_progress" | "pending" | "unknown";

export type UpdatePlanStepView = {
  step: string;
  status: string;
};

export type UpdatePlanView = {
  explanation?: string;
  steps: UpdatePlanStepView[];
};

export const parseUpdatePlanArguments = (args: Record<string, unknown> | null | undefined): UpdatePlanView | null => {
  if (!args) return null;

  const explanation = typeof args.explanation === "string" && args.explanation.trim()
    ? args.explanation.trim()
    : undefined;
  const steps = Array.isArray(args.plan)
    ? args.plan.flatMap((item): UpdatePlanStepView[] => {
      const record = asRecord(item);
      const step = typeof record?.step === "string" ? record.step.trim() : "";
      if (!step) return [];
      return [{
        step,
        status: typeof record?.status === "string" && record.status.trim()
          ? record.status.trim()
          : "pending"
      }];
    })
    : [];

  if (!explanation && !steps.length) return null;
  return { explanation, steps };
};

export const normalizeUpdatePlanStatus = (status: string): UpdatePlanStatus => {
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "completed" || normalized === "in_progress" || normalized === "pending") return normalized;
  return "unknown";
};

export const updatePlanStatusIcon = (status: string) => {
  const normalized = normalizeUpdatePlanStatus(status);
  if (normalized === "completed") return "✓";
  if (normalized === "in_progress") return "→";
  if (normalized === "pending") return "○";
  return "•";
};

export const updatePlanStatusLabel = (status: string) => {
  const normalized = normalizeUpdatePlanStatus(status);
  if (normalized === "completed") return "Completed";
  if (normalized === "in_progress") return "In progress";
  if (normalized === "pending") return "Pending";
  return status.trim() || "Unknown";
};

export const formatUpdatePlanCompact = (plan: UpdatePlanView) => {
  const lines = [
    plan.explanation,
    ...plan.steps.map((step) => {
      const normalized = normalizeUpdatePlanStatus(step.status);
      const suffix = normalized === "unknown" ? ` (${step.status})` : "";
      return `${updatePlanStatusIcon(step.status)} ${step.step}${suffix}`;
    })
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
};
