import React from "react";
import { Tabs } from "antd";
import {
  FileText,
  Gauge,
  Image as ImageIcon,
  ListChecks,
  MessageCircle,
  Paperclip,
  Target,
  X,
  type LucideIcon
} from "lucide-react";
import { Virtuoso, type Components } from "react-virtuoso";
import { approvalPolicyOptions, composerModeOptions, isVscodeSurface, sandboxPolicyOptions } from "./appConfig.js";
import { AppDialogs } from "./AppDialogs.js";
import { AppSidebar } from "./AppSidebar.js";
import type { AppViewModel } from "./viewModel.js";
import {
  ActivityStatusOverlay,
  canForkAtMessage,
  canRenderMarkdown,
  EmptyMessages,
  formatGoalAge,
  goalStatusClass,
  goalStatusLabel,
  MessageCard,
  dataTransferHasPathPayload,
  droppedPathsFromDataTransfer,
  textareaCaretIndexFromPoint,
} from "./appHelpers.js";

type AppViewProps = {
  viewModel: AppViewModel;
};

const composerModeIconByValue: Record<(typeof composerModeOptions)[number]["value"], LucideIcon> = {
  chat: MessageCircle,
  plan: ListChecks,
  goal: Target
};

const weeklyGoalPolicyLabel = (targetRemainingPercent: number) =>
  `weekly ≤ ${formatGoalPolicyPercent(targetRemainingPercent)}`;

const formatGoalPolicyPercent = (value: number) =>
  `${Number.isInteger(value) ? value : value.toFixed(1)}%`;

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

const messagesBottomThreshold = 48;
const messagesScrollbarHitArea = 20;
const messagesUserScrollIntentMs = 900;
const messagesScrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

type MessagesVirtuosoContext = {
  turnLoadingDuration: string;
};

const MessagesTurnLoadingFooter = ({ context }: { context?: MessagesVirtuosoContext }) => {
  const duration = context?.turnLoadingDuration;
  return (
    <div
      className="turnLoadingMessage"
      role="status"
      aria-live="polite"
      aria-label={duration ? `Running ${duration}` : "Running"}
    >
      <span className="turnLoadingText">Running</span>
      {duration ? <span className="turnLoadingDuration">· {duration}</span> : null}
    </div>
  );
};

