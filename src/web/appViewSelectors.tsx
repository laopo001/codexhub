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
  activityStatusesFromRecords,
  formatComposerModelButtonLabel,
  formatComposerModelTitle,
  formatContextTitle,
  formatContextUsage,
  formatRateLimitRemaining,
  formatResetTitle,
  isFastServiceTier,
  latestThreadConfigFromRecords,
  latestThreadUsageFromRecords,
  latestTurnActivityScope,
  latestThreadGoalFromRecords,
  mergeThreadUsage,
  normalizeReasoningEffort,
  shortId,
  threadDisplayRecords,
  threadDisplayTitle,
  threadUsageFromSessionRateLimits
} from "./appHelpers.js";
import { LiveThreadRunningText } from "./helpers/liveTime.js";
import { threadExecutionMeta } from "./helpers/threadExecution.js";
import type { AppSelectors } from "./appSelectors.js";
import type { AppState } from "./appState.js";
import { contextMenuPosition } from "./helpers/composer.js";
import type { OpenThreadState } from "./types.js";
import { formatPlanProgress, planProgressFromStatuses } from "../shared/planProgress.js";

type ComposerThreadControlsMode = "inline" | "popover";

type ComposerThreadControlsProps = {
  thread: OpenThreadState;
  threadModel: AppSelectors["activeThreadModel"];
  threadReasoning: AppSelectors["activeThreadReasoning"];
  threadServiceTier: AppSelectors["activeThreadServiceTier"];
  threadUsage: AppSelectors["activeThreadUsage"];
  compactThread: AppViewActions["compactThread"];
  mode: ComposerThreadControlsMode;
  onRequestClose?: () => void;
  openThreadModelDialog: AppState["openThreadModelDialog"];
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

  const renderComposerThreadControls = (
    thread: OpenThreadState,
    mode: ComposerThreadControlsMode,
    onRequestClose?: () => void
  ) => {
    const runtime = state.runtimeList.find((item) => item.machineId === thread.runtime.machineId);
    const threadSummary = runtime?.threads?.find((item) => item.threadId === thread.threadId);
    const records = threadDisplayRecords(thread.threadId, thread);
    const activity = latestTurnActivityScope(records, thread.activeTurnId);
    const latestUsage = latestThreadUsageFromRecords(activity.records)
      ?? latestThreadUsageFromRecords(records);
    const threadUsage = mergeThreadUsage(
      mergeThreadUsage(latestUsage, thread.threadUsage ?? threadSummary?.threadUsage ?? null),
      threadUsageFromSessionRateLimits(runtime?.accountRateLimits)
    );
    const latestConfig = latestThreadConfigFromRecords(activity.records)
      ?? latestThreadConfigFromRecords(records);
    const threadModel = latestConfig?.model
      ?? thread.model
      ?? threadSummary?.model
      ?? state.systemStatus.model
      ?? null;
    const threadReasoning = latestConfig?.reasoning
      ?? thread.modelReasoningEffort
      ?? threadSummary?.modelReasoningEffort
      ?? normalizeReasoningEffort(state.systemStatus.modelReasoningEffort)
      ?? null;
    const threadServiceTier = latestConfig?.serviceTier
      ?? thread.serviceTier
      ?? threadSummary?.serviceTier
      ?? state.systemStatus.serviceTier
      ?? null;

    return (
      <ComposerThreadControls
        thread={thread}
        threadModel={threadModel}
        threadReasoning={threadReasoning}
        threadServiceTier={threadServiceTier}
        threadUsage={threadUsage}
        compactThread={actions.compactThread}
        mode={mode}
        onRequestClose={onRequestClose}
        openThreadModelDialog={state.openThreadModelDialog}
      />
    );
  };

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
  const activityScope = latestTurnActivityScope(records, thread.activeTurnId);
  const executionMeta = threadExecutionMeta(thread, activityScope);
  const planStatus = activityStatusesFromRecords(activityScope.records).find((status) => status.key === "plan");
  const planProgress = planStatus?.steps?.length
    ? planProgressFromStatuses(planStatus.steps.map((step) => step.status))
    : undefined;
  const leadingStatusText = executionMeta.status === "running" && planProgress
    ? formatPlanProgress(planProgress)
    : undefined;
  const activeGoal = latestThreadGoalFromRecords(records, thread.threadId);
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
        <code>
          <LiveThreadRunningText
            executionMeta={executionMeta}
            activeGoal={activeGoal}
            leadingText={leadingStatusText}
          />
        </code>
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
          <em className={`openThreadTabBadge ${executionMeta.status}`}>
            <LiveThreadRunningText
              executionMeta={executionMeta}
              activeGoal={activeGoal}
              leadingText={leadingStatusText}
            />
          </em>
        </span>
      </span>
    </Popover>
  );
};

const ComposerThreadControls = ({
  thread,
  threadModel,
  threadReasoning,
  threadServiceTier,
  threadUsage,
  compactThread,
  mode,
  onRequestClose,
  openThreadModelDialog
}: ComposerThreadControlsProps) => {
  const composerModelButtonLabel = formatComposerModelButtonLabel(
    thread.modelDraft,
    thread.reasoningDraft,
    thread.serviceTierDraft,
    threadModel,
    threadReasoning
  );
  const composerModelButtonTitle = formatComposerModelTitle(
    thread.modelDraft,
    thread.reasoningDraft,
    thread.serviceTierDraft,
    threadModel,
    threadReasoning,
    threadServiceTier
  );
  const showFastTierIcon = isFastServiceTier(thread.serviceTierDraft);
  const canCompactThread = !thread.running;
  const contextUsageLabel = formatContextUsage(threadUsage);
  const contextPercent = contextUsagePercent(threadUsage);
  const contextProgressStyle = contextPercent == null
    ? undefined
    : ({ "--context-progress": `${contextPercent}%` } as React.CSSProperties);
  const fiveHourRateLimit = rateLimitUsageForWindowMinutes(
    threadUsage,
    fiveHourRateLimitWindowMinutes
  );
  const sevenDayRateLimit = rateLimitUsageForWindowMinutes(
    threadUsage,
    sevenDayRateLimitWindowMinutes
  );
  const compactTitle = thread.running
    ? "Stop the running turn before compacting context"
    : [
        formatContextTitle(threadUsage),
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
            if (thread.running) return;
            onRequestClose?.();
            void compactThread(thread.threadId);
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
          onRequestClose?.();
          openThreadModelDialog(thread.threadId);
        }}
      >
        {composerModelButtonLabel}
        {showFastTierIcon ? <Zap className="composerModelTierIcon" aria-label="Fast mode" /> : null}
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
