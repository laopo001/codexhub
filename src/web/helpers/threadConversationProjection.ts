import {
  activeGoalActivityScopeFromRecords,
  activityStatusSnapshotsFromRecords,
  combineRecordSources,
  latestThreadGoalFromRecords,
  latestTurnActivityScope,
  pendingUserMessageViews,
  threadDisplayRecords,
  threadExecutionIsRunning,
  userMessageHistoryFromRecords,
  withActivityStatusSnapshots
} from "../appHelpers.js";
import { conversationViewsFromRecords } from "./conversationViews.js";
import { finalAnswerViewsWithTurnDurations, turnDurationMapFromRecords } from "./turnDurations.js";
import { threadExecutionMeta } from "./threadExecution.js";
import type { CodexRecord } from "../../shared/recordTypes.js";
import type { OpenThreadState, ThreadExecutionMeta, ThreadGoalView, WebRecordView } from "../types.js";

export type ThreadConversationProjection = {
  displayRecords: CodexRecord[];
  views: WebRecordView[];
  userMessageHistory: string[];
  latestTurnActivity: ReturnType<typeof latestTurnActivityScope>;
  executionMeta: ThreadExecutionMeta;
  activeGoal: ThreadGoalView | null;
  activeGoalActivity: ReturnType<typeof activeGoalActivityScopeFromRecords>;
  statusScopeKey: string;
  canStop: boolean;
  showSendButton: boolean;
};

export const threadConversationProjection = (
  thread: OpenThreadState,
  options: {
    expandedToolBatchKeys?: Readonly<Record<string, string[]>>;
  } = {}
): ThreadConversationProjection => {
  const displayRecords = threadDisplayRecords(thread.threadId, thread);
  const goalRecords = combineRecordSources(displayRecords, thread.records);
  const latestTurnActivity = latestTurnActivityScope(displayRecords, thread.activeTurnId);
  const activeGoal = latestThreadGoalFromRecords(goalRecords, thread.threadId);
  const activeGoalActivity = activeGoal
    ? activeGoalActivityScopeFromRecords(displayRecords, thread.threadId)
    : null;
  const statusActivity = activeGoalActivity?.key
    ? activeGoalActivity
    : latestTurnActivity;
  const statusScopeKey = statusActivity.key ? `${thread.threadId}:${statusActivity.key}` : "";
  const expandedToolBatchKeys = new Set(options.expandedToolBatchKeys?.[thread.threadId] ?? []);
  const baseViews = conversationViewsFromRecords(displayRecords, expandedToolBatchKeys);
  const views = [
    ...withActivityStatusSnapshots(
      finalAnswerViewsWithTurnDurations(baseViews, turnDurationMapFromRecords(displayRecords)),
      activityStatusSnapshotsFromRecords(
        displayRecords,
        threadExecutionIsRunning(thread.running, latestTurnActivity.turnStatus)
          ? latestTurnActivity.turnId
          : undefined,
        thread.threadId
      )
    ),
    ...pendingUserMessageViews(thread.pendingUserMessages, thread.queuedTurns)
  ];
  return {
    displayRecords,
    views,
    userMessageHistory: userMessageHistoryFromRecords(
      displayRecords,
      thread.pendingUserMessages,
      thread.queuedTurns
    ),
    latestTurnActivity,
    executionMeta: threadExecutionMeta(thread, latestTurnActivity),
    activeGoal,
    activeGoalActivity,
    statusScopeKey,
    canStop: Boolean(
      thread.runtime.online
      && thread.runtime.runnable !== false
      && thread.status === "running"
      && thread.activeTurnId
    ),
    showSendButton: !thread.running
  };
};
