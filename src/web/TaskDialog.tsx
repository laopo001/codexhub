import React from "react";
import { Alert, Button, Empty, Form, Input, Modal, Select, Space, Switch } from "antd";
import { History, MessageSquare, Pencil, Play, Trash2 } from "lucide-react";
import {
  defaultTaskDraft,
  findProjectByMachinePath,
  machineProjectLauncher,
  shortId,
  taskBelongsToProject,
  taskDraftFromTask,
  taskDraftSchedulePreview,
  taskPromptPreview,
  taskRunDetailTitle,
  taskRunLine,
  taskRunSummary,
  taskRunTitle,
  taskScheduleLine,
  taskSearchMatches,
  taskStatusClass,
  taskStatusLabel,
  taskTargetLabel,
  taskTargetTitle,
  taskThreadOptionsFor,
  taskThreadSearchMatches,
  threadDisplayTitle,
  uniqueMachines
} from "./appHelpers.js";
import type { TaskDraft } from "./types.js";
import type { AppTaskDialogViewModel } from "./viewModel.js";

type TaskDialogProps = {
  viewModel: AppTaskDialogViewModel;
};

const taskSchedulePresets = [
  { label: "Hourly", value: "0 * * * *" },
  { label: "Daily", value: "0 9 * * *" },
  { label: "Weekdays", value: "0 9 * * 1-5" }
] as const;

