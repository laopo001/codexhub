import type { ProxyInput } from "../shared/inputTypes.js";
import type {
  ThreadGoalRunPolicy,
  ThreadGoalUpdate,
  ThreadRunOptions
} from "../shared/threadTypes.js";

export const goalUpdateFromInput = (input: ProxyInput, options: ThreadRunOptions): ThreadGoalUpdate => {
  const configuredObjective = typeof options.goalObjective === "string" ? options.goalObjective.trim() : "";
  const objective = configuredObjective || summarizeInput(input).trim();
  return {
    objective: objective ? objective.slice(0, 4000) : "Pursue the attached user request.",
    status: "active",
    ...(hasOwn(options, "goalTokenBudget") ? { tokenBudget: options.goalTokenBudget } : {})
  };
};

export const appServerGoalUpdate = (goal: ThreadGoalUpdate): ThreadGoalUpdate => ({
  ...(hasOwn(goal, "objective") ? { objective: goal.objective } : {}),
  ...(hasOwn(goal, "status") ? { status: goal.status } : {}),
  ...(hasOwn(goal, "tokenBudget") ? { tokenBudget: goal.tokenBudget } : {})
});

export const hasThreadGoalPatch = (goal: ThreadGoalUpdate) =>
  hasOwn(goal, "objective") || hasOwn(goal, "status") || hasOwn(goal, "tokenBudget");

export const goalUpdateCanStartRunPolicy = (goal: ThreadGoalUpdate) =>
  (!hasOwn(goal, "status") || goal.status === "active")
  && (hasOwn(goal, "runPolicy") || hasOwn(goal, "objective") || goal.status === "active");

export const goalRunPolicyStatusCanRun = (status: string | null | undefined, allowComplete = false) =>
  status === "active" || (allowComplete && status === "complete");

export const normalizeThreadGoalRunPolicy = (
  policy: ThreadGoalUpdate["runPolicy"]
): ThreadGoalRunPolicy | null => {
  if (!policy || policy.type !== "consumeUntilWeeklyRemainingAtOrBelow") return null;
  if (
    typeof policy.targetRemainingPercent !== "number"
    || !Number.isFinite(policy.targetRemainingPercent)
    || policy.targetRemainingPercent < 0
    || policy.targetRemainingPercent >= 100
  ) return null;
  return {
    type: "consumeUntilWeeklyRemainingAtOrBelow",
    targetRemainingPercent: policy.targetRemainingPercent
  };
};

export const weeklyGoalWrapUpObjective = "收尾工作";

export const formatPercent = (value: number) =>
  Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`;

export const formatThreadGoalMessage = (goal: Record<string, unknown> | null) => {
  const status = typeof goal?.status === "string" ? goal.status : "active";
  const objective = typeof goal?.objective === "string" && goal.objective.trim()
    ? goal.objective.trim()
    : "Untitled goal";
  const tokenBudget = numberValue(goal?.tokenBudget) ?? numberValue(goal?.token_budget);
  const budget = tokenBudget == null ? "" : ` (budget ${tokenBudget} tokens)`;
  return `Goal ${status}: ${objective}${budget}`;
};

export const threadGoalThreadId = (
  payload: Record<string, unknown> | null,
  goal: Record<string, unknown> | null
) =>
  stringValue(payload?.threadId)
  ?? stringValue(payload?.thread_id)
  ?? stringValue(goal?.threadId)
  ?? stringValue(goal?.thread_id);

export const threadGoalRecordMatchesThread = (
  payload: Record<string, unknown> | null,
  goal: Record<string, unknown> | null,
  threadId: string
) => {
  const payloadThreadId = stringValue(payload?.threadId) ?? stringValue(payload?.thread_id);
  const goalThreadId = stringValue(goal?.threadId) ?? stringValue(goal?.thread_id);
  return payloadThreadId === threadId || goalThreadId === threadId || (!payloadThreadId && !goalThreadId);
};

export const threadGoalsEqual = (
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null
) => {
  if (!left || !right) return false;
  return normalizedGoalObjective(left) === normalizedGoalObjective(right)
    && normalizedGoalStatus(left) === normalizedGoalStatus(right)
    && normalizedGoalTokenBudget(left) === normalizedGoalTokenBudget(right);
};

export const threadGoalTimestamp = (
  payload: Record<string, unknown>,
  goal: Record<string, unknown> | null
) =>
  timestampFromEpochOrIso(payload.timestamp, "millis")
  ?? timestampFromEpochOrIso(payload.createdAt ?? payload.created_at, "seconds")
  ?? timestampFromEpochOrIso(payload.updatedAt ?? payload.updated_at, "seconds")
  ?? timestampFromEpochOrIso(goal?.updatedAt ?? goal?.updated_at, "seconds")
  ?? timestampFromEpochOrIso(goal?.createdAt ?? goal?.created_at, "seconds")
  ?? new Date().toISOString();

const summarizeInput = (input: ProxyInput) => {
  if (typeof input === "string") return input;
  return input
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
};

const normalizedGoalObjective = (goal: Record<string, unknown>) =>
  typeof goal.objective === "string" ? goal.objective.trim() : "";

const normalizedGoalStatus = (goal: Record<string, unknown>) =>
  typeof goal.status === "string" && goal.status ? goal.status : "active";

const normalizedGoalTokenBudget = (goal: Record<string, unknown>) =>
  numberValue(goal.tokenBudget) ?? numberValue(goal.token_budget) ?? null;

const timestampFromEpochOrIso = (value: unknown, numericUnit: "millis" | "seconds") => {
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const millis = numericUnit === "millis" ? value : value * 1000;
  return new Date(millis).toISOString();
};

const numberValue = (value: unknown) => typeof value === "number" ? value : undefined;
const stringValue = (value: unknown) => typeof value === "string" ? value : undefined;
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
