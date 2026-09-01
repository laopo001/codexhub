import React from "react";
import { Pencil, Target, X } from "lucide-react";
import {
  goalStatusClass,
  goalStatusControl,
  goalStatusLabel
} from "./appHelpers.js";
import { LiveGoalDuration } from "./helpers/liveTime.js";
import { threadConversationProjection } from "./helpers/threadConversationProjection.js";
import {
  ThreadComposerLeftActions,
  ThreadComposerRightActions
} from "./ThreadComposerChrome.js";
import { ThreadConversation } from "./ThreadConversation.js";
import type { AppWorkspaceViewModel } from "./viewModel.js";

export type WorkspaceThreadConversationProps = {
  workspace: AppWorkspaceViewModel;
  threadId: string;
};

export const WorkspaceThreadConversation = ({ workspace, threadId }: WorkspaceThreadConversationProps) => {
  const {
    addThreadFiles,
    clearThreadAttachments,
    clearThreadGoal,
    compactThread,
    commandPaletteByScope,
    commandPaletteLoadingScopes,
    composerDraftStore,
    dismissPendingUserMessage,
    cancelQueuedSubmission,
    expandedStatusKeys,
    expandedStatusTurns,
    forkingMessageKey,
    forkMessage,
    handleComposerKeyDown,
    insertThreadPathText,
    loadCommandPalette,
    loadOlderThread,
    messageRenderModes,
    openMessageSelectionToolbar,
    openSubagentThread,
    openThreadModelDialog,
    pasteThreadImages,
    removeThreadImage,
    removeThreadTextAttachment,
    resetComposerHistory,
    respondToApproval,
    respondToUserInput,
    reviewThread,
    resizeComposerTextarea,
    send,
    setExpandedStatusKeys,
    setExpandedStatusTurns,
    setExpandedToolBatchKeys,
    setGoalDialog,
    setImagePreview,
    openInspectMessage,
    setThreadComposerMode,
    setThreadModelDialogOpen,
    stopTurn,
    updateMessageRenderMode,
    updateThreadGoal,
    updateThreadInput
  } = workspace;

  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const activeThread = workspace.openThreads.find((thread) => thread.threadId === threadId);
  if (!activeThread) return null;
  const projection = threadConversationProjection(activeThread, {
    expandedToolBatchKeys: workspace.expandedToolBatchKeys
  });
  const activeGoal = projection.activeGoal;
  const activeGoalStatusControl = activeGoal ? goalStatusControl(activeGoal.status) : null;

  const goal = activeGoal ? (
    <div
      className={`goalStrip ${goalStatusClass(activeGoal.status)}`}
      title={`${goalStatusLabel(activeGoal.status)} · ${activeGoal.objective}`}
      aria-label={`${goalStatusLabel(activeGoal.status)}: ${activeGoal.objective}`}
    >
      <div className="goalStripMain">
        <Target className="goalStripIcon" aria-hidden="true" />
        <span className="goalStripLabel">{goalStatusLabel(activeGoal.status)}</span>
        <span className="goalStripObjective" title={activeGoal.objective}>{activeGoal.objective}</span>
        {activeGoal.timeUsedSeconds !== undefined ? (
          <span className="goalStripAge">
            <LiveGoalDuration
              status={activeGoal.status}
              running={activeThread.status === "running"}
              activeTurnStartedAt={projection.latestTurnActivity.startedAt}
              timeUsedSeconds={activeGoal.timeUsedSeconds}
              updatedAt={activeGoal.updatedAt}
            />
          </span>
        ) : null}
      </div>
      <div className="goalStripActions">
        <button
          type="button"
          className="goalIconButton"
          title="编辑目标"
          aria-label="编辑目标"
          onClick={() => {
            setGoalDialog({
              threadId,
              objective: activeGoal.objective,
              saving: false,
              error: ""
            });
          }}
        >
          <Pencil size={12} strokeWidth={2.2} aria-hidden="true" />
        </button>
        {activeGoalStatusControl ? (
          <button
            type="button"
            className="goalIconButton"
            title={activeGoalStatusControl.label}
            aria-label={activeGoalStatusControl.label}
            onClick={() => void updateThreadGoal(threadId, {
              status: activeGoalStatusControl.nextStatus
            })}
          >
            {activeGoalStatusControl.icon}
          </button>
        ) : null}
        <button
          type="button"
          className="goalIconButton danger"
          title="清除目标"
          aria-label="清除目标"
          onClick={() => void clearThreadGoal(threadId)}
        >
          <X size={13} strokeWidth={2.4} aria-hidden="true" />
        </button>
      </div>
    </div>
  ) : null;

  const leftActions = (
    <ThreadComposerLeftActions
      workspace={workspace}
      thread={activeThread}
      fileInputRef={fileInputRef}
    />
  );

  const threadControls = (
    <ThreadComposerRightActions workspace={workspace} thread={activeThread} />
  );

  return (
    <ThreadConversation
      className="threadWorkspacePane"
      thread={activeThread}
      views={projection.views}
      userMessageHistory={projection.userMessageHistory}
      composerDraftStore={composerDraftStore}
      commandPaletteByScope={commandPaletteByScope}
      commandPaletteLoadingScopes={commandPaletteLoadingScopes}
      executionMeta={projection.executionMeta}
      activeGoal={projection.activeGoal}
      messageRenderModes={messageRenderModes}
      expandedStatusKeys={expandedStatusKeys}
      expandedStatusTurns={expandedStatusTurns}
      fileInputRef={fileInputRef}
      showSendButton={projection.showSendButton}
      canStop={projection.canStop}
      forkingMessageKey={forkingMessageKey}
      goal={goal}
      leftActions={leftActions}
      threadControls={threadControls}
      onSend={send}
      onStop={stopTurn}
      onTerminateBackgroundTerminal={workspace.terminateBackgroundTerminal}
      onAddFiles={addThreadFiles}
      onClearAttachments={clearThreadAttachments}
      onRemoveImage={removeThreadImage}
      onRemoveTextAttachment={removeThreadTextAttachment}
      onCompactThread={compactThread}
      onReviewThread={reviewThread}
      onUpdateInput={updateThreadInput}
      onSetComposerMode={setThreadComposerMode}
      onHandleComposerKeyDown={handleComposerKeyDown}
      onInsertPathText={insertThreadPathText}
      onLoadCommandPalette={(_targetThreadId, machineId, cwd) => loadCommandPalette(machineId, cwd)}
      onLoadOlderThread={loadOlderThread}
      onPasteImages={pasteThreadImages}
      onResetComposerHistory={resetComposerHistory}
      onResizeComposerTextarea={(_targetThreadId, textarea) => resizeComposerTextarea(textarea)}
      onThreadModelDialogChange={(targetThreadId, open) => {
        if (open) {
          openThreadModelDialog(targetThreadId);
          return;
        }
        setThreadModelDialogOpen(false);
      }}
      setExpandedStatusKeys={setExpandedStatusKeys}
      setExpandedStatusTurns={setExpandedStatusTurns}
      onMessageRenderModeChange={updateMessageRenderMode}
      onMessageSelection={openMessageSelectionToolbar}
      onInspectMessage={openInspectMessage}
      onDismissPendingMessage={dismissPendingUserMessage}
      onCancelQueuedMessage={cancelQueuedSubmission}
      onOpenImage={setImagePreview}
      onOpenSubagentThread={(parentThreadId, activity) => {
        if (!activity.agentThreadId) return;
        return openSubagentThread(activity.agentThreadId, {
          parentThreadId,
          agentPath: activity.agentPath,
          assignment: activity.assignment
        });
      }}
      onToggleToolBatch={(targetThreadId, toolBatchKey, expanded) => {
        setExpandedToolBatchKeys((current) => {
          const keys = new Set(current[targetThreadId] ?? []);
          if (expanded) keys.add(toolBatchKey);
          else keys.delete(toolBatchKey);
          return {
            ...current,
            [targetThreadId]: [...keys]
          };
        });
      }}
      onApprovalDecision={respondToApproval}
      onUserInputResponse={respondToUserInput}
      onForkMessage={forkMessage}
    />
  );
};
