import { useMemo } from "react";
import type React from "react";
import { Popover } from "antd";
import { Zap } from "lucide-react";
import { asRecord, type CodexRecord } from "../shared/recordTypes.js";
import {
  activityStatusTitle,
  formatComposerModelButtonLabel,
  formatComposerModelTitle,
  formatContextTitle,
  formatContextUsage,
  formatRateLimitRemaining,
  formatResetTitle,
  latestTurnStatusFromRecords,
  latestUserTurnStatusScope,
  shortId,
  threadDisplayRecords,
  threadDisplayTitle
} from "./appHelpers.js";
import type { AppSelectors } from "./appSelectors.js";
import type { AppState } from "./appState.js";
import { contextMenuPosition } from "./helpers/composer.js";
import type { ActivityStatusView, OpenThreadState, ThreadTurnMeta } from "./types.js";

type ComposerThreadControlsMode = "inline" | "popover";

type ComposerThreadControlsProps = {
  activeThread: AppSelectors["activeThread"];
  activeThreadModel: AppSelectors["activeThreadModel"];
  activeThreadModelDraft: AppSelectors["activeThreadModelDraft"];
  activeThreadReasoning: AppSelectors["activeThreadReasoning"];
  activeThreadReasoningDraft: AppSelectors["activeThreadReasoningDraft"];
  activeThreadServiceTier: AppSelectors["activeThreadServiceTier"];
  activeThreadServiceTierDraft: AppSelectors["activeThreadServiceTierDraft"];
  activeThreadUsage: AppSelectors["activeThreadUsage"];
  compactThread: AppViewActions["compactThread"];
  latestTurnStatusScope: AppSelectors["latestTurnStatusScope"];
  mode: ComposerThreadControlsMode;
  setHiddenStatusTurns: AppState["setHiddenStatusTurns"];
  setThreadControlsMenuOpen: AppState["setThreadControlsMenuOpen"];
  setThreadModelDialogOpen: AppState["setThreadModelDialogOpen"];
  showInlineStatusPanel: AppSelectors["showInlineStatusPanel"];
  statusPanelAvailable: AppSelectors["statusPanelAvailable"];
  turnStatusItems: AppSelectors["turnStatusItems"];
  turnUiState: AppSelectors["turnUiState"];
};

type AppViewActions = {
  compactThread: (threadId: string) => unknown;
};

export const useAppViewSelectors = (state: AppState, selectors: AppSelectors, actions: AppViewActions) => {
  const activeThreadTurnMeta = useMemo(() => {
    const activeThread = selectors.activeThread;
    if (!activeThread) return null;
    const records = threadDisplayRecords(activeThread.threadId, activeThread);
    const turnStatus = latestTurnStatusFromRecords(records);
    return threadTurnMeta(activeThread, records, turnStatus, state.nowMs);
  }, [selectors.activeThread, state.nowMs]);
  const activeRunningTurnDuration = activeThreadTurnMeta?.status === "running"
    ? activeThreadTurnMeta.duration
    : "";
  const openThreadTabs = useMemo(() => state.openThreads.map((thread) => ({
    key: thread.threadId,
    label: (
      <OpenThreadTabLabel
        thread={thread}
        nowMs={state.nowMs}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          state.setThreadTabContextMenu({
            ...contextMenuPosition(event.clientX, event.clientY),
            threadId: thread.threadId
          });
        }}
      />
    )
  })), [state.nowMs, state.openThreads, state.setThreadTabContextMenu]);

  const renderComposerThreadControls = (mode: ComposerThreadControlsMode) => (
    <ComposerThreadControls
      activeThread={selectors.activeThread}
      activeThreadModel={selectors.activeThreadModel}
      activeThreadModelDraft={selectors.activeThreadModelDraft}
      activeThreadReasoning={selectors.activeThreadReasoning}
      activeThreadReasoningDraft={selectors.activeThreadReasoningDraft}
      activeThreadServiceTier={selectors.activeThreadServiceTier}
      activeThreadServiceTierDraft={selectors.activeThreadServiceTierDraft}
      activeThreadUsage={selectors.activeThreadUsage}
      compactThread={actions.compactThread}
      latestTurnStatusScope={selectors.latestTurnStatusScope}
      mode={mode}
      setHiddenStatusTurns={state.setHiddenStatusTurns}
      setThreadControlsMenuOpen={state.setThreadControlsMenuOpen}
      setThreadModelDialogOpen={state.setThreadModelDialogOpen}
      showInlineStatusPanel={selectors.showInlineStatusPanel}
      statusPanelAvailable={selectors.statusPanelAvailable}
      turnStatusItems={selectors.turnStatusItems}
      turnUiState={selectors.turnUiState}
    />
  );

  return {
    activeRunningTurnDuration,
    activeThreadTurnMeta,
    openThreadTabs,
    renderComposerThreadControls
  };
};

