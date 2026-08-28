import React from "react";
import { FileText, Image as ImageIcon, Paperclip, X } from "lucide-react";
import { Virtuoso, type Components, type VirtuosoHandle } from "react-virtuoso";
import type {
  AppServerApprovalDecision,
  AppServerUserInputAnswers,
  CommandPalette
} from "../shared/apiContract.js";
import { backgroundTerminalViewsFromThread } from "./helpers/records.js";
import type { SubagentActivityView } from "../shared/recordTypes.js";
import { ComposerSubmitButton, ComposerTextInput } from "./ComposerTextInput.js";
import {
  activeGoalActivityScopeFromRecords,
  activityStatusesFromRecords,
  ActivityStatusBar,
  StatusCardOverview,
  canForkAtMessage,
  canRenderMarkdown,
  EmptyMessages,
  latestTurnActivityScope,
  MessageCard,
  ThreadStatusCard,
  threadDisplayRecords
} from "./appHelpers.js";
import type { ComposerDraftStore } from "./helpers/composer.js";
import { renderedPrependCount } from "./helpers/historyViewport.js";
import {
  resolveStatusPanelExpanded,
  type StatusPanelExpansionDecision
} from "./helpers/statusPanelExpansion.js";
import {
  MessagesTurnLoadingFooter,
  type MessagesTurnLoadingContext
} from "./helpers/liveTime.js";
import type {
  ComposerMode,
  ImagePreviewState,
  MessageRenderMode,
  OpenThreadState,
  ThreadExecutionMeta,
  ThreadGoalView,
  WebRecordView
} from "./types.js";

type MaybePromise<T = void> = T | Promise<T>;

export type ThreadConversationProps = {
  thread: OpenThreadState;
  views: WebRecordView[];
  userMessageHistory: string[];
  composerDraftStore: ComposerDraftStore;
  commandPaletteByScope: Record<string, CommandPalette>;
  commandPaletteLoadingScopes: Record<string, boolean>;
  executionMeta: ThreadExecutionMeta | null;
  activeGoal?: ThreadGoalView | null;
  messageRenderModes: Readonly<Record<string, MessageRenderMode>>;
  expandedStatusKeys: Readonly<Record<string, string[]>>;
  expandedStatusTurns: Readonly<Record<string, StatusPanelExpansionDecision>>;

  className?: string;
  leading?: React.ReactNode;
  goal?: React.ReactNode;
  leftActions?: React.ReactNode;
  threadControls?: React.ReactNode;

  messagesRef?: React.RefObject<VirtuosoHandle | null>;
  messagesShouldFollowRef?: React.MutableRefObject<boolean>;
  composerTextareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  fileInputRef?: React.RefObject<HTMLInputElement | null>;

  showSendButton?: boolean;
  canStop?: boolean;
  threadModelDialogOpen?: boolean;
  forkingMessageKey?: string;

  onSend: (threadId: string) => MaybePromise;
  onStop: (threadId: string) => MaybePromise;
  onTerminateBackgroundTerminal: (threadId: string, processId: string) => MaybePromise;
  onAddFiles: (threadId: string, files: FileList | null) => MaybePromise;
  onClearAttachments: (threadId: string) => void;
  onRemoveImage: (threadId: string, attachmentId: string) => void;
  onRemoveTextAttachment: (threadId: string, attachmentId: string) => void;
  onCompactThread: (threadId: string) => MaybePromise;
  onReviewThread: (threadId: string) => MaybePromise;
  onUpdateInput: (threadId: string, input: string) => void;
  onSetComposerMode: (threadId: string, mode: ComposerMode) => void;
  onHandleComposerKeyDown: (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    threadId: string,
    history: string[],
    canSend: boolean
  ) => void;
  onInsertPathText: (
    threadId: string,
    paths: string[],
    textarea: HTMLTextAreaElement | null,
    caretIndex?: number | null
  ) => void;
  onLoadCommandPalette: (threadId: string, machineId: string, cwd: string) => MaybePromise;
  onLoadOlderThread: (threadId: string) => MaybePromise<number>;
  onPasteImages: (threadId: string, clipboardData: DataTransfer) => boolean;
  onResetComposerHistory: (threadId: string) => void;
  onResizeComposerTextarea: (threadId: string, textarea: HTMLTextAreaElement | null) => void;
  onThreadModelDialogChange?: (threadId: string, open: boolean) => void;
  setExpandedStatusKeys: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  setExpandedStatusTurns: React.Dispatch<React.SetStateAction<Record<string, StatusPanelExpansionDecision>>>;

  onMessageRenderModeChange?: (
    threadId: string,
    messageId: string,
    mode: MessageRenderMode
  ) => void;
  onMessageSelection?: (
    event: React.MouseEvent<HTMLElement>,
    threadId: string
  ) => void;
  onInspectMessage?: (threadId: string, message: WebRecordView) => void;
  onDismissPendingMessage?: (threadId: string, messageId: string) => void;
  onCancelQueuedMessage?: (threadId: string, messageId: string, submissionId: string) => MaybePromise;
  onOpenImage?: (image: ImagePreviewState) => void;
  onOpenSubagentThread?: (threadId: string, activity: SubagentActivityView) => MaybePromise;
  onToggleToolBatch?: (threadId: string, toolBatchKey: string, expanded: boolean) => void;
  onApprovalDecision?: (
    threadId: string,
    approvalId: string,
    decision: AppServerApprovalDecision
  ) => MaybePromise;
  onUserInputResponse?: (
    threadId: string,
    userInputId: string,
    answers: AppServerUserInputAnswers
  ) => MaybePromise;
  onForkMessage?: (threadId: string, recordId: string) => MaybePromise;
};

