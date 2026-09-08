import React from "react";
import { Bot, RotateCcw, X } from "lucide-react";
import type { SubagentActivityView } from "../shared/recordTypes.js";
import {
  MessageText,
  threadDisplayRecords
} from "./appHelpers.js";
import { conversationViewsFromRecords } from "./helpers/conversationViews.js";
import { finalAnswerViewsWithTurnDurations, turnDurationMapFromRecords } from "./helpers/turnDurations.js";
import type {
  SubagentThreadDialogState,
  SubagentThreadOpenOptions,
  WebRecordView
} from "./types.js";

export const SubagentThreadDialog = ({
  dialog,
  assignment,
  onClose,
  onRetry,
  children
}: {
  dialog: SubagentThreadDialogState;
  assignment?: SubagentActivityView["assignment"];
  onClose: () => void;
  onRetry: (threadId: string, options?: SubagentThreadOpenOptions) => void | Promise<void>;
  children?: React.ReactNode;
}) => {
  React.useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const agentName = subagentDialogAgentName(dialog.agentPath);
  const cli = dialog.origin === "codexhub";
  const statusText = dialog.status === "loading"
    ? "Loading"
    : dialog.status === "error"
      ? "Unavailable"
      : dialog.thread?.running || dialog.thread?.status === "running"
        ? "Running"
        : "Ready";
  return (
    <div
      className="modalOverlay subagentThreadDialogOverlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal subagentThreadDialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subagentThreadDialogTitle"
      >
        <header className="modalHeader subagentThreadDialogHeader">
          <span className="subagentThreadDialogIcon" aria-hidden="true"><Bot size={18} strokeWidth={1.9} /></span>
          <div className="subagentThreadDialogHeading">
            <h2 id="subagentThreadDialogTitle">{cli ? "CodexHub" : "Subagent"} · {agentName}</h2>
            <p className="subagentThreadDialogMeta">
              <span>{statusText}</span>
              {dialog.workingDirectory ? (
                <span className="subagentThreadDialogWorkingDirectory" title={dialog.workingDirectory}>
                  {dialog.workingDirectory}
                </span>
              ) : null}
            </p>
            <div className="subagentThreadDialogThreadId">
              <span>{cli ? "Thread" : "Child thread"}</span>
              <code title={`Child thread ID: ${dialog.threadId}`}>{dialog.threadId}</code>
            </div>
          </div>
          <button type="button" className="iconButton" onClick={onClose} aria-label="Close subagent thread">
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <div className="subagentThreadDialogBody">
          {dialog.status === "loading" ? (
            <div className="subagentThreadDialogState" role="status" aria-live="polite">
              <span className="subagentThreadDialogSpinner" aria-hidden="true" />
              <strong>{cli ? "正在加载 CodexHub 线程…" : "Loading subagent conversation…"}</strong>
              <span>The parent thread stays open behind this dialog.</span>
            </div>
          ) : dialog.status === "error" ? (
            <div className="subagentThreadDialogState error" role="alert">
              <strong>{cli ? "无法加载 CodexHub 线程" : "Unable to load this subagent thread"}</strong>
              <span>{dialog.error}</span>
              <button
                type="button"
                className="secondaryButton subagentThreadDialogRetry"
                onClick={() => void onRetry(dialog.threadId, {
                  origin: dialog.origin,
                  machineId: dialog.machineId,
                  parentThreadId: dialog.parentThreadId,
                  agentPath: dialog.agentPath,
                  assignment
                })}
              >
                <RotateCcw size={14} aria-hidden="true" />
                Retry
              </button>
            </div>
          ) : (
            children
          )}
        </div>
      </section>
    </div>
  );
};

export const SubagentThreadAssignment = ({
  assignment,
  machineId,
  workingDirectory
}: {
  assignment?: SubagentActivityView["assignment"];
  machineId?: string;
  workingDirectory?: string;
}) => (
  <details className="subagentThreadAssignment" open>
    <summary>
      <strong>Assignment from parent</strong>
      <span className="subagentThreadAssignmentTags">
        {assignment?.model ? <span>{assignment.model}</span> : null}
        {assignment?.reasoningEffort ? <span>{assignment.reasoningEffort}</span> : null}
      </span>
    </summary>
    {assignment?.initialMessage ? (
      <div className="subagentThreadAssignmentPrompt">
        <MessageText
          text={assignment.initialMessage}
          mode="markdown"
          markdownEnabled
          threadMachineId={machineId}
          threadWorkingDirectory={workingDirectory}
        />
      </div>
    ) : assignment ? (
      <span className="subagentThreadAssignmentEmpty">The parent did not provide a text prompt.</span>
    ) : (
      <span className="subagentThreadAssignmentEmpty">
        This app-server transcript does not include the parent spawn prompt.
      </span>
    )}
  </details>
);

export const subagentThreadDialogViews = (
  thread: NonNullable<SubagentThreadDialogState["thread"]>,
  expandedToolBatchKeys: Set<string> = new Set()
): WebRecordView[] => {
  const records = threadDisplayRecords(thread.threadId, thread);
  const views = conversationViewsFromRecords(records, expandedToolBatchKeys);
  return finalAnswerViewsWithTurnDurations(views, turnDurationMapFromRecords(records));
};

const subagentDialogAgentName = (agentPath: string | undefined) => {
  const path = agentPath?.trim();
  if (!path) return "Subagent";
  return path.split("/").filter(Boolean).at(-1) ?? path;
};
