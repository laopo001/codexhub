import React from "react";
import { ChevronRight, Copy, ListTodo, Pin, PinOff, Settings, Trash2 } from "lucide-react";
import type { ProjectMachineGroup } from "./types.js";
import type { AppSidebarViewModel } from "./viewModel.js";
import {
  fixedProject,
  filterProjectMachineGroupsBySearch,
  machineProjectCatalogEditable,
  machineProjectLauncher,
  projectKeyForProject,
  uniqueMachines
} from "./appHelpers.js";
import { writeTextToClipboard } from "./helpers/composer.js";

type AppSidebarProps = {
  viewModel: AppSidebarViewModel;
};

export const AppSidebar = ({ viewModel }: AppSidebarProps) => {
  const {
    activeProjectKey,
    collapsedProjectMachineKeys,
    deleteProject,
    deletingProjectId,
    machines,
    offlineProjectsCollapsed,
    openingProjectKey,
    showProjectPicker,
    projectGroups,
    projectScopeLocked,
    projectActionError,
    selectProject,
    sidebarDraftStore,
    setOfflineProjectsCollapsed,
    setSettingsDialogOpen,
    setTasksDialogOpen,
    toggleProjectMachineGroup,
    toggleProjectPinned
  } = viewModel;
  const {
    projectSearch
  } = React.useSyncExternalStore(
    sidebarDraftStore.subscribe,
    sidebarDraftStore.getSnapshot,
    sidebarDraftStore.getSnapshot
  );
  const setProjectSearch = React.useCallback(
    (value: string) => sidebarDraftStore.set("projectSearch", value),
    [sidebarDraftStore]
  );

  const projectQuery = projectSearch.trim();
  const visibleProjectGroups = filterProjectMachineGroupsBySearch(projectGroups, projectQuery);
  const onlineProjectGroups = visibleProjectGroups.filter((machine) => machine.online);
  const offlineProjectGroups = visibleProjectGroups.filter((machine) => !machine.online);
  const projectAddMachine = projectScopeLocked
    ? undefined
    : uniqueMachines(machines)
      .filter((machine) => machine.online && machineProjectLauncher(machine) && machineProjectCatalogEditable(machine))
      .map((machine): ProjectMachineGroup => ({
        key: machine.machineId,
        kind: "machine",
        machineId: machine.machineId,
        machineType: machine.type ?? "registered",
        label: machine.name ?? machine.hostname,
        online: machine.online,
        projectLauncher: machineProjectLauncher(machine),
        badgeLabel: machine.type ?? "registered",
        projects: []
      }))[0];
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
          <span className={`projectOfflineArrow ${collapsed ? "collapsed" : ""}`} aria-hidden="true">
            <ChevronRight size={14} strokeWidth={2.25} />
          </span>
          <span title={machine.label}>{machine.label}</span>
          <strong>{machine.badgeLabel}</strong>
        </button>
        {!collapsed ? (
          <div className="projectMachineRows">
            {machine.projects.length === 0 ? (
              <div className="projectEmptyRow">No projects</div>
            ) : machine.projects.map((project) => {
              const projectKey = projectKeyForProject(project);
              const active = projectKey === activeProjectKey;
              const deleting = deletingProjectId === project.projectId;
              const busy = openingProjectKey === projectKey || deleting;
              const openDisabled = busy;
              const fixed = fixedProject(project);
              const worktreeRelation = project.relation?.type === "worktree" ? project.relation : null;
              const saveTitle = project.transient ? "Save project to CodexHub" : project.pinned ? "Unpin project" : "Pin project";
              const saveAria = project.transient
                ? `Save ${project.name} to CodexHub`
                : project.pinned ? `Unpin ${project.name}` : `Pin ${project.name}`;
              const removeTitle = `Remove ${project.name} from CodexHub`;
              return (
                <div
                  key={project.projectId}
                  className={`projectRow ${active ? "active" : ""} ${project.pinned ? "pinned" : ""} ${fixed ? "transient" : ""} ${worktreeRelation ? "worktreeProject" : ""}`}
                >
                  <button
                    type="button"
                    className="projectRowSelectButton"
                    onClick={() => void selectProject(project)}
                    disabled={openDisabled}
                    aria-label={`Select ${project.name}`}
                    aria-current={active ? "true" : undefined}
                    title={`Select ${project.name}`}
                  />
                  <div className="projectRowTop">
                    <span className="projectSelectText projectSelectName" title={project.name}>
                      <span className="projectSelectNameText">{project.name}</span>
                      {worktreeRelation ? <em className="projectWorktreeBadge" title={worktreeRelation.branch}>{worktreeRelation.branch}</em> : null}
                    </span>
                    <div className="projectRowActions">
                      <button
                        type="button"
                        className="projectMiniButton"
                        onClick={() => void writeTextToClipboard(project.path).catch(() => undefined)}
                        aria-label={`Copy ${project.name} path`}
                        title={`Copy ${project.name} path`}
                      >
                        <Copy size={13} strokeWidth={2.1} aria-hidden="true" />
                      </button>
                      {!projectScopeLocked && !fixed ? (
                        <>
                          <button
                            type="button"
                            className={`projectMiniButton ${project.pinned ? "active" : ""}`}
                            onClick={() => void toggleProjectPinned(project)}
                            disabled={busy}
                            aria-label={saveAria}
                            title={saveTitle}
                          >
                            {project.pinned ? <PinOff size={13} strokeWidth={2.1} aria-hidden="true" /> : <Pin size={13} strokeWidth={2.1} aria-hidden="true" />}
                          </button>
                          <button
                            type="button"
                            className="projectDeleteButton"
                            onClick={() => void deleteProject(project)}
                            disabled={deleting}
                            aria-label={`Remove ${project.name}`}
                            title={removeTitle}
                          >
                            <Trash2 size={13} strokeWidth={2.1} aria-hidden="true" />
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <code className="projectSelectText projectSelectPath" title={project.path}>{project.path}</code>
                </div>
              );
            })}
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <aside id="codexhub-sidebar" className="sidebar">
      <div className="brand">
        <div>
          <h1>Codex Hub</h1>
        </div>
      </div>

      <section className="projectPanel">
        <div className="projectPanelHeader">
          <h2>Projects</h2>
          <span>{projectGroups.length} groups</span>
        </div>
        {!projectScopeLocked ? (
          <button
            type="button"
            className="projectAddButton"
            onClick={() => projectAddMachine ? showProjectPicker(projectAddMachine) : undefined}
            disabled={!projectAddMachine}
            title={projectAddMachine ? "Add a project" : "No online machines"}
          >
            Add Project
          </button>
        ) : null}
        <input
          className="projectSearchInput"
          value={projectSearch}
          onChange={(event) => setProjectSearch(event.target.value)}
          placeholder="Search projects"
          spellCheck={false}
        />
        {visibleProjectGroups.length === 0 ? (
          <div className="projectEmptyRow">{projectQuery ? "No matching projects" : "No project groups"}</div>
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
                  <span className={`projectOfflineArrow ${offlineProjectsCollapsed ? "collapsed" : ""}`} aria-hidden="true">
                    <ChevronRight size={14} strokeWidth={2.25} />
                  </span>
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
        {projectActionError ? <div className="projectActionError">{projectActionError}</div> : null}
      </section>
      <div className="sidebarFooter">
        {!projectScopeLocked ? (
          <button
            type="button"
            className="sidebarSettingsButton"
            onClick={() => setTasksDialogOpen(true)}
            title="Open tasks"
            aria-label="Open tasks"
          >
            <ListTodo size={16} strokeWidth={2.1} aria-hidden="true" />
            <span>Tasks</span>
          </button>
        ) : null}
        <button
          type="button"
          className="sidebarSettingsButton"
          onClick={() => setSettingsDialogOpen(true)}
          title="Open settings"
          aria-label="Open settings"
        >
          <Settings size={16} strokeWidth={2.1} aria-hidden="true" />
          <span>Settings</span>
        </button>
      </div>
    </aside>
  );
};