export const TaskDialog = ({ viewModel }: TaskDialogProps) => {
  const {
    createTask,
    deleteTask,
    focusTaskDraftProject,
    machines,
    patchTask,
    projectList,
    projectScopeLocked,
    runTaskNow,
    openTaskRunThread,
    runtimeList,
    selectedProject,
    sidebarDraftStore,
    setTaskFormOpen,
    setTasksDialogOpen,
    taskBusyId,
    taskError,
    taskFormOpen,
    tasks,
    tasksDialogOpen,
    updateTaskDraftMachine,
    updateTaskDraftProject
  } = viewModel;
  const { taskDraft } = React.useSyncExternalStore(
    sidebarDraftStore.subscribe,
    sidebarDraftStore.getSnapshot,
    sidebarDraftStore.getSnapshot
  );
  const setTaskDraft = React.useCallback(
    (update: React.SetStateAction<TaskDraft>) => sidebarDraftStore.set("taskDraft", update),
    [sidebarDraftStore]
  );
  const [taskThreadQuery, setTaskThreadQuery] = React.useState("");
  const [taskSearch, setTaskSearch] = React.useState("");
  const [editingTaskId, setEditingTaskId] = React.useState("");

  const visibleProjectTaskTargets = new Set(projectList.map((project) => `${project.machineId}\0${project.path}`));
  const scopedTasks = selectedProject
    ? tasks.filter((task) => taskBelongsToProject(task, selectedProject))
    : projectScopeLocked
      ? tasks.filter((task) => visibleProjectTaskTargets.has(`${task.machineId}\0${task.projectPath}`))
      : tasks;
  const taskQuery = taskSearch.trim();
  const visibleTasks = scopedTasks.filter((task) => taskSearchMatches(task, taskQuery, projectList, machines));
  const taskPanelContextLabel = selectedProject?.name ?? (projectScopeLocked ? "Workspace" : "All projects");
  const taskPanelContextTitle = selectedProject
    ? `${selectedProject.name}\n${selectedProject.path}`
    : projectScopeLocked
      ? "VSCode workspace projects"
      : "All projects";
  const taskFormProjectLocked = Boolean(selectedProject);
  const taskMachineOptions = taskFormOpen
    ? uniqueMachines(machines)
      .filter(machineProjectLauncher)
      .filter((machine) => !projectScopeLocked || visibleProjectTaskTargets.size === 0 || projectList.some((project) => project.machineId === machine.machineId))
    : [];
  const taskProjectOptions = taskFormOpen
    ? projectList.filter((project) => !taskDraft.machineId || project.machineId === taskDraft.machineId)
    : [];
  const selectedTaskProject = taskFormOpen
    ? findProjectByMachinePath(taskProjectOptions, taskDraft.machineId, taskDraft.projectPath)
    : undefined;
  const taskThreadOptions = taskFormOpen ? taskThreadOptionsFor(selectedTaskProject, runtimeList) : [];
  const editingTask = editingTaskId ? tasks.find((task) => task.taskId === editingTaskId) : undefined;
  const taskSubmitBusy = editingTaskId ? taskBusyId === editingTaskId : taskBusyId === "create";
  const taskThreadEmptyLabel = editingTask?.threadId ? "Keep current thread" : "Current thread";
  const taskSubmitLabel = taskSubmitBusy ? "Saving" : editingTaskId ? "Update" : "Save";
  const taskThreadScopeKey = `${taskDraft.machineId}\0${taskDraft.projectPath}`;
  React.useEffect(() => {
    setTaskThreadQuery("");
  }, [taskThreadScopeKey, taskFormOpen]);
  const matchingTaskThreadOptions = taskFormOpen
    ? taskThreadOptions.filter((thread) => taskThreadSearchMatches(thread, taskThreadQuery))
    : [];
  const selectedTaskThread = taskDraft.threadId
    ? taskThreadOptions.find((thread) => thread.threadId === taskDraft.threadId)
    : undefined;
  const visibleTaskThreadOptions = selectedTaskThread
    && !matchingTaskThreadOptions.some((thread) => thread.threadId === selectedTaskThread.threadId)
    ? [selectedTaskThread, ...matchingTaskThreadOptions]
    : matchingTaskThreadOptions;
  const taskThreadQueryActive = Boolean(taskThreadQuery.trim());
  const taskSchedulePreview = React.useMemo(
    () => taskFormOpen ? taskDraftSchedulePreview(taskDraft.schedule) : null,
    [taskDraft.schedule, taskFormOpen]
  );
  const taskThreadTargetSummary = !selectedTaskProject
    ? "Select a project before choosing a thread."
    : selectedTaskThread
      ? `Pinned to ${threadDisplayTitle(selectedTaskThread)} (${shortId(selectedTaskThread.threadId)})`
      : taskThreadOptions.length
        ? "Uses the project thread created or reused when the task runs."
        : "No live threads for this project yet; the first run will create one.";
  const taskThreadTargetTitle = selectedTaskThread
    ? selectedTaskThread.threadId
    : selectedTaskProject?.path;
  const canCreateTask = Boolean(
    taskDraft.machineId.trim()
    && taskDraft.projectPath.trim()
    && taskDraft.schedule.trim()
    && taskSchedulePreview?.kind === "valid"
    && taskDraft.input.trim()
  );

  React.useEffect(() => {
    if (editingTaskId && !editingTask) {
      setEditingTaskId("");
      setTaskFormOpen(false);
    }
  }, [editingTask, editingTaskId, setTaskFormOpen]);

  const openNewTaskForm = () => {
    const wasEditing = Boolean(editingTaskId);
    setEditingTaskId("");
    if (wasEditing) {
      const nextDraft = defaultTaskDraft();
      setTaskDraft(selectedProject ? { ...nextDraft, machineId: selectedProject.machineId, projectPath: selectedProject.path } : nextDraft);
    } else if (selectedProject) {
      focusTaskDraftProject(selectedProject);
    }
    setTaskFormOpen(true);
  };

  const closeTaskForm = () => {
    setEditingTaskId("");
    setTaskFormOpen(false);
  };

  const closeTaskDialog = () => {
    closeTaskForm();
    setTasksDialogOpen(false);
  };

  const submitTaskForm = async () => {
    if (!editingTaskId) {
      await createTask();
      return;
    }
    const name = taskDraft.name.trim() || "Scheduled task";
    const schedule = taskDraft.schedule.trim();
    const machineId = taskDraft.machineId.trim();
    const projectPath = taskDraft.projectPath.trim();
    const input = taskDraft.input.trim();
    const threadId = taskDraft.threadId.trim();
    if (!machineId || !projectPath || !schedule || taskSchedulePreview?.kind !== "valid" || !input) return;
    const project = findProjectByMachinePath(projectList, machineId, projectPath);
    const saved = await patchTask(editingTaskId, {
      name,
      enabled: taskDraft.enabled,
      schedule,
      machineId,
      projectId: project?.projectId,
      projectPath,
      input,
      ...(threadId ? { threadId } : {})
    });
    if (!saved) return;
    setEditingTaskId("");
    setTaskDraft((current) => ({
      ...defaultTaskDraft(),
      machineId,
      projectPath,
      schedule: current.schedule,
      input: current.input
    }));
    setTaskFormOpen(false);
  };

  if (!tasksDialogOpen || projectScopeLocked) return null;

  return (
    <Modal
      open={tasksDialogOpen}
      className="taskModal"
      centered
      width={780}
      title={(
        <div className="taskModalTitle">
          <strong>Tasks</strong>
          <span title={taskPanelContextTitle}>{taskPanelContextLabel}</span>
        </div>
      )}
      footer={null}
      mask={{ closable: true }}
      onCancel={closeTaskDialog}
    >
      <div className="taskModalBody">
        <div className="taskPanel">
          <div className="taskPanelHeader">
            <div className="taskPanelTitle">
              <span>{visibleTasks.length ? `${visibleTasks.length} task${visibleTasks.length === 1 ? "" : "s"}` : "No configured tasks"}</span>
            </div>
            <Button
              type={taskFormOpen ? "default" : "primary"}
              onClick={() => taskFormOpen ? closeTaskForm() : openNewTaskForm()}
            >
              {taskFormOpen ? "Close" : "New"}
            </Button>
          </div>
          {scopedTasks.length > 0 || taskQuery ? (
            <Input
              className="taskSearchInput"
              value={taskSearch}
              onChange={(event) => setTaskSearch(event.target.value)}
              placeholder="Search tasks"
              allowClear
              spellCheck={false}
            />
          ) : null}
          {visibleTasks.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={taskQuery ? "No matching tasks" : selectedProject ? "No tasks for this project" : "No tasks"}
            />
          ) : (
            <div className="taskList">
              {visibleTasks.map((task) => {
                const busy = taskBusyId === task.taskId;
                const taskRunError = task.lastError ? `Last run failed: ${task.lastError}` : "";
                const promptPreview = taskPromptPreview(task);
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
                    <small className="taskPromptPreview" title={task.input}>Prompt: {promptPreview}</small>
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
                              {run.threadId ? (
                                <Button
                                  type="text"
                                  size="small"
                                  className="taskRunThreadButton"
                                  onClick={() => void openTaskRunThread(run.threadId ?? "")}
                                  aria-label={`Open thread for ${task.name} run`}
                                  title="Open run thread"
                                  icon={<MessageSquare size={12} strokeWidth={2.2} aria-hidden="true" />}
                                />
                              ) : null}
                              {run.error ? <em>{run.error}</em> : null}
                            </li>
                          ))}
                        </ol>
                      </details>
                    ) : null}
                    <div className="taskActions">
                      <Button
                        type="text"
                        size="small"
                        className="taskIconButton"
                        onClick={() => {
                          setEditingTaskId(task.taskId);
                          setTaskDraft(taskDraftFromTask(task));
                          setTaskFormOpen(true);
                        }}
                        disabled={busy}
                        aria-label={`Edit ${task.name}`}
                        title={`Edit ${task.name}`}
                        icon={<Pencil size={13} strokeWidth={2.1} aria-hidden="true" />}
                      />
                      <Button
                        type="primary"
                        danger
                        size="small"
                        className="taskIconButton taskRunButton"
                        onClick={() => void runTaskNow(task)}
                        disabled={busy}
                        aria-label={`Run ${task.name}`}
                        title="Run now"
                        icon={busy ? undefined : <Play size={13} strokeWidth={2.2} aria-hidden="true" />}
                      >
                        {busy ? "..." : null}
                      </Button>
                      <Switch
                        size="small"
                        checked={task.enabled}
                        onChange={(checked) => void patchTask(task.taskId, { enabled: checked })}
                        disabled={busy}
                        aria-label={task.enabled ? "Disable task" : "Enable task"}
                      />
                      <Button
                        type="text"
                        danger
                        size="small"
                        className="taskIconButton taskDeleteButton"
                        onClick={() => void deleteTask(task.taskId)}
                        disabled={busy}
                        aria-label={`Delete ${task.name}`}
                        title={`Delete ${task.name}`}
                        icon={<Trash2 size={13} strokeWidth={2.1} aria-hidden="true" />}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {taskFormOpen ? (
            <Form className="taskForm" layout="vertical" onFinish={() => void submitTaskForm()}>
              <Form.Item label="Name">
                <Input
                  value={taskDraft.name}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder="daily-summary"
                />
              </Form.Item>
              <Form.Item label="Machine">
                <Select
                  value={taskDraft.machineId || undefined}
                  onChange={(value) => updateTaskDraftMachine(value)}
                  disabled={taskFormProjectLocked || !taskMachineOptions.length}
                  placeholder="Machine"
                  options={taskMachineOptions.map((machine) => ({
                    value: machine.machineId,
                    label: machine.name ?? machine.hostname
                  }))}
                />
              </Form.Item>
              <Form.Item label="Project">
                <Select
                  value={taskDraft.projectPath || undefined}
                  onChange={(value) => updateTaskDraftProject(value)}
                  disabled={taskFormProjectLocked || !taskProjectOptions.length}
                  placeholder="Project"
                  options={taskProjectOptions.map((project) => ({
                    value: project.path,
                    label: project.name
                  }))}
                />
              </Form.Item>
              <Form.Item label="Thread">
                {selectedTaskProject && taskThreadOptions.length ? (
                  <Input
                    value={taskThreadQuery}
                    onChange={(event) => setTaskThreadQuery(event.target.value)}
                    placeholder="Filter threads"
                    aria-label="Filter task threads"
                    autoComplete="off"
                    spellCheck={false}
                  />
                ) : null}
                <Select
                  value={taskDraft.threadId || undefined}
                  onChange={(value) => setTaskDraft((current) => ({ ...current, threadId: value }))}
                  disabled={!selectedTaskProject}
                  placeholder={taskThreadEmptyLabel}
                  options={visibleTaskThreadOptions.map((thread) => ({
                    value: thread.threadId,
                    label: threadDisplayTitle(thread)
                  }))}
                />
                {taskThreadQueryActive && matchingTaskThreadOptions.length === 0 ? (
                  <small className="taskThreadSearchEmpty">No matching threads</small>
                ) : null}
                <small className="taskThreadTargetSummary" title={taskThreadTargetTitle}>
                  {taskThreadTargetSummary}
                </small>
              </Form.Item>
              <Form.Item label="Schedule">
                <Input
                  value={taskDraft.schedule}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, schedule: event.target.value }))}
                  placeholder="0 9 * * *"
                  spellCheck={false}
                />
                <Space className="taskSchedulePresets" size={4}>
                  {taskSchedulePresets.map((preset) => (
                    <Button
                      type={taskDraft.schedule === preset.value ? "primary" : "default"}
                      size="small"
                      onClick={() => setTaskDraft((current) => ({ ...current, schedule: preset.value }))}
                      key={preset.value}
                    >
                      {preset.label}
                    </Button>
                  ))}
                </Space>
                <small className={`taskSchedulePreview ${taskSchedulePreview?.kind ?? "empty"}`} title={taskSchedulePreview?.title ?? ""}>
                  {taskSchedulePreview?.text ?? ""}
                </small>
              </Form.Item>
              <Form.Item label="Prompt">
                <Input.TextArea
                  value={taskDraft.input}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, input: event.target.value }))}
                  rows={3}
                  placeholder="检查这个项目最近的变更，给我总结风险和下一步。"
                />
              </Form.Item>
              <div className="taskFormActions">
                <Space className="taskEnabledControl" size={8}>
                  <Switch
                    size="small"
                    checked={taskDraft.enabled}
                    onChange={(checked) => setTaskDraft((current) => ({ ...current, enabled: checked }))}
                    aria-label={taskDraft.enabled ? "Disable new task" : "Enable new task"}
                  />
                  <span>Enabled</span>
                </Space>
                <Button
                  className="taskSaveButton"
                  type="primary"
                  htmlType="submit"
                  disabled={!canCreateTask || taskSubmitBusy}
                >
                  {taskSubmitLabel}
                </Button>
              </div>
            </Form>
          ) : null}
          {taskError ? <Alert type="error" showIcon message={taskError} /> : null}
        </div>
      </div>
    </Modal>
  );
};