export type AppViewSelectors = ReturnType<typeof useAppViewSelectors>;

const OpenThreadTabLabel = ({
  thread,
  nowMs,
  onContextMenu
}: {
  thread: OpenThreadState;
  nowMs: number;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
}) => {
  const title = threadDisplayTitle(thread);
  const workspaceName = compactWorkspaceName(thread.workingDirectory);
  const records = threadDisplayRecords(thread.threadId, thread);
  const turnStatus = latestTurnStatusFromRecords(records);
  const turnMeta = threadTurnMeta(thread, records, turnStatus, nowMs);
  const badgeText = turnMeta.duration
    ? `${turnMeta.status} | ${turnMeta.duration}`
    : turnMeta.status;
  const details = (
    <div className="openThreadTabDetails">
      <div>
        <span>Path</span>
        <code>{thread.workingDirectory}</code>
      </div>
      <div>
        <span>Title</span>
        <code>{title}</code>
      </div>
      <div>
        <span>Thread</span>
        <code>{thread.threadId}</code>
      </div>
      <div>
        <span>Status</span>
        <code>{badgeText}</code>
      </div>
      {thread.session.sessionId ? (
        <div>
          <span>Session</span>
          <code>{thread.session.sessionId}</code>
        </div>
      ) : null}
    </div>
  );

  return (
    <Popover
      content={details}
      placement="bottomLeft"
      trigger="click"
      overlayClassName="openThreadTabDetailsPopover"
    >
      <span
        className="openThreadTabLabel"
        title={`${thread.workingDirectory}\n${title}\n${thread.threadId}`}
        onContextMenu={onContextMenu}
      >
        <span className="openThreadTabTitle">{title}</span>
        <span className="openThreadTabMeta">
          <code title={`${thread.workingDirectory}\n${thread.threadId}`}>{workspaceName} · {shortId(thread.threadId)}</code>
          <em className={`openThreadTabBadge ${turnMeta.status}`}>{badgeText}</em>
        </span>
      </span>
    </Popover>
  );
};

const ComposerThreadControls = ({
  activeThread,
  activeThreadModel,
  activeThreadModelDraft,
  activeThreadReasoning,
  activeThreadReasoningDraft,
  activeThreadServiceTier,
  activeThreadServiceTierDraft,
  activeThreadUsage,
  compactThread,
  latestTurnStatusScope,
  mode,
  setHiddenStatusTurns,
  setThreadControlsMenuOpen,
  setThreadModelDialogOpen,
  showInlineStatusPanel,
  statusPanelAvailable,
  turnStatusItems,
  turnUiState
}: ComposerThreadControlsProps) => {
  const statusItemCount = turnStatusItems.length;
  const statusButtonLabel = statusItemCount ? `Status ${statusItemCount}` : "Status";
  const statusPanelExpanded = Boolean(statusPanelAvailable && showInlineStatusPanel);
  const statusButtonClass = [
    "usagePill",
    "statusPill",
    statusPanelAvailable ? "available" : "",
    statusPanelAvailable && !statusPanelExpanded ? "collapsed" : ""
  ].filter(Boolean).join(" ");
  const statusButtonTitle = statusPanelAvailable
    ? [
        `${statusPanelExpanded ? "Hide" : "Show"} turn status`,
        statusItemCount ? activityStatusTitle(turnStatusItems) : turnUiState.title
      ].filter(Boolean).join("\n")
    : turnUiState.title;
  const toggleStatusPanel = () => {
    if (!activeThread?.threadId || !latestTurnStatusScope.key) return;
    setHiddenStatusTurns((current) => {
      if (current[activeThread.threadId] !== latestTurnStatusScope.key) {
        return {
          ...current,
          [activeThread.threadId]: latestTurnStatusScope.key
        };
      }
      const next = { ...current };
      delete next[activeThread.threadId];
      return next;
    });
  };
  const composerModelButtonLabel = formatComposerModelButtonLabel(
    activeThreadModelDraft,
    activeThreadReasoningDraft,
    activeThreadServiceTierDraft,
    activeThreadModel,
    activeThreadReasoning,
    activeThreadServiceTier
  );
  const composerModelButtonTitle = formatComposerModelTitle(
    activeThreadModelDraft,
    activeThreadReasoningDraft,
    activeThreadServiceTierDraft,
    activeThreadModel,
    activeThreadReasoning,
    activeThreadServiceTier
  );
  const composerModelServiceTier = activeThreadServiceTierDraft === "auto"
    ? activeThreadServiceTier
    : activeThreadServiceTierDraft;
  const showPriorityTierIcon = composerModelServiceTier === "priority";
  const canCompactThread = Boolean(activeThread?.threadId && !activeThread.running);
  const contextUsageLabel = formatContextUsage(activeThreadUsage);
  const contextPercent = contextUsagePercent(activeThreadUsage);
  const contextProgressStyle = contextPercent == null
    ? undefined
    : ({ "--context-progress": `${contextPercent}%` } as React.CSSProperties);
  const compactTitle = activeThread?.running
    ? "Stop the running turn before compacting context"
    : [
        formatContextTitle(activeThreadUsage),
        "Click to compact this thread's app-server context"
      ].filter(Boolean).join("\n");

  return (
    <div className={`composerSessionControls ${mode}`} aria-label="Thread usage and model">
      <div className="composerUsagePills" aria-label="Thread usage">
        <button
          type="button"
          className={statusButtonClass}
          disabled={!statusPanelAvailable}
          title={statusButtonTitle}
          aria-pressed={statusPanelAvailable ? statusPanelExpanded : undefined}
          onClick={toggleStatusPanel}
        >
          {statusButtonLabel}
        </button>
        <button
          type="button"
          className="usagePill contextCompactButton"
          disabled={!canCompactThread}
          title={compactTitle}
          aria-label={`Context ${contextUsageLabel}. Compact context`}
          style={contextProgressStyle}
          onClick={() => {
            if (!activeThread?.threadId || activeThread.running) return;
            setThreadControlsMenuOpen(false);
            void compactThread(activeThread.threadId);
          }}
        >
          <span className="contextUsageIcon" aria-hidden="true" />
        </button>

        <span className="usagePill" title={formatResetTitle(activeThreadUsage?.primaryRateLimit)}>5h {formatRateLimitRemaining(activeThreadUsage?.primaryRateLimit)}</span>
        <span className="usagePill" title={formatResetTitle(activeThreadUsage?.secondaryRateLimit)}>weekly {formatRateLimitRemaining(activeThreadUsage?.secondaryRateLimit)}</span>
      </div>
      <button
        type="button"
        className="composerModelButton"
        title={composerModelButtonTitle}
        onClick={() => {
          setThreadControlsMenuOpen(false);
          setThreadModelDialogOpen(true);
        }}
      >
        {composerModelButtonLabel}
        {showPriorityTierIcon ? <Zap className="composerModelTierIcon" aria-label="priority" /> : null}
      </button>
    </div>
  );
};

