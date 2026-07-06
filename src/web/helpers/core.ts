import { asRecord } from "../../shared/recordTypes.js";
import type { ModelCatalogItem, StoredMachine } from "../../shared/apiContract.js";
import type { AnyApiRoute, ApiRouteCallArgs, ApiRoutePathArgs, ApiRouteResponse } from "../../shared/apiRoutes.js";
import { modelOptions, reasoningOptions, serviceTierOptions } from "../appConfig.js";
import type { CodexThreadCandidate, ComposerMode, LocalTask, LocalTaskRun, MachineSummary, ModelSelection, PluginSummary, ProjectMachineGroup, ProjectSummary, ReasoningSelection, RealtimeMessage, ServiceTierSelection, SessionSummary, SessionView, SshConnection, SshHost, TaskDraft, ThreadSummary, ApprovalPolicyDraft, SandboxPolicyDraft } from "../types.js";
import { formatDate, shortId } from "./common.js";

const authStorageKey = "codexhub.authToken";

export const initAuthTokenFromUrl = () => {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  const token = url.searchParams.get("codexhub_token")?.trim() || url.searchParams.get("token")?.trim() || "";
  if (!token) return authToken();
  window.localStorage.setItem(authStorageKey, token);
  url.searchParams.delete("codexhub_token");
  url.searchParams.delete("token");
  window.history.replaceState(window.history.state, "", url);
  return token;
};

export const authToken = () => {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(authStorageKey)?.trim() ?? "";
};

export const setAuthToken = (token: string) => {
  if (typeof window === "undefined") return;
  const trimmed = token.trim();
  if (trimmed) window.localStorage.setItem(authStorageKey, trimmed);
  else window.localStorage.removeItem(authStorageKey);
};

export const clearAuthToken = () => {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(authStorageKey);
};

export const authFetch = (path: string, init: RequestInit = {}) => {
  const token = authToken();
  const headers = new Headers(init.headers);
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
};

export const authWebSocketUrl = (path: string) => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(path, `${protocol}//${window.location.host}`);
  const token = authToken();
  if (token) url.searchParams.set("codexhub_token", token);
  return url.toString();
};

export const apiJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await authFetch(path, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
};

export const apiRouteJson = async <Route extends AnyApiRoute>(
  route: Route,
  ...args: ApiRouteCallArgs<Route>
): Promise<ApiRouteResponse<Route>> => {
  const values = [...args] as unknown[];
  const body = route.hasBody ? values.pop() : undefined;
  const pathArgs = values as ApiRoutePathArgs<Route>;
  const path = typeof route.path === "function"
    ? route.path(...(pathArgs as never[]))
    : route.path;
  const init: RequestInit | undefined = route.method === "GET"
    ? undefined
    : {
      method: route.method,
      ...(route.hasBody
        ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }
        : {})
    };
  return apiJson<ApiRouteResponse<Route>>(path, init);
};

const hasNonBlankString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export const realtimeMessageTypes = new Set([
  "sessions",
  "projects",
  "tasks",
  "connections",
  "thread",
  "record",
  "done",
  "ready",
  "thread_subscribed",
  "thread_unsubscribed",
  "error"
]);

export const parseRealtimeMessage = (data: unknown): RealtimeMessage | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(data));
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const type = typeof record?.type === "string"
    ? record.type
    : typeof record?.kind === "string" ? record.kind : "";
  if (!realtimeMessageTypes.has(type)) return null;
  return { ...record, type } as RealtimeMessage;
};

export const canForkAtMessage = (threadId: string, message: { canFork?: boolean; record: { id: string } }) =>
  Boolean(message.canFork && turnIdFromAppRecordId(threadId, message.record.id));

export const turnIdFromAppRecordId = (threadId: string, recordId: string) => {
  const prefix = `app:${threadId}:`;
  if (!recordId.startsWith(prefix)) return null;
  const rest = recordId.slice(prefix.length);
  const [turnId, kind] = rest.split(":");
  if (!turnId || !kind) return null;
  return turnId;
};

const isThreadSummaryLike = (value: unknown): value is ThreadSummary => {
  const record = asRecord(value);
  return Boolean(record && hasNonBlankString(record.threadId) && hasNonBlankString(record.updatedAt));
};

