import React from "react";
import { Tabs } from "antd";
import { Virtuoso } from "react-virtuoso";
import { composerModeOptions } from "./appConfig.js";
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
} from "./appHelpers.js";

type AppViewProps = {
  viewModel: AppViewModel;
};

export const AppView = ({ viewModel }: AppViewProps) => {
  const {
    activeCanSend,
    activeCanStop,
    activeCanSubmit,
    activeExpandedStatusKeys,
    activeGoal,
    activeProjectKey,
    activeProjectSession,
    activeSession,
    activeThreadBelongsToSession,
    activeUserMessageHistory,
    activeViews,
    authError,
    authRequired,
    authTokenDraft,
    addContextSelectionToConversation,
    addSessionFiles,
    addSessionImages,
    addSshHost,
    changeProjectPickerMachine,
    chooseThreadCandidate,
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
    inspectContextMessage,
    inspectMessage,
    latestTurnStatusScope,
    loadProjectPickerDirectory,
    localMachines,
    messageContextMenu,
    messageDisplayMode,
    messageRenderModes,
    messagesRef,
    messagesScrollerRef,
    modelOptions,
    offlineProjectsCollapsed,
    onlineMachines,
    openingProjectKey,
    openMessageContextMenu,
    openProjectPicker,
    openThreadPicker,
    pasteSessionImages,
    patchTask,
    projectGroups,
    projectList,
    projectOpenError,
    projectPicker,
    registeredCommand,
    registeredCommandCopied,
    registeredMachines,
    removeSessionImage,
    removeSessionTextAttachment,
    removeSshHost,
    renderComposerSessionControls,
    resetComposerHistory,
    resizeComposerTextarea,
    rollbackMessage,
    runTaskNow,
    saveGoalDialog,
    selectProject,
    send,
    sessionDialogOpen,
    sessionList,
    sessionMenuOpen,
    setComposerMenuOpen,
    setComposerMode,
    setConnectionMode,
    setExpandedStatusKeys,
    setGoalDialog,
    setHiddenStatusTurns,
    setInspectMessage,
    setMessageContextMenu,
    setMessageDisplayMode,
    setOfflineProjectsCollapsed,
    setProjectPicker,
    setAuthTokenDraft,
    setSelectedModel,
    setSelectedReasoning,
    setSessionDialogOpen,
    setSessionMenuOpen,
    setSidebarCollapsed,
    setSshHostDraft,
    setTaskDraft,
    setTaskFormOpen,
    setThreadPicker,
    showComposerSendButton,
    showInlineStatusPanel,
    sidebarCollapsed,
    simpleStatuses,
    sshConfigHostOptions,
    sshConfigHosts,
    sshConnectingHost,
    sshConnections,
    sshError,
    sshHostBusy,
    sshHostDraft,
    sshHosts,
    statusScopeKey,
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
    updateSessionInput,
    updateTaskDraftMachine,
    updateTaskDraftProject,
    updateThreadGoal,
    workspaceEmptyMessage,
    workspaceThreadTabs
  } = viewModel;
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
        {activeSession && activeThreadBelongsToSession ? (
          <Tabs
            className="workspaceThreadTabs"
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
            activeKey={activeSession.threadId}
            items={workspaceThreadTabs.map((item) => ({
              ...item,
              closable: true,
              children: item.key === activeSession.threadId ? (
                <div className="threadWorkspacePane">
                  <Virtuoso
                    key={activeSession.threadId}
                    ref={messagesRef}
                    scrollerRef={(ref) => {
                      messagesScrollerRef.current = ref instanceof HTMLElement ? ref : null;
                    }}
                    className="messages"
                    data={activeViews}
                    followOutput={() => "smooth"}
                    initialTopMostItemIndex={Math.max(activeViews.length - 1, 0)}
                    increaseViewportBy={{ top: 360, bottom: 720 }}
                    computeItemKey={(_, message) => message.id}
                    components={{ EmptyPlaceholder: EmptyMessages }}
                    itemContent={(_, message) => {
                      const markdownEnabled = canRenderMarkdown(message);
                      const renderMode = markdownEnabled ? messageRenderModes[message.id] ?? "markdown" : "raw";
                      const inspectable = message.record.rawJsonl != null || (messageDisplayMode === "compact" && message.role === "tool");
                      return (
                        <MessageCard
                          message={message}
                          showStatus={messageDisplayMode === "compact" || message.role !== "tool"}
                          showTimestamp={!(messageDisplayMode === "compact" && message.role === "tool")}
                          renderToolPreview={messageDisplayMode === "compact"}
                          renderMode={renderMode}
                          markdownEnabled={markdownEnabled}
                          onRenderModeChange={markdownEnabled ? (mode) => updateMessageRenderMode(message.id, mode) : undefined}
                          onContextMenu={(event) => openMessageContextMenu(event, activeSession.threadId, message, inspectable)}
                          onFork={canForkAtMessage(activeSession.threadId, message) ? () => void forkMessage(activeSession.threadId, message.record.id) : undefined}
                          onRollback={canForkAtMessage(activeSession.threadId, message) ? () => void rollbackMessage(activeSession.threadId, message.record.id) : undefined}
                        />
                      );
                    }}
                  />
                  {showInlineStatusPanel ? (
                    <ActivityStatusOverlay
                      statuses={simpleStatuses}
                      expandedKeys={activeExpandedStatusKeys}
                      onMinimize={() => {
                        if (!activeSession?.threadId || !latestTurnStatusScope.key) return;
                        setHiddenStatusTurns((current) => ({
                          ...current,
                          [activeSession.threadId]: latestTurnStatusScope.key
                        }));
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
                      if (activeCanSend) void send(activeSession.threadId);
                    }}
                  >
                    <div className="composerLayout">
                      <div className="composerSurface">
                        {activeGoal && activeSession ? (
                          <div
                            className={`goalStrip ${goalStatusClass(activeGoal.status)}`}
                            title={`${goalStatusLabel(activeGoal.status)} · ${activeGoal.objective}`}
                            aria-label={`${goalStatusLabel(activeGoal.status)}: ${activeGoal.objective}`}
                          >
                            <div className="goalStripMain">
                              <span className="goalStripIcon" aria-hidden="true">◎</span>
                              <span className="goalStripLabel">{goalStatusLabel(activeGoal.status)}</span>
                              <span className="goalStripObjective" title={activeGoal.objective}>{activeGoal.objective}</span>
                              {activeGoal.updatedAt ? <span className="goalStripAge">{formatGoalAge(activeGoal.updatedAt)}</span> : null}
                            </div>
                            <div className="goalStripActions">
                              <button
                                type="button"
                                className="goalIconButton"
                                title="编辑目标"
                                aria-label="编辑目标"
                                onClick={() => setGoalDialog({
                                  threadId: activeSession.threadId,
                                  objective: activeGoal.objective,
                                  saving: false,
                                  error: ""
                                })}
                              >
                                ✎
                              </button>
                              {activeGoal.status !== "complete" ? (
                                <button
                                  type="button"
                                  className="goalIconButton"
                                  title={activeGoal.status === "paused" ? "继续目标" : "暂停目标"}
                                  aria-label={activeGoal.status === "paused" ? "继续目标" : "暂停目标"}
                                  onClick={() => void updateThreadGoal(activeSession.threadId, {
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
                                onClick={() => void clearThreadGoal(activeSession.threadId)}
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        ) : null}
                        <div className="composerInput">
                          {activeSession.textAttachments.length || activeSession.imageAttachments.length ? (
                            <div className="composerAttachmentList">
                              {activeSession.textAttachments.map((item) => (
                                <div className="textAttachment" key={item.id} title={item.text}>
                                  <span className="textAttachmentLabel">文本</span>
                                  <p>{item.text}</p>
                                  <button type="button" onClick={() => removeSessionTextAttachment(activeSession.threadId, item.id)} aria-label="Remove selected text">x</button>
                                </div>
                              ))}
                              {activeSession.imageAttachments.map((image) => (
                                <div className="imageAttachment" key={image.id}>
                                  <img src={image.previewUrl} alt={image.name} />
                                  <button type="button" onClick={() => removeSessionImage(activeSession.threadId, image.id)} aria-label={`Remove ${image.name}`}>x</button>
                                </div>
                              ))}
                            </div>
                          ) : null}
                          <textarea
                            ref={composerTextareaRef}
                            value={activeSession.input}
                            onChange={(event) => {
                              resetComposerHistory(activeSession.threadId);
                              resizeComposerTextarea(event.currentTarget);
                              updateSessionInput(activeSession.threadId, event.target.value);
                            }}
                            onPaste={(event) => {
                              if (!pasteSessionImages(activeSession.threadId, event.clipboardData)) return;
                              event.preventDefault();
                            }}
                            onKeyDown={(event) => handleComposerKeyDown(event, activeSession.threadId, activeUserMessageHistory)}
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
                                </div>
                              ) : null}
                            </div>
                            <div className="composerModeSegmented" role="radiogroup" aria-label="Composer mode">
                              {composerModeOptions.map((option) => (
                                <button
                                  key={option.value}
                                  type="button"
                                  className={`composerModeOption${composerMode === option.value ? " active" : ""}`}
                                  role="radio"
                                  aria-checked={composerMode === option.value}
                                  onClick={() => setComposerMode(option.value)}
                                >
                                  {option.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="composerRightActions">
                            {renderComposerSessionControls("inline")}
                            <div className="composerSessionMenuHost" onClick={(event) => event.stopPropagation()}>
                              <button
                                type="button"
                                className="composerMoreButton"
                                aria-label="Show session usage and model"
                                aria-expanded={sessionMenuOpen}
                                onClick={() => setSessionMenuOpen((open) => !open)}
                              >
                                ...
                              </button>
                              {sessionMenuOpen ? (
                                <div className="composerSessionPopover">
                                  {renderComposerSessionControls("popover")}
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
                              {activeSession.running ? (
                                <button
                                  type="button"
                                  className="composerStopButton composerActionButton"
                                  disabled={!activeCanStop}
                                  aria-label="Stop current turn"
                                  title={`Stop current turn · ${turnUiState.title}`}
                                  onClick={() => void stopTurn(activeSession.threadId)}
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
                            void addSessionFiles(activeSession.threadId, event.currentTarget.files);
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
                if (activeProjectSession?.online) openThreadPicker(activeProjectSession);
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
            <span>{workspaceEmptyMessage}</span>
            {activeProjectSession?.online ? (
              <button type="button" className="emptyActionButton" onClick={() => openThreadPicker(activeProjectSession)}>
                Add Thread
              </button>
            ) : null}
          </div>
        )}
      </section>

      <AppDialogs viewModel={viewModel} />

    </main>
  );
};
