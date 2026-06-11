import React from "react";
import { Switch } from "antd";
import { History, Pin, PinOff, Play, Trash2 } from "lucide-react";
import type { ProjectMachineGroup, ServerConnection } from "./types.js";
import type { AppSidebarViewModel } from "./viewModel.js";
import {
  activeSshConnectionForHost,
  latestSshConnectionForHost,
  machineProjectLauncher,
  pluginIntegrationStatusLabel,
  pluginStatusClass,
  projectKeyForProject,
  projectSearchMatches,
  projectStatusLabel,
  sshConnectionDoctorLines,
  sshConnectionDetail,
  sshConnectionStatusClass,
  sshConnectionStatusLabel,
  sshConnectionTitle,
  sshHostMeta,
  taskBelongsToProject,
  taskRunDetailTitle,
  taskRunLine,
  taskRunSummary,
  taskRunTitle,
  taskScheduleLine,
  taskStatusClass,
  taskStatusLabel,
  taskTargetLabel,
  taskTargetTitle,
  taskThreadOptionsFor,
  threadDisplayTitle,
  uniqueMachines
} from "./appHelpers.js";

type AppSidebarProps = {
  viewModel: AppSidebarViewModel;
};

const taskSchedulePresets = [
  { label: "Hourly", value: "0 * * * *" },
  { label: "Daily", value: "0 9 * * *" },
  { label: "Weekdays", value: "0 9 * * 1-5" }
] as const;

