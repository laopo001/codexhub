import React from "react";
import { Modal, Select, Switch } from "antd";
import { Check, ChevronRight, Copy, Download, ExternalLink, Target, X } from "lucide-react";
import { isVscodeSurface } from "./appConfig.js";
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
import {
  composerInputHistoryStore,
  formatComposerInputHistoryTime,
  useComposerInputHistory
} from "./helpers/composerInputHistory.js";
import { downloadImageFile, extractImageFilename, writeImageToClipboard } from "./helpers/imageClipboard.js";
import { ConnectionsPanel } from "./ConnectionsPanel.js";
import { MachineAppsPanel } from "./MachineAppsPanel.js";
import { DeveloperInstructionsSettings } from "./DeveloperInstructionsSettings.js";
import { ThreadPickerInstructions } from "./ThreadPickerInstructions.js";
import { TaskDialog } from "./TaskDialog.js";
import type { ModelSelection, ReasoningSelection, ServiceTierSelection } from "./types.js";
import type { AppDialogsViewModel } from "./viewModel.js";

type AppDialogsProps = {
  viewModel: AppDialogsViewModel;
};

export const AppDialogs = ({ viewModel }: AppDialogsProps) => {
  const {
    addSelectionToConversation,
    appSettings,
    changeProjectPickerMachine,
    chooseThreadCandidate,
    confirmProjectPicker,
    copySelection,
    createMachineThread,
    createWorktreeThread,
    goalDialog,
    imagePreview,
    inspectMessage,
    loadProjectPickerDirectory,
    loadCommandPalette,
    loadThreadPickerCandidates,
    machines,
    messageSelectionToolbar,
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
    projectList,
    projectPicker,
    retryModelCatalog,
    saveGoalDialog,
    saveThreadRenameDialog,
    threadModelDialogOpen,
    threadRenameDialog,
    threadTabContextMenu,
    settingsDialogOpen,
    tasksDialogOpen,
    runtimeList,
    openThreads,
    setGoalDialog,
    setImagePreview,
    setInspectMessageSelection,
    setAppSettings,
    setMessageSelectionToolbar,
    setProjectPicker,
    setThreadModelDialogModelDraft,
    setThreadModelDialogReasoningDraft,
    setThreadModelDialogServiceTierDraft,
    setThreadModelDialogOpen,
    setThreadRenameDialog,
    setThreadTabContextMenu,
    setSettingsDialogOpen,
    setThreadPicker,
    selectThreadPickerWorkingDirectory,
    submitProjectPickerPath,
    systemStatus,
    threadOrderByMachine,
    threadPicker
  } = viewModel;
  const [projectPickerSearch, setProjectPickerSearch] = React.useState("");
  const [restartState, setRestartState] = React.useState<"idle" | "restarting" | "error">("idle");
  const [settingsSection, setSettingsSection] = React.useState<"general" | "developerInstructions" | "connections" | "apps" | "inputHistory">("general");
  const [notificationPersistAfterMinutesDraft, setNotificationPersistAfterMinutesDraft] = React.useState(
    String(appSettings.taskCompleteNotificationPersistAfterMinutes)
  );
  const [imageCopyStatus, setImageCopyStatus] = React.useState<"idle" | "copying" | "copied" | "failed">("idle");
  const [imageDownloadStatus, setImageDownloadStatus] = React.useState<"idle" | "downloading" | "downloaded">("idle");
  const previewImageElementRef = React.useRef<HTMLImageElement | null>(null);
  const restartAvailable = Boolean(systemStatus.authority);
  const authorityUpdateDetected = Boolean(systemStatus.authorityUpdate);
  const authorityUpdateAvailable = Boolean(systemStatus.authorityUpdate?.restartable);
  const reloadFrontend = () => window.location.reload();
  React.useEffect(() => {
    setProjectPickerSearch("");
  }, [projectPicker?.machineId, projectPicker?.entries]);
  React.useEffect(() => {
    if (settingsDialogOpen) {
      setRestartState("idle");
      setNotificationPersistAfterMinutesDraft(String(appSettings.taskCompleteNotificationPersistAfterMinutes));
    }
  }, [
    appSettings.taskCompleteNotificationPersistAfterMinutes,
    settingsDialogOpen
  ]);
  React.useEffect(() => {
    setImageCopyStatus("idle");
    setImageDownloadStatus("idle");
  }, [imagePreview?.url]);
  const copyPreviewImage = async () => {
    if (!imagePreview || imageCopyStatus === "copying") return;
    setImageCopyStatus("copying");
    try {
      await writeImageToClipboard(imagePreview.url, previewImageElementRef.current);
      setImageCopyStatus("copied");
    } catch {
      setImageCopyStatus("failed");
    }
  };
  const downloadPreviewImage = async () => {
    if (!imagePreview || imageDownloadStatus === "downloading") return;
    setImageDownloadStatus("downloading");
    try {
      const filename = imagePreview.title ? extractImageFilename(imagePreview.title) : undefined;
      await downloadImageFile(imagePreview.url, filename);
      setImageDownloadStatus("downloaded");
    } catch {
      setImageDownloadStatus("idle");
    } finally {
      window.setTimeout(() => setImageDownloadStatus("idle"), 1500);
    }
  };
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
    const currentBuild = systemStatus.build ?? "unknown";
    const localBuild = systemStatus.authorityLocalBuild ?? "unavailable";
    const surfaceCandidate = systemStatus.authorityUpdate?.buildId;
    const hasUnverifiedUpdate = authorityUpdateDetected && !authorityUpdateAvailable;
    const updateState = authorityUpdateAvailable
      ? "verified"
      : hasUnverifiedUpdate
        ? "unverified"
        : localBuild === "unavailable"
          ? "unavailable"
          : localBuild === currentBuild
            ? "same"
            : "pending";
    Modal.confirm({
      title: authorityUpdateAvailable
        ? "Compare and apply this CodexHub build?"
        : hasUnverifiedUpdate
          ? "Compare builds and restart current authority?"
        : "Restart this CodexHub authority and frontend?",
      content: (
        <AuthorityBuildComparison
          currentBuild={currentBuild}
          localBuild={localBuild}
          surfaceCandidate={surfaceCandidate}
          updateState={updateState}
        />
      ),
      okText: authorityUpdateAvailable ? "Apply selected build" : hasUnverifiedUpdate ? "Restart current version" : "Restart all",
      cancelText: "Cancel",
      onOk: async () => {
        setRestartState("restarting");
        try {
          await apiRouteJson(apiRoutes.restartAuthority);
        } catch {
          setRestartState("error");
        }
      }
    });
  };
  const hasOpenDialog = Boolean(
    threadModelDialogOpen
    || settingsDialogOpen
    || tasksDialogOpen
    || projectPicker
    || threadPicker
    || inspectMessage
    || imagePreview
    || goalDialog
    || threadRenameDialog
    || threadTabContextMenu
    || messageSelectionToolbar
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
        setInspectMessageSelection(null);
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
    setInspectMessageSelection,
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
  const threadPickerPathOptions = threadPicker
    ? [
        ...projectList
          .filter((project) => project.machineId === threadPicker.machineId)
          .map((project) => ({ value: project.path, label: project.path })),
        ...(projectList.some((project) =>
          project.machineId === threadPicker.machineId && project.path === threadPicker.workingDirectory
        ) ? [] : [{ value: threadPicker.workingDirectory, label: threadPicker.workingDirectory }])
      ]
    : [];
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
      <TaskDialog viewModel={viewModel} />
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
                Used for subsequent turns. The default option follows your Codex configuration.
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
            <div className="settingsDialogLayout">
              <nav className="settingsNavigation" aria-label="Settings sections">
                <button
                  type="button"
                  className={settingsSection === "general" ? "active" : ""}
                  onClick={() => setSettingsSection("general")}
                  aria-current={settingsSection === "general" ? "page" : undefined}
                >
                  General
                </button>
                <button
                  type="button"
                  className={settingsSection === "developerInstructions" ? "active" : ""}
                  onClick={() => setSettingsSection("developerInstructions")}
                  aria-current={settingsSection === "developerInstructions" ? "page" : undefined}
                >
                  Developer instructions
                </button>
                <button
                  type="button"
                  className={settingsSection === "connections" ? "active" : ""}
                  onClick={() => setSettingsSection("connections")}
                  aria-current={settingsSection === "connections" ? "page" : undefined}
                >
                  Connections
                </button>
                <button
                  type="button"
                  className={settingsSection === "apps" ? "active" : ""}
                  onClick={() => setSettingsSection("apps")}
                  aria-current={settingsSection === "apps" ? "page" : undefined}
                >
                  Codex Apps
                </button>
                <button
                  type="button"
                  className={settingsSection === "inputHistory" ? "active" : ""}
                  onClick={() => setSettingsSection("inputHistory")}
                  aria-current={settingsSection === "inputHistory" ? "page" : undefined}
                >
                  Input history
                </button>
              </nav>
              <div className="settingsDialogContent">
                {settingsSection === "general" ? (
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
                    <div className="settingsRow">
                      <span className="settingsRowText">
                        <strong id="settingAutoGenerateThreadTitle">Auto rename threads</strong>
                        <em>Automatically regenerate the title after each completed context compaction</em>
                      </span>
                      <Switch
                        checked={appSettings.autoGenerateThreadTitle}
                        onChange={(checked) => {
                          const previous = appSettings.autoGenerateThreadTitle;
                          setAppSettings((current) => ({ ...current, autoGenerateThreadTitle: checked }));
                          void apiRouteJson(apiRoutes.updateConfig, {
                            ui: { autoGenerateThreadTitle: checked }
                          }).then((payload) => {
                            setAppSettings((current) => ({
                              ...current,
                              autoGenerateThreadTitle: payload.config.ui.autoGenerateThreadTitle
                            }));
                          }).catch(() => {
                            setAppSettings((current) => ({ ...current, autoGenerateThreadTitle: previous }));
                          });
                        }}
                        aria-labelledby="settingAutoGenerateThreadTitle"
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
                    <div className="settingsRow settingsFrontendReloadRow">
                      <span className="settingsRowText">
                        <strong>Reload frontend</strong>
                        <em>Reload only this CodexHub surface. The authority, Codex runtime, and other windows keep running.</em>
                      </span>
                      <button
                        type="button"
                        className="petSettingsButton settingsRestartButton"
                        onClick={reloadFrontend}
                      >
                        Reload frontend
                      </button>
                    </div>
                    {restartAvailable ? (
                      <div
                        className={`settingsRow settingsRestartRow${authorityUpdateAvailable ? " has-update" : ""}${restartState === "restarting" ? " is-restarting" : ""}${restartState === "error" ? " has-error" : ""}`}
                        aria-busy={restartState === "restarting"}
                      >
                        <span className="settingsRowText">
                          <strong>{authorityUpdateAvailable ? "Update authority and frontends" : "Restart authority and frontends"}</strong>
                          <em
                            className={restartState === "error" ? "settingsError" : undefined}
                            aria-live="polite"
                          >
                            {restartState === "restarting"
                              ? authorityUpdateAvailable
                                ? "Applying the update, restarting this host's authority, and reconnecting this window..."
                                : "Restarting this host's authority and reconnecting this window..."
                              : restartState === "error"
                                ? "Restart failed. Check the authority log and try again."
                              : authorityUpdateAvailable
                                  ? "A new CodexHub build is ready. Apply it by explicitly restarting this host's authority, runtime, and connected frontends."
                                  : authorityUpdateDetected
                                    ? "A different surface reported a build. Compare the hashes and choose whether to apply it."
                                  : "Restart this host's authority, Codex runtime, and connected frontends. Host applications stay open."}
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
                              <span>{authorityUpdateAvailable ? "Updating..." : "Restarting..."}</span>
                            </>
                          ) : authorityUpdateAvailable ? "Update and restart all" : authorityUpdateDetected ? "Compare builds" : "Restart all"}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : settingsSection === "developerInstructions" ? (
                  <DeveloperInstructionsSettings />
                ) : settingsSection === "connections" ? (
                  <ConnectionsPanel viewModel={viewModel} />
                ) : settingsSection === "apps" ? (
                  <MachineAppsPanel machines={machines} openThreads={openThreads} loadCommandPalette={loadCommandPalette} />
                ) : (
                  <InputHistorySettingsPanel />
                )}
              </div>
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
                <Select
                  className="threadPickerPathSelect"
                  value={threadPicker.workingDirectory}
                  options={threadPickerPathOptions}
                  onChange={(workingDirectory) => void selectThreadPickerWorkingDirectory(workingDirectory)}
                  disabled={!threadPickerReady || threadPicker.acting !== null || threadPickerPathOptions.length <= 1}
                  showSearch
                  optionFilterProp="label"
                  aria-label="Thread working directory"
                  title={threadPicker.workingDirectory}
                />
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
            <div
              className="threadPickerList"
              role={threadPicker.selectingInstructions ? undefined : "listbox"}
              aria-label={threadPicker.selectingInstructions ? undefined : "Thread candidates"}
            >
              {threadPicker.selectingInstructions ? (
                <ThreadPickerInstructions
                  disabled={!threadPickerReady}
                  acting={threadPicker.acting}
                  onBack={() => setThreadPicker((current) => current ? { ...current, selectingInstructions: false } : current)}
                  onSelect={(developerInstructionsId) => void createMachineThread({ developerInstructionsId })}
                  onOpenSettings={() => {
                    setThreadPicker(null);
                    setSettingsSection("developerInstructions");
                    setSettingsDialogOpen(true);
                  }}
                />
              ) : (
                <>
                  <div className="threadPickerNewRow">
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
                    <button
                      type="button"
                      className="threadPickerRow newThreadWithInstructions"
                      onClick={() => setThreadPicker((current) => current ? { ...current, selectingInstructions: true } : current)}
                      disabled={!threadPickerReady || threadPicker.acting !== null}
                    >
                      <span className="threadPickerRowTitle">New with instructions</span>
                      <span className="threadPickerRowMeta">
                        {threadPicker.preparingRuntime
                          ? "Available when the Codex runtime is ready"
                          : "Choose instruction template"}
                      </span>
                    </button>
                  </div>
                  <details className="threadPickerWorktree">
                <summary className="threadPickerWorktreeSummary">
                  <span className="threadPickerWorktreeTitle">New worktree thread</span>
                  <span className="threadPickerWorktreeMeta">Create an isolated branch</span>
                  <ChevronRight size={15} strokeWidth={2.25} aria-hidden="true" />
                </summary>
                <form
                  className="threadPickerWorktreeBody"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createWorktreeThread();
                  }}
                >
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
                  <div className="threadPickerWorktreeFooter">
                    <div className="threadPickerWorktreePreview" title={worktreePreview}>
                      <span>Target</span>
                      <code>{worktreePreview}</code>
                    </div>
                    <button
                      type="submit"
                      disabled={!threadPickerReady || threadPicker.acting !== null || !threadPicker.worktreeBranch.trim()}
                    >
                      {threadPicker.acting === "worktree" ? "creating" : "Create"}
                    </button>
                  </div>
                </form>
              </details>
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
                </>
              )}
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
                  generating: false,
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
                placeholder={threadRenameDialog.generating ? "Generating title..." : undefined}
                disabled={threadRenameDialog.saving || threadRenameDialog.generating}
                autoFocus
              />
            </label>
            {threadRenameDialog.generating ? <div className="threadRenameDialogGenerating">Generating title...</div> : null}
            {threadRenameDialog.error ? <div className="threadRenameDialogError">{threadRenameDialog.error}</div> : null}
            <footer className="threadRenameDialogActions">
              <button type="button" onClick={() => setThreadRenameDialog(null)} disabled={threadRenameDialog.saving}>Cancel</button>
              <button type="submit" className="primary" disabled={threadRenameDialog.generating || threadRenameDialog.saving || !threadRenameDialog.title.trim()}>
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

      {messageSelectionToolbar ? (
        <div
          className="messageContextMenuLayer selectionToolbarLayer"
          role="presentation"
          onMouseDown={() => setMessageSelectionToolbar(null)}
        >
          <div
            className="messageContextMenu selectionToolbar"
            role="menu"
            style={{ left: messageSelectionToolbar.x, top: messageSelectionToolbar.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" onClick={() => void copySelection()}>
              复制
            </button>
            <button type="button" role="menuitem" onClick={addSelectionToConversation}>
              添加到对话
            </button>
          </div>
        </div>
      ) : null}

      {inspectMessage ? (
        <div className="modalOverlay detailModalOverlay" role="dialog" aria-modal="true" onClick={() => setInspectMessageSelection(null)}>
          <section className="modal detailModal" onClick={(event) => event.stopPropagation()}>
            <header className="modalHeader">
              <div>
                <h2>{formatInspectTitle(inspectMessage)}</h2>
                <p>{inspectMessage.status ? statusLabel(inspectMessage.status, inspectMessage.statusText, inspectMessage.statusDurationMs) : "Details"}</p>
              </div>
              <button type="button" className="iconButton" onClick={() => setInspectMessageSelection(null)} aria-label="Close">x</button>
            </header>
            <ToolInspectBody message={inspectMessage} onOpenImage={setImagePreview} />
          </section>
        </div>
      ) : null}

      {imagePreview ? (
        <div className="modalOverlay imagePreviewOverlay" role="dialog" aria-modal="true" onClick={() => setImagePreview(null)}>
          <section className="modal imagePreviewModal" aria-labelledby="image-preview-title" onClick={(event) => event.stopPropagation()}>
            <header className="modalHeader imagePreviewHeader">
              <h2 id="image-preview-title">Image preview</h2>
              <div className="imagePreviewActions">
                <button
                  type="button"
                  className={`imagePreviewCopyButton ${imageCopyStatus}`}
                  onClick={() => void copyPreviewImage()}
                  disabled={imageCopyStatus === "copying"}
                  aria-label="Copy image"
                  title={imageCopyStatus === "failed" ? "Copy failed. Try again or download image." : undefined}
                >
                  {imageCopyStatus === "copied"
                    ? <Check size={16} aria-hidden="true" />
                    : <Copy size={16} aria-hidden="true" />}
                  <span>{imageCopyButtonLabel(imageCopyStatus)}</span>
                </button>
                <button
                  type="button"
                  className="iconButton"
                  onClick={() => void downloadPreviewImage()}
                  disabled={imageDownloadStatus === "downloading"}
                  aria-label="Download image"
                  title="Download image"
                >
                  {imageDownloadStatus === "downloaded"
                    ? <Check size={16} aria-hidden="true" />
                    : <Download size={16} aria-hidden="true" />}
                </button>
                <button type="button" className="iconButton" onClick={() => setImagePreview(null)} aria-label="Close image preview">
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
            </header>
            <div className="imagePreviewBody">
              <img ref={previewImageElementRef} src={imagePreview.url} alt={imagePreview.title ?? "preview"} />
            </div>
            {imagePreview.title ? (
              <details className="imagePreviewDetails">
                <summary>Image details</summary>
                <p>{imagePreview.title}</p>
                {isVscodeSurface && isLocalAbsolutePath(imagePreview.title) ? (
                  <button
                    type="button"
                    className="imagePreviewOpenFileButton"
                    onClick={() => {
                      window.parent?.postMessage({
                        type: "codexhub.openFile",
                        path: imagePreview.title
                      }, "*");
                    }}
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                    <span>在 VS Code 中打开</span>
                  </button>
                ) : null}
              </details>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
};

export const AuthorityBuildComparison = ({
  currentBuild,
  localBuild,
  surfaceCandidate,
  updateState
}: {
  currentBuild: string;
  localBuild: string;
  surfaceCandidate?: string;
  updateState: "same" | "verified" | "unverified" | "pending" | "unavailable";
}) => (
  <div className="authorityBuildComparison">
    <p>Compare the build hashes before restarting this CodexHub authority.</p>
    <p><strong>Running authority:</strong> <code>{currentBuild}</code></p>
    <p><strong>Local files:</strong> <code>{localBuild}</code></p>
    {surfaceCandidate ? <p><strong>Surface candidate:</strong> <code>{surfaceCandidate}</code></p> : null}
    <p>
      <strong>Result:</strong>{" "}
      {updateState === "verified"
        ? "Local update available"
        : updateState === "unverified"
          ? "Surface candidate is not verified in local files"
          : updateState === "pending"
            ? "Local files differ; update verification is pending"
            : updateState === "unavailable"
              ? "Local build could not be verified"
              : "Same build"}
    </p>
    <p>Restarting interrupts running turns on this host. Connected surfaces will reconnect and restore their tabs.</p>
  </div>
);

const imageCopyButtonLabel = (status: "idle" | "copying" | "copied" | "failed") => {
  if (status === "copying") return "Copying...";
  if (status === "copied") return "Copied";
  if (status === "failed") return "Copy failed";
  return "Copy image";
};

const isLocalAbsolutePath = (value?: string | null): boolean => {
  if (!value) return false;
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);
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

export const InputHistorySettingsPanel = ({
  store = composerInputHistoryStore,
  copyText = writeTextToClipboard
}: {
  store?: typeof composerInputHistoryStore;
  copyText?: (text: string) => Promise<void>;
}) => {
  const entries = useComposerInputHistory(store);
  const [copyStatus, setCopyStatus] = React.useState<{
    id: string;
    status: "copied" | "failed";
  } | null>(null);

  const handleCopy = async (id: string, text: string) => {
    try {
      await copyText(text);
      setCopyStatus({ id, status: "copied" });
    } catch {
      setCopyStatus({ id, status: "failed" });
    }
    window.setTimeout(() => setCopyStatus((current) => (current?.id === id ? null : current)), 1500);
  };

  const handleClearAll = () => {
    Modal.confirm({
      title: "Clear all input history?",
      content: "This will remove all saved composer input history. This action cannot be undone.",
      okText: "Clear all",
      okType: "danger",
      cancelText: "Cancel",
      onOk: () => {
        store.clear();
      }
    });
  };

  return (
    <div className="settingsHistoryPanel">
      <div className="settingsHistoryToolbar">
        <span className="settingsHistoryCount">
          {entries.length === 0 ? "No input history" : `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}
        </span>
        {entries.length > 0 ? (
          <button
            type="button"
            className="settingsHistoryClearButton"
            onClick={handleClearAll}
          >
            Clear all
          </button>
        ) : null}
      </div>
      {entries.length === 0 ? (
        <div className="settingsHistoryEmpty" role="status">
          No input history yet. Messages sent from the composer will appear here.
        </div>
      ) : (
        <div className="settingsHistoryList" role="list">
          {entries.map((entry) => (
            <div className="settingsHistoryRow" key={entry.id} role="listitem">
              <div className="settingsHistoryRowHeader">
                <span className="settingsHistoryTime" title={entry.createdAt}>
                  {formatComposerInputHistoryTime(entry.createdAt)}
                </span>
                <div className="settingsHistoryActions">
                  <button
                    type="button"
                    className={`settingsHistoryActionButton${copyStatus?.id === entry.id ? ` ${copyStatus.status}` : ""}`}
                    onClick={() => void handleCopy(entry.id, entry.text)}
                    aria-label="Copy input text"
                    aria-live="polite"
                  >
                    {copyStatus?.id === entry.id
                      ? copyStatus.status === "copied" ? "Copied" : "Copy failed"
                      : "Copy"}
                  </button>
                  <button
                    type="button"
                    className="settingsHistoryActionButton delete"
                    onClick={() => store.delete(entry.id)}
                    aria-label="Delete input history entry"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <pre className="settingsHistoryText">{entry.text}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
