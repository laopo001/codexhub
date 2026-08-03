import React from "react";
import type { SubagentActivityView } from "../shared/recordTypes.js";
import {
  latestThreadGoalFromRecords,
  latestTurnActivityScope,
  threadDisplayRecords,
  userMessageHistoryFromRecords
} from "./appHelpers.js";
import { threadExecutionMeta } from "./appViewSelectors.js";
import {
  SubagentThreadAssignment,
  subagentThreadDialogViews
} from "./SubagentThreadDialog.js";
import {
  ThreadComposerLeftActions,
  ThreadComposerRightActions
} from "./ThreadComposerChrome.js";
import { ThreadConversation } from "./ThreadConversation.js";
import type { SubagentThreadDialogState } from "./types.js";
import type { AppWorkspaceViewModel } from "./viewModel.js";

export const SubagentThreadConversation = ({
  workspace,
  dialog,
  assignment
}: {
  workspace: AppWorkspaceViewModel;
  dialog: SubagentThreadDialogState & { status: "ready"; thread: NonNullable<SubagentThreadDialogState["thread"]> };
  assignment?: SubagentActivityView["assignment"];
}) => {
  const thread = dialog.thread;
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const records = threadDisplayRecords(thread.threadId, thread);
  const activityScope = latestTurnActivityScope(records, thread.activeTurnId);
  const executionMeta = threadExecutionMeta(thread, activityScope);
  const activeGoal = latestThreadGoalFromRecords(records, thread.threadId);
  const canStop = Boolean(
    thread.runtime.online
    && thread.runtime.runnable !== false
    && thread.status === "running"
    && thread.activeTurnId
  );
  const expandedToolBatchKeys = new Set(workspace.expandedToolBatchKeys[thread.threadId] ?? []);

  return (
    <ThreadConversation
      thread={thread}
      views={subagentThreadDialogViews(thread, workspace.messageDisplayMode, expandedToolBatchKeys)}
      userMessageHistory={userMessageHistoryFromRecords(records)}
      composerDraftStore={workspace.composerDraftStore}
      commandPaletteByScope={workspace.commandPaletteByScope}
      commandPaletteLoadingScopes={workspace.commandPaletteLoadingScopes}
      executionMeta={executionMeta}
      activeGoal={activeGoal}
      messageDisplayMode={workspace.messageDisplayMode}
      messageRenderModes={workspace.messageRenderModes}
      className="subagentThreadConversation"
      messagesClassName="subagentThreadMessages"
      composerClassName="subagentThreadComposer"
      messageItemClassName="subagentThreadMessageItem"
      fileInputRef={fileInputRef}
      leading={(
        <SubagentThreadAssignment
          assignment={assignment}
          workingDirectory={thread.workingDirectory}
        />
      )}
      leftActions={(
        <ThreadComposerLeftActions
          workspace={workspace}
          thread={thread}
          activeGoal={activeGoal}
          fileInputRef={fileInputRef}
        />
      )}
      threadControls={<ThreadComposerRightActions workspace={workspace} thread={thread} />}
      showSendButton={!thread.running}
      canStop={canStop}
      threadModelDialogOpen={false}
      forkingMessageKey={workspace.forkingMessageKey}
      onSend={workspace.send}
      onStop={workspace.stopTurn}
      onAddFiles={workspace.addThreadFiles}
      onClearAttachments={workspace.clearThreadAttachments}
      onRemoveImage={workspace.removeThreadImage}
      onRemoveTextAttachment={workspace.removeThreadTextAttachment}
      onCompactThread={workspace.compactThread}
      onReviewThread={workspace.reviewThread}
      onUpdateInput={workspace.updateThreadInput}
      onSetComposerMode={workspace.setThreadComposerMode}
      onHandleComposerKeyDown={workspace.handleComposerKeyDown}
      onInsertPathText={workspace.insertThreadPathText}
      onLoadCommandPalette={(_threadId, machineId, cwd) => workspace.loadCommandPalette(machineId, cwd)}
      onPasteImages={workspace.pasteThreadImages}
      onResetComposerHistory={workspace.resetComposerHistory}
      onResizeComposerTextarea={(_threadId, textarea) => workspace.resizeComposerTextarea(textarea)}
      onThreadModelDialogChange={(threadId, open) => {
        if (open) {
          workspace.openThreadModelDialog(threadId);
          return;
        }
        workspace.setThreadModelDialogOpen(false);
      }}
      onMessageRenderModeChange={(_threadId, messageId, mode) => workspace.updateMessageRenderMode(messageId, mode)}
      onMessageContextMenu={workspace.openMessageContextMenu}
      onInspectMessage={(_threadId, message) => workspace.setInspectMessage(message)}
      onOpenImage={(_threadId, image) => workspace.setImagePreview(image)}
      onOpenSubagentThread={(parentThreadId, activity) => {
        if (!activity.agentThreadId) return;
        return workspace.openSubagentThread(activity.agentThreadId, {
          parentThreadId,
          agentPath: activity.agentPath,
          assignment: activity.assignment
        });
      }}
      onToggleToolBatch={(threadId, toolBatchKey, expanded) => {
        workspace.setExpandedToolBatchKeys((current) => {
          const keys = new Set(current[threadId] ?? []);
          if (expanded) keys.add(toolBatchKey);
          else keys.delete(toolBatchKey);
          return { ...current, [threadId]: [...keys] };
        });
      }}
      onApprovalDecision={workspace.respondToApproval}
      onUserInputResponse={workspace.respondToUserInput}
    />
  );
};
