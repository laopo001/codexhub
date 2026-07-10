import { useMemo } from "react";
import type React from "react";
import { Popover } from "antd";
import { Zap } from "lucide-react";
import { asRecord, type CodexRecord } from "../shared/recordTypes.js";
import {
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
  threadExecutionIsRunning,
  threadDisplayTitle
} from "./appHelpers.js";
import type { AppSelectors } from "./appSelectors.js";
import type { AppState } from "./appState.js";
import { contextMenuPosition } from "./helpers/composer.js";
import type { ActivityStatusView, OpenThreadState, ThreadExecutionMeta } from "./types.js";

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
  mode: ComposerThreadControlsMode;
  setThreadControlsMenuOpen: AppState["setThreadControlsMenuOpen"];
  setThreadModelDialogOpen: AppState["setThreadModelDialogOpen"];
};

type AppViewActions = {
  compactThread: (threadId: string) => unknown;
};

export const useAppViewSelectors = (state: AppState, selectors: AppSelectors, actions: AppViewActions) => {
  const activeThreadExecutionMeta = useMemo(() => {
    const activeThread = selectors.activeThread;
    if (!activeThread) return null;
    const records = threadDisplayRecords(activeThread.threadId, activeThread);
    const turnStatus = latestTurnStatusFromRecords(records);
    return threadExecutionMeta(activeThread, records, turnStatus, state.nowMs);
  }, [selectors.activeThread, state.nowMs]);
  const activeRunningExecutionDuration = activeThreadExecutionMeta?.status === "running"
    ? activeThreadExecutionMeta.duration
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
      mode={mode}
      setThreadControlsMenuOpen={state.setThreadControlsMenuOpen}
      setThreadModelDialogOpen={state.setThreadModelDialogOpen}
    />
  );

  return {
    activeRunningExecutionDuration,
    activeThreadExecutionMeta,
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
  const executionMeta = threadExecutionMeta(thread, records, turnStatus, nowMs);
  const badgeText = executionMeta.text;
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
          <em className={`openThreadTabBadge ${executionMeta.status}`}>{badgeText}</em>
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
  mode,
  setThreadControlsMenuOpen,
  setThreadModelDialogOpen
}: ComposerThreadControlsProps) => {
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

export const threadExecutionMeta = (
  thread: OpenThreadState,
  records: CodexRecord[],
  turnStatus: ActivityStatusView | null,
  nowMs: number
): ThreadExecutionMeta => {
  const running = threadExecutionIsRunning(thread.running, turnStatus);
  const statusScope = latestUserTurnStatusScope(records);
  const durationMs = activityElapsedMs(
    statusScope.records,
    running,
    nowMs,
    statusScope.startedAt,
    turnStatus?.at
  );
  const status = running ? "running" : "idle";
  const label = running ? "Running" : "Idle";
  const duration = durationMs == null ? "" : formatThreadDuration(durationMs);
  return { status, label, duration, text: [label, duration].filter(Boolean).join(" · ") };
};

const activityElapsedMs = (
  records: CodexRecord[],
  running: boolean,
  nowMs: number,
  startedAt?: string,
  endedAtFallback?: string
) => {
  const startedMs = parseTimestamp(startedAt);
  if (startedMs === null) return null;
  if (running) return Math.max(0, nowMs - startedMs);

  let endedMs: number | null = null;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const payload = asRecord(record.payload);
    if (record.type !== "event_msg" || !payload) continue;
    if (payload.type !== "task_complete" && payload.type !== "turn_aborted") continue;
    endedMs = parseRecordTimestamp(record);
    if (endedMs !== null) break;
  }
  endedMs ??= parseTimestamp(endedAtFallback);
  return endedMs === null ? null : Math.max(0, endedMs - startedMs);
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
