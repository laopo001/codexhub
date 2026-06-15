import { useMemo } from "react";
import { Popover } from "antd";
import { asRecord, type CodexRecord } from "../core/codexRecord.js";
import {
  activityStatusTitle,
  formatComposerModelButtonLabel,
  formatComposerModelTitle,
  formatContextTitle,
  formatContextUsage,
  formatRateLimitRemaining,
  formatResetTitle,
  latestTurnStatusFromRecords,
  shortId,
  threadDisplayRecords,
  threadDisplayTitle
} from "./appHelpers.js";
import type { AppSelectors } from "./appSelectors.js";
import type { AppState } from "./appState.js";
import type { ActivityStatusView, OpenThreadState } from "./types.js";

type ThreadTabTurnMeta = {
  status: "running" | "idle";
  duration: string;
};

type ComposerThreadControlsMode = "inline" | "popover";

type ComposerThreadControlsProps = {
  activeThread: AppSelectors["activeThread"];
  activeThreadModel: AppSelectors["activeThreadModel"];
  activeThreadModelDraft: AppSelectors["activeThreadModelDraft"];
  activeThreadReasoning: AppSelectors["activeThreadReasoning"];
  activeThreadReasoningDraft: AppSelectors["activeThreadReasoningDraft"];
  activeThreadUsage: AppSelectors["activeThreadUsage"];
  mode: ComposerThreadControlsMode;
  setHiddenStatusTurns: AppState["setHiddenStatusTurns"];
  setThreadControlsMenuOpen: AppState["setThreadControlsMenuOpen"];
  setThreadModelDialogOpen: AppState["setThreadModelDialogOpen"];
  simpleStatuses: AppSelectors["simpleStatuses"];
  turnUiState: AppSelectors["turnUiState"];
};

export const useAppViewSelectors = (state: AppState, selectors: AppSelectors) => {
  const openThreadTabs = useMemo(() => state.openThreads.map((thread) => ({
    key: thread.threadId,
    label: <OpenThreadTabLabel thread={thread} nowMs={state.nowMs} />
  })), [state.nowMs, state.openThreads]);

  const renderComposerThreadControls = (mode: ComposerThreadControlsMode) => (
    <ComposerThreadControls
      activeThread={selectors.activeThread}
      activeThreadModel={selectors.activeThreadModel}
      activeThreadModelDraft={selectors.activeThreadModelDraft}
      activeThreadReasoning={selectors.activeThreadReasoning}
      activeThreadReasoningDraft={selectors.activeThreadReasoningDraft}
      activeThreadUsage={selectors.activeThreadUsage}
      mode={mode}
      setHiddenStatusTurns={state.setHiddenStatusTurns}
      setThreadControlsMenuOpen={state.setThreadControlsMenuOpen}
      setThreadModelDialogOpen={state.setThreadModelDialogOpen}
      simpleStatuses={selectors.simpleStatuses}
      turnUiState={selectors.turnUiState}
    />
  );

  return {
    openThreadTabs,
    renderComposerThreadControls
  };
};

export type AppViewSelectors = ReturnType<typeof useAppViewSelectors>;

const OpenThreadTabLabel = ({ thread, nowMs }: { thread: OpenThreadState; nowMs: number }) => {
  const title = threadDisplayTitle(thread);
  const workspaceName = compactWorkspaceName(thread.workingDirectory);
  const records = threadDisplayRecords(thread.threadId, thread);
  const turnStatus = latestTurnStatusFromRecords(records);
  const turnMeta = threadTabTurnMeta(thread, records, turnStatus, nowMs);
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
  activeThreadUsage,
  mode,
  setHiddenStatusTurns,
  setThreadControlsMenuOpen,
  setThreadModelDialogOpen,
  simpleStatuses,
  turnUiState
}: ComposerThreadControlsProps) => {
  const statusButtonLabel = simpleStatuses.length ? `Status ${simpleStatuses.length}` : "Status";
  const statusButtonTitle = simpleStatuses.length
    ? `Show latest turn status\n${activityStatusTitle(simpleStatuses)}`
    : turnUiState.title;
  const composerModelButtonLabel = formatComposerModelButtonLabel(
    activeThreadModelDraft,
    activeThreadReasoningDraft,
    activeThreadModel,
    activeThreadReasoning
  );
  const composerModelButtonTitle = formatComposerModelTitle(
    activeThreadModelDraft,
    activeThreadReasoningDraft,
    activeThreadModel,
    activeThreadReasoning
  );

  return (
    <div className={`composerSessionControls ${mode}`} aria-label="Thread usage and model">
      <div className="composerUsagePills" aria-label="Thread usage">
        <button
          type="button"
          className={`usagePill statusPill${simpleStatuses.length ? " available" : ""}`}
          disabled={!simpleStatuses.length}
          title={statusButtonTitle}
          onClick={() => {
            if (!activeThread?.threadId) return;
            setHiddenStatusTurns((current) => {
              if (!(activeThread.threadId in current)) return current;
              const next = { ...current };
              delete next[activeThread.threadId];
              return next;
            });
          }}
        >
          {statusButtonLabel}
        </button>
        <span className="usagePill" title={formatContextTitle(activeThreadUsage)}>
          Context {formatContextUsage(activeThreadUsage)}
        </span>

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
      </button>
    </div>
  );
};

const compactWorkspaceName = (value: string) => {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? (value || "workspace");
};

const threadTabTurnMeta = (
  thread: OpenThreadState,
  records: CodexRecord[],
  turnStatus: ActivityStatusView | null,
  nowMs: number
): ThreadTabTurnMeta => {
  const running = Boolean(thread.running || turnStatus?.status === "pending");
  if (running) {
    const startedAt = latestTurnStartedAt(records) ?? (turnStatus?.status === "pending" ? turnStatus.at : undefined);
    const startedMs = startedAt ? Date.parse(startedAt) : NaN;
    return {
      status: "running",
      duration: Number.isFinite(startedMs) ? formatThreadTabDuration(nowMs - startedMs) : ""
    };
  }
  const durationMs = latestCompletedTurnDurationMs(records);
  return {
    status: "idle",
    duration: durationMs == null ? "" : formatThreadTabDuration(durationMs)
  };
};

const latestTurnStartedAt = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const payload = asRecord(record.payload);
    if (record.type === "event_msg" && payload?.type === "task_started") return record.timestamp;
  }
  return undefined;
};

const latestCompletedTurnDurationMs = (records: CodexRecord[]) => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = asRecord(records[index].payload);
    if (!payload || (payload.type !== "task_complete" && payload.type !== "turn_aborted")) continue;
    const duration = payload.duration_ms;
    return typeof duration === "number" && Number.isFinite(duration) ? Math.max(0, duration) : undefined;
  }
  return undefined;
};

const formatThreadTabDuration = (durationMs: number) => {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h${minutes}m${remainder}s`;
  if (minutes) return `${minutes}m${remainder}s`;
  return `${remainder}s`;
};
