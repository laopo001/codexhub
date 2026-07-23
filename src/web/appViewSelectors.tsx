import { useMemo } from "react";
import type React from "react";
import { Popover } from "antd";
import { Zap } from "lucide-react";
import {
  fiveHourRateLimitWindowMinutes,
  rateLimitUsageForWindowMinutes,
  sevenDayRateLimitWindowMinutes
} from "../core/threadUsage.js";
import {
  formatComposerModelButtonLabel,
  formatComposerModelTitle,
  formatContextTitle,
  formatContextUsage,
  formatRateLimitRemaining,
  formatResetTitle,
  latestTurnActivityScope,
  shortId,
  threadDisplayRecords,
  threadExecutionIsRunning,
  threadDisplayTitle
} from "./appHelpers.js";
import type { TurnActivityScope } from "./appHelpers.js";
import { formatThreadDuration, LiveThreadExecutionText } from "./helpers/liveTime.js";
import type { AppSelectors } from "./appSelectors.js";
import type { AppState } from "./appState.js";
import { contextMenuPosition } from "./helpers/composer.js";
import type { OpenThreadState, ThreadExecutionMeta } from "./types.js";

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
    return threadExecutionMeta(activeThread, selectors.latestTurnActivityScope);
  }, [selectors.activeThread, selectors.latestTurnActivityScope]);
  const openThreadTabs = useMemo(() => state.openThreads.map((thread) => ({
    key: thread.threadId,
    label: (
      <OpenThreadTabLabel
        thread={thread}
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
  })), [state.openThreads, state.setThreadTabContextMenu]);

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
    activeThreadExecutionMeta,
    openThreadTabs,
    renderComposerThreadControls
  };
};

export type AppViewSelectors = ReturnType<typeof useAppViewSelectors>;

const OpenThreadTabLabel = ({
  thread,
  onContextMenu
}: {
  thread: OpenThreadState;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
}) => {
  const title = threadDisplayTitle(thread);
  const workspaceName = compactWorkspaceName(thread.workingDirectory);
  const records = threadDisplayRecords(thread.threadId, thread);
  const activityScope = latestTurnActivityScope(records);
  const executionMeta = threadExecutionMeta(thread, activityScope);
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
        <code><LiveThreadExecutionText executionMeta={executionMeta} /></code>
      </div>
      {thread.runtime.machineId ? (
        <div>
          <span>Runtime</span>
          <code>{thread.runtime.machineId}</code>
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
          <em className={`openThreadTabBadge ${executionMeta.status}`}><LiveThreadExecutionText executionMeta={executionMeta} /></em>
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
  const fiveHourRateLimit = rateLimitUsageForWindowMinutes(
    activeThreadUsage,
    fiveHourRateLimitWindowMinutes
  );
  const sevenDayRateLimit = rateLimitUsageForWindowMinutes(
    activeThreadUsage,
    sevenDayRateLimitWindowMinutes
  );
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

        {fiveHourRateLimit ? (
          <span className="usagePill" title={formatResetTitle(fiveHourRateLimit)}>5h {formatRateLimitRemaining(fiveHourRateLimit)}</span>
        ) : null}
        {sevenDayRateLimit ? (
          <span className="usagePill" title={formatResetTitle(sevenDayRateLimit)}>7d {formatRateLimitRemaining(sevenDayRateLimit)}</span>
        ) : null}
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
  activityScope: TurnActivityScope
): ThreadExecutionMeta => {
  const running = threadExecutionIsRunning(thread.running, activityScope.turnStatus);
  const startedAt = running
    ? thread.activeTurnStartedAt ?? activityScope.startedAt
    : activityScope.startedAt ?? activityScope.turnStatus?.at;
  const durationMs = running ? undefined : activityScope.durationMs;
  const status = running ? "running" : "idle";
  const label = running ? "Running" : "Idle";
  const duration = durationMs == null ? "" : formatThreadDuration(durationMs);
  return {
    status,
    label,
    duration,
    text: [label, duration].filter(Boolean).join(" · "),
    ...(running && startedAt ? { startedAt } : {}),
    ...(running && thread.activeTurnObservedAt ? { observedAt: thread.activeTurnObservedAt } : {})
  };
};
