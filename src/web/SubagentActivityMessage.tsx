import React from "react";
import { Bot, ExternalLink } from "lucide-react";
import type { SubagentActivityView } from "../shared/recordTypes.js";

export const SubagentActivityMessage = ({
  activity,
  statusLabel,
  timestampText,
  timestampTitle,
  onOpenThread,
  onContextMenu
}: {
  activity: SubagentActivityView;
  statusLabel: string;
  timestampText?: string;
  timestampTitle?: string;
  onOpenThread?: (activity: SubagentActivityView) => void | Promise<void>;
  onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
}) => {
  const agentName = subagentActivityAgentName(activity);
  const tone = subagentActivityTone(activity.kind);
  const canOpenThread = Boolean(activity.agentThreadId && onOpenThread);
  const initialMessage = activity.assignment?.initialMessage?.trim();
  const assignedModel = activity.assignment?.model?.trim();
  const assignedReasoning = activity.assignment?.reasoningEffort?.trim();
  const hasAssignment = Boolean(initialMessage || assignedModel || assignedReasoning);
  const openingRef = React.useRef(false);
  const [opening, setOpening] = React.useState(false);
  const openThread = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const threadId = activity.agentThreadId;
    if (!threadId || !onOpenThread || openingRef.current) return;
    openingRef.current = true;
    setOpening(true);
    try {
      await onOpenThread(activity);
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };
  const articleLabel = [
    `Subagent ${agentName}: ${statusLabel}`,
    assignedModel ? `requested model ${assignedModel}` : null,
    assignedReasoning ? `requested reasoning ${assignedReasoning}` : null,
    initialMessage ? `initial task ${initialMessage}` : null
  ].filter(Boolean).join(". ");
  return (
    <article
      className={`message event subagentActivityMessage ${tone} ${hasAssignment ? "hasAssignment" : ""} ${onContextMenu ? "hasContextMenu" : ""}`}
      onContextMenu={onContextMenu}
      aria-label={articleLabel}
    >
      <span className="subagentActivityIcon" aria-hidden="true"><Bot size={15} strokeWidth={1.9} /></span>
      <span className="subagentActivityIdentity">
        <span className="subagentActivityType">Subagent</span>
        <strong title={activity.agentPath}>{agentName}</strong>
      </span>
      <span className={`subagentActivityStatus ${tone}`}>
        <span aria-hidden="true" />
        {statusLabel}
      </span>
      {canOpenThread ? (
        <button
          type="button"
          className={`subagentActivityOpen ${opening ? "opening" : ""}`}
          disabled={opening}
          aria-busy={opening}
          onClick={openThread}
          title={opening ? "Loading subagent thread" : `View subagent thread ${activity.agentThreadId}`}
          aria-label={`View ${agentName} subagent thread`}
        >
          <span>{opening ? "Loading…" : "View"}</span>
          <ExternalLink size={13} strokeWidth={1.9} aria-hidden="true" />
        </button>
      ) : null}
      {timestampText ? (
        <span className="subagentActivityTime" title={timestampTitle}>{timestampText}</span>
      ) : null}
      {hasAssignment ? (
        <span className="subagentActivityAssignment">
          <span className="subagentActivityAssignmentMeta">
            {assignedModel || assignedReasoning ? (
              <span className="subagentActivityAssignmentLabel">Requested</span>
            ) : null}
            {assignedModel ? (
              <span
                className="subagentActivityAssignmentTag model"
                title={`Requested model: ${assignedModel}`}
                aria-label={`Requested model: ${assignedModel}`}
              >
                {assignedModel}
              </span>
            ) : null}
            {assignedReasoning ? (
              <span
                className="subagentActivityAssignmentTag reasoning"
                title={`Requested reasoning: ${assignedReasoning}`}
                aria-label={`Requested reasoning: ${assignedReasoning}`}
              >
                {subagentReasoningLabel(assignedReasoning)}
              </span>
            ) : null}
          </span>
          {initialMessage ? (
            <span className="subagentActivityTask" title={initialMessage}>
              <span className="subagentActivityTaskLabel">Task</span>
              <span className="subagentActivityTaskText">{initialMessage}</span>
            </span>
          ) : null}
        </span>
      ) : null}
    </article>
  );
};

export const subagentActivityAgentName = (activity: SubagentActivityView) => {
  const path = activity.agentPath?.trim();
  if (path) return path.split("/").filter(Boolean).at(-1) ?? path;
  return activity.agentThreadId ? "Subagent" : "Agent";
};

const subagentActivityTone = (kind: string) => {
  const normalized = kind.trim().replace(/[-\s]+/g, "_").toLowerCase();
  if (normalized === "started") return "started";
  if (normalized === "interacted") return "interacted";
  if (normalized === "interrupted") return "interrupted";
  return "activity";
};

const subagentReasoningLabel = (value: string) => {
  const labels: Record<string, string> = {
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra"
  };
  return labels[value.toLowerCase()] ?? value;
};