const messagesBottomThreshold = 48;
const messagesScrollbarHitArea = 20;
const messagesScrollbarIntentMs = 900;
const messagesUpScrollKeys = new Set(["ArrowUp", "PageUp", "Home"]);
const messagesDownScrollKeys = new Set(["ArrowDown", "PageDown", "End"]);
const threadFileAccept = "image/*,.css,.csv,.html,.js,.json,.jsx,.log,.md,.py,.sh,.sql,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml";

const firstContentLine = (text: string) =>
  text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";

const clippedText = (text: string, maxLength: number) =>
  text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;

const textAttachmentTitle = (text: string) => {
  const firstLine = firstContentLine(text);
  const fileMatch = /^File:\s*(.+)$/i.exec(firstLine);
  const pathMatch = /^Path:\s*(.+)$/i.exec(firstLine);
  return clippedText(fileMatch?.[1] || pathMatch?.[1] || "Text selection", 80);
};

const textAttachmentPreview = (text: string) => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const previewLines = /^(File|Path):/i.test(lines[0] ?? "") ? lines.slice(1) : lines;
  return clippedText((previewLines.join(" ") || lines[0] || "Text").replace(/\s+/g, " "), 160);
};

const textAttachmentTooltip = (text: string) => {
  const title = textAttachmentTitle(text);
  const preview = textAttachmentPreview(text);
  return title === preview ? title : `${title}\n${preview}`;
};

const attachmentCountLabel = (count: number) =>
  `${count} attachment${count === 1 ? "" : "s"}`;

const classNames = (...values: Array<string | undefined>) => values.filter(Boolean).join(" ");