export const AppView = ({ viewModel }: AppViewProps) => {
  const {
    activeCanSend,
    activeCanStop,
    activeCanSubmit,
    activeExpandedStatusKeys,
    activeGoal,
    activeProjectKey,
    activeRuntimeSession,
    activeRunningTurnDuration,
    activeThread,
    activeThreadIsOpen,
    activeThreadTurnMeta,
    activeThreadApprovalPolicySelection,
    activeThreadSandboxPolicySelection,
    activeUserMessageHistory,
    activeViews,
    authError,
    authRequired,
    authTokenDraft,
    addContextSelectionToConversation,
    addThreadFiles,
    addThreadImages,
    addSshHost,
    changeProjectPickerMachine,
    chooseThreadCandidate,
    clearThreadAttachments,
    clearThreadGoal,
    closeThread,
    collapsedProjectMachineKeys,
    composerMenuOpen,
    composerMode,
    composerTextareaRef,
    confirmProjectPicker,
    connectionMode,
    connectSshHost,
    copyContextSelection,
    copyRegisteredCommand,
    createSessionThread,
    createTask,
    deleteProject,
    deleteTask,
    deletingProjectId,
    effectiveModelSelection,
    effectiveReasoningSelection,
    focusTaskDraftProject,
    forkMessage,
    goalDialog,
    handleComposerKeyDown,
    imageFileInputRef,
    insertThreadPathText,
    inspectContextMessage,
    inspectMessage,
    latestTurnStatusScope,
    loadProjectPickerDirectory,
    localMachines,
    messageContextMenu,
    messageDisplayMode,
    messageRenderModes,
    messagesRef,
    messagesShouldFollowRef,
    modelOptions,
    offlineProjectsCollapsed,
    onlineMachines,
    openingProjectKey,
    openMessageContextMenu,
    showProjectPicker,
    openSelectedProjectThreadPicker,
    pasteThreadImages,
    patchTask,
    projectGroups,
    projectList,
    projectActionError,
    projectPicker,
    registeredCommand,
    registeredCommandCopied,
    registeredMachines,
    removeThreadImage,
    removeThreadTextAttachment,
    removeSshHost,
    renderComposerThreadControls,
    resetComposerHistory,
    respondToApproval,
    respondToUserInput,
    reviewThread,
    resizeComposerTextarea,
    rollbackMessage,
    runTaskNow,
    saveGoalDialog,
    selectProject,
    selectedProject,
    send,
    sessionList,
    threadControlsMenuOpen,
    setComposerMenuOpen,
    setComposerMode,
    setConnectionMode,
    setExpandedStatusKeys,
    setExpandedToolBatchKeys,
    setGoalDialog,
    setHiddenStatusTurns,
    setInspectMessage,
    setMessageContextMenu,
    setMessageDisplayMode,
    setActiveThreadApprovalPolicyDraft,
    setActiveThreadSandboxPolicyDraft,
    setOfflineProjectsCollapsed,
    setProjectPicker,
    setAuthTokenDraft,
    setThreadControlsMenuOpen,
    setSidebarCollapsed,
    setSshHostDraft,
    setTaskDraft,
    setTaskFormOpen,
    setThreadPicker,
    showComposerSendButton,
    showInlineStatusPanel,
    sidebarCollapsed,
    sshConfigHostOptions,
    sshConfigHosts,
    sshConnectingHost,
    sshConnections,
    sshError,
    sshHostBusy,
    sshHostDraft,
    sshHosts,
    statusScopeKey,
    turnStatusItems,
    stopTurn,
    submitAuthToken,
    submitProjectPickerPath,
    switchSessionThread,
    taskBusyId,
    taskDraft,
    taskError,
    taskFormOpen,
    tasks,
    threadOrderBySession,
    threadPicker,
    toggleProjectMachineGroup,
    turnUiState,
    updateMessageRenderMode,
    updateThreadInput,
    updateTaskDraftMachine,
    updateTaskDraftProject,
    updateThreadGoal,
    openThreadEmptyMessage,
    openThreadTabs
  } = viewModel;
  const canAddThreadForProject = Boolean(activeRuntimeSession?.online || selectedProject?.machineOnline);
  const activeThreadKey = activeThread && activeThreadIsOpen ? activeThread.threadId : "";
  const activeAttachmentCount = activeThread
    ? activeThread.textAttachments.length + activeThread.imageAttachments.length
    : 0;
  const showThreadTabs = Boolean(activeThreadKey || canAddThreadForProject);
  const showTurnLoadingMessage = Boolean(activeThread?.running || turnUiState.kind === "running");
  const messagesVirtuosoContext = React.useMemo(
    () => ({ turnLoadingDuration: activeRunningTurnDuration }),
    [activeRunningTurnDuration]
  );
  const messagesVirtuosoComponents = React.useMemo<Components<(typeof activeViews)[number], MessagesVirtuosoContext>>(() => ({
    EmptyPlaceholder: EmptyMessages,
    Footer: showTurnLoadingMessage ? MessagesTurnLoadingFooter : undefined
  }), [showTurnLoadingMessage]);
  const messagesUserScrollIntentRef = React.useRef(false);
  const messagesUserScrollIntentTimerRef = React.useRef<number | null>(null);
  const messagesStickScrollFrameRef = React.useRef<number | null>(null);
  const composerDropCaretRef = React.useRef<Record<string, number>>({});
  const openGoalRunPolicyDialog = () => {
    if (!activeThread) return;
    const goalRunPolicy = activeThread.goalRunPolicy?.type === "consumeUntilWeeklyRemainingAtOrBelow"
      ? activeThread.goalRunPolicy
      : null;
    setGoalDialog({
      threadId: activeThread.threadId,
      objective: activeGoal?.objective ?? activeThread.input,
      targetRemainingPercent: goalRunPolicy
        ? String(goalRunPolicy.targetRemainingPercent)
        : "",
      saving: false,
      error: ""
    });
  };
  React.useEffect(() => () => {
    if (messagesUserScrollIntentTimerRef.current !== null) {
      window.clearTimeout(messagesUserScrollIntentTimerRef.current);
      messagesUserScrollIntentTimerRef.current = null;
    }
    if (messagesStickScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(messagesStickScrollFrameRef.current);
      messagesStickScrollFrameRef.current = null;
    }
  }, []);
  React.useEffect(() => {
    messagesUserScrollIntentRef.current = false;
    if (messagesUserScrollIntentTimerRef.current !== null) {
      window.clearTimeout(messagesUserScrollIntentTimerRef.current);
      messagesUserScrollIntentTimerRef.current = null;
    }
    if (messagesStickScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(messagesStickScrollFrameRef.current);
      messagesStickScrollFrameRef.current = null;
    }
  }, [activeThread?.threadId]);
  const scrollMessagesToBottom = React.useCallback(() => {
    if (messagesStickScrollFrameRef.current !== null) return;
    messagesStickScrollFrameRef.current = window.requestAnimationFrame(() => {
      messagesStickScrollFrameRef.current = null;
      if (!messagesShouldFollowRef.current) return;
      messagesRef.current?.scrollTo({
        top: Number.MAX_SAFE_INTEGER,
        behavior: "auto"
      });
    });
  }, [messagesRef, messagesShouldFollowRef]);
  React.useEffect(() => {
    if (showTurnLoadingMessage && messagesShouldFollowRef.current) scrollMessagesToBottom();
  }, [messagesShouldFollowRef, scrollMessagesToBottom, showTurnLoadingMessage]);
  const updateMessagesFollowFromUserScroll = React.useCallback((scroller: HTMLElement) => {
    const distanceFromBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    if (distanceFromBottom > messagesBottomThreshold) {
      messagesShouldFollowRef.current = false;
    } else {
      messagesShouldFollowRef.current = true;
    }
  }, [messagesShouldFollowRef]);
  const markMessagesUserScrollIntent = React.useCallback((scroller: HTMLElement, shouldLeaveBottom = true) => {
    messagesUserScrollIntentRef.current = true;
    if (shouldLeaveBottom) messagesShouldFollowRef.current = false;
    if (messagesUserScrollIntentTimerRef.current !== null) {
      window.clearTimeout(messagesUserScrollIntentTimerRef.current);
    }
    messagesUserScrollIntentTimerRef.current = window.setTimeout(() => {
      messagesUserScrollIntentRef.current = false;
      messagesUserScrollIntentTimerRef.current = null;
    }, messagesUserScrollIntentMs);
    window.requestAnimationFrame(() => updateMessagesFollowFromUserScroll(scroller));
  }, [messagesShouldFollowRef, updateMessagesFollowFromUserScroll]);
  const handleMessagesScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (!messagesUserScrollIntentRef.current) return;
    updateMessagesFollowFromUserScroll(event.currentTarget);
  }, [updateMessagesFollowFromUserScroll]);
  const handleMessagesWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    markMessagesUserScrollIntent(event.currentTarget, event.deltaY < 0);
  }, [markMessagesUserScrollIntent]);
  const handleMessagesTouchMove = React.useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    markMessagesUserScrollIntent(event.currentTarget);
  }, [markMessagesUserScrollIntent]);
  const handleMessagesPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.right - messagesScrollbarHitArea) return;
    markMessagesUserScrollIntent(event.currentTarget);
  }, [markMessagesUserScrollIntent]);
  const handleMessagesKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || !messagesScrollKeys.has(event.key)) return;
    markMessagesUserScrollIntent(event.currentTarget);
  }, [markMessagesUserScrollIntent]);
  if (authRequired) {
    return (
      <main className="authShell">
        <form className="authPanel" onSubmit={submitAuthToken}>
          <div className="authPanelHeader">
            <h1>Codex Hub</h1>
            <span>Access token required</span>
          </div>
          <label>
            <span>Token</span>
            <input
              type="password"
              value={authTokenDraft}
              onChange={(event) => setAuthTokenDraft(event.target.value)}
              autoFocus
              autoComplete="current-password"
            />
          </label>
          {authError ? <div className="authError">{authError}</div> : null}
          <button type="submit">Unlock</button>
        </form>
      </main>
    );
  }
  const sidebarToggle = (
    <button
      type="button"
      className="sidebarPanelToggle"
      onClick={() => setSidebarCollapsed((current) => !current)}
      aria-label={sidebarCollapsed ? "Show menu" : "Hide menu"}
      title={sidebarCollapsed ? "Show menu" : "Hide menu"}
    >
      {sidebarCollapsed ? "Menu" : "Hide"}
    </button>
  );
  return (
    <main className={`app ${sidebarCollapsed ? "sidebarCollapsed" : ""}`}>
      {!sidebarCollapsed ? (
        <button
          type="button"
          className="sidebarScrim"
          onClick={() => setSidebarCollapsed(true)}
          aria-label="Hide menu"
        />
      ) : null}
      <AppSidebar viewModel={viewModel} />

      <section className="workspace">
        {showThreadTabs ? (
          <Tabs
            className="openThreadTabs"
            tabBarExtraContent={{
              left: sidebarToggle,
              right: (
                <div className="threadTabActions">
                  <label className="switchControl">
                    <span>View</span>
                    <button
                      type="button"
                      className={`switchButton ${messageDisplayMode === "compact" ? "active" : ""}`}
                      aria-pressed={messageDisplayMode === "compact"}
                      onClick={() => setMessageDisplayMode((current) => current === "compact" ? "detailed" : "compact")}
                    >
                      {messageDisplayMode === "compact" ? "Simple" : "Detailed"}
                    </button>
                  </label>
                </div>
              )
            }}
            size="small"
            type="editable-card"
            activeKey={activeThreadKey || undefined}
            items={openThreadTabs.map((item) => ({
              ...item,
              closable: true,
              children: activeThread && item.key === activeThreadKey ? (
                <div className="threadWorkspacePane">
                  <Virtuoso
                    key={activeThread.threadId}
                    ref={messagesRef}
                    className="messages"
                    data={activeViews}
                    onKeyDown={handleMessagesKeyDown}
                    onPointerDown={handleMessagesPointerDown}
                    onScroll={handleMessagesScroll}
                    onTouchMove={handleMessagesTouchMove}
                    onWheel={handleMessagesWheel}
                    atBottomStateChange={(atBottom) => {
                      if (atBottom) {
                        messagesShouldFollowRef.current = true;
                      } else if (messagesShouldFollowRef.current && !messagesUserScrollIntentRef.current) {
                        scrollMessagesToBottom();
                      }
                    }}
                    atBottomThreshold={messagesBottomThreshold}
                    followOutput={(isAtBottom) => {
                      if (isAtBottom) {
                        messagesShouldFollowRef.current = true;
                      }
                      return messagesShouldFollowRef.current ? "auto" : false;
                    }}
                    initialTopMostItemIndex={Math.max(activeViews.length - 1, 0)}
                    increaseViewportBy={{ top: 360, bottom: 720 }}
                    computeItemKey={(_, message) => message.id}
                    components={messagesVirtuosoComponents}
                    context={messagesVirtuosoContext}
                    itemContent={(_, message) => {
                      const markdownEnabled = canRenderMarkdown(message);
                      const renderMode = markdownEnabled ? messageRenderModes[message.id] ?? "markdown" : "raw";
                      const toolBatchKey = message.toolBatch?.key;
                      const inspectable = messageDisplayMode === "compact" && message.role === "tool" && !toolBatchKey;
                      return (
                        <MessageCard
                          message={message}
                          showStatus={messageDisplayMode === "compact" || message.role !== "tool"}
                          showTimestamp={!(messageDisplayMode === "compact" && message.role === "tool")}
                          renderToolPreview={messageDisplayMode === "compact"}
                          renderMode={renderMode}
                          markdownEnabled={markdownEnabled}
                          threadWorkingDirectory={activeThread.workingDirectory}
                          onRenderModeChange={markdownEnabled ? (mode) => updateMessageRenderMode(message.id, mode) : undefined}
                          onContextMenu={(event) => openMessageContextMenu(event, activeThread.threadId, message, inspectable)}
                          onInspect={inspectable && message.role === "tool" ? () => setInspectMessage(message) : undefined}
                          onToggleToolBatch={toolBatchKey ? () => {
                            setExpandedToolBatchKeys((current) => {
                              const keys = new Set(current[activeThread.threadId] ?? []);
                              if (message.toolBatch?.expanded) keys.delete(toolBatchKey);
                              else keys.add(toolBatchKey);
                              return {
                                ...current,
                                [activeThread.threadId]: [...keys]
                              };
                            });
                          } : undefined}
                          onApprovalDecision={(approvalId, decision) => void respondToApproval(activeThread.threadId, approvalId, decision)}
                          onUserInputResponse={(userInputId, answers) => void respondToUserInput(activeThread.threadId, userInputId, answers)}
                          onFork={canForkAtMessage(activeThread.threadId, message) ? () => void forkMessage(activeThread.threadId, message.record.id) : undefined}
                          onRollback={canForkAtMessage(activeThread.threadId, message) ? () => void rollbackMessage(activeThread.threadId, message.record.id) : undefined}
                        />
                      );
                    }}
                  />
                  {showInlineStatusPanel ? (
                    <ActivityStatusOverlay
                      statuses={turnStatusItems}
                      turnMeta={activeThreadTurnMeta}
                      expandedKeys={activeExpandedStatusKeys}
                      onToggleRows={() => {
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
                      }}
                      onToggle={(key) => {
                        if (!statusScopeKey) return;
                        setExpandedStatusKeys((current) => {
                          const keys = new Set(current[statusScopeKey] ?? []);
                          if (keys.has(key)) keys.delete(key);
                          else keys.add(key);
                          return { ...current, [statusScopeKey]: [...keys] };
                        });
                      }}
                    />
                  ) : null}

                  <form
                    className="composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (activeCanSend) void send(activeThread.threadId);
                    }}
                  >
                    <div className="composerLayout">
                      <div className="composerSurface">
                        {activeGoal && activeThread ? (
                          <div
                            className={`goalStrip ${goalStatusClass(activeGoal.status)}`}
                            title={`${goalStatusLabel(activeGoal.status)} · ${activeGoal.objective}`}
                            aria-label={`${goalStatusLabel(activeGoal.status)}: ${activeGoal.objective}`}
                          >
                            <div className="goalStripMain">
                              <Target className="goalStripIcon" aria-hidden="true" />
                              <span className="goalStripLabel">{goalStatusLabel(activeGoal.status)}</span>
                              <span className="goalStripObjective" title={activeGoal.objective}>{activeGoal.objective}</span>
                              {activeThread.goalRunPolicy?.type === "consumeUntilWeeklyRemainingAtOrBelow" ? (
                                <span className="goalStripPolicy">
                                  {weeklyGoalPolicyLabel(activeThread.goalRunPolicy.targetRemainingPercent)}
                                </span>
                              ) : null}
                              {activeGoal.updatedAt ? <span className="goalStripAge">{formatGoalAge(activeGoal.updatedAt)}</span> : null}
                            </div>
                            <div className="goalStripActions">
                              <button
                                type="button"
                                className="goalIconButton"
                                title="编辑目标"
                                aria-label="编辑目标"
                                onClick={() => {
                                  const goalRunPolicy = activeThread.goalRunPolicy?.type === "consumeUntilWeeklyRemainingAtOrBelow"
                                    ? activeThread.goalRunPolicy
                                    : null;
                                  setGoalDialog({
                                    threadId: activeThread.threadId,
                                    objective: activeGoal.objective,
                                    targetRemainingPercent: goalRunPolicy
                                      ? String(goalRunPolicy.targetRemainingPercent)
                                      : "",
                                    saving: false,
                                    error: ""
                                  });
                                }}
                              >
                                ✎
                              </button>
                              {activeGoal.status !== "complete" ? (
                                <button
                                  type="button"
                                  className="goalIconButton"
                                  title={activeGoal.status === "paused" ? "继续目标" : "暂停目标"}
                                  aria-label={activeGoal.status === "paused" ? "继续目标" : "暂停目标"}
                                  onClick={() => void updateThreadGoal(activeThread.threadId, {
                                    status: activeGoal.status === "paused" ? "active" : "paused"
                                  })}
                                >
                                  {activeGoal.status === "paused" ? "▶" : "Ⅱ"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="goalIconButton danger"
                                title="清除目标"
                                aria-label="清除目标"
                                onClick={() => void clearThreadGoal(activeThread.threadId)}
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        ) : null}
                        <div className="composerInput">
                          {activeAttachmentCount ? (
                            <div
                              className="composerAttachmentStrip"
                              aria-label={`${attachmentCountLabel(activeAttachmentCount)} selected`}
                            >
                              <div className="composerAttachmentCount" title={`${attachmentCountLabel(activeAttachmentCount)} selected`}>
                                <Paperclip aria-hidden="true" />
                                <span>{activeAttachmentCount}</span>
                              </div>
                              <div className="composerAttachmentScroller">
                                {activeThread.textAttachments.map((item) => (
                                  <div className="composerAttachmentChip text" key={item.id} title={textAttachmentTooltip(item.text)}>
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
                                      onClick={() => removeThreadTextAttachment(activeThread.threadId, item.id)}
                                      aria-label={`Remove ${textAttachmentTitle(item.text)}`}
                                      title="Remove attachment"
                                    >
                                      <X aria-hidden="true" />
                                    </button>
                                  </div>
                                ))}
                                {activeThread.imageAttachments.map((image) => (
                                  <div className="composerAttachmentChip image" key={image.id} title={image.name || "Image attachment"}>
                                    <span className="composerAttachmentThumb">
                                      <img src={image.previewUrl} alt="" />
                                    </span>
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
                                      onClick={() => removeThreadImage(activeThread.threadId, image.id)}
                                      aria-label={`Remove ${image.name || "image attachment"}`}
                                      title="Remove attachment"
                                    >
                                      <X aria-hidden="true" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                              {activeAttachmentCount > 1 ? (
                                <button
                                  type="button"
                                  className="composerAttachmentClearButton"
                                  onClick={() => clearThreadAttachments(activeThread.threadId)}
                                >
                                  Clear all
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                          <textarea
                            ref={composerTextareaRef}
                            value={activeThread.input}
                            onChange={(event) => {
                              resetComposerHistory(activeThread.threadId);
                              resizeComposerTextarea(event.currentTarget);
                              updateThreadInput(activeThread.threadId, event.target.value);
                            }}
                            onPaste={(event) => {
                              if (!pasteThreadImages(activeThread.threadId, event.clipboardData)) return;
                              event.preventDefault();
                            }}
                            onDragOver={(event) => {
                              if (!isVscodeSurface || !dataTransferHasPathPayload(event.dataTransfer)) return;
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "copy";
                              const caretIndex = textareaCaretIndexFromPoint(
                                event.currentTarget,
                                event.clientX,
                                event.clientY
                              );
                              composerDropCaretRef.current[activeThread.threadId] = caretIndex;
                              event.currentTarget.focus();
                              event.currentTarget.setSelectionRange(caretIndex, caretIndex);
                            }}
                            onDrop={(event) => {
                              if (!isVscodeSurface) return;
                              const paths = droppedPathsFromDataTransfer(event.dataTransfer);
                              if (!paths.length) return;
                              event.preventDefault();
                              const caretIndex = composerDropCaretRef.current[activeThread.threadId]
                                ?? textareaCaretIndexFromPoint(event.currentTarget, event.clientX, event.clientY);
                              delete composerDropCaretRef.current[activeThread.threadId];
                              insertThreadPathText(activeThread.threadId, paths, event.currentTarget, caretIndex);
                            }}
                            onKeyDown={(event) => handleComposerKeyDown(event, activeThread.threadId, activeUserMessageHistory)}
                            placeholder="例如：检查这个 repo 的结构并给我下一步建议"
                            rows={2}
                          />
                        </div>
                        <div className="composerActions">
                          <div className="composerLeftActions">
                            <div className="composerMenuHost" onClick={(event) => event.stopPropagation()}>
                              <button
                                type="button"
                                className="composerIconButton"
                                aria-label="Open composer menu"
                                aria-expanded={composerMenuOpen}
                                onClick={() => setComposerMenuOpen((open) => !open)}
                              >
                                +
                              </button>
                              {composerMenuOpen ? (
                                <div className="composerMenu" role="menu">
                                  <button
                                    type="button"
                                    className="composerMenuItem"
                                    role="menuitem"
                                    onClick={() => {
                                      setComposerMenuOpen(false);
                                      imageFileInputRef.current?.click();
                                    }}
                                  >
                                    <span className="composerMenuIcon" aria-hidden="true">[]</span>
                                    <span>添加照片和文件</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="composerMenuItem"
                                    role="menuitem"
                                    disabled={activeThread.running}
                                    title={activeThread.running ? "Stop the running turn before starting a review" : "Review uncommitted changes in this thread"}
                                    onClick={() => {
                                      setComposerMenuOpen(false);
                                      void reviewThread(activeThread.threadId);
                                    }}
                                  >
                                    <span className="composerMenuIcon" aria-hidden="true">R</span>
                                    <span>Review changes</span>
                                  </button>
                                  <div className="composerMenuGroup" role="group" aria-label="Approval policy">
                                    <div className="composerMenuGroupLabel">Approval policy</div>
                                    <div className="composerMenuChoiceGrid">
                                      {approvalPolicyOptions.map((option) => (
                                        <button
                                          key={option.value}
                                          type="button"
                                          className={`composerMenuChoice${activeThreadApprovalPolicySelection === option.value ? " active" : ""}`}
                                          role="menuitemradio"
                                          aria-checked={activeThreadApprovalPolicySelection === option.value}
                                          onClick={() => setActiveThreadApprovalPolicyDraft(option.value)}
                                        >
                                          {option.label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                  <div className="composerMenuGroup" role="group" aria-label="Sandbox policy">
                                    <div className="composerMenuGroupLabel">Sandbox policy</div>
                                    <div className="composerMenuChoiceGrid">
                                      {sandboxPolicyOptions.map((option) => (
                                        <button
                                          key={option.value}
                                          type="button"
                                          className={`composerMenuChoice${activeThreadSandboxPolicySelection === option.value ? " active" : ""}`}
                                          role="menuitemradio"
                                          aria-checked={activeThreadSandboxPolicySelection === option.value}
                                          onClick={() => setActiveThreadSandboxPolicyDraft(option.value)}
                                        >
                                          {option.label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                            <div className="composerModeSegmented" role="radiogroup" aria-label="Composer mode">
                              {composerModeOptions.map((option) => {
                                const ModeIcon = composerModeIconByValue[option.value];
                                return (
                                  <button
                                    key={option.value}
                                    type="button"
                                    className={`composerModeOption${composerMode === option.value ? " active" : ""}`}
                                    role="radio"
                                    aria-checked={composerMode === option.value}
                                    aria-label={option.label}
                                    title={option.label}
                                    onClick={() => setComposerMode(option.value)}
                                  >
                                    <ModeIcon className="composerModeIcon" aria-hidden="true" />
                                  </button>
                                );
                              })}
                            </div>
                            <button
                              type="button"
                              className="composerIconButton composerGoalRunPolicyButton"
                              aria-label="消耗到 weekly 剩余"
                              title="消耗到 weekly 剩余"
                              disabled={!activeThread}
                              onClick={openGoalRunPolicyDialog}
                            >
                              <Gauge aria-hidden="true" />
                            </button>
                          </div>
                          <div className="composerRightActions">
                            {renderComposerThreadControls("inline")}
                            <div className="composerSessionMenuHost" onClick={(event) => event.stopPropagation()}>
                              <button
                                type="button"
                                className="composerMoreButton"
                                aria-label="Show thread usage and model"
                                aria-expanded={threadControlsMenuOpen}
                                onClick={() => setThreadControlsMenuOpen((open) => !open)}
                              >
                                ...
                              </button>
                              {threadControlsMenuOpen ? (
                                <div className="composerSessionPopover">
                                  {renderComposerThreadControls("popover")}
                                </div>
                              ) : null}
                            </div>
                            <div
                              className={`composerActionButtons status-${turnUiState.kind}`}
                              title={turnUiState.title}
                              aria-label={`Turn status: ${turnUiState.label}`}
                            >
                              {showComposerSendButton ? (
                                <button
                                  type="submit"
                                  className="composerSendButton composerActionButton"
                                  disabled={!activeCanSubmit}
                                  aria-label="Send message"
                                  title={`Send message · ${turnUiState.title}`}
                                >
                                  ↑
                                </button>
                              ) : null}
                              {activeThread.running ? (
                                <button
                                  type="button"
                                  className="composerStopButton composerActionButton"
                                  disabled={!activeCanStop}
                                  aria-label="Stop current turn"
                                  title={`Stop current turn · ${turnUiState.title}`}
                                  onClick={() => void stopTurn(activeThread.threadId)}
                                >
                                  ■
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                        <input
                          ref={imageFileInputRef}
                          className="imageUploadInput"
                          type="file"
                          accept="image/*,.css,.csv,.html,.js,.json,.jsx,.log,.md,.py,.sh,.sql,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml"
                          multiple
                          onChange={(event) => {
                            void addThreadFiles(activeThread.threadId, event.currentTarget.files);
                            event.currentTarget.value = "";
                          }}
                        />
                      </div>
                    </div>
                  </form>
                </div>
              ) : null
            }))}
            onChange={(threadId) => void switchSessionThread(threadId)}
            onEdit={(targetKey, action) => {
              if (action === "add") {
                if (canAddThreadForProject) void openSelectedProjectThreadPicker();
                return;
              }
              if (action === "remove" && typeof targetKey === "string") {
                void closeThread(targetKey);
              }
            }}
          />
        ) : (
          <div className="empty">
            <div className="emptySidebarToggle">{sidebarToggle}</div>
            <span>{openThreadEmptyMessage}</span>
          </div>
        )}
      </section>

      <AppDialogs viewModel={viewModel} />

    </main>
  );
};
