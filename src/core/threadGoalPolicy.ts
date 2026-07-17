import type { ProxyInput } from "../shared/inputTypes.js";
import type {
  ThreadGoalRunPolicy,
  ThreadGoalStatus,
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

export const appServerThreadGoalFromValue = (goal: Record<string, unknown>) => {
  if (
    typeof goal.threadId !== "string"
    || typeof goal.objective !== "string"
    || !isThreadGoalStatus(goal.status)
    || !(typeof goal.tokenBudget === "number" || goal.tokenBudget === null)
    || !isFiniteNumber(goal.tokensUsed)
    || !isFiniteNumber(goal.timeUsedSeconds)
    || !isFiniteNumber(goal.createdAt)
    || !isFiniteNumber(goal.updatedAt)
  ) return null;
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt
  };
};

export const threadGoalPatchFromValue = (goal: Record<string, unknown>) => ({
  ...(typeof goal.threadId === "string" ? { threadId: goal.threadId } : {}),
  ...(typeof goal.objective === "string" ? { objective: goal.objective } : {}),
  ...(isThreadGoalStatus(goal.status) ? { status: goal.status } : {}),
  ...(typeof goal.tokenBudget === "number" || goal.tokenBudget === null ? { tokenBudget: goal.tokenBudget } : {}),
  ...(isFiniteNumber(goal.tokensUsed) ? { tokensUsed: goal.tokensUsed } : {}),
  ...(isFiniteNumber(goal.timeUsedSeconds) ? { timeUsedSeconds: goal.timeUsedSeconds } : {}),
  ...(isFiniteNumber(goal.createdAt) ? { createdAt: goal.createdAt } : {}),
  ...(isFiniteNumber(goal.updatedAt) ? { updatedAt: goal.updatedAt } : {})
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
  const tokenBudget = numberValue(goal?.tokenBudget);
  const budget = tokenBudget == null ? "" : ` (budget ${tokenBudget} tokens)`;
  return `Goal ${status}: ${objective}${budget}`;
};

export const threadGoalThreadId = (
  payload: Record<string, unknown> | null,
  goal: Record<string, unknown> | null
) =>
  stringValue(payload?.threadId)
  ?? stringValue(goal?.threadId);

export const threadGoalRecordMatchesThread = (
  payload: Record<string, unknown> | null,
  goal: Record<string, unknown> | null,
  threadId: string
) => {
  const payloadThreadId = stringValue(payload?.threadId);
  const goalThreadId = stringValue(goal?.threadId);
  return payloadThreadId === threadId || goalThreadId === threadId || (!payloadThreadId && !goalThreadId);
};

export const threadGoalsEqual = (
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null
) => {
  if (!left || !right) return false;
  return normalizedGoalObjective(left) === normalizedGoalObjective(right)
    && normalizedGoalStatus(left) === normalizedGoalStatus(right)
    && normalizedGoalTokenBudget(left) === normalizedGoalTokenBudget(right)
    && numberValue(left.tokensUsed) === numberValue(right.tokensUsed)
    && numberValue(left.timeUsedSeconds) === numberValue(right.timeUsedSeconds)
    && numberValue(left.createdAt) === numberValue(right.createdAt)
    && numberValue(left.updatedAt) === numberValue(right.updatedAt);
};

export const threadGoalTimestamp = (goal: Record<string, unknown> | null) =>
  timestampFromEpochSeconds(goal?.updatedAt)
  ?? timestampFromEpochSeconds(goal?.createdAt)
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
  numberValue(goal.tokenBudget) ?? null;

const timestampFromEpochSeconds = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value * 1000).toISOString();
};

const numberValue = (value: unknown) => typeof value === "number" ? value : undefined;
const stringValue = (value: unknown) => typeof value === "string" ? value : undefined;
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isThreadGoalStatus = (value: unknown): value is ThreadGoalStatus =>
  value === "active"
  || value === "paused"
  || value === "blocked"
  || value === "usageLimited"
  || value === "budgetLimited"
  || value === "complete";