const compactWorkspaceName = (value: string) => {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? (value || "workspace");
};

const contextUsagePercent = (threadUsage: AppSelectors["activeThreadUsage"]) => {
  const context = threadUsage?.context;
  if (!context || context.windowTokens <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((context.usedTokens / context.windowTokens) * 100)));
};

export const threadTurnMeta = (
  thread: OpenThreadState,
  records: CodexRecord[],
  turnStatus: ActivityStatusView | null,
  nowMs: number
): ThreadTurnMeta => {
  const activeStatus = turnStatus?.status === "pending" || turnStatus?.status === "in_progress";
  const running = Boolean(thread.running || activeStatus);
  const durationMs = activityDurationMs(
    latestUserTurnStatusScope(records).records,
    running,
    nowMs,
    activeStatus ? turnStatus?.at : undefined
  );
  return {
    status: running ? "running" : "idle",
    duration: durationMs == null ? "" : formatThreadDuration(durationMs)
  };
};

const activityDurationMs = (
  records: CodexRecord[],
  running: boolean,
  nowMs: number,
  runningFallbackAt?: string
) => {
  let totalMs = 0;
  let hasDuration = false;
  let openStartedMs: number | null = null;
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (record.type !== "event_msg" || !payload) continue;
    if (payload.type === "task_started") {
      openStartedMs = parseRecordTimestamp(record);
      continue;
    }
    if (payload.type !== "task_complete" && payload.type !== "turn_aborted") continue;
    const duration = payload.duration_ms;
    if (typeof duration === "number" && Number.isFinite(duration)) {
      totalMs += Math.max(0, duration);
      hasDuration = true;
    } else {
      const finishedMs = parseRecordTimestamp(record);
      if (openStartedMs !== null && finishedMs !== null) {
        totalMs += Math.max(0, finishedMs - openStartedMs);
        hasDuration = true;
      }
    }
    openStartedMs = null;
  }
  if (running) {
    const startedMs = openStartedMs ?? parseTimestamp(runningFallbackAt);
    if (startedMs !== null) {
      totalMs += Math.max(0, nowMs - startedMs);
      hasDuration = true;
    }
  }
  return hasDuration ? totalMs : null;
};

const parseRecordTimestamp = (record: CodexRecord) => parseTimestamp(record.timestamp);

const parseTimestamp = (value: string | undefined) => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

export const formatThreadDuration = (durationMs: number) => {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h${minutes}m${remainder}s`;
  if (minutes) return `${minutes}m${remainder}s`;
  return `${remainder}s`;
};