const normalizeThreads = (threads: unknown): ThreadSummary[] =>
  Array.isArray(threads)
    ? threads.filter(isThreadSummaryLike).map((thread) => ({
      ...thread,
      title: hasNonBlankString(thread.title) ? thread.title : thread.threadId,
      goalRunPolicy: normalizeThreadGoalRunPolicy(thread.goalRunPolicy)
    }))
    : [];

const normalizeThreadGoalRunPolicy = (value: unknown): ThreadSummary["goalRunPolicy"] => {
  const policy = asRecord(value);
  if (policy?.type !== "consumeUntilWeeklyRemainingAtOrBelow") return null;
  const target = policy.targetRemainingPercent;
  if (typeof target !== "number" || !Number.isFinite(target) || target < 0 || target >= 100) return null;
  return {
    type: "consumeUntilWeeklyRemainingAtOrBelow",
    targetRemainingPercent: target
  };
};

const candidateText = (value: unknown) => typeof value === "string" ? value : "";
const candidateCount = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

export const normalizeThreadCandidates = (threads: CodexThreadCandidate[] | undefined): CodexThreadCandidate[] =>
  Array.isArray(threads)
    ? threads.flatMap((thread) => {
      const record = asRecord(thread);
      if (!record || !hasNonBlankString(record.threadId) || !hasNonBlankString(record.updatedAt)) return [];
      return [{
        threadId: record.threadId,
        cwd: candidateText(record.cwd),
        path: candidateText(record.path),
        title: candidateText(record.title),
        updatedAt: record.updatedAt,
        firstUserMessage: candidateText(record.firstUserMessage),
        lastAssistantMessage: candidateText(record.lastAssistantMessage),
        artifactCount: candidateCount(record.artifactCount),
        messageCount: candidateCount(record.messageCount)
      }];
    })
    : [];

const isSessionLike = (value: unknown): value is SessionSummary => {
  const record = asRecord(value);
  return Boolean(record && hasNonBlankString(record.sessionId));
};

export const normalizeSessions = (sessions: SessionSummary[] | undefined): SessionView[] =>
  Array.isArray(sessions)
    ? sessions
      .filter(isSessionLike)
      .map((session) => ({
        ...session,
        sessionId: session.sessionId,
        threads: normalizeThreads(session.threads)
      }))
    : [];

const normalizeMachine = (machine: MachineSummary | StoredMachine): MachineSummary =>
  "online" in machine
    ? machine
    : {
      ...machine,
      online: false,
      status: "offline"
    };

export const normalizeMachines = (machines: Array<MachineSummary | StoredMachine> | undefined): MachineSummary[] =>
  Array.isArray(machines)
    ? machines.map(normalizeMachine)
    : [];

export const normalizeProjects = (projects: ProjectSummary[] | undefined) =>
  Array.isArray(projects)
    ? projects.map((project) => ({
      ...project,
      machineOnline: Boolean(project.machineOnline ?? (project.machine && "online" in project.machine && project.machine.online))
    }))
    : [];

export const normalizePlugins = (plugins: PluginSummary[] | undefined) =>
  Array.isArray(plugins)
    ? plugins.map((plugin) => ({
      ...plugin,
      contributions: {
        web: {
          styles: Array.isArray(plugin.contributions?.web?.styles) ? plugin.contributions.web.styles : []
        },
        integrations: Array.isArray(plugin.contributions?.integrations) ? plugin.contributions.integrations : []
      }
    }))
    : [];

