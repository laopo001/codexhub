import React from "react";
import { Select, Switch } from "antd";
import { Target } from "lucide-react";
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
    createSessionThread,
    createWorktreeThread,
    goalDialog,
    imagePreview,
    inspectContextMessage,
    inspectMessage,
    loadProjectPickerDirectory,
    loadThreadPickerCandidates,
    machines,
    messageContextMenu,
    activeModelCatalogError,
    activeModelCatalogStatus,
    effectiveModelSelection,
    effectiveReasoningSelection,
    effectiveServiceTierSelection,
    modelOptions,
    reasoningOptions,
    serviceTierOptions,
    onlineMachines,
    openingProjectKey,
    projectPicker,
    retryModelCatalog,
    saveGoalDialog,
    saveThreadRenameDialog,
    threadModelDialogOpen,
    threadRenameDialog,
    threadTabContextMenu,
    settingsDialogOpen,
    sessionList,
    openThreads,
    setGoalDialog,
    setImagePreview,
    setInspectMessage,
    setAppSettings,
    setMessageContextMenu,
    setProjectPicker,
    setActiveThreadModelDraft,
    setActiveThreadReasoningDraft,
    setActiveThreadServiceTierDraft,
    setThreadModelDialogOpen,
    setThreadRenameDialog,
    setThreadTabContextMenu,
    setSettingsDialogOpen,
    setThreadPicker,
    submitProjectPickerPath,
    threadOrderBySession,
    threadPicker
  } = viewModel;
  const [projectPickerSearch, setProjectPickerSearch] = React.useState("");
  React.useEffect(() => {
    setProjectPickerSearch("");
  }, [projectPicker?.machineId, projectPicker?.entries]);
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
  const threadPickerSession = threadPicker
    ? sessionList.find((session) => session.sessionId === threadPicker.sessionId)
    : undefined;
  const threadPickerOpenThreadIds = new Set([
    ...(threadPickerSession?.threads
      ?.filter((thread) => !threadPicker?.workingDirectory || thread.workingDirectory === threadPicker.workingDirectory)
      .map((thread) => thread.threadId) ?? []),
    ...(threadPicker ? threadOrderBySession[threadPicker.sessionId] ?? [] : []),
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
  const dialogModelOptions = optionsWithoutAutoWhenResolved(modelOptions, effectiveModelSelection);
  const dialogReasoningOptions = optionsWithoutAutoWhenResolved(reasoningOptions, effectiveReasoningSelection);
  const dialogServiceTierOptions = optionsWithoutAutoWhenResolved(serviceTierOptions, effectiveServiceTierSelection);
  const worktreePreview = threadPicker
    ? worktreeTargetPreview(threadPicker.workingDirectory, threadPicker.worktreeBranch, threadPicker.worktreePath)
    : "";
  const dialogModelSelectOptions = dialogModelOptions.map((option) => ({
    ...option,
    label: modelOptionLabel(option)
  }));
  const modelCatalogLoading = activeModelCatalogStatus === "idle" || activeModelCatalogStatus === "loading";
  const modelCatalogError = activeModelCatalogStatus === "error";
  const modelCatalogNotice = activeModelCatalogStatus === "unavailable"
    ? "No online runtime session."
    : modelCatalogLoading
      ? "Loading model catalog..."
      : modelCatalogError
        ? activeModelCatalogError || "Model catalog unavailable."
        : "";
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
                value={effectiveModelSelection}
                options={dialogModelSelectOptions}
                disabled={threadModelSelectDisabled}
                loading={modelCatalogLoading}
                filterOption={(input, option) => modelOptionSearchMatches(selectOptionSearchPayload(option), input)}
                onChange={(value) => setActiveThreadModelDraft(value as ModelSelection)}
              />
            </label>
            <label className="sessionDialogField">
              <span>Thinking</span>
              <Select
                className="threadModelSelect"
                value={effectiveReasoningSelection}
                options={dialogReasoningOptions.map((option) => ({ value: option.value, label: reasoningOptionLabel(option) }))}
                disabled={threadModelSelectDisabled}
                loading={modelCatalogLoading}
                onChange={(value) => setActiveThreadReasoningDraft(value as ReasoningSelection)}
              />
            </label>
            <label className="sessionDialogField">
              <span>Service Tier</span>
              <Select
                className="threadModelSelect"
                value={effectiveServiceTierSelection}
                options={dialogServiceTierOptions.map((option) => ({ value: option.value, label: serviceTierOptionLabel(option) }))}
                disabled={threadModelSelectDisabled}
                loading={modelCatalogLoading}
                onChange={(value) => setActiveThreadServiceTierDraft(value as ServiceTierSelection)}
              />
            </label>
            {modelCatalogNotice ? (
              <div className={`sessionDialogNotice${modelCatalogError ? " error" : ""}`}>
                <span>{modelCatalogNotice}</span>
                {modelCatalogError ? (
                  <button type="button" className="textButton" onClick={retryModelCatalog}>Retry</button>
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
            <label className="goalPolicyField">
              <span>消耗到 7d 剩余</span>
              <span className="goalPolicyPercentInput">
                <input
                  type="number"
                  min={0}
                  max={99.9}
                  step={0.1}
                  required
                  value={goalDialog.targetRemainingPercent}
                  onChange={(event) => setGoalDialog((current) => current
                    ? { ...current, targetRemainingPercent: event.target.value, error: "" }
                    : current)}
                />
                <span>%</span>
              </span>
            </label>
            {goalDialog.error ? <div className="goalDialogError">{goalDialog.error}</div> : null}
            <footer className="goalDialogActions">
              <button type="button" onClick={() => setGoalDialog(null)} disabled={goalDialog.saving}>取消</button>
              <button
                type="button"
                className="primary"
                onClick={() => void saveGoalDialog()}
                disabled={goalDialog.saving || !goalDialog.objective.trim() || !goalDialog.targetRemainingPercent.trim()}
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
                  onClick={() => void loadThreadPickerCandidates(threadPicker.sessionId)}
                  disabled={threadPicker.loading || threadPicker.acting !== null}
                >
                  {threadPicker.loading ? "Refreshing" : "Refresh"}
                </button>
                <button type="button" className="iconButton" onClick={() => setThreadPicker(null)} aria-label="Close">x</button>
              </div>
            </header>
            <div className="threadPickerList" role="listbox" aria-label="Thread candidates">
              <button
                type="button"
                className="threadPickerRow newThread"
                onClick={() => void createSessionThread()}
                disabled={threadPicker.acting !== null}
              >
                <span className="threadPickerRowTitle">New thread</span>
                <span className="threadPickerRowMeta">{threadPicker.acting === "new" ? "creating" : "Start a new Codex thread"}</span>
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
                    disabled={threadPicker.acting !== null || !threadPicker.worktreeBranch.trim()}
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
                    disabled={threadPicker.acting !== null}
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
                      disabled={threadPicker.acting !== null}
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
                      disabled={threadPicker.acting !== null}
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
                  disabled={threadPicker.acting !== null || threadPicker.loading || threadPicker.candidates.length === 0}
                  placeholder="Title, message, or thread ID"
                  spellCheck={false}
                />
              </label>
              {threadPicker.loading ? (
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
                    disabled={threadPicker.acting !== null}
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
        <div className="modalOverlay" role="dialog" aria-modal="true" onClick={() => setInspectMessage(null)}>
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
