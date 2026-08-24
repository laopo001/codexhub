import React from "react";
import { Modal, Select, Switch } from "antd";
import { Target } from "lucide-react";
import { isNativeElectronSurface } from "./appConfig.js";
import {
  apiRouteJson,
  filterProjectDirectoryEntries,
  filterThreadCandidates,
  formatInspectTitle,
  formatThreadCandidateTime,
  machineProjectCatalogEditable,
  machineProjectLauncher,
  modelOptionLabel,
  modelOptionSearchMatches,
  primeTaskNotificationPermission,
  reasoningOptionLabel,
  serviceTierOptionLabel,
  shortId,
  statusLabel,
  threadCandidateHoverTitle,
  threadCandidateSnippet,
  threadCandidateStats,
  threadCandidateTitle,
  threadDisplayTitle,
  ToolInspectBody,
  worktreeTargetPreview
} from "./appHelpers.js";
import { apiRoutes } from "../shared/apiRoutes.js";
import { writeTextToClipboard } from "./helpers/composer.js";
import type { ModelSelection, ReasoningSelection, ServiceTierSelection } from "./types.js";
import type { AppDialogsViewModel } from "./viewModel.js";

type AppDialogsProps = {
  viewModel: AppDialogsViewModel;
};

export const AppDialogs = ({ viewModel }: AppDialogsProps) => {
  const {
    addContextSelectionToConversation,
    appSettings,
    changeProjectPickerMachine,
    chooseThreadCandidate,
    confirmProjectPicker,
    copyContextSelection,
    createMachineThread,
    createWorktreeThread,
    goalDialog,
    imagePreview,
    inspectContextMessage,
    inspectMessage,
    loadProjectPickerDirectory,
    loadThreadPickerCandidates,
    machines,
    messageContextMenu,
    activeModelCatalogCacheNotice,
    activeModelCatalogError,
    activeModelCatalogStatus,
    threadModelDialogModelSelection,
    threadModelDialogReasoningSelection,
    threadModelDialogServiceTierSelection,
    modelOptions,
    reasoningOptions,
    serviceTierOptions,
    onlineMachines,
    openingProjectKey,
    openPetPicker,
    petEnabled,
    petName,
    projectPicker,
    retryModelCatalog,
    saveGoalDialog,
    saveThreadRenameDialog,
    threadModelDialogOpen,
    threadRenameDialog,
    threadTabContextMenu,
    settingsDialogOpen,
    runtimeList,
    openThreads,
    setGoalDialog,
    setImagePreview,
    setInspectMessage,
    setAppSettings,
    setMessageContextMenu,
    setProjectPicker,
    setThreadModelDialogModelDraft,
    setThreadModelDialogReasoningDraft,
    setThreadModelDialogServiceTierDraft,
    setThreadModelDialogOpen,
    setThreadRenameDialog,
    setThreadTabContextMenu,
    setSettingsDialogOpen,
    setThreadPicker,
    submitProjectPickerPath,
    systemStatus,
    threadOrderByMachine,
    threadPicker
  } = viewModel;
  const [projectPickerSearch, setProjectPickerSearch] = React.useState("");
  const [restartState, setRestartState] = React.useState<"idle" | "restarting" | "error">("idle");
  const [notificationPersistAfterMinutesDraft, setNotificationPersistAfterMinutesDraft] = React.useState(
    String(appSettings.taskCompleteNotificationPersistAfterMinutes)
  );
  const restartAvailable = Boolean(systemStatus.authority);
  React.useEffect(() => {
    setProjectPickerSearch("");
  }, [projectPicker?.machineId, projectPicker?.entries]);
  React.useEffect(() => {
    if (settingsDialogOpen) {
      setRestartState("idle");
      setNotificationPersistAfterMinutesDraft(String(appSettings.taskCompleteNotificationPersistAfterMinutes));
    }
  }, [appSettings.taskCompleteNotificationPersistAfterMinutes, settingsDialogOpen]);
  const saveNotificationPersistence = () => {
    const parsed = Number(notificationPersistAfterMinutesDraft.trim());
    if (!Number.isInteger(parsed) || parsed < 0) {
      setNotificationPersistAfterMinutesDraft(String(appSettings.taskCompleteNotificationPersistAfterMinutes));
      return;
    }
    const previous = appSettings.taskCompleteNotificationPersistAfterMinutes;
    setAppSettings((current) => ({ ...current, taskCompleteNotificationPersistAfterMinutes: parsed }));
    void apiRouteJson(apiRoutes.updateConfig, {
      ui: { taskCompleteNotificationPersistAfterMinutes: parsed }
    }).then((payload) => {
      setAppSettings((current) => ({
        ...current,
        taskCompleteNotificationPersistAfterMinutes: payload.config.ui.taskCompleteNotificationPersistAfterMinutes
      }));
    }).catch(() => {
      setAppSettings((current) => ({
        ...current,
        taskCompleteNotificationPersistAfterMinutes: previous
      }));
      setNotificationPersistAfterMinutesDraft(String(previous));
    });
  };
  const restartAuthority = () => {
    if (!restartAvailable || restartState === "restarting") return;
    Modal.confirm({
      title: "Restart this CodexHub authority?",
      content: "Restart the authority and Codex runtime for this host. This window will reconnect automatically; VS Code or Electron itself will stay open, and other hosts will not be restarted.",
      okText: "Restart",
      cancelText: "Cancel",
      onOk: async () => {
        setRestartState("restarting");
        try {
          if (isNativeElectronSurface && window.codexhubElectronPet?.restartAuthority) {
            await window.codexhubElectronPet.restartAuthority();
          } else {
            await apiRouteJson(apiRoutes.restartAuthority);
          }
        } catch {
          setRestartState("error");
        }
      }
    });
  };
  const hasOpenDialog = Boolean(
    threadModelDialogOpen
    || settingsDialogOpen
    || projectPicker
    || threadPicker
    || inspectMessage
    || imagePreview
    || goalDialog
    || threadRenameDialog
    || threadTabContextMenu
    || messageContextMenu
  );
  React.useEffect(() => {
    if (!imagePreview && !inspectMessage && !goalDialog && !threadModelDialogOpen) return undefined;
    const closeTopOverlayOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (imagePreview) {
        setImagePreview(null);
      } else if (inspectMessage) {
        setInspectMessage(null);
      } else if (goalDialog) {
        if (!goalDialog.saving) setGoalDialog(null);
      } else {
        setThreadModelDialogOpen(false);
      }
    };
    window.addEventListener("keydown", closeTopOverlayOnEscape, true);
    return () => window.removeEventListener("keydown", closeTopOverlayOnEscape, true);
  }, [
    goalDialog,
    imagePreview,
    inspectMessage,
    setGoalDialog,
    setImagePreview,
    setInspectMessage,
    setThreadModelDialogOpen,
    threadModelDialogOpen
  ]);
  if (!hasOpenDialog) return null;

  const projectPickerMachine = projectPicker
    ? machines.find((machine) => machine.machineId === projectPicker.machineId)
    : undefined;
  const projectPickerMachines = onlineMachines.filter((machine) =>
    machineProjectLauncher(machine) && machineProjectCatalogEditable(machine)
  );
  const projectPickerOpening = projectPicker
    ? openingProjectKey === `${projectPicker.machineId}:${projectPicker.path.trim()}`
    : false;
  const visibleProjectPickerEntries = projectPicker
    ? filterProjectDirectoryEntries(projectPicker.entries, projectPickerSearch)
    : [];
  const projectPickerQuery = projectPickerSearch.trim();
  const threadPickerRuntime = threadPicker
    ? runtimeList.find((runtime) => runtime.machineId === threadPicker.machineId)
    : undefined;
  const threadPickerReady = Boolean(threadPicker?.machineId) && !threadPicker?.preparingRuntime;
  const threadPickerOpenThreadIds = new Set([
    ...(threadPickerRuntime?.threads
      ?.filter((thread) => !threadPicker?.workingDirectory || thread.workingDirectory === threadPicker.workingDirectory)
      .map((thread) => thread.threadId) ?? []),
    ...(threadPicker ? threadOrderByMachine[threadPicker.machineId] ?? [] : []),
    ...openThreads.map((thread) => thread.threadId)
  ]);
  const threadPickerSearchQuery = threadPicker?.searchQuery ?? "";
  const filteredThreadCandidates = threadPicker
    ? filterThreadCandidates(threadPicker.candidates, threadPickerSearchQuery)
    : [];
  const threadPickerHasSearch = threadPickerSearchQuery.trim().length > 0;
  const threadTabContextThread = threadTabContextMenu
    ? openThreads.find((thread) => thread.threadId === threadTabContextMenu.threadId)
    : undefined;
  const dialogModelOptions = optionsWithoutAutoWhenResolved(modelOptions, threadModelDialogModelSelection);
  const dialogReasoningOptions = optionsWithoutAutoWhenResolved(reasoningOptions, threadModelDialogReasoningSelection);
  const worktreePreview = threadPicker
    ? worktreeTargetPreview(threadPicker.workingDirectory, threadPicker.worktreeBranch, threadPicker.worktreePath)
    : "";
  const dialogModelSelectOptions = dialogModelOptions.map((option) => ({
    ...option,
    label: modelOptionLabel(option)
  }));
  const dialogReasoningSelectOptions = dialogReasoningOptions.map((option) => ({
    ...option,
    label: reasoningOptionLabel(option)
  }));
  const modelCatalogLoading = activeModelCatalogStatus === "idle" || activeModelCatalogStatus === "loading";
  const modelCatalogError = activeModelCatalogStatus === "error";
  const modelCatalogNotice = activeModelCatalogStatus === "unavailable"
    ? "No online runtime."
    : modelCatalogLoading
      ? "Loading model catalog..."
      : modelCatalogError
        ? activeModelCatalogError || "Model catalog unavailable."
        : activeModelCatalogCacheNotice;
  const threadModelSelectDisabled = activeModelCatalogStatus !== "ready";

  return (
    <>
      {threadModelDialogOpen ? (
        <div className="sessionDialogOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setThreadModelDialogOpen(false);
        }}>
          <section className="sessionDialog" role="dialog" aria-modal="true" aria-labelledby="sessionDialogTitle">
            <header className="sessionDialogHeader">
              <h2 id="sessionDialogTitle">Thread Model</h2>
              <button type="button" className="iconButton" onClick={() => setThreadModelDialogOpen(false)} aria-label="Close">x</button>
            </header>
            <label className="sessionDialogField">
              <span>Model</span>
              <Select
                className="threadModelSelect"
                showSearch
                value={threadModelDialogModelSelection}
                options={dialogModelSelectOptions}
                disabled={threadModelSelectDisabled}
                loading={modelCatalogLoading}
                filterOption={(input, option) => modelOptionSearchMatches(selectOptionSearchPayload(option), input)}
                onChange={(value) => setThreadModelDialogModelDraft(value as ModelSelection)}
              />
            </label>
            <label className="sessionDialogField">
              <span>Thinking</span>
              <Select
                className="threadModelSelect"
                value={threadModelDialogReasoningSelection}
                options={dialogReasoningSelectOptions}
                disabled={threadModelSelectDisabled}
                loading={modelCatalogLoading}
                virtual={false}
                classNames={{ popup: { root: "threadModelOptionPopup" } }}
                optionRender={(option) => (
                  <div className="threadModelOption">
                    <strong>{option.label}</strong>
                    {option.data.description ? <small>{option.data.description}</small> : null}
                  </div>
                )}
                onChange={(value) => setThreadModelDialogReasoningDraft(value as ReasoningSelection)}
              />
            </label>
            <label className="sessionDialogField">
              <span>Response speed</span>
              <Select
                className="threadModelSelect"
                value={threadModelDialogServiceTierSelection}
                options={serviceTierOptions.map((option) => ({
                  ...option,
                  label: serviceTierOptionLabel(option)
                }))}
                disabled={threadModelSelectDisabled}
                loading={modelCatalogLoading}
                virtual={false}
                classNames={{ popup: { root: "threadModelOptionPopup" } }}
                optionRender={(option) => (
                  <div className="threadModelOption">
                    <strong>{option.label}</strong>
                    {option.data.description ? <small>{option.data.description}</small> : null}
                  </div>
                )}
                onChange={(value) => setThreadModelDialogServiceTierDraft(value as ServiceTierSelection)}
              />
              <small className="sessionDialogFieldHint">
                Used for subsequent turns. Default follows your Codex configuration.
              </small>
            </label>
            {modelCatalogNotice ? (
              <div className={`sessionDialogNotice${modelCatalogError ? " error" : ""}`}>
                <span>{modelCatalogNotice}</span>
                {modelCatalogError || activeModelCatalogCacheNotice ? (
                  <button type="button" className="textButton" onClick={retryModelCatalog}>
                    {modelCatalogError ? "Retry" : "Refresh"}
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {settingsDialogOpen ? (
        <div className="modalOverlay settingsDialogOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSettingsDialogOpen(false);
        }}>
          <section className="settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settingsDialogTitle">
            <header className="settingsDialogHeader">
              <h2 id="settingsDialogTitle">Settings</h2>
              <button type="button" className="iconButton" onClick={() => setSettingsDialogOpen(false)} aria-label="Close">x</button>
            </header>
            <div className="settingsList">
              <div className="settingsRow">
                <span className="settingsRowText">
                  <strong>Pet</strong>
                  <em>{petEnabled ? `${petName} is awake` : `${petName} is tucked away`}</em>
                </span>
                <button type="button" className="petSettingsButton" onClick={() => {
                  setSettingsDialogOpen(false);
                  openPetPicker();
                }}>Choose</button>
              </div>
              <div className="settingsRow">
                <span className="settingsRowText">
                  <strong id="settingTaskCompletePopups">Task complete popups</strong>
                  <em>Browser or IDE notification</em>
                </span>
                <Switch
                  checked={appSettings.taskCompleteSystemNotifications}
                  onChange={(checked) => {
                    const previous = appSettings.taskCompleteSystemNotifications;
                    setAppSettings((current) => ({ ...current, taskCompleteSystemNotifications: checked }));
                    if (checked) primeTaskNotificationPermission();
                    void apiRouteJson(apiRoutes.updateConfig, {
                      ui: { taskCompleteSystemNotifications: checked }
                    }).then((payload) => {
                      setAppSettings((current) => ({
                        ...current,
                        taskCompleteSystemNotifications: payload.config.ui.taskCompleteSystemNotifications
                      }));
                    }).catch(() => {
                      setAppSettings((current) => ({ ...current, taskCompleteSystemNotifications: previous }));
                    });
                  }}
                  aria-labelledby="settingTaskCompletePopups"
                />
              </div>
              <div className="settingsRow settingsNotificationPersistenceRow">
                <span className="settingsRowText">
                  <strong id="settingTaskCompleteNotificationPersistence">Keep long-task notifications</strong>
                  <em>0 keeps all; otherwise keep tasks at or above this runtime (minutes)</em>
                </span>
                <label className="settingsNumberControl" aria-labelledby="settingTaskCompleteNotificationPersistence">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    inputMode="numeric"
                    value={notificationPersistAfterMinutesDraft}
                    onChange={(event) => setNotificationPersistAfterMinutesDraft(event.currentTarget.value)}
                    onBlur={saveNotificationPersistence}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    aria-label="Keep long-task notifications after minutes"
                  />
                  <span>min</span>
                </label>
              </div>
              <div className="settingsRow">
                <span className="settingsRowText">
                  <strong>Version</strong>
                  <em>{systemStatus.version ? `CodexHub v${systemStatus.version}` : "Version unavailable"}</em>
                </span>
              </div>
              {restartAvailable ? (
                <div
                  className={`settingsRow settingsRestartRow${restartState === "restarting" ? " is-restarting" : ""}${restartState === "error" ? " has-error" : ""}`}
                  aria-busy={restartState === "restarting"}
                >
                  <span className="settingsRowText">
                    <strong>Restart current authority</strong>
                    <em
                      className={restartState === "error" ? "settingsError" : undefined}
                      aria-live="polite"
                    >
                      {restartState === "restarting"
                        ? "Restarting this host's authority and reconnecting this window..."
                        : restartState === "error"
                          ? "Restart failed. Check the authority log and try again."
                          : "Restart this host's authority and Codex runtime. The host application stays open."}
                    </em>
                  </span>
                  <button
                    type="button"
                    className={`petSettingsButton settingsRestartButton${restartState === "restarting" ? " is-loading" : ""}`}
                    disabled={restartState === "restarting"}
                    onClick={() => void restartAuthority()}
                    aria-busy={restartState === "restarting"}
                  >
                    {restartState === "restarting" ? (
                      <>
                        <span className="settingsRestartSpinner" aria-hidden="true" />
                        <span>Restarting...</span>
                      </>
                    ) : "Restart"}
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {goalDialog ? (
        <div className="modalOverlay goalDialogOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !goalDialog.saving) setGoalDialog(null);
        }}>
          <section className="goalDialog" role="dialog" aria-modal="true" aria-labelledby="goalDialogTitle">
            <header className="goalDialogHeader">
              <div className="goalDialogMark" aria-hidden="true">
                <Target />
              </div>
              <button
                type="button"
                className="goalDialogClose"
                onClick={() => setGoalDialog(null)}
                disabled={goalDialog.saving}
                aria-label="关闭"
              >
                ×
              </button>
            </header>
            <h2 id="goalDialogTitle">编辑目标</h2>
            <textarea
              value={goalDialog.objective}
              onChange={(event) => setGoalDialog((current) => current
                ? { ...current, objective: event.target.value, error: "" }
                : current)}
              rows={7}
              autoFocus
            />
            {goalDialog.error ? <div className="goalDialogError">{goalDialog.error}</div> : null}
            <footer className="goalDialogActions">
              <button type="button" onClick={() => setGoalDialog(null)} disabled={goalDialog.saving}>取消</button>
              <button
                type="button"
                className="primary"
                onClick={() => void saveGoalDialog()}
                disabled={goalDialog.saving || !goalDialog.objective.trim()}
              >
                {goalDialog.saving ? "保存中" : "保存"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {threadPicker ? (
        <div className="modalOverlay threadPickerOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setThreadPicker(null);
        }}>
          <section className="threadPickerModal" role="dialog" aria-modal="true" aria-labelledby="threadPickerTitle">
            <header className="threadPickerHeader">
              <div className="threadPickerHeaderTitle">
                <h2 id="threadPickerTitle">Add Thread</h2>
                <p title={threadPicker.workingDirectory}>{threadPicker.workingDirectory}</p>
              </div>
              <div className="threadPickerHeaderActions">
                <button
                  type="button"
                  className="threadPickerRefreshButton"
                  onClick={() => {
                    if (threadPicker.machineId) void loadThreadPickerCandidates(threadPicker.machineId);
                  }}
                  disabled={!threadPickerReady || threadPicker.loading || threadPicker.acting !== null}
                >
                  {threadPicker.preparingRuntime ? "Starting" : threadPicker.loading ? "Refreshing" : "Refresh"}
                </button>
                <button type="button" className="iconButton" onClick={() => setThreadPicker(null)} aria-label="Close">x</button>
              </div>
            </header>
            <div className="threadPickerList" role="listbox" aria-label="Thread candidates">
              <button
                type="button"
                className="threadPickerRow newThread"
                onClick={() => void createMachineThread()}
                disabled={!threadPickerReady || threadPicker.acting !== null}
              >
                <span className="threadPickerRowTitle">New thread</span>
                <span className="threadPickerRowMeta">
                  {threadPicker.preparingRuntime
                    ? "Available when the Codex runtime is ready"
                    : threadPicker.acting === "new"
                      ? "creating"
                      : "Start a new Codex thread"}
                </span>
              </button>
              <form
                className="threadPickerWorktree"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createWorktreeThread();
                }}
              >
                <div className="threadPickerWorktreeHeader">
                  <span>New worktree thread</span>
                  <button
                    type="submit"
                    disabled={!threadPickerReady || threadPicker.acting !== null || !threadPicker.worktreeBranch.trim()}
                  >
                    {threadPicker.acting === "worktree" ? "creating" : "Create"}
                  </button>
                </div>
                <label>
                  <span>Branch</span>
                  <input
                    value={threadPicker.worktreeBranch}
                    onChange={(event) => setThreadPicker((current) => current ? {
                      ...current,
                      worktreeBranch: event.target.value,
                      error: ""
                    } : current)}
                    disabled={!threadPickerReady || threadPicker.acting !== null}
                    placeholder="feature/name"
                  />
                </label>
                <div className="threadPickerWorktreeGrid">
                  <label>
                    <span>Base</span>
                    <input
                      value={threadPicker.worktreeBaseRef}
                      onChange={(event) => setThreadPicker((current) => current ? {
                        ...current,
                        worktreeBaseRef: event.target.value,
                        error: ""
                      } : current)}
                      disabled={!threadPickerReady || threadPicker.acting !== null}
                      placeholder="HEAD"
                    />
                  </label>
                  <label>
                    <span>Path</span>
                    <input
                      value={threadPicker.worktreePath}
                      onChange={(event) => setThreadPicker((current) => current ? {
                        ...current,
                        worktreePath: event.target.value,
                        error: ""
                      } : current)}
                      disabled={!threadPickerReady || threadPicker.acting !== null}
                      placeholder="auto"
                    />
                  </label>
                </div>
                <div className="threadPickerWorktreePreview" title={worktreePreview}>
                  <span>Target</span>
                  <code>{worktreePreview}</code>
                </div>
              </form>
              <label className="threadPickerSearch">
                <span>Search</span>
                <input
                  value={threadPicker.searchQuery}
                  onChange={(event) => setThreadPicker((current) => current ? {
                    ...current,
                    searchQuery: event.target.value
                  } : current)}
                  disabled={!threadPickerReady || threadPicker.acting !== null || threadPicker.loading || threadPicker.candidates.length === 0}
                  placeholder="Title, message, or thread ID"
                  spellCheck={false}
                />
              </label>
              {threadPicker.preparingRuntime ? (
                <div className="threadPickerEmpty" role="status">Starting Codex runtime…</div>
              ) : !threadPicker.machineId ? (
                <div className="threadPickerEmpty">Codex runtime is not ready</div>
              ) : threadPicker.loading ? (
                <div className="threadPickerEmpty">Loading threads</div>
              ) : threadPicker.candidates.length === 0 ? (
                <div className="threadPickerEmpty">No local threads</div>
              ) : filteredThreadCandidates.length === 0 ? (
                <div className="threadPickerEmpty">{threadPickerHasSearch ? "No matching threads" : "No local threads"}</div>
              ) : filteredThreadCandidates.map((candidate) => {
                const isOpen = threadPickerOpenThreadIds.has(candidate.threadId);
                const acting = threadPicker.acting === candidate.threadId;
                const candidateSnippet = threadCandidateSnippet(candidate);
                const candidateStats = threadCandidateStats(candidate);
                return (
                  <button
                    type="button"
                    className={`threadPickerRow ${isOpen ? "open" : ""}`}
                    key={candidate.threadId}
                    onClick={() => void chooseThreadCandidate(candidate)}
                    disabled={!threadPickerReady || threadPicker.acting !== null}
                    title={threadCandidateHoverTitle(candidate)}
                  >
                    <span className="threadPickerRowTitle">{threadCandidateTitle(candidate)}</span>
                    {candidateSnippet ? <span className="threadPickerRowSnippet">{candidateSnippet}</span> : null}
                    <span className="threadPickerRowMeta">
                      <code>{shortId(candidate.threadId)}</code>
                      <span>{formatThreadCandidateTime(candidate.updatedAt)}</span>
                      {candidateStats ? <span>{candidateStats}</span> : null}
                      {isOpen ? <strong>open</strong> : null}
                      {acting ? <strong>restoring</strong> : null}
                    </span>
                  </button>
                );
              })}
            </div>
            {threadPicker.error ? <div className="projectActionError">{threadPicker.error}</div> : null}
          </section>
        </div>
      ) : null}

      {threadTabContextMenu && threadTabContextThread ? (
        <div
          className="messageContextMenuLayer"
          role="presentation"
          onMouseDown={() => setThreadTabContextMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setThreadTabContextMenu(null);
          }}
        >
          <div
            className="messageContextMenu"
            role="menu"
            style={{ left: threadTabContextMenu.x, top: threadTabContextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void writeTextToClipboard(threadTabContextThread.threadId).catch(() => undefined);
                setThreadTabContextMenu(null);
              }}
            >
              Copy thread ID
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setThreadRenameDialog({
                  threadId: threadTabContextThread.threadId,
                  title: threadDisplayTitle(threadTabContextThread),
                  saving: false,
                  error: ""
                });
                setThreadTabContextMenu(null);
              }}
            >
              Rename
            </button>
          </div>
        </div>
      ) : null}

      {threadRenameDialog ? (
        <div className="modalOverlay threadRenameDialogOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !threadRenameDialog.saving) setThreadRenameDialog(null);
        }}>
          <form
            className="threadRenameDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="threadRenameDialogTitle"
            onSubmit={(event) => {
              event.preventDefault();
              void saveThreadRenameDialog();
            }}
          >
            <header className="threadRenameDialogHeader">
              <h2 id="threadRenameDialogTitle">Rename Thread</h2>
              <button
                type="button"
                className="iconButton"
                onClick={() => setThreadRenameDialog(null)}
                disabled={threadRenameDialog.saving}
                aria-label="Close"
              >
                x
              </button>
            </header>
            <label className="threadRenameDialogField">
              <span>Name</span>
              <input
                value={threadRenameDialog.title}
                onChange={(event) => setThreadRenameDialog((current) => current
                  ? { ...current, title: event.target.value, error: "" }
                  : current)}
                maxLength={200}
                disabled={threadRenameDialog.saving}
                autoFocus
              />
            </label>
            {threadRenameDialog.error ? <div className="threadRenameDialogError">{threadRenameDialog.error}</div> : null}
            <footer className="threadRenameDialogActions">
              <button type="button" onClick={() => setThreadRenameDialog(null)} disabled={threadRenameDialog.saving}>Cancel</button>
              <button type="submit" className="primary" disabled={threadRenameDialog.saving || !threadRenameDialog.title.trim()}>
                {threadRenameDialog.saving ? "Saving" : "Save"}
              </button>
            </footer>
          </form>
        </div>
      ) : null}

      {projectPicker ? (
        <div className="modalOverlay projectPickerOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setProjectPicker(null);
        }}>
          <section className="projectPickerModal" role="dialog" aria-modal="true" aria-labelledby="projectPickerTitle">
            <header className="projectPickerHeader">
              <div>
                <h2 id="projectPickerTitle">Add Project</h2>
                <p>{projectPickerMachine?.name ?? projectPickerMachine?.hostname ?? projectPicker.machineId}</p>
              </div>
              <button type="button" className="iconButton" onClick={() => setProjectPicker(null)} aria-label="Close">x</button>
            </header>
            <div className="projectPickerBody">
              <label className="projectPickerField">
                <span>Machine</span>
                <select
                  value={projectPicker.machineId}
                  onChange={(event) => changeProjectPickerMachine(event.target.value)}
                  disabled={projectPicker.loading || projectPickerMachines.length <= 1}
                >
                  {projectPickerMachines.map((machine) => (
                    <option value={machine.machineId} key={machine.machineId}>
                      {machine.name ?? machine.hostname}
                    </option>
                  ))}
                </select>
              </label>
              <div className="projectPickerField">
                <span>Folder path</span>
                <form className="projectPickerPathForm" onSubmit={submitProjectPickerPath}>
                  <button
                    type="button"
                    className="projectPickerPathButton"
                    onClick={() => projectPicker.parent ? void loadProjectPickerDirectory(projectPicker.machineId, projectPicker.parent) : undefined}
                    disabled={projectPicker.loading || !projectPicker.parent}
                    aria-label="Go to parent folder"
                  >
                    ..
                  </button>
                  <button
                    type="button"
                    className="projectPickerPathButton"
                    onClick={() => projectPicker.home ? void loadProjectPickerDirectory(projectPicker.machineId, projectPicker.home) : undefined}
                    disabled={projectPicker.loading || !projectPicker.home}
                    aria-label="Go to home folder"
                  >
                    ~
                  </button>
                  <input
                    value={projectPicker.path}
                    onChange={(event) => setProjectPicker((current) => current ? { ...current, path: event.target.value } : current)}
                    spellCheck={false}
                    aria-label="Folder path"
                  />
                  <button type="submit" className="projectPickerGoButton" disabled={projectPicker.loading || !projectPicker.path.trim()}>
                    Go
                  </button>
                </form>
              </div>
              <label className="projectPickerSearchField">
                <span>Search folders</span>
                <input
                  value={projectPickerSearch}
                  onChange={(event) => setProjectPickerSearch(event.target.value)}
                  disabled={projectPicker.loading || projectPicker.entries.length === 0}
                  placeholder="Filter current folder"
                  spellCheck={false}
                />
              </label>
              <div className="projectPickerList" role="listbox" aria-label="Folders">
                {projectPicker.loading ? (
                  <div className="projectPickerEmpty">Loading folders</div>
                ) : visibleProjectPickerEntries.length === 0 ? (
                  <div className="projectPickerEmpty">{projectPickerQuery ? "No matching folders" : "No folders"}</div>
                ) : visibleProjectPickerEntries.map((entry) => (
                  <button
                    type="button"
                    className="projectPickerRow"
                    key={entry.path}
                    onClick={() => void loadProjectPickerDirectory(projectPicker.machineId, entry.path)}
                    title={entry.path}
                  >
                    <span className="projectFolderIcon" aria-hidden="true" />
                    <span>{entry.name}</span>
                  </button>
                ))}
              </div>
              {projectPicker.error ? <div className="projectActionError">{projectPicker.error}</div> : null}
            </div>
            <footer className="projectPickerFooter">
              <button type="button" className="secondaryButton" onClick={() => setProjectPicker(null)}>Cancel</button>
              <button
                type="button"
                className="projectPickerPrimaryButton"
                onClick={() => void confirmProjectPicker()}
                disabled={projectPicker.loading || projectPickerOpening || !projectPicker.path.trim()}
              >
                {projectPickerOpening ? "Opening" : "Add Project"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {messageContextMenu ? (
        <div
          className="messageContextMenuLayer"
          role="presentation"
          onMouseDown={() => setMessageContextMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMessageContextMenu(null);
          }}
        >
          <div
            className="messageContextMenu"
            role="menu"
            style={{ left: messageContextMenu.x, top: messageContextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {messageContextMenu.selectedText ? (
              <>
                <button type="button" role="menuitem" onClick={() => void copyContextSelection()}>
                  复制
                </button>
                <button type="button" role="menuitem" onClick={addContextSelectionToConversation}>
                  添加到对话
                </button>
              </>
            ) : null}
            {messageContextMenu.canInspect ? (
              <button type="button" role="menuitem" onClick={inspectContextMessage}>
                查看详细
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {inspectMessage ? (
        <div className="modalOverlay detailModalOverlay" role="dialog" aria-modal="true" onClick={() => setInspectMessage(null)}>
          <section className="modal detailModal" onClick={(event) => event.stopPropagation()}>
            <header className="modalHeader">
              <div>
                <h2>{formatInspectTitle(inspectMessage)}</h2>
                <p>{inspectMessage.status ? statusLabel(inspectMessage.status, inspectMessage.statusText, inspectMessage.statusDurationMs) : "Details"}</p>
              </div>
              <button type="button" className="iconButton" onClick={() => setInspectMessage(null)} aria-label="Close">x</button>
            </header>
            <ToolInspectBody message={inspectMessage} onOpenImage={setImagePreview} />
          </section>
        </div>
      ) : null}

      {imagePreview ? (
        <div className="modalOverlay imagePreviewOverlay" role="dialog" aria-modal="true" onClick={() => setImagePreview(null)}>
          <section className="modal imagePreviewModal" onClick={(event) => event.stopPropagation()}>
            <header className="modalHeader">
              <div>
                <h2>Image</h2>
                {imagePreview.title ? <p>{imagePreview.title}</p> : null}
              </div>
              <button type="button" className="iconButton" onClick={() => setImagePreview(null)} aria-label="Close">x</button>
            </header>
            <div className="imagePreviewBody">
              <img src={imagePreview.url} alt={imagePreview.title ?? "preview"} />
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
};

const optionsWithoutAutoWhenResolved = <T extends { value: string; label: string }>(options: T[], value: string) =>
  value === "auto" ? options : options.filter((option) => option.value !== "auto");

const selectOptionSearchPayload = (option: unknown) => {
  const record = option as { value?: unknown; label?: unknown; searchText?: unknown } | undefined;
  return {
    value: typeof record?.value === "string" ? record.value : "",
    label: typeof record?.label === "string" ? record.label : "",
    searchText: typeof record?.searchText === "string" ? record.searchText : ""
  };
};
