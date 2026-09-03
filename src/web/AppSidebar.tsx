import React from "react";
import {
  ChevronRight,
  Copy,
  FolderGit2,
  GitBranch,
  ListTodo,
  MessagesSquare,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  PanelsTopLeft,
  X
} from "lucide-react";
import type { ProjectMachineGroup } from "./types.js";
import type { AppSidebarViewModel } from "./viewModel.js";
import {
  fixedProject,
  filterProjectMachineGroupsBySearch,
  machineProjectCatalogEditable,
  machineProjectLauncher,
  projectKeyForProject,
  projectMachineBadgeToneClass,
  shortId,
  threadDisplayTitle,
  uniqueMachines
} from "./appHelpers.js";
import { writeTextToClipboard } from "./helpers/composer.js";
import { sidebarOpenThreadItems } from "./helpers/sidebarOpenThreads.js";

type AppSidebarProps = {
  viewModel: AppSidebarViewModel;
};

export const AppSidebar = ({ viewModel }: AppSidebarProps) => {
  const {
    activeTabThreadId,
    activeProjectKey,
    collapsedProjectMachineKeys,
    deleteProject,
    deletingProjectId,
    machines,
    offlineProjectsCollapsed,
    openingProjectKey,
    openThreads,
    showProjectPicker,
    projectGroups,
    projectScopeLocked,
    projectActionError,
    selectProject,
    sidebarDraftStore,
    setOfflineProjectsCollapsed,
    setSettingsDialogOpen,
    setTasksDialogOpen,
    switchMachineThread,
    systemStatus,
    toggleProjectMachineGroup,
    toggleProjectPinned
  } = viewModel;
  const [catalogMode, setCatalogMode] = React.useState<"projects" | "threads">("projects");
  const [threadSearch, setThreadSearch] = React.useState("");
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
  const threadQuery = threadSearch.trim().toLocaleLowerCase();
  const authorityUpdateAvailable = Boolean(systemStatus.authorityUpdate?.restartable);
  const visibleProjectGroups = filterProjectMachineGroupsBySearch(projectGroups, projectQuery);
  const onlineProjectGroups = visibleProjectGroups.filter((machine) => machine.online);
  const offlineProjectGroups = visibleProjectGroups.filter((machine) => !machine.online);
  const visibleOpenThreads = sidebarOpenThreadItems(openThreads, machines).filter((item) => {
    if (!threadQuery) return true;
    return [
      threadDisplayTitle(item.thread),
      item.thread.workingDirectory,
      item.thread.threadId,
      item.machineLabel,
      item.machineType ?? ""
    ]
      .some((value) => value.toLocaleLowerCase().includes(threadQuery));
  });
  const projectAddMachine = projectScopeLocked
    ? undefined
    : uniqueMachines(machines)
      .filter((machine) =>
        machine.online
        && machineProjectLauncher(machine)
        && (!projectScopeLocked || machineProjectCatalogEditable(machine))
      )
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
            <ChevronRight size={13} strokeWidth={2.3} />
          </span>
          <span className={`projectMachineStatusDot ${machine.online ? "online" : "offline"}`} aria-hidden="true" />
          <span className="projectMachineName" title={machine.label}>{machine.label}</span>
          <strong className={`projectMachineBadge ${projectMachineBadgeToneClass(machine)}`}>{machine.badgeLabel}</strong>
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
                      {worktreeRelation ? (
                        <em className="projectWorktreeBadge" title={worktreeRelation.branch}>
                          <GitBranch size={10} strokeWidth={2.2} aria-hidden="true" />
                          <span>{worktreeRelation.branch}</span>
                        </em>
                      ) : null}
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
        <div className="brandInfo">
          <div className="brandLogo" aria-hidden="true">
            <FolderGit2 size={16} strokeWidth={2.2} />
          </div>
          <div className="brandTitleWrap">
            <h1>Codex Hub</h1>
            <span className="brandSubtitle">Control Plane</span>
          </div>
        </div>
      </div>

      <section className="projectPanel">
        <div className="projectPanelHeader">
          <h2>{catalogMode === "projects" ? "Projects" : "Open threads"}</h2>
          <div className="sidebarCatalogHeaderActions">
            <span className="projectGroupCountBadge">
              {catalogMode === "projects"
                ? `${projectGroups.length} ${projectGroups.length === 1 ? "group" : "groups"}`
                : `${openThreads.length} open`}
            </span>
            <button
              type="button"
              className="sidebarCatalogToggle"
              onClick={() => setCatalogMode((mode) => mode === "projects" ? "threads" : "projects")}
              aria-label={catalogMode === "projects" ? "Show open threads" : "Show projects"}
              title={catalogMode === "projects" ? "Show open threads" : "Show projects"}
            >
              {catalogMode === "projects"
                ? <MessagesSquare size={15} strokeWidth={2.2} aria-hidden="true" />
                : <PanelsTopLeft size={15} strokeWidth={2.2} aria-hidden="true" />}
            </button>
          </div>
        </div>
        {catalogMode === "projects" && !projectScopeLocked ? (
          <button
            type="button"
            className="projectAddButton"
            onClick={() => projectAddMachine ? showProjectPicker(projectAddMachine) : undefined}
            disabled={!projectAddMachine}
            title={projectAddMachine ? "Add a project" : "No online machines"}
          >
            <Plus size={14} strokeWidth={2.4} aria-hidden="true" />
            <span>Add Project</span>
          </button>
        ) : null}
        <div className="projectSearchWrapper">
          <Search size={13} strokeWidth={2.2} className="projectSearchIcon" aria-hidden="true" />
          <input
            className="projectSearchInput"
            value={catalogMode === "projects" ? projectSearch : threadSearch}
            onChange={(event) => catalogMode === "projects"
              ? setProjectSearch(event.target.value)
              : setThreadSearch(event.target.value)}
            placeholder={catalogMode === "projects" ? "Search projects" : "Search open threads"}
            spellCheck={false}
          />
          {(catalogMode === "projects" ? projectQuery : threadQuery) ? (
            <button
              type="button"
              className="projectSearchClear"
              onClick={() => catalogMode === "projects" ? setProjectSearch("") : setThreadSearch("")}
              aria-label="Clear search"
              title="Clear search"
            >
              <X size={12} strokeWidth={2.4} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {catalogMode === "projects" ? (visibleProjectGroups.length === 0 ? (
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
                    <ChevronRight size={13} strokeWidth={2.3} />
                  </span>
                  <span className="projectOfflineStatusDot" aria-hidden="true" />
                  <span className="projectOfflineTitle">Offline</span>
                  <strong className="projectOfflineCountBadge">{offlineProjectGroups.length}</strong>
                </button>
                {!offlineProjectsCollapsed ? (
                  <div className="projectOfflineMachines">
                    {offlineProjectGroups.map(renderProjectMachineGroup)}
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        )) : (visibleOpenThreads.length === 0 ? (
          <div className="projectEmptyRow">{threadQuery ? "No matching open threads" : "No open threads"}</div>
        ) : (
          <div className="projectList openThreadSidebarList">
            {visibleOpenThreads.map(({ thread, machineLabel, machineType }) => {
              const active = thread.threadId === activeTabThreadId;
              const title = threadDisplayTitle(thread);
              return (
                <button
                  type="button"
                  key={thread.threadId}
                  className={`openThreadSidebarRow${active ? " active" : ""}`}
                  onClick={() => void switchMachineThread(thread.threadId)}
                  aria-label={`Open thread ${title}`}
                  aria-current={active ? "true" : undefined}
                  title={`${title}\n${thread.workingDirectory}\n${thread.threadId}`}
                >
                  <span className="openThreadSidebarTitleRow">
                    <MessagesSquare size={13} strokeWidth={2.1} aria-hidden="true" />
                    <strong>{title}</strong>
                    <code>{shortId(thread.threadId)}</code>
                  </span>
                  <code className="openThreadSidebarPath">{thread.workingDirectory}</code>
                  <span className="openThreadSidebarMachine">
                    <span title={machineLabel}>{machineLabel}</span>
                    <strong className={machineType ?? "unknown"}>{machineType ?? "machine"}</strong>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        {catalogMode === "projects" && projectActionError ? <div className="projectActionError">{projectActionError}</div> : null}
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
            <ListTodo size={15} strokeWidth={2.2} aria-hidden="true" />
            <span>Tasks</span>
          </button>
        ) : null}
        <button
          type="button"
          className={`sidebarSettingsButton${authorityUpdateAvailable ? " has-update" : ""}`}
          onClick={() => setSettingsDialogOpen(true)}
          title={authorityUpdateAvailable ? "Open settings — update available" : "Open settings"}
          aria-label={authorityUpdateAvailable ? "Open settings, update available" : "Open settings"}
        >
          <Settings size={15} strokeWidth={2.2} aria-hidden="true" />
          <span>Settings</span>
          {authorityUpdateAvailable ? <span className="sidebarSettingsUpdateDot" aria-hidden="true" /> : null}
        </button>
      </div>
    </aside>
  );
};