export const ThreadConversation = ({
  thread,
  views,
  userMessageHistory,
  composerDraftStore,
  commandPaletteByScope,
  commandPaletteLoadingScopes,
  executionMeta,
  activeGoal = null,
  messageRenderModes,
  expandedStatusKeys,
  expandedStatusTurns,
  className,
  leading,
  goal,
  leftActions,
  threadControls,
  messagesRef: suppliedMessagesRef,
  messagesShouldFollowRef: suppliedMessagesShouldFollowRef,
  composerTextareaRef: suppliedComposerTextareaRef,
  fileInputRef: suppliedFileInputRef,
  showSendButton = !thread.running,
  canStop,
  threadModelDialogOpen = false,
  forkingMessageKey = "",
  onSend,
  onStop,
  onTerminateBackgroundTerminal,
  onAddFiles,
  onClearAttachments,
  onRemoveImage,
  onRemoveTextAttachment,
  onCompactThread,
  onReviewThread,
  onUpdateInput,
  onSetComposerMode,
  onHandleComposerKeyDown,
  onInsertPathText,
  onLoadCommandPalette,
  onLoadOlderThread,
  onPasteImages,
  onResetComposerHistory,
  onResizeComposerTextarea,
  onThreadModelDialogChange,
  setExpandedStatusKeys,
  setExpandedStatusTurns,
  onMessageRenderModeChange,
  onMessageSelection,
  onInspectMessage,
  onDismissPendingMessage,
  onCancelQueuedMessage,
  onOpenImage,
  onOpenSubagentThread,
  onToggleToolBatch,
  onApprovalDecision,
  onUserInputResponse,
  onForkMessage
}: ThreadConversationProps) => {
  const localMessagesRef = React.useRef<VirtuosoHandle | null>(null);
  const localMessagesShouldFollowRef = React.useRef(true);
  const localComposerTextareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const localFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const messagesRef = suppliedMessagesRef ?? localMessagesRef;
  const messagesShouldFollowRef = suppliedMessagesShouldFollowRef ?? localMessagesShouldFollowRef;
  const composerTextareaRef = suppliedComposerTextareaRef ?? localComposerTextareaRef;
  const fileInputRef = suppliedFileInputRef ?? localFileInputRef;
  const messagesScrollbarIntentRef = React.useRef(false);
  const messagesScrollbarIntentTimerRef = React.useRef<number | null>(null);
  const messagesLastScrollTopRef = React.useRef<number | null>(null);
  const messagesLastTouchYRef = React.useRef<number | null>(null);
  const messagesStickScrollFrameRef = React.useRef<number | null>(null);
  const loadingOlderRef = React.useRef(false);
  const historyPrependRef = React.useRef(false);
  const historyPrependReleaseTimerRef = React.useRef<number | null>(null);
  const previousViewIdsRef = React.useRef(views.map((view) => view.id));
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [historyLoadFailed, setHistoryLoadFailed] = React.useState(false);
  const [firstItemIndex, setFirstItemIndex] = React.useState(1_000_000);
  const attachmentCount = thread.textAttachments.length + thread.imageAttachments.length;
  const runtimeReady = Boolean(thread.runtime.online && thread.runtime.runnable !== false);
  const executionStatus = executionMeta?.status ?? "idle";
  const executionLabel = executionMeta?.label ?? "Idle";
  const executionText = executionMeta?.text ?? executionLabel;
  const showTurnLoadingMessage = executionStatus === "waiting" || executionStatus === "running";
  const backgroundTerminals = React.useMemo(
    () => backgroundTerminalViewsFromThread(thread),
    [thread.backgroundTerminals, thread.records]
  );
  // The Thread card is always mounted; the Turn card below is mounted only
  // while the thread has an active Waiting/Running Turn.
  const statusRecords = React.useMemo(
    () => threadDisplayRecords(thread.threadId, thread),
    [thread]
  );
  const statusActivity = React.useMemo(() => {
    const latestActivity = thread.status === "waiting"
      ? { key: "waiting", records: [] }
      : latestTurnActivityScope(statusRecords, thread.activeTurnId);
    const goalActivity = activeGoal
      ? activeGoalActivityScopeFromRecords(statusRecords, thread.threadId)
      : null;
    const key = goalActivity?.key ?? latestActivity.key;
    return {
      items: activityStatusesFromRecords(goalActivity?.records ?? latestActivity.records),
      scopeKey: key ? `${thread.threadId}:${key}` : ""
    };
  }, [activeGoal, statusRecords, thread.activeTurnId, thread.status, thread.threadId]);
  const statusPanelExpanded = resolveStatusPanelExpanded({
    scopeKey: statusActivity.scopeKey,
    decision: expandedStatusTurns[thread.threadId],
    statuses: statusActivity.items,
    backgroundTerminalCount: backgroundTerminals.length
  });
  const activeExpandedStatusKeys = React.useMemo(
    () => new Set(statusActivity.scopeKey ? expandedStatusKeys[statusActivity.scopeKey] ?? [] : []),
    [expandedStatusKeys, statusActivity.scopeKey]
  );
  const expandedStatusKeysInitialized = Boolean(
    statusActivity.scopeKey
    && Object.prototype.hasOwnProperty.call(expandedStatusKeys, statusActivity.scopeKey)
  );
  const stopEnabled = canStop ?? Boolean(
    runtimeReady
    && thread.status === "running"
    && thread.activeTurnId
  );
  const messagesVirtuosoContext = React.useMemo<MessagesTurnLoadingContext>(
    () => ({ executionMeta, activeGoal }),
    [activeGoal, executionMeta]
  );

  React.useEffect(() => {
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    setHistoryLoadFailed(false);
    setFirstItemIndex(1_000_000);
    historyPrependRef.current = false;
    previousViewIdsRef.current = views.map((view) => view.id);
  }, [thread.threadId]);

  React.useLayoutEffect(() => {
    const currentViewIds = views.map((view) => view.id);
    if (historyPrependRef.current) {
      const anchoredPrependCount = renderedPrependCount(previousViewIdsRef.current, currentViewIds);
      const prependCount = anchoredPrependCount
        ?? Math.max(0, currentViewIds.length - previousViewIdsRef.current.length);
      if (prependCount > 0) setFirstItemIndex((current) => current - prependCount);
    }
    previousViewIdsRef.current = currentViewIds;
  }, [thread.threadId, views]);

  const loadOlderMessages = React.useCallback(async () => {
    if (loadingOlderRef.current || !thread.history?.hasOlder) return;
    loadingOlderRef.current = true;
    historyPrependRef.current = true;
    messagesShouldFollowRef.current = false;
    setLoadingOlder(true);
    setHistoryLoadFailed(false);
    try {
      await onLoadOlderThread(thread.threadId);
    } catch {
      setHistoryLoadFailed(true);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
      if (historyPrependReleaseTimerRef.current !== null) {
        window.clearTimeout(historyPrependReleaseTimerRef.current);
      }
      historyPrependReleaseTimerRef.current = window.setTimeout(() => {
        historyPrependRef.current = false;
        historyPrependReleaseTimerRef.current = null;
      }, 250);
    }
  }, [onLoadOlderThread, thread.history?.hasOlder, thread.threadId]);

  const messagesVirtuosoComponents = React.useMemo<Components<WebRecordView, MessagesTurnLoadingContext>>(
    () => ({
      EmptyPlaceholder: EmptyMessages,
      Footer: showTurnLoadingMessage ? MessagesTurnLoadingFooter : undefined,
      Header: loadingOlder
        ? () => <div className="messagesHistoryLoading">Loading older messages…</div>
        : historyLoadFailed
          ? () => (
              <button
                type="button"
                className="messagesHistoryRetry"
                onClick={() => void loadOlderMessages()}
              >
                Older messages failed · Retry
              </button>
            )
          : undefined
    }),
    [historyLoadFailed, loadOlderMessages, loadingOlder, showTurnLoadingMessage]
  );

  React.useEffect(() => {
    if (
      views.length
      || !thread.history?.hasOlder
      || loadingOlderRef.current
      || historyLoadFailed
    ) return;
    void loadOlderMessages();
  }, [historyLoadFailed, loadOlderMessages, thread.history?.hasOlder, views.length]);

  React.useEffect(() => () => {
    if (messagesScrollbarIntentTimerRef.current !== null) {
      window.clearTimeout(messagesScrollbarIntentTimerRef.current);
      messagesScrollbarIntentTimerRef.current = null;
    }
    if (messagesStickScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(messagesStickScrollFrameRef.current);
      messagesStickScrollFrameRef.current = null;
    }
    if (historyPrependReleaseTimerRef.current !== null) {
      window.clearTimeout(historyPrependReleaseTimerRef.current);
      historyPrependReleaseTimerRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    messagesShouldFollowRef.current = true;
    messagesScrollbarIntentRef.current = false;
    messagesLastScrollTopRef.current = null;
    messagesLastTouchYRef.current = null;
    if (messagesScrollbarIntentTimerRef.current !== null) {
      window.clearTimeout(messagesScrollbarIntentTimerRef.current);
      messagesScrollbarIntentTimerRef.current = null;
    }
    if (messagesStickScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(messagesStickScrollFrameRef.current);
      messagesStickScrollFrameRef.current = null;
    }
  }, [messagesShouldFollowRef, thread.threadId]);

  const scrollMessagesToBottom = React.useCallback(() => {
    if (!messagesShouldFollowRef.current) return;
    if (messagesStickScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(messagesStickScrollFrameRef.current);
    }
    messagesStickScrollFrameRef.current = window.requestAnimationFrame(() => {
      messagesStickScrollFrameRef.current = null;
      if (!messagesShouldFollowRef.current) return;
      messagesRef.current?.autoscrollToBottom();
      messagesStickScrollFrameRef.current = window.requestAnimationFrame(() => {
        messagesStickScrollFrameRef.current = null;
        if (!messagesShouldFollowRef.current) return;
        messagesRef.current?.scrollTo({
          top: Number.MAX_SAFE_INTEGER,
          behavior: "auto"
        });
      });
    });
  }, [messagesRef, messagesShouldFollowRef]);

  React.useEffect(() => {
    if (showTurnLoadingMessage && messagesShouldFollowRef.current) scrollMessagesToBottom();
  }, [messagesShouldFollowRef, scrollMessagesToBottom, showTurnLoadingMessage]);

  const markMessagesScrollbarIntent = React.useCallback((scroller: HTMLElement) => {
    messagesScrollbarIntentRef.current = true;
    messagesLastScrollTopRef.current = scroller.scrollTop;
    if (messagesScrollbarIntentTimerRef.current !== null) {
      window.clearTimeout(messagesScrollbarIntentTimerRef.current);
    }
    messagesScrollbarIntentTimerRef.current = window.setTimeout(() => {
      messagesScrollbarIntentRef.current = false;
      messagesScrollbarIntentTimerRef.current = null;
      messagesLastScrollTopRef.current = null;
    }, messagesScrollbarIntentMs);
  }, []);

  const clearMessagesScrollbarIntent = React.useCallback(() => {
    messagesScrollbarIntentRef.current = false;
    messagesLastScrollTopRef.current = null;
    if (messagesScrollbarIntentTimerRef.current !== null) {
      window.clearTimeout(messagesScrollbarIntentTimerRef.current);
      messagesScrollbarIntentTimerRef.current = null;
    }
  }, []);

  const handleMessagesScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (!messagesScrollbarIntentRef.current) return;
    const previousScrollTop = messagesLastScrollTopRef.current;
    const nextScrollTop = event.currentTarget.scrollTop;
    messagesLastScrollTopRef.current = nextScrollTop;
    if (previousScrollTop !== null && nextScrollTop < previousScrollTop) {
      messagesShouldFollowRef.current = false;
    }
  }, [messagesShouldFollowRef]);

  const handleMessagesWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.deltaY < 0) messagesShouldFollowRef.current = false;
  }, [messagesShouldFollowRef]);

  const handleMessagesTouchStart = React.useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    messagesLastTouchYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleMessagesTouchMove = React.useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const nextTouchY = event.touches[0]?.clientY ?? null;
    const previousTouchY = messagesLastTouchYRef.current;
    messagesLastTouchYRef.current = nextTouchY;
    if (nextTouchY !== null && previousTouchY !== null && nextTouchY > previousTouchY) {
      messagesShouldFollowRef.current = false;
    }
  }, [messagesShouldFollowRef]);

  const handleMessagesTouchEnd = React.useCallback(() => {
    messagesLastTouchYRef.current = null;
  }, []);

  const handleMessagesPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.right - messagesScrollbarHitArea) return;
    markMessagesScrollbarIntent(event.currentTarget);
  }, [markMessagesScrollbarIntent]);

  const handleMessagesKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const scrollsUp = messagesUpScrollKeys.has(event.key) || (event.key === " " && event.shiftKey);
    const scrollsDown = messagesDownScrollKeys.has(event.key) || (event.key === " " && !event.shiftKey);
    if (!scrollsUp && !scrollsDown) return;
    if (scrollsUp) {
      messagesShouldFollowRef.current = false;
    } else if (event.key === "End") {
      messagesShouldFollowRef.current = true;
      scrollMessagesToBottom();
    }
  }, [messagesShouldFollowRef, scrollMessagesToBottom]);

  const setThreadModelDialogOpen = React.useCallback<React.Dispatch<React.SetStateAction<boolean>>>(
    (next) => {
      const open = typeof next === "function" ? next(threadModelDialogOpen) : next;
      onThreadModelDialogChange?.(thread.threadId, open);
    },
    [onThreadModelDialogChange, thread.threadId, threadModelDialogOpen]
  );

  const renderMessage = React.useCallback((message: WebRecordView) => {
    const markdownEnabled = canRenderMarkdown(message);
    const renderMode = markdownEnabled ? messageRenderModes[message.id] ?? "markdown" : "raw";
    const toolBatchKey = message.toolBatch?.key;
    const inspectable = message.role === "tool" && !toolBatchKey;
    const card = (
      <MessageCard
        message={message}
        showStatus
        showTimestamp={message.role !== "tool"}
        renderToolPreview
        renderMode={renderMode}
        markdownEnabled={markdownEnabled}
        threadMachineId={thread.runtime.machineId}
        threadWorkingDirectory={thread.workingDirectory}
        onRenderModeChange={markdownEnabled && onMessageRenderModeChange
          ? (mode) => onMessageRenderModeChange(thread.threadId, message.id, mode)
          : undefined}
        onSelectionMenu={onMessageSelection
          ? (event) => onMessageSelection(event, thread.threadId)
          : undefined}
        onInspect={inspectable && onInspectMessage
          ? () => onInspectMessage(thread.threadId, message)
          : undefined}
        onDismiss={message.queuedSubmissionId && onCancelQueuedMessage
          ? () => void onCancelQueuedMessage(thread.threadId, message.id, message.queuedSubmissionId!)
          : message.pendingUserMessage && onDismissPendingMessage
            ? () => onDismissPendingMessage(thread.threadId, message.id)
            : undefined}
        dismissLabel={message.queuedSubmissionId ? "Cancel queued message" : "Dismiss pending message"}
        onOpenImage={onOpenImage}
        onOpenSubagentThread={onOpenSubagentThread
          ? (activity) => onOpenSubagentThread(thread.threadId, activity)
          : undefined}
        onToggleToolBatch={toolBatchKey && onToggleToolBatch
          ? () => onToggleToolBatch(thread.threadId, toolBatchKey, !message.toolBatch?.expanded)
          : undefined}
        onApprovalDecision={onApprovalDecision
          ? (approvalId, decision) => void onApprovalDecision(thread.threadId, approvalId, decision)
          : undefined}
        onUserInputResponse={onUserInputResponse
          ? (userInputId, answers) => onUserInputResponse(thread.threadId, userInputId, answers)
          : undefined}
        onFork={onForkMessage && canForkAtMessage(thread.threadId, message)
          ? () => void onForkMessage(thread.threadId, message.record.id)
          : undefined}
        forkDisabled={Boolean(forkingMessageKey)}
        forking={forkingMessageKey === `${thread.threadId}:${message.record.id}`}
      />
    );
    return card;
  }, [
    forkingMessageKey,
    messageRenderModes,
    onApprovalDecision,
    onDismissPendingMessage,
    onCancelQueuedMessage,
    onForkMessage,
    onInspectMessage,
    onMessageSelection,
    onMessageRenderModeChange,
    onOpenImage,
    onOpenSubagentThread,
    onToggleToolBatch,
    onUserInputResponse,
    thread.threadId,
    thread.workingDirectory
  ]);
  const threadStatus = executionMeta ? (
    <ThreadStatusCard
      visible={statusPanelExpanded}
      backgroundTerminals={backgroundTerminals}
      onTerminate={(processId) => onTerminateBackgroundTerminal(thread.threadId, processId)}
    />
  ) : null;
  const turnStatus = showTurnLoadingMessage && executionMeta && statusActivity.items.length ? (
    <ActivityStatusBar
      statuses={statusActivity.items}
      expanded={statusPanelExpanded}
      expandedKeys={activeExpandedStatusKeys}
      expandedKeysInitialized={expandedStatusKeysInitialized}
      onToggle={(key, expanded) => {
        if (!statusActivity.scopeKey) return;
        setExpandedStatusKeys((current) => {
          const keys = new Set(current[statusActivity.scopeKey] ?? []);
          if (expanded) keys.delete(key);
          else keys.add(key);
          return { ...current, [statusActivity.scopeKey]: [...keys] };
        });
      }}
    />
  ) : null;
  const status = executionMeta ? (
    <div
      className={`activityStatusBar statusCard ${executionStatus}${backgroundTerminals.length ? " background" : ""}${turnStatus ? " hasTurn" : ""}`}
      aria-live="polite"
    >
      <StatusCardOverview
        executionMeta={executionMeta}
        turnActive={showTurnLoadingMessage}
        statuses={statusActivity.items}
        backgroundTerminals={backgroundTerminals}
        expanded={statusPanelExpanded}
        onToggleExpanded={() => {
          if (!statusActivity.scopeKey) return;
          setExpandedStatusTurns((current) => {
            return {
              ...current,
              [thread.threadId]: {
                scopeKey: statusActivity.scopeKey,
                expanded: !statusPanelExpanded
              }
            };
          });
        }}
      />
      {turnStatus}
      {threadStatus}
    </div>
  ) : null;

  return (
    <div className={classNames("threadConversation", className)}>
      {leading ? <div className="threadConversationLeading">{leading}</div> : null}
      <Virtuoso
        key={thread.threadId}
        ref={messagesRef}
        className="messages"
        data={views}
        firstItemIndex={firstItemIndex}
        startReached={loadOlderMessages}
        onKeyDown={handleMessagesKeyDown}
        onPointerCancel={clearMessagesScrollbarIntent}
        onPointerDown={handleMessagesPointerDown}
        onPointerUp={clearMessagesScrollbarIntent}
        onScroll={handleMessagesScroll}
        onTouchCancel={handleMessagesTouchEnd}
        onTouchEnd={handleMessagesTouchEnd}
        onTouchMove={handleMessagesTouchMove}
        onTouchStart={handleMessagesTouchStart}
        onWheel={handleMessagesWheel}
        atBottomStateChange={(atBottom) => {
          if (atBottom) {
            if (!historyPrependRef.current) messagesShouldFollowRef.current = true;
          } else if (!historyPrependRef.current && messagesShouldFollowRef.current) {
            scrollMessagesToBottom();
          }
        }}
        atBottomThreshold={messagesBottomThreshold}
        followOutput={() => messagesShouldFollowRef.current ? "auto" : false}
        totalListHeightChanged={() => {
          if (!historyPrependRef.current && messagesShouldFollowRef.current) scrollMessagesToBottom();
        }}
        initialTopMostItemIndex={firstItemIndex + Math.max(views.length - 1, 0)}
        increaseViewportBy={{ top: 360, bottom: 720 }}
        computeItemKey={(_, message) => message.id}
        components={messagesVirtuosoComponents}
        context={messagesVirtuosoContext}
        itemContent={(_, message) => renderMessage(message)}
      />
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (runtimeReady) void onSend(thread.threadId);
        }}
      >
        <div className="composerLayout">
          {status}
          <div className="composerSurface">
            {goal}
            <div className="composerInput">
              {attachmentCount ? (
                <div
                  className="composerAttachmentStrip"
                  aria-label={`${attachmentCountLabel(attachmentCount)} selected`}
                >
                  <div
                    className="composerAttachmentCount"
                    title={`${attachmentCountLabel(attachmentCount)} selected`}
                  >
                    <Paperclip aria-hidden="true" />
                    <span>{attachmentCount}</span>
                  </div>
                  <div className="composerAttachmentScroller">
                    {thread.textAttachments.map((item) => (
                      <div
                        className="composerAttachmentChip text"
                        key={item.id}
                        title={textAttachmentTooltip(item.text)}
                      >
                        <span className="composerAttachmentIcon" aria-hidden="true">
                          <FileText />
                        </span>
                        <span className="composerAttachmentText">
                          <span className="composerAttachmentName">{textAttachmentTitle(item.text)}</span>
                          <span className="composerAttachmentPreview">{textAttachmentPreview(item.text)}</span>
                        </span>
                        <button
                          type="button"
                          className="composerAttachmentRemoveButton"
                          onClick={() => onRemoveTextAttachment(thread.threadId, item.id)}
                          aria-label={`Remove ${textAttachmentTitle(item.text)}`}
                          title="Remove attachment"
                        >
                          <X aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                    {thread.imageAttachments.map((image) => (
                      <div
                        className="composerAttachmentChip image"
                        key={image.id}
                        title={image.name || "Image attachment"}
                      >
                        {onOpenImage ? (
                          <button
                            type="button"
                            className="composerAttachmentThumb composerAttachmentThumbButton"
                            onClick={() => onOpenImage({
                              url: image.previewUrl,
                              title: image.name || "Image attachment"
                            })}
                            aria-label={`Preview ${image.name || "image attachment"}`}
                            title="Preview image"
                          >
                            <img src={image.previewUrl} alt="" />
                          </button>
                        ) : (
                          <span className="composerAttachmentThumb">
                            <img src={image.previewUrl} alt="" />
                          </span>
                        )}
                        <span className="composerAttachmentText">
                          <span className="composerAttachmentName">{image.name || "Image"}</span>
                          <span className="composerAttachmentPreview">
                            <ImageIcon aria-hidden="true" />
                            Image
                          </span>
                        </span>
                        <button
                          type="button"
                          className="composerAttachmentRemoveButton"
                          onClick={() => onRemoveImage(thread.threadId, image.id)}
                          aria-label={`Remove ${image.name || "image attachment"}`}
                          title="Remove attachment"
                        >
                          <X aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                  {attachmentCount > 1 ? (
                    <button
                      type="button"
                      className="composerAttachmentClearButton"
                      onClick={() => onClearAttachments(thread.threadId)}
                    >
                      Clear all
                    </button>
                  ) : null}
                </div>
              ) : null}
              <ComposerTextInput
                activeUserMessageHistory={userMessageHistory}
                commandPaletteByScope={commandPaletteByScope}
                commandPaletteLoadingScopes={commandPaletteLoadingScopes}
                compactThread={onCompactThread}
                composerDraftStore={composerDraftStore}
                composerTextareaRef={composerTextareaRef}
                handleComposerKeyDown={onHandleComposerKeyDown}
                insertThreadPathText={onInsertPathText}
                loadCommandPalette={(machineId, cwd) => onLoadCommandPalette(thread.threadId, machineId, cwd)}
                pasteThreadImages={onPasteImages}
                resetComposerHistory={onResetComposerHistory}
                resizeComposerTextarea={(textarea) => onResizeComposerTextarea(thread.threadId, textarea)}
                reviewThread={onReviewThread}
                setComposerMode={(mode) => onSetComposerMode(thread.threadId, mode)}
                setThreadModelDialogOpen={setThreadModelDialogOpen}
                thread={thread}
                updateThreadInput={onUpdateInput}
              />
            </div>
            <div className="composerActions">
              <div className="composerLeftActions">{leftActions}</div>
              <div className="composerRightActions">
                {threadControls}
                <div
                  className={`composerActionButtons status-${executionStatus}`}
                  title={executionText}
                  aria-label={`Thread status: ${executionLabel}`}
                >
                  {showSendButton ? (
                    <ComposerSubmitButton
                      attachmentCount={attachmentCount}
                      composerDraftStore={composerDraftStore}
                      runtimeReady={runtimeReady}
                      threadId={thread.threadId}
                      title={`Send message · ${executionText}`}
                    />
                  ) : null}
                  {thread.running ? (
                    <button
                      type="button"
                      className="composerStopButton composerActionButton"
                      disabled={!stopEnabled}
                      aria-label="Stop current turn"
                      title={`Stop current turn · ${executionText}`}
                      onClick={() => void onStop(thread.threadId)}
                    >
                      ■
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
            <input
              ref={fileInputRef}
              className="imageUploadInput"
              type="file"
              accept={threadFileAccept}
              multiple
              onChange={(event) => {
                void onAddFiles(thread.threadId, event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
          </div>
        </div>
      </form>
    </div>
  );
};
