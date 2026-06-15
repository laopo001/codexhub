import React from "react";
import { Switch } from "antd";
import { reasoningOptions } from "./appConfig.js";
import {
  formatInspectTitle,
  formatThreadCandidateTime,
  machineProjectCatalogEditable,
  machineProjectLauncher,
  modelOptionLabel,
  primeTaskNotificationPermission,
  reasoningOptionLabel,
  shortId,
  statusLabel,
  threadCandidateTitle,
  ToolInspectBody
} from "./appHelpers.js";
import type { ModelSelection, ReasoningSelection } from "./types.js";
import type { AppViewModel } from "./viewModel.js";

type AppDialogsProps = {
  viewModel: AppViewModel;
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
    goalDialog,
    inspectContextMessage,
    inspectMessage,
    loadProjectPickerDirectory,
    machines,
    messageContextMenu,
    activeThreadModelDraft,
    activeThreadReasoningDraft,
    modelOptions,
    onlineMachines,
    openingProjectKey,
    projectPicker,
    saveGoalDialog,
    threadModelDialogOpen,
    settingsDialogOpen,
    sessionList,
    openThreads,
    setGoalDialog,
    setInspectMessage,
    setAppSettings,
    setMessageContextMenu,
    setProjectPicker,
    setActiveThreadModelDraft,
    setActiveThreadReasoningDraft,
    setThreadModelDialogOpen,
    setSettingsDialogOpen,
    setThreadPicker,
    submitProjectPickerPath,
    threadOrderBySession,
    threadPicker
  } = viewModel;

  const projectPickerMachine = projectPicker
    ? machines.find((machine) => machine.machineId === projectPicker.machineId)
    : undefined;
  const projectPickerMachines = onlineMachines.filter((machine) =>
    machineProjectLauncher(machine) && machineProjectCatalogEditable(machine)
  );
  const projectPickerOpening = projectPicker
    ? openingProjectKey === `${projectPicker.machineId}:${projectPicker.path.trim()}`
    : false;
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
              <select value={activeThreadModelDraft} onChange={(event) => setActiveThreadModelDraft(event.target.value as ModelSelection)}>
                {modelOptions.map((option) => <option value={option.value} key={option.value}>{modelOptionLabel(option)}</option>)}
              </select>
            </label>
            <label className="sessionDialogField">
              <span>Thinking</span>
              <select value={activeThreadReasoningDraft} onChange={(event) => setActiveThreadReasoningDraft(event.target.value as ReasoningSelection)}>
                {reasoningOptions.map((option) => <option value={option.value} key={option.value}>{reasoningOptionLabel(option)}</option>)}
              </select>
            </label>
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
                  <em>Browser or VSCode notification</em>
                </span>
                <Switch
                  checked={appSettings.taskCompleteSystemNotifications}
                  onChange={(checked) => {
                    setAppSettings((current) => ({ ...current, taskCompleteSystemNotifications: checked }));
                    if (checked) primeTaskNotificationPermission();
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
              <div className="goalDialogMark" aria-hidden="true">◎</div>
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
              <div>
                <h2 id="threadPickerTitle">Add Thread</h2>
                <p>{threadPickerSession?.name ?? shortId(threadPicker.sessionId)}</p>
              </div>
              <button type="button" className="iconButton" onClick={() => setThreadPicker(null)} aria-label="Close">x</button>
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
              {threadPicker.loading ? (
                <div className="threadPickerEmpty">Loading threads</div>
              ) : threadPicker.candidates.length === 0 ? (
                <div className="threadPickerEmpty">No local threads</div>
              ) : threadPicker.candidates.map((candidate) => {
                const isOpen = threadPickerOpenThreadIds.has(candidate.threadId);
                const acting = threadPicker.acting === candidate.threadId;
                return (
                  <button
                    type="button"
                    className={`threadPickerRow ${isOpen ? "open" : ""}`}
                    key={candidate.threadId}
                    onClick={() => void chooseThreadCandidate(candidate)}
                    disabled={threadPicker.acting !== null}
                    title={candidate.threadId}
                  >
                    <span className="threadPickerRowTitle">{threadCandidateTitle(candidate)}</span>
                    <span className="threadPickerRowMeta">
                      <code>{shortId(candidate.threadId)}</code>
                      <span>{formatThreadCandidateTime(candidate.updatedAt)}</span>
                      {isOpen ? <strong>open</strong> : null}
                      {acting ? <strong>restoring</strong> : null}
                    </span>
                  </button>
                );
              })}
            </div>
            {threadPicker.error ? <div className="projectOpenError">{threadPicker.error}</div> : null}
          </section>
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
              <div className="projectPickerList" role="listbox" aria-label="Folders">
                {projectPicker.loading ? (
                  <div className="projectPickerEmpty">Loading folders</div>
                ) : projectPicker.entries.length === 0 ? (
                  <div className="projectPickerEmpty">No folders</div>
                ) : projectPicker.entries.map((entry) => (
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
              {projectPicker.error ? <div className="projectOpenError">{projectPicker.error}</div> : null}
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
                <p>{inspectMessage.status ? statusLabel(inspectMessage.status, inspectMessage.statusText) : "Details"}</p>
              </div>
              <button type="button" className="iconButton" onClick={() => setInspectMessage(null)} aria-label="Close">x</button>
            </header>
            <ToolInspectBody message={inspectMessage} />
          </section>
        </div>
      ) : null}
    </>
  );
};
