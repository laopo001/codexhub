import type { ThreadGoalUpdate } from "../../shared/threadTypes.js";
import type { GoalDialogState } from "../types.js";

export const goalUpdateFromDialog = (
  dialog: Pick<GoalDialogState, "kind" | "objective" | "targetRemainingPercent">
): ThreadGoalUpdate => {
  const objective = dialog.objective.trim();
  if (dialog.kind === "goal") {
    return {
      objective
    };
  }
  return {
    objective,
    status: "active",
    runPolicy: {
      type: "consumeUntilWeeklyRemainingAtOrBelow",
      targetRemainingPercent: Number(dialog.targetRemainingPercent.trim())
    }
  };
};