export const AppSidebar = ({ viewModel }: AppSidebarProps) => {
  const {
    activeProjectKey,
    addServerConnection,
    addSshHost,
    collapsedProjectMachineKeys,
    connectionMode,
    connectServerConnection,
    connectSshHost,
    copyRegisteredCommand,
    createTask,
    currentServerShareUrl,
    deleteProject,
    deleteTask,
    deletingProjectId,
    disconnectServerConnection,
    focusTaskDraftProject,
    localMachines,
    machines,
    offlineProjectsCollapsed,
    onlineMachines,
    openingProjectKey,
    openProjectPicker,
    patchTask,
    plugins,
    projectGroups,
    projectList,
    projectSearch,
    projectOpenError,
    registeredCommand,
    registeredCommandIncludesToken,
    registeredCommandCopied,
    registeredMachines,
    removeServerConnection,
    removeSshHost,
    runTaskNow,
    selectedProject,
    selectProject,
    selectProjectSession,
    selectSessionThread,
    setConnectionMode,
    setOfflineProjectsCollapsed,
    setProjectSearch,
    setServerConnectionDraft,
    setSshHostDraft,
    setTaskDraft,
    setTaskFormOpen,
    serverConnectionBusyId,
    serverConnectionDraft,
    serverConnectionError,
    serverConnections,
    serverThreadGroups,
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
    toggleProjectPinned,
    toggleServerConnectionEnabled,
    updateTaskDraftMachine,
    updateTaskDraftProject
  } = viewModel;

  const projectQuery = projectSearch.trim();
  const visibleProjectGroups = projectGroups
    .map((machine) => ({
      ...machine,
      projects: machine.projects.filter((project) => projectSearchMatches(project, projectQuery))
    }))
    .filter((machine) => !projectQuery || machine.projects.length || machine.label.toLowerCase().includes(projectQuery.toLowerCase()));
  const onlineProjectGroups = visibleProjectGroups.filter((machine) => machine.online);
  const offlineProjectGroups = visibleProjectGroups.filter((machine) => !machine.online);
  const projectAddMachine = projectGroups.filter((machine) => machine.online).find((machine) => machine.projectLauncher);
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

  const renderProjectMachineGroup = (machine: ProjectMachineGroup) => {
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
              const busy = openingProjectKey === projectKey || deleting;
              const openDisabled = busy;
              return (
                <div
                  key={project.projectId}
                  className={`projectRow ${active ? "active" : ""} ${project.pinned ? "pinned" : ""} ${sessionActive ? "online" : projectReachable ? "ready" : "offline"}`}
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
                        className={`projectMiniButton ${project.pinned ? "active" : ""}`}
                        onClick={() => void toggleProjectPinned(project)}
                        disabled={busy}
                        aria-label={project.pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
                        title={project.pinned ? "Unpin project" : "Pin project"}
                      >
                        {project.pinned ? <PinOff size={13} strokeWidth={2.1} aria-hidden="true" /> : <Pin size={13} strokeWidth={2.1} aria-hidden="true" />}
                      </button>
                      <button
                        type="button"
                        className="projectDeleteButton"
                        onClick={() => void deleteProject(project)}
                        disabled={deleting}
                        aria-label={`Remove ${project.name}`}
                        title={`Remove ${project.name} from CodexHub`}
                      >
                        <Trash2 size={13} strokeWidth={2.1} aria-hidden="true" />
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
            className={connectionMode === "servers" ? "active" : ""}
            onClick={() => setConnectionMode("servers")}
          >
            Servers
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
                  <details className="connectionDoctor">
                    <summary>Doctor</summary>
                    <pre>{sshConnectionDoctorLines(host, latestConnection)}</pre>
                  </details>
                </div>
              );
            })}
            {sshError ? <div className="projectOpenError">{sshError}</div> : null}
          </div>
        ) : connectionMode === "servers" ? (
          <div className="connectionList">
            <form className="serverConnectionForm" onSubmit={(event) => void addServerConnection(event)}>
              <input
                value={serverConnectionDraft.name}
                onChange={(event) => setServerConnectionDraft((draft) => ({ ...draft, name: event.target.value }))}
                placeholder="Name (optional)"
                spellCheck={false}
              />
              <input
                value={serverConnectionDraft.url}
                onChange={(event) => setServerConnectionDraft((draft) => ({ ...draft, url: event.target.value }))}
                placeholder="https://hub.example.com?token=..."
                spellCheck={false}
              />
              <button type="submit" disabled={!serverConnectionDraft.url.trim() || serverConnectionBusyId === "new"}>
                {serverConnectionBusyId === "new" ? "..." : "Add"}
              </button>
            </form>
            {serverConnections.length === 0 && serverThreadGroups.length === 0 ? (
              <div className="connectionEmpty">No server connections</div>
            ) : serverConnections.map((connection) => {
              const busy = serverConnectionBusyId === connection.connectionId;
              const detail = serverConnectionDetail(connection);
              return (
                <div className={`connectionRow server ${connection.status}`} key={connection.connectionId} title={detail}>
                  <button
                    type="button"
                    className="connectionHostButton"
                    onClick={() => void (connection.online
                      ? disconnectServerConnection(connection.connectionId)
                      : connectServerConnection(connection.connectionId))}
                    disabled={busy || connection.status === "connecting"}
                  >
                    <span>{connection.name}</span>
                    <code title={connection.url}>{connection.url}</code>
                  </button>
                  <strong>{serverConnectionStatusLabel(connection.status)}</strong>
                  <button
                    type="button"
                    className="connectionSmallButton"
                    onClick={() => void toggleServerConnectionEnabled(connection)}
                    disabled={busy}
                    title={connection.enabled ? "Disable startup auto connect" : "Enable startup auto connect"}
                  >
                    {connection.enabled ? "Auto" : "Manual"}
                  </button>
                  <button
                    type="button"
                    className="connectionDeleteButton"
                    onClick={() => void removeServerConnection(connection)}
                    disabled={busy}
                    aria-label={`Remove ${connection.name}`}
                    title={`Remove ${connection.name}`}
                  >
                    x
                  </button>
                  {connection.lastError ? <code className="connectionErrorLine">{connection.lastError}</code> : null}
                </div>
              );
            })}
            {serverThreadGroups.map((group) => {
              const machine = group.machine;
              const machineLabel = machine.name ?? machine.hostname;
              return (
                <React.Fragment key={machine.machineId}>
                  <div className={`connectionRow ${machine.online ? "online" : "offline"}`} title={`${machineLabel}\n${machine.machineId}`}>
                    <span>{machineLabel}</span>
                    <strong>{machine.online ? "online" : "offline"}</strong>
                    <code title={machine.machineId}>{`${group.sessions.length} sessions · ${group.threads.length} threads · ${machine.machineId}`}</code>
                  </div>
                  {group.sessions.length ? (
                    <div className="serverThreadList" aria-label={`${machineLabel} sessions`}>
                      {group.sessions.map((session) => {
                        const sessionThreads = [...(session.threads ?? [])].sort((left, right) =>
                          Number(right.running) - Number(left.running) || right.updatedAt.localeCompare(left.updatedAt)
                        );
                        const targetThread = sessionThreads[0];
                        const sessionLabel = session.name ?? session.sessionId;
                        return (
                          <React.Fragment key={session.sessionId}>
                            <button
                              type="button"
                              className={`serverSessionRow ${session.online ? "online" : "offline"}`}
                              onClick={() => void (targetThread
                                ? selectSessionThread(session, targetThread.threadId)
                                : selectProjectSession(session))}
                              disabled={!session.online}
                              title={`${sessionLabel}\n${session.workingDirectory}\n${session.sessionId}`}
                            >
                              <History size={13} strokeWidth={2.1} aria-hidden="true" />
                              <span className="serverThreadMain">
                                <span className="serverThreadTitle">{sessionLabel}</span>
                                <code>{session.workingDirectory}</code>
                              </span>
                              <strong>{session.online ? `${sessionThreads.length} threads` : "offline"}</strong>
                            </button>
                            {sessionThreads.length ? sessionThreads.map((thread) => {
                              const title = threadDisplayTitle(thread);
                              const runnable = session.online && thread.session.runnable !== false;
                              return (
                                <button
                                  type="button"
                                  className={`serverThreadRow ${thread.running ? "running" : ""}`}
                                  key={`${session.sessionId}:${thread.threadId}`}
                                  onClick={() => void selectSessionThread(session, thread.threadId)}
                                  disabled={!runnable}
                                  title={`${title}\n${thread.workingDirectory}\n${thread.threadId}`}
                                >
                                  <History size={13} strokeWidth={2.1} aria-hidden="true" />
                                  <span className="serverThreadMain">
                                    <span className="serverThreadTitle">{title}</span>
                                    <code>{thread.threadId}</code>
                                  </span>
                                  <strong>{thread.running ? "running" : runnable ? "ready" : "offline"}</strong>
                                </button>
                              );
                            }) : (
                              <div className="serverThreadEmpty">No threads</div>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </div>
                  ) : machine.online ? (
                    <div className="serverThreadEmpty">No remote sessions</div>
                  ) : null}
                </React.Fragment>
              );
            })}
            {serverConnectionError ? <div className="projectOpenError">{serverConnectionError}</div> : null}
          </div>
        ) : (
          <div className="connectionList">
            <div className="registeredCommand">
              <div className="registeredCommandText">
                <code title={registeredCommand}>{registeredCommand}</code>
                {registeredCommandIncludesToken ? <span>auth token included</span> : null}
              </div>
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
        <input
          className="projectSearchInput"
          value={projectSearch}
          onChange={(event) => setProjectSearch(event.target.value)}
          placeholder="Search projects"
          spellCheck={false}
        />
        {visibleProjectGroups.length === 0 ? (
          <div className="projectEmptyRow">{projectQuery ? "No matching projects" : "No machines"}</div>
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

      <section className="pluginPanel">
        <div className="pluginPanelHeader">
          <h2>Plugins</h2>
          <span>{plugins.length}</span>
        </div>
        {plugins.length === 0 ? (
          <div className="pluginEmpty">No plugins</div>
        ) : (
          <div className="pluginList">
            {plugins.map((plugin) => {
              const integrations = plugin.contributions?.integrations ?? [];
              const styles = plugin.contributions?.web?.styles ?? [];
              return (
                <div className={`pluginRow ${pluginStatusClass(plugin)}`} key={plugin.pluginId}>
                  <div className="pluginRowHeader">
                    <span title={plugin.name}>{plugin.name}</span>
                    <strong>{pluginIntegrationStatusLabel(plugin)}</strong>
                  </div>
                  <code title={plugin.root}>{plugin.origin ?? "local"} · {plugin.pluginId}</code>
                  <small>{styles.length} styles · {integrations.length} integrations</small>
                </div>
              );
            })}
          </div>
        )}
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
              const recentRuns = (task.runs ?? []).slice(0, 5);
              return (
                <div className={`taskRow ${task.enabled ? "enabled" : "paused"}`} key={task.taskId}>
                  <div className="taskRowHeader">
                    <span title={task.name}>{task.name}</span>
                    <strong className={`taskStatus ${taskStatusClass(task)}`}>
                      {taskStatusLabel(task)}
                    </strong>
                  </div>
                  <code title={taskTargetTitle(task, projectList, machines)}>{taskScheduleLine(task)}</code>
                  <em title={taskTargetTitle(task, projectList, machines)}>{taskTargetLabel(task, projectList, machines)}</em>
                  <small className="taskRunSummary" title={taskRunTitle(task)}>{taskRunSummary(task)}</small>
                  {taskRunError ? <small className="taskLastError" title={taskRunError}>{taskRunError}</small> : null}
                  {recentRuns.length ? (
                    <details className="taskRunHistory">
                      <summary>
                        <History size={12} strokeWidth={2.1} aria-hidden="true" />
                        <span>Recent runs</span>
                        <strong>{recentRuns.length}</strong>
                      </summary>
                      <ol>
                        {recentRuns.map((run) => (
                          <li className={`taskRunItem ${run.status}`} key={run.runId} title={taskRunDetailTitle(run)}>
                            <span>{taskRunLine(run)}</span>
                            {run.error ? <em>{run.error}</em> : null}
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                  <div className="taskActions">
                    <button
                      type="button"
                      className="taskRunButton"
                      onClick={() => void runTaskNow(task)}
                      disabled={busy}
                      aria-label={`Run ${task.name}`}
                      title="Run now"
                    >
                      {busy ? "..." : <Play size={13} strokeWidth={2.2} aria-hidden="true" />}
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
                      title={`Delete ${task.name}`}
                    >
                      <Trash2 size={13} strokeWidth={2.1} aria-hidden="true" />
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
              <div className="taskSchedulePresets" aria-label="Schedule presets">
                {taskSchedulePresets.map((preset) => (
                  <button
                    type="button"
                    className={taskDraft.schedule === preset.value ? "active" : ""}
                    onClick={() => setTaskDraft((current) => ({ ...current, schedule: preset.value }))}
                    key={preset.value}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
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
      {currentServerShareUrl ? (
        <section className="serverSharePanel" aria-label="Current server URL">
          <span>Current server URL</span>
          <code title={currentServerShareUrl}>{currentServerShareUrl}</code>
        </section>
      ) : null}
    </aside>
  );
};

const serverConnectionStatusLabel = (status: ServerConnection["status"]) =>
  status === "online" ? "online" : status === "connecting" ? "connecting" : status === "failed" ? "failed" : "offline";

const serverConnectionDetail = (connection: ServerConnection) => [
  connection.url,
  connection.enabled ? "auto connect enabled" : "manual connect",
  connection.hasAuthToken ? "auth token saved" : "no auth token",
  connection.connectedAt ? `connected ${connection.connectedAt}` : null,
  connection.lastConnectedAt ? `last connected ${connection.lastConnectedAt}` : null,
  connection.lastError ? `last error ${connection.lastError}` : null
].filter(Boolean).join("\n");