export const normalizeTasks = (tasks: LocalTask[] | undefined) =>
  Array.isArray(tasks)
    ? tasks
      .map((task) => ({
        ...task,
        runs: Array.isArray(task.runs) ? task.runs : []
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    : [];

export const defaultTaskDraft = (): TaskDraft => ({
  name: "daily-summary",
  enabled: true,
  schedule: "0 9 * * *",
  machineId: "",
  projectPath: "",
  threadId: "",
  input: "检查这个项目最近的变更，给我总结风险和下一步。"
});

export const taskDraftFromTask = (task: LocalTask): TaskDraft => ({
  name: task.name,
  enabled: task.enabled,
  schedule: task.schedule,
  machineId: task.machineId,
  projectPath: task.projectPath,
  threadId: task.threadId ?? "",
  input: task.input
});

export const taskThreadOptionsFor = (project: ProjectSummary | undefined, sessions: SessionView[] = []) => {
  const threads = new Map<string, Pick<ThreadSummary, "threadId" | "title" | "updatedAt">>();
  const pushThread = (thread: Pick<ThreadSummary, "threadId" | "title" | "updatedAt">) => {
    if (!thread.threadId) return;
    const existing = threads.get(thread.threadId);
    if (existing && existing.updatedAt >= thread.updatedAt) return;
    threads.set(thread.threadId, {
      threadId: thread.threadId,
      title: thread.title,
      updatedAt: thread.updatedAt
    });
  };
  if (project) {
    for (const session of sessions.filter((session) => session.machineId === project.machineId)) {
      for (const thread of session.threads ?? []) {
        if (thread.workingDirectory === project.path) pushThread(thread);
      }
    }
  }
  return [...threads.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};

export const taskStatusLabel = (task: LocalTask) => {
  if (!task.enabled) return "paused";
  if (task.lastStatus === "queued") return "queued";
  if (task.lastStatus === "completed") return "done";
  if (task.lastStatus === "failed") return "failed";
  if (task.lastStatus === "skipped") return "skipped";
  return "scheduled";
};

export const taskStatusClass = (task: LocalTask) => task.enabled ? task.lastStatus ?? "idle" : "paused";

export const taskBelongsToProject = (task: LocalTask, project: ProjectSummary) =>
  task.machineId === project.machineId
  && (task.projectPath === project.path || Boolean(task.projectId && task.projectId === project.projectId));

export const taskTargetLabel = (task: LocalTask, projects: ProjectSummary[], machines: MachineSummary[]) => {
  const project = projects.find((item) => item.machineId === task.machineId && item.path === task.projectPath);
  const machine = machines.find((item) => item.machineId === task.machineId);
  const projectName = project?.name ?? basename(task.projectPath);
  const machineName = machine?.name ?? machine?.hostname ?? task.machineId;
  const thread = task.threadId ? shortId(task.threadId) : "project thread";
  return `${projectName} · ${machineName} · ${thread}`;
};

export const taskTargetTitle = (task: LocalTask, projects: ProjectSummary[], machines: MachineSummary[]) => {
  const project = projects.find((item) => item.machineId === task.machineId && item.path === task.projectPath);
  const machine = machines.find((item) => item.machineId === task.machineId);
  return [
    `machine: ${machine?.name ?? machine?.hostname ?? task.machineId}`,
    `project: ${project?.path ?? task.projectPath}`,
    `thread: ${task.threadId ?? "project default"}`,
    task.lastRunAt ? `last run: ${formatDate(task.lastRunAt)}` : null,
    task.nextRunAt ? `next run: ${formatDate(task.nextRunAt)}` : null
  ].filter(Boolean).join("\n");
};

export const taskScheduleLine = (task: LocalTask) =>
  task.nextRunAt && task.enabled
    ? `${task.schedule} · next ${relativeTimeFuture(task.nextRunAt)}`
    : task.schedule;

export const taskRunSummary = (task: LocalTask) => {
  const run = task.runs?.[0];
  if (!run) return task.lastRunAt ? `last ${relativeTime(task.lastRunAt)}` : "not run yet";
  const status = run.status === "completed" ? "done" : run.status;
  const duration = run.durationMs != null ? ` · ${formatDuration(run.durationMs)}` : "";
  const when = run.finishedAt ?? run.startedAt;
  return `${status} ${relativeTime(when)}${duration}`;
};

export const taskRunTitle = (task: LocalTask) => {
  const runs = task.runs ?? [];
  if (!runs.length) return "No task runs yet";
  return runs.slice(0, 5).map((run) => {
    const duration = run.durationMs != null ? `, ${formatDuration(run.durationMs)}` : "";
    const thread = run.threadId ? `, thread ${shortId(run.threadId)}` : "";
    const error = run.error ? `, ${run.error}` : "";
    return `${run.status}: ${formatDate(run.finishedAt ?? run.startedAt)}${duration}${thread}${error}`;
  }).join("\n");
};

export const taskRunStatusLabel = (run: LocalTaskRun) => run.status === "completed" ? "done" : run.status;

export const taskRunLine = (run: LocalTaskRun) => {
  const status = taskRunStatusLabel(run);
  const when = relativeTime(run.finishedAt ?? run.startedAt);
  const duration = run.durationMs != null ? ` · ${formatDuration(run.durationMs)}` : "";
  const thread = run.threadId ? ` · ${shortId(run.threadId)}` : "";
  return `${status} · ${when}${duration}${thread}`;
};

export const taskRunDetailTitle = (run: LocalTaskRun) => [
  `status: ${run.status}`,
  `started: ${formatDate(run.startedAt)}`,
  run.finishedAt ? `finished: ${formatDate(run.finishedAt)}` : null,
  run.durationMs != null ? `duration: ${formatDuration(run.durationMs)}` : null,
  run.sessionId ? `session: ${run.sessionId}` : null,
  run.threadId ? `thread: ${run.threadId}` : null,
  run.error ? `error: ${run.error}` : null
].filter(Boolean).join("\n");

export const formatDuration = (durationMs: number | undefined) => {
  if (durationMs == null || !Number.isFinite(durationMs)) return "";
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder ? `${hours}h ${minuteRemainder}m` : `${hours}h`;
};

export const relativeTimeFuture = (iso: string | undefined) => {
  if (!iso) return "unknown";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.round((timestamp - Date.now()) / 1000));
  if (seconds < 60) return `${Math.max(1, seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

export const uniqueMachines = (machines: MachineSummary[]) => {
  const byId = new Map<string, MachineSummary>();
  for (const machine of machines) {
    const key = `${machine.type ?? "registered"}:${machine.name ?? machine.hostname ?? machine.machineId}`;
    const existing = byId.get(key);
    if (!existing || (!existing.online && machine.online)) byId.set(key, machine);
  }
  return [...byId.values()];
};

export const groupProjectsByMachine = (projects: ProjectSummary[], machines: MachineSummary[]): ProjectMachineGroup[] => {
  const machinesById = new Map(machines.map((machine) => [machine.machineId, machine]));
  const groups = new Map<string, ProjectMachineGroup>();
  const groupedMachineIds = new Set<string>();
  for (const project of projects) {
    const machine = machinesById.get(project.machineId) ?? project.machine;
    const machineType = machine?.type ?? "registered";
    const sourceGroupKey = project.source?.kind === "vscode" ? `vscode:${project.source.groupId}` : "";
    const groupKey = sourceGroupKey || project.machineId;
    const label = machine
      ? machine.name ?? machine.hostname
      : project.machineId;
    const online = Boolean(machine && "online" in machine ? machine.online : project.machineOnline);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        key: groupKey,
        kind: sourceGroupKey ? "vscodeWorkspace" : "machine",
        machineId: project.machineId,
        machineType,
        label: project.source?.label ?? label,
        online,
        projectLauncher: machineProjectLauncher(machine),
        badgeLabel: machineType,
        projects: []
      };
      groups.set(groupKey, group);
    }
    group.online = group.online || online;
    group.machineType = group.machineType ?? machineType;
    group.projectLauncher = group.projectLauncher || machineProjectLauncher(machine);
    if (group.label === project.machineId && label !== project.machineId) group.label = label;
    group.projects.push(project);
    groupedMachineIds.add(project.machineId);
  }
  for (const machine of machines) {
    if (!machine.online) continue;
    if (!machineProjectLauncher(machine)) continue;
    if (!machineProjectCatalogEditable(machine)) continue;
    if (groupedMachineIds.has(machine.machineId)) continue;
    groups.set(machine.machineId, {
      key: machine.machineId,
      kind: "machine",
      machineId: machine.machineId,
      machineType: machine.type ?? "registered",
      label: machine.name ?? machine.hostname,
      online: machine.online,
      projectLauncher: machineProjectLauncher(machine),
      badgeLabel: machine.type ?? "registered",
      projects: []
    });
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      badgeLabel: projectMachineBadgeLabel(group),
      projects: orderProjectsByRelation(group.projects)
    }))
    .sort((left, right) =>
      Number(right.kind === "vscodeWorkspace") - Number(left.kind === "vscodeWorkspace")
      || Number(right.online) - Number(left.online)
      || left.label.localeCompare(right.label)
    );
};

export const projectMachineBadgeLabel = (group: Pick<ProjectMachineGroup, "machineType">) => {
  return group.machineType;
};

export const machineProjectLauncher = (machine: MachineSummary | StoredMachineLike | undefined) =>
  machine?.capabilities?.projectLauncher !== false;

export const machineProjectCatalogEditable = (machine: MachineSummary | StoredMachineLike | undefined) =>
  machine?.capabilities?.projectCatalog !== "fixed";

export const fixedProject = (project: ProjectSummary) =>
  project.machine?.capabilities?.projectCatalog === "fixed";

type StoredMachineLike = {
  capabilities?: {
    projectLauncher?: boolean;
    projectCatalog?: "editable" | "fixed";
  };
};

export const compareProjectRows = (left: ProjectSummary, right: ProjectSummary) => {
  if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
  const createdCompare = left.createdAt.localeCompare(right.createdAt);
  if (createdCompare) return createdCompare;
  const nameCompare = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  if (nameCompare) return nameCompare;
  return left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
};

export const orderProjectsByRelation = (projects: ProjectSummary[]) => {
  const projectIds = new Set(projects.map((project) => project.projectId));
  const childrenByParent = new Map<string, ProjectSummary[]>();
  const roots: ProjectSummary[] = [];
  for (const project of projects) {
    const parentProjectId = project.relation?.type === "worktree" ? project.relation.parentProjectId : "";
    if (parentProjectId && projectIds.has(parentProjectId)) {
      const children = childrenByParent.get(parentProjectId) ?? [];
      children.push(project);
      childrenByParent.set(parentProjectId, children);
    } else {
      roots.push(project);
    }
  }
  const ordered: ProjectSummary[] = [];
  for (const root of roots.sort(compareProjectRows)) {
    ordered.push(root);
    const children = childrenByParent.get(root.projectId);
    if (children?.length) ordered.push(...children.sort(compareProjectRows));
  }
  for (const [parentProjectId, children] of childrenByParent) {
    if (projectIds.has(parentProjectId) && ordered.some((project) => project.projectId === parentProjectId)) continue;
    ordered.push(...children.sort(compareProjectRows));
  }
  return ordered;
};

export const projectKeyFor = (machineId: string, projectPath: string) => `${machineId}:${projectPath}`;

export const projectKeyForProject = (project: Pick<ProjectSummary, "machineId" | "path">) =>
  projectKeyFor(project.machineId, project.path);

export const basename = (projectPath: string) => projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath;

export const projectSearchMatches = (project: ProjectSummary, query: string) => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    project.name,
    project.path,
    project.machineId,
    project.relation?.type === "worktree" ? project.relation.branch : "",
    project.relation?.type === "worktree" ? project.relation.parentPath : ""
  ].filter(Boolean).some((value) => String(value).toLowerCase().includes(normalized));
};

export const sshHostMeta = (host: SshHost) => [
  host.user,
  host.hostName,
  host.port ? `:${host.port}` : null,
  host.proxyJump ? `via ${host.proxyJump}` : null
].filter(Boolean).join(" ") || host.alias;

type SshConnectionStatusLabel = "ready" | "starting" | "connected" | "failed" | "stopped" | "missing";

export const latestSshConnectionForHost = (connections: SshConnection[], host: string) =>
  connections
    .filter((connection) => connection.host === host)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

export const activeSshConnectionForHost = (connections: SshConnection[], host: string) =>
  latestSshConnectionForHost(connections.filter((connection) => connection.status !== "exited"), host);

export const sshConnectionStatusLabel = (
  connection: SshConnection | undefined,
  connecting: boolean,
  configured: boolean
): SshConnectionStatusLabel => {
  if (connecting) return "starting";
  if (connection?.status === "starting") return "starting";
  if (connection?.status === "running") return "connected";
  if (connection?.status === "exited") return sshConnectionStoppedCleanly(connection) ? "stopped" : "failed";
  return configured ? "ready" : "missing";
};

export const sshConnectionStatusClass = (status: SshConnectionStatusLabel) =>
  status === "connected" ? "online connected" : status;

export const sshConnectionStoppedCleanly = (connection: SshConnection) =>
  connection.status === "exited"
  && (connection.exitCode === 0 || connection.signal === "SIGTERM" || connection.signal === "SIGKILL");

export const sshConnectionDetail = (host: SshHost, connection: SshConnection | undefined) => {
  const lastLine = compactSshOutput(connection?.lastOutput);
  if (connection?.status === "exited" && lastLine) return lastLine;
  if (host.configured === false) return "not found in SSH config";
  return sshHostMeta(host);
};

export const sshConnectionTitle = (host: SshHost, connection: SshConnection | undefined) => {
  if (!connection) return host.configured === false ? "SSH config entry missing" : "Ready to connect";
  const status = sshConnectionStatusLabel(connection, false, host.configured !== false);
  const lastLine = compactSshOutput(connection.lastOutput);
  const updated = connection.updatedAt ? `updated ${relativeTime(connection.updatedAt)}` : "";
  return [status, updated, lastLine ? `last output: ${lastLine}` : ""].filter(Boolean).join("; ");
};

export const sshConnectionDoctorLines = (host: SshHost, connection: SshConnection | undefined) => [
  `alias: ${host.alias}`,
  host.hostName ? `host: ${host.hostName}` : null,
  host.user ? `user: ${host.user}` : null,
  host.port ? `port: ${host.port}` : null,
  host.proxyJump ? `proxy: ${host.proxyJump}` : null,
  connection ? `status: ${connection.status}` : "status: ready",
  connection ? `remote port: ${connection.remotePort}` : null,
  connection?.exitCode != null ? `exit: ${connection.exitCode}` : null,
  connection?.signal ? `signal: ${connection.signal}` : null,
  connection?.updatedAt ? `updated: ${formatDate(connection.updatedAt)}` : null,
  connection?.lastOutput ? `last output:\n${connection.lastOutput}` : null
].filter(Boolean).join("\n");

export const pluginIntegrationStatusLabel = (plugin: PluginSummary) => {
  const integrations = plugin.contributions?.integrations ?? [];
  if (!integrations.length) return plugin.contributions?.web?.styles?.length ? "style" : "metadata";
  const started = integrations.filter((integration) => integration.started).length;
  const configured = integrations.filter((integration) => integration.configured).length;
  if (started) return `${started}/${integrations.length} running`;
  if (configured) return `${configured}/${integrations.length} configured`;
  return "not configured";
};

export const pluginStatusClass = (plugin: PluginSummary) => {
  if (!plugin.enabled) return "disabled";
  const integrations = plugin.contributions?.integrations ?? [];
  if (integrations.some((integration) => integration.started)) return "running";
  if (integrations.some((integration) => integration.configured)) return "configured";
  return "idle";
};

export const compactSshOutput = (value: string | undefined) =>
  value?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 180) ?? "";

export const sessionStatusTitle = (session: SessionView) => {
  if (session.online) return "Session online";
  const reason = session.offlineReason === "heartbeat_timeout"
    ? "heartbeat timeout"
    : session.offlineReason === "transport_disconnected"
      ? "connection lost"
      : "recently disconnected";
  const lastSeen = session.lastSeenAt ? `, last seen ${relativeTime(session.lastSeenAt)}` : "";
  return `Session disconnected: ${reason}${lastSeen}`;
};

export const relativeTime = (iso: string | undefined) => {
  if (!iso) return "unknown";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export const formatGoalAge = (iso: string) => {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${Math.max(1, seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

export const goalStatusLabel = (status: string) => {
  if (status === "paused") return "暂停的目标";
  if (status === "complete") return "完成的目标";
  if (status === "blocked") return "阻塞的目标";
  if (status === "usageLimited") return "受限的目标";
  if (status === "budgetLimited") return "预算受限的目标";
  return "进行中的目标";
};

export const goalStatusClass = (status: string) => {
  if (status === "paused") return "paused";
  if (status === "complete") return "complete";
  if (status === "blocked" || status === "usageLimited" || status === "budgetLimited") return "blocked";
  return "active";
};

export const threadCandidateTitle = (candidate: CodexThreadCandidate) =>
  compactLine(candidate.title || candidate.firstUserMessage || candidate.lastAssistantMessage || shortId(candidate.threadId));

export const formatThreadCandidateTime = (value: string) => relativeTime(value);

export const compactLine = (value: string) => value.replace(/\s+/g, " ").trim();

export const threadDisplayTitle = (thread: Pick<ThreadSummary, "threadId" | "title">) => {
  const title = compactLine(thread.title);
  const threadShortId = shortId(thread.threadId);
  return title && title !== thread.threadId && title !== threadShortId ? title : "New thread";
};

export const appendThreadOrder = (current: Record<string, string[]>, sessionId: string, threadId: string) => {
  const existing = current[sessionId] ?? [];
  if (existing.includes(threadId)) return current;
  return { ...current, [sessionId]: [...existing, threadId] };
};

export const removeThreadOrder = (current: Record<string, string[]>, threadId: string) => {
  const next: Record<string, string[]> = {};
  for (const [sessionId, threadIds] of Object.entries(current)) {
    const filtered = threadIds.filter((item) => item !== threadId);
    if (filtered.length) next[sessionId] = filtered;
  }
  return next;
};

export const mergeThreadOrderBySession = (current: Record<string, string[]>, sessionList: SessionView[]) => {
  const next: Record<string, string[]> = {};
  for (const session of sessionList) {
    const threadIds = sessionThreadIds(session);
    const liveThreadIds = new Set(threadIds);
    const existing = (current[session.sessionId] ?? []).filter((threadId) => liveThreadIds.has(threadId));
    const appended = threadIds.filter((threadId) => !existing.includes(threadId));
    next[session.sessionId] = [...existing, ...appended];
  }
  return next;
};

export const sessionThreadIds = (session: SessionView) => {
  const threadIds: string[] = [];
  const pushThreadId = (threadId?: string) => {
    if (threadId && !threadIds.includes(threadId)) threadIds.push(threadId);
  };
  for (const thread of session.threads ?? []) pushThreadId(thread.threadId);
  return threadIds;
};

export const preferredThreadIdForSession = (session: SessionView, project?: ProjectSummary) => {
  const sessionThreads = session.threads ?? [];
  if (!project) return sessionThreads[0]?.threadId ?? "";
  const projectThreads = sessionThreads.filter((thread) => thread.workingDirectory === project.path);
  const projectThreadIds = new Set(projectThreads.map((thread) => thread.threadId));
  if (project.lastThreadId && projectThreadIds.has(project.lastThreadId)) return project.lastThreadId;
  return projectThreads[0]?.threadId ?? "";
};

export const runtimeSessionForMachine = (sessions: SessionView[], machineId?: string) => {
  if (!machineId) return undefined;
  return sessions.find((session) => session.machineId === machineId && session.online)
    ?? sessions.find((session) => session.machineId === machineId);
};

export const runtimeSessionForProject = (project: ProjectSummary | undefined, sessions: SessionView[]) =>
  project ? runtimeSessionForMachine(sessions, project.machineId) : undefined;

export const adjacentThreadId = (threadIds: string[], threadId: string) => {
  const index = threadIds.indexOf(threadId);
  if (index === -1) return threadIds.find((item) => item !== threadId) ?? "";
  return threadIds[index + 1] ?? threadIds[index - 1] ?? "";
};

export const patchSessionsThread = (sessionList: SessionView[], thread: ThreadSummary) =>
  sessionList.map((session) => {
    if (session.sessionId !== thread.session.sessionId) return session;
    return {
      ...session,
      threads: upsertThreadSummary(session.threads ?? [], thread)
    };
  });

export const patchProjectsThread = (projects: ProjectSummary[], thread: ThreadSummary) =>
  projects.map((project) => {
    const matchesPath = project.path === thread.workingDirectory;
    if (!matchesPath) return project;
    return {
      ...project,
      lastThreadId: thread.threadId,
      running: thread.running || thread.status === "running" || project.running
    };
  });

export const removeSessionsThread = (sessionList: SessionView[], threadId: string) =>
  sessionList.map((session) => ({
    ...session,
    threads: (session.threads ?? []).filter((thread) => thread.threadId !== threadId)
  }));

export const removeProjectsThread = (projects: ProjectSummary[], threadId: string) =>
  projects.map((project) => {
    return {
      ...project,
      lastThreadId: project.lastThreadId === threadId ? undefined : project.lastThreadId
    };
  });

export const upsertThreadSummary = (threads: ThreadSummary[], thread: ThreadSummary) => {
  const byId = new Map(threads.map((item) => [item.threadId, item]));
  byId.set(thread.threadId, { ...byId.get(thread.threadId), ...thread });
  return [...byId.values()].sort((left, right) => {
    return Number(right.running) - Number(left.running)
      || right.updatedAt.localeCompare(left.updatedAt);
  });
};

export const selectedThreadOptions = (
  model: ModelSelection,
  reasoning: ReasoningSelection,
  serviceTier: ServiceTierSelection,
  composerMode: ComposerMode,
  approvalPolicy: ApprovalPolicyDraft,
  sandboxPolicy: SandboxPolicyDraft,
  workingDirectory: string
) => ({
  model: model === "auto" ? null : model,
  modelReasoningEffort: reasoning === "auto" ? null : reasoning,
  serviceTier: serviceTier === "auto" ? null : serviceTier,
  approvalPolicy: approvalPolicy === "auto" ? null : approvalPolicy,
  sandboxPolicy: sandboxPolicyFromSelection(sandboxPolicy, workingDirectory),
  ...(composerMode === "plan" ? { collaborationMode: "plan" as const } : {}),
  ...(composerMode === "goal" ? { goalMode: true } : {})
});

const sandboxPolicyFromSelection = (selection: SandboxPolicyDraft, workingDirectory: string) => {
  if (selection === "auto") return null;
  if (selection === "read-only") return { type: "readOnly" as const, networkAccess: false };
  if (selection === "workspace-write") {
    return {
      type: "workspaceWrite" as const,
      writableRoots: [workingDirectory],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    };
  }
  return { type: "dangerFullAccess" as const };
};

export const isModelCommand = (text: string) => /^\/model\s*$/i.test(text);

export const fastCommandAction = (text: string) => {
  const match = /^\/fast(?:\s+(\S+))?\s*$/i.exec(text.trim());
  const action = match?.[1]?.toLowerCase();
  return action === "on" || action === "off" || action === "status" || (match && action === undefined)
    ? action ?? "status"
    : null;
};

export const rawModelLabel = (model: ModelSelection) => model === "auto" ? "Auto" : model;

export const modelOptionLabel = (option: { value: string; label: string }) =>
  option.value;

export const reasoningOptionLabel = (option: { value: string; label: string }) =>
  option.value;

export const serviceTierDisplayLabel = (tier: string) => tier;

export const serviceTierOptionLabel = (option: { value: string; label: string }) => option.value;

export const modelOptionsForSelection = (model: ModelSelection, catalog: ModelCatalogItem[] = []) => {
  const catalogOptions = catalog
    .filter((item) => !item.hidden)
    .map((item) => ({
      value: modelCatalogValue(item),
      label: modelCatalogValue(item)
    }))
    .filter((option) => option.value);
  const options = catalogOptions.length ? [{ value: "auto", label: "Auto" }, ...dedupeOptions(catalogOptions)] : modelOptions;
  return ensureOption(options, model);
};

export const reasoningOptionsForSelection = (
  reasoning: ReasoningSelection,
  catalog: ModelCatalogItem[] = [],
  model: ModelSelection = "auto"
) => {
  const catalogModel = modelCatalogItemForSelection(catalog, model);
  const catalogOptions = (catalogModel?.supportedReasoningEfforts ?? [])
    .filter((option) => reasoningOptions.some((staticOption) => staticOption.value === option.value))
    .map((option) => ({
      value: option.value,
      label: option.value
    }));
  const options = catalogOptions.length ? [{ value: "auto", label: "Auto" }, ...dedupeOptions(catalogOptions)] : reasoningOptions;
  return ensureOption(options, reasoning);
};

export const serviceTierOptionsForSelection = (
  serviceTier: ServiceTierSelection,
  catalog: ModelCatalogItem[] = [],
  model: ModelSelection = "auto"
) => {
  const catalogModel = modelCatalogItemForSelection(catalog, model);
  const sourceTiers = catalogModel?.serviceTiers.length
    ? catalogModel.serviceTiers
    : catalog.flatMap((item) => item.serviceTiers);
  const catalogOptions = sourceTiers.map((option) => ({
    value: option.value,
    label: option.value
  }));
  const options = catalogOptions.length
    ? [{ value: "auto", label: "Auto" }, ...dedupeOptions([...catalogOptions, { value: "default", label: "default" }])]
    : serviceTierOptions;
  return ensureOption(options, serviceTier, serviceTierDisplayLabel(serviceTier));
};

const modelCatalogValue = (item: Pick<ModelCatalogItem, "model" | "id">) => item.model || item.id;

const modelCatalogItemForSelection = (catalog: ModelCatalogItem[], model: ModelSelection) => {
  if (!model || model === "auto") return undefined;
  return catalog.find((item) => modelCatalogValue(item) === model || item.id === model || item.displayName === model);
};

const dedupeOptions = <T extends { value: string; label: string }>(options: T[]): T[] => {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (!option.value || seen.has(option.value)) return false;
    seen.add(option.value);
    return true;
  });
};

const ensureOption = <T extends { value: string; label: string }>(options: T[], value: string, label = value) => {
  if (!value || options.some((option) => option.value === value)) return options;
  return [...options, { value, label }];
};
