// @ts-nocheck
import React from "react";
import { Switch } from "antd";
import {
  activeSshConnectionForHost,
  latestSshConnectionForHost,
  machineProjectLauncher,
  projectKeyForProject,
  projectStatusLabel,
  sshConnectionDetail,
  sshConnectionStatusClass,
  sshConnectionStatusLabel,
  sshConnectionTitle,
  sshHostMeta,
  taskBelongsToProject,
  taskStatusClass,
  taskStatusLabel,
  taskTargetLabel,
  taskTargetTitle,
  taskThreadOptionsFor,
  threadDisplayTitle,
  uniqueMachines
} from "./appHelpers.js";

type AppSidebarProps = {
  viewModel: Record<string, any>;
};

export const AppSidebar = ({ viewModel }: AppSidebarProps) => {
  const {
    activeProjectKey,
    addSshHost,
    collapsedProjectMachineKeys,
    connectionMode,
    connectSshHost,
    copyRegisteredCommand,
    createTask,
    deleteProject,
    deleteTask,
    deletingProjectId,
    focusTaskDraftProject,
    localMachines,
    machines,
    offlineProjectsCollapsed,
    onlineMachines,
    openingProjectKey,
    openProjectPicker,
    patchTask,
    projectGroups,
    projectList,
    projectOpenError,
    registeredCommand,
    registeredCommandCopied,
    registeredMachines,
    removeSshHost,
    runTaskNow,
    selectedProject,
    selectProject,
    setConnectionMode,
    setOfflineProjectsCollapsed,
    setSshHostDraft,
    setTaskDraft,
    setTaskFormOpen,
    sshConfigHostOptions,
    sshConfigHosts,
    sshConnectingHost,
    sshConnections,
    sshError,
    sshHostBusy,
    sshHostDraft,
    sshHosts,
    taskBusyId,
    taskDraft,
    taskError,
    taskFormOpen,
    tasks,
    toggleProjectMachineGroup,
    updateTaskDraftMachine,
    updateTaskDraftProject
  } = viewModel;

  const onlineProjectGroups = projectGroups.filter((machine) => machine.online);
  const offlineProjectGroups = projectGroups.filter((machine) => !machine.online);
  const projectAddMachine = onlineProjectGroups.find((machine) => machine.projectLauncher);
  const visibleTasks = selectedProject
    ? tasks.filter((task) => taskBelongsToProject(task, selectedProject))
    : tasks;
  const taskPanelContextLabel = selectedProject?.name ?? "All projects";
  const taskPanelContextTitle = selectedProject ? `${selectedProject.name}\n${selectedProject.path}` : "All projects";
  const taskFormProjectLocked = Boolean(selectedProject);
  const taskMachineOptions = uniqueMachines(machines).filter(machineProjectLauncher);
  const taskProjectOptions = projectList.filter((project) => !taskDraft.machineId || project.machineId === taskDraft.machineId);
  const selectedTaskProject = taskProjectOptions.find((project) => project.path === taskDraft.projectPath);
  const taskThreadOptions = taskThreadOptionsFor(selectedTaskProject);
  const canCreateTask = Boolean(
    taskDraft.machineId.trim()
    && taskDraft.projectPath.trim()
    && taskDraft.schedule.trim()
    && taskDraft.input.trim()
  );

  const renderProjectMachineGroup = (machine) => {
    const collapsed = collapsedProjectMachineKeys.includes(machine.key);
    return (
      <section className="projectMachineGroup" key={machine.key}>
        <button
          type="button"
          className={`projectMachineHeader ${machine.online ? "online" : "offline"}`}
          onClick={() => toggleProjectMachineGroup(machine.key)}
          aria-expanded={!collapsed}
        >
          <span className={`projectOfflineArrow ${collapsed ? "collapsed" : ""}`}>{">"}</span>
          <span title={machine.label}>{machine.label}</span>
          <strong>{machine.statusLabel}</strong>
        </button>
        {!collapsed ? (
          <div className="projectMachineRows">
            {machine.projects.length === 0 ? (
              <div className="projectEmptyRow">No projects</div>
            ) : machine.projects.map((project) => {
              const projectKey = projectKeyForProject(project);
              const active = projectKey === activeProjectKey;
              const statusLabel = projectStatusLabel(project);
              const sessionActive = Boolean(project.session?.online);
              const projectReachable = sessionActive || project.machineOnline;
              const deleting = deletingProjectId === project.projectId;
              const openDisabled = openingProjectKey === projectKey || deleting;
              return (
                <div
                  key={project.projectId}
                  className={`projectRow ${active ? "active" : ""} ${sessionActive ? "online" : projectReachable ? "ready" : "offline"}`}
                >
                  <div className="projectRowTop">
                    <button
                      type="button"
                      className="projectOpenButton projectOpenNameButton"
                      onClick={() => void selectProject(project)}
                      disabled={openDisabled}
                    >
                      <span title={project.name}>{project.name}</span>
                    </button>
                    <div className="projectRowActions">
                      <strong>{openingProjectKey === projectKey ? "opening" : statusLabel}</strong>
                      <button
                        type="button"
                        className="projectDeleteButton"
                        onClick={() => void deleteProject(project)}
                        disabled={deleting}
                        aria-label={`Remove ${project.name}`}
                        title={`Remove ${project.name} from CodexHub`}
                      >
                        x
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="projectOpenButton projectOpenPathButton"
                    onClick={() => void selectProject(project)}
                    disabled={openDisabled}
                  >
                    <code title={project.path}>{project.path}</code>
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div>
          <h1>Codex Hub</h1>
          <p>Local machine workbench</p>
        </div>
      </div>

      <section className="connectionPanel">
        <div className="connectionPanelHeader">
          <h2>Connections</h2>
          <span>{onlineMachines.length} online</span>
        </div>
        <div className="connectionTabs" role="tablist" aria-label="Connection type">
          <button
            type="button"
            className={connectionMode === "local" ? "active" : ""}
            onClick={() => setConnectionMode("local")}
          >
            This Computer
          </button>
          <button
            type="button"
            className={connectionMode === "ssh" ? "active" : ""}
            onClick={() => setConnectionMode("ssh")}
          >
            SSH
          </button>
          <button
            type="button"
            className={connectionMode === "registered" ? "active" : ""}
            onClick={() => setConnectionMode("registered")}
          >
            Registered
          </button>
        </div>
        {connectionMode === "local" ? (
          <div className="connectionList">
            {localMachines.length === 0 ? (
              <div className="connectionEmpty">No machines</div>
            ) : localMachines.map((machine) => (
              <div className={`connectionRow ${machine.online ? "online" : "offline"}`} key={machine.machineId}>
                <span title={machine.name ?? machine.hostname}>{machine.name ?? machine.hostname}</span>
                <strong>{machine.type}</strong>
                <code>{machine.online ? "online" : "offline"}</code>
              </div>
            ))}
          </div>
        ) : connectionMode === "ssh" ? (
          <div className="connectionList">
            <form className="sshManualForm" onSubmit={(event) => void addSshHost(event)}>
              <input
                value={sshHostDraft}
                onChange={(event) => setSshHostDraft(event.target.value)}
                list="sshConfigHostOptions"
                placeholder="SSH config alias"
                spellCheck={false}
              />
              <datalist id="sshConfigHostOptions">
                {sshConfigHostOptions.map((host) => (
                  <option key={host.alias} value={host.alias}>
                    {sshHostMeta(host)}
                  </option>
                ))}
              </datalist>
              <button
                type="submit"
                disabled={
                  !sshHostDraft.trim()
                  || sshHostBusy === sshHostDraft.trim()
                  || sshHosts.some((host) => host.alias === sshHostDraft.trim())
                  || !sshConfigHosts.some((host) => host.alias === sshHostDraft.trim())
                }
              >
                {sshHostBusy === sshHostDraft.trim() ? "..." : "Add"}
              </button>
            </form>
            {sshHosts.length === 0 ? (
              <div className="connectionEmpty">No SSH hosts</div>
            ) : sshHosts.map((host) => {
              const activeConnection = activeSshConnectionForHost(sshConnections, host.alias);
              const latestConnection = latestSshConnectionForHost(sshConnections, host.alias);
              const connecting = sshConnectingHost === host.alias;
              const statusLabel = sshConnectionStatusLabel(latestConnection, connecting, host.configured !== false);
              const statusClass = sshConnectionStatusClass(statusLabel);
              const connectionDetail = sshConnectionDetail(host, latestConnection);
              return (
                <div className={`connectionRow ssh ${statusClass}`} key={host.alias} title={sshConnectionTitle(host, latestConnection)}>
                  <button
                    type="button"
                    className="connectionHostButton"
                    title={host.configured === false ? "SSH config entry missing" : host.hostName ?? host.alias}
                    onClick={() => void connectSshHost(host.alias, host.alias)}
                    disabled={host.configured === false || Boolean(activeConnection) || connecting || sshHostBusy === host.alias}
                  >
                    <span>{host.alias}</span>
                    <code title={connectionDetail}>{connectionDetail}</code>
                  </button>
                  <strong>{statusLabel}</strong>
                  <button
                    type="button"
                    className="connectionDeleteButton"
                    onClick={() => void removeSshHost(host, activeConnection)}
                    disabled={sshHostBusy === host.alias}
                    aria-label={`Remove ${host.alias}`}
                    title={`Remove ${host.alias} from CodexHub`}
                  >
                    x
                  </button>
                </div>
              );
            })}
            {sshError ? <div className="projectOpenError">{sshError}</div> : null}
          </div>
        ) : (
          <div className="connectionList">
            <div className="registeredCommand">
              <code title={registeredCommand}>{registeredCommand}</code>
              <button type="button" onClick={() => void copyRegisteredCommand()}>
                {registeredCommandCopied ? "Copied" : "Copy"}
              </button>
            </div>
            {registeredMachines.length === 0 ? (
              <div className="connectionEmpty">No registered machines</div>
            ) : registeredMachines.map((machine) => (
              <div className={`connectionRow ${machine.online ? "online" : "offline"}`} key={machine.machineId}>
                <span title={machine.name ?? machine.hostname}>{machine.name ?? machine.hostname}</span>
                <strong>{machine.online ? "online" : "offline"}</strong>
                <code title={machine.machineId}>{machine.machineId}</code>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="projectPanel">
        <div className="projectPanelHeader">
          <h2>Projects</h2>
          <span>{projectGroups.length} machines</span>
        </div>
        <button
          type="button"
          className="projectAddButton"
          onClick={() => projectAddMachine ? openProjectPicker(projectAddMachine) : undefined}
          disabled={!projectAddMachine}
          title={projectAddMachine ? "Add a project" : "No online machines"}
        >
          Add Project
        </button>
        {projectGroups.length === 0 ? (
          <div className="projectEmptyRow">No machines</div>
        ) : (
          <div className="projectList">
            {onlineProjectGroups.map(renderProjectMachineGroup)}
            {offlineProjectGroups.length ? (
              <section className="projectOfflineSection">
                <button
                  type="button"
                  className="projectOfflineHeader"
                  onClick={() => setOfflineProjectsCollapsed((collapsed) => !collapsed)}
                  aria-expanded={!offlineProjectsCollapsed}
                >
                  <span className={`projectOfflineArrow ${offlineProjectsCollapsed ? "collapsed" : ""}`}>{">"}</span>
                  <span>Offline</span>
                  <strong>{offlineProjectGroups.length}</strong>
                </button>
                {!offlineProjectsCollapsed ? (
                  <div className="projectOfflineMachines">
                    {offlineProjectGroups.map(renderProjectMachineGroup)}
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        )}
        {projectOpenError ? <div className="projectOpenError">{projectOpenError}</div> : null}
      </section>

      <section className="taskPanel">
        <div className="taskPanelHeader">
          <div className="taskPanelTitle">
            <h2>Tasks</h2>
            <span title={taskPanelContextTitle}>{taskPanelContextLabel}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              if (selectedProject) focusTaskDraftProject(selectedProject);
              setTaskFormOpen((open) => !open);
            }}
          >
            {taskFormOpen ? "Close" : "New"}
          </button>
        </div>
        {visibleTasks.length === 0 ? (
          <div className="taskEmpty">{selectedProject ? "No tasks for this project" : "No tasks"}</div>
        ) : (
          <div className="taskList">
            {visibleTasks.map((task) => {
              const busy = taskBusyId === task.taskId;
              const taskRunError = task.lastError ? `Last run failed: ${task.lastError}` : "";
              return (
                <div className={`taskRow ${task.enabled ? "enabled" : "paused"}`} key={task.taskId}>
                  <div className="taskRowHeader">
                    <span title={task.name}>{task.name}</span>
                    <strong className={`taskStatus ${taskStatusClass(task)}`}>
                      {taskStatusLabel(task)}
                    </strong>
                  </div>
                  <code title={task.schedule}>{task.schedule}</code>
                  <em title={taskTargetTitle(task, projectList, machines)}>{taskTargetLabel(task, projectList, machines)}</em>
                  {taskRunError ? <small className="taskLastError" title={taskRunError}>{taskRunError}</small> : null}
                  <div className="taskActions">
                    <button
                      type="button"
                      className="taskRunButton"
                      onClick={() => void runTaskNow(task)}
                      disabled={busy}
                    >
                      {busy ? "..." : "Run"}
                    </button>
                    <Switch
                      size="small"
                      checked={task.enabled}
                      onChange={(checked) => void patchTask(task.taskId, { enabled: checked })}
                      disabled={busy}
                      aria-label={task.enabled ? "Disable task" : "Enable task"}
                    />
                    <button
                      type="button"
                      className="taskDeleteButton"
                      onClick={() => void deleteTask(task.taskId)}
                      disabled={busy}
                      aria-label={`Delete ${task.name}`}
                    >
                      x
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {taskFormOpen ? (
          <form className="taskForm" onSubmit={createTask}>
            <label className="taskField">
              <span>Name</span>
              <input
                value={taskDraft.name}
                onChange={(event) => setTaskDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="daily-summary"
              />
            </label>
            <label className="taskField">
              <span>Machine</span>
              <select
                value={taskDraft.machineId}
                onChange={(event) => updateTaskDraftMachine(event.target.value)}
                disabled={taskFormProjectLocked || !taskMachineOptions.length}
              >
                <option value="">Machine</option>
                {taskMachineOptions.map((machine) => (
                  <option value={machine.machineId} key={machine.machineId}>
                    {machine.name ?? machine.hostname}
                  </option>
                ))}
              </select>
            </label>
            <label className="taskField">
              <span>Project</span>
              <select
                value={taskDraft.projectPath}
                onChange={(event) => updateTaskDraftProject(event.target.value)}
                disabled={taskFormProjectLocked || !taskProjectOptions.length}
              >
                <option value="">Project</option>
                {taskProjectOptions.map((project) => (
                  <option value={project.path} key={`${project.machineId}:${project.path}`}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="taskField">
              <span>Thread</span>
              <select
                value={taskDraft.threadId}
                onChange={(event) => setTaskDraft((current) => ({ ...current, threadId: event.target.value }))}
                disabled={!selectedTaskProject}
              >
                <option value="">Current thread</option>
                {taskThreadOptions.map((thread) => (
                  <option value={thread.threadId} key={thread.threadId}>
                    {threadDisplayTitle(thread)}
                  </option>
                ))}
              </select>
            </label>
            <label className="taskField">
              <span>Schedule</span>
              <input
                value={taskDraft.schedule}
                onChange={(event) => setTaskDraft((current) => ({ ...current, schedule: event.target.value }))}
                placeholder="0 9 * * *"
                spellCheck={false}
              />
            </label>
            <label className="taskField">
              <span>Prompt</span>
              <textarea
                value={taskDraft.input}
                onChange={(event) => setTaskDraft((current) => ({ ...current, input: event.target.value }))}
                rows={3}
                placeholder="检查这个项目最近的变更，给我总结风险和下一步。"
              />
            </label>
            <div className="taskFormActions">
              <label className="taskEnabledControl">
                <Switch
                  size="small"
                  checked={taskDraft.enabled}
                  onChange={(checked) => setTaskDraft((current) => ({ ...current, enabled: checked }))}
                  aria-label={taskDraft.enabled ? "Disable new task" : "Enable new task"}
                />
                <span>Enabled</span>
              </label>
              <button type="submit" disabled={!canCreateTask || taskBusyId === "create"}>
                {taskBusyId === "create" ? "Saving" : "Save"}
              </button>
            </div>
          </form>
        ) : null}
        {taskError ? <div className="projectOpenError">{taskError}</div> : null}
      </section>
    </aside>
  );
};
