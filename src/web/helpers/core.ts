import { asRecord } from "../../core/codexRecord.js";
import { modelOptions } from "../appConfig.js";
import type { CodexThreadCandidate, ComposerMode, LocalTask, LocalTaskRun, MachineSummary, ModelSelection, PluginSummary, ProjectMachineGroup, ProjectSummary, ReasoningSelection, RealtimeMessage, SessionSummary, SessionView, SshConnection, SshHost, TaskDraft, ThreadSummary } from "../types.js";
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

export const realtimeMessageTypes = new Set([
  "sessions",
  "projects",
  "tasks",
  "connections",
  "server_connections",
  "thread",
  "record",
  "done",
  "jsonl_snapshot",
  "jsonl_append",
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

export const normalizeSessions = (sessions: SessionSummary[] | undefined): SessionView[] =>
  Array.isArray(sessions)
    ? sessions
      .filter((session) => typeof session.sessionId === "string" && Boolean(session.sessionId))
      .map((session) => ({
        ...session,
        sessionId: session.sessionId,
        threads: Array.isArray(session.threads) ? session.threads : []
      }))
    : [];

export const normalizeMachines = (machines: MachineSummary[] | undefined) =>
  Array.isArray(machines)
    ? machines
    : [];

export const normalizeProjects = (projects: ProjectSummary[] | undefined) =>
  Array.isArray(projects)
    ? projects.map((project) => ({
      ...project,
      machineOnline: Boolean(project.machineOnline ?? (project.machine && "online" in project.machine && project.machine.online)),
      session: project.session ? normalizeSessions([project.session])[0] ?? null : null,
      sessions: normalizeSessions(project.sessions),
      threads: Array.isArray(project.threads) ? project.threads : []
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

export const taskThreadOptionsFor = (project: ProjectSummary | undefined) => {
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
  for (const thread of project?.threads ?? []) pushThread(thread);
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
  for (const machine of machines) {
    if (!machine.online) continue;
    groups.set(machine.machineId, {
      key: machine.machineId,
      label: machine.name ?? machine.hostname,
      online: machine.online,
      projectLauncher: machineProjectLauncher(machine),
      statusLabel: machine.online ? "ready" : "offline",
      projects: []
    });
  }
  for (const project of projects) {
    const machine = machinesById.get(project.machineId) ?? project.machine;
    const label = machine
      ? machine.name ?? machine.hostname
      : project.machineId;
    const online = Boolean(machine && "online" in machine ? machine.online : project.machineOnline);
    let group = groups.get(project.machineId);
    if (!group) {
      group = {
        key: project.machineId,
        label,
        online,
        projectLauncher: machineProjectLauncher(machine),
        statusLabel: online ? "online" : "offline",
        projects: []
      };
      groups.set(project.machineId, group);
    }
    group.online = group.online || online;
    group.projectLauncher = group.projectLauncher || machineProjectLauncher(machine);
    if (group.label === project.machineId && label !== project.machineId) group.label = label;
    group.projects.push(project);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      statusLabel: projectMachineStatus(group),
      projects: [...group.projects].sort((left, right) => {
        return compareProjectRows(left, right);
      })
    }))
    .sort((left, right) => Number(right.online) - Number(left.online) || left.label.localeCompare(right.label));
};

export const projectMachineStatus = (group: Pick<ProjectMachineGroup, "online" | "projectLauncher" | "projects">) => {
  const onlineProjects = group.projects.filter((project) => project.session?.online).length;
  if (!group.online) return "offline";
  if (!group.projectLauncher) return "session";
  if (onlineProjects) return `${onlineProjects}/${group.projects.length} active`;
  return "ready";
};

export const machineProjectLauncher = (machine: MachineSummary | StoredMachineLike | undefined) =>
  machine?.capabilities?.projectLauncher !== false;

type StoredMachineLike = {
  capabilities?: {
    projectLauncher?: boolean;
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

export const projectKeyFor = (machineId: string, projectPath: string) => `${machineId}:${projectPath}`;

export const projectKeyForProject = (project: Pick<ProjectSummary, "machineId" | "path">) =>
  projectKeyFor(project.machineId, project.path);

export const basename = (projectPath: string) => projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath;

export const projectStatusLabel = (project: ProjectSummary) => {
  if (project.running) return "running";
  if (project.session?.online) return "session";
  if (project.machineOnline || (project.machine && "online" in project.machine && project.machine.online)) return "ready";
  return "offline";
};

export const projectSearchMatches = (project: ProjectSummary, query: string) => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    project.name,
    project.path,
    project.machineId,
    project.session?.sessionId,
    ...project.threads.map((thread) => thread.title)
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
  compactLine(candidate.firstUserMessage || candidate.lastAssistantMessage || shortId(candidate.threadId));

export const formatThreadCandidateTime = (value: string) => relativeTime(value);

export const compactLine = (value: string) => value.replace(/\s+/g, " ").trim();

export const threadDisplayTitle = (thread: Pick<ThreadSummary, "threadId" | "title">) => {
  const title = compactLine(thread.title);
  const threadShortId = shortId(thread.threadId);
  return title && title !== thread.threadId && title !== threadShortId ? title : "new";
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
  const sessionThreadIds = new Set((session.threads ?? []).map((thread) => thread.threadId));
  if (project?.lastThreadId && sessionThreadIds.has(project.lastThreadId)) return project.lastThreadId;
  return session.threads?.[0]?.threadId
    ?? project?.threads?.[0]?.threadId
    ?? "";
};

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
    const matchesSession = Boolean(thread.session.sessionId && project.session?.sessionId === thread.session.sessionId);
    const matchesPath = project.path === thread.workingDirectory;
    if (!matchesSession && !matchesPath) return project;
    const threads = upsertThreadSummary(project.threads ?? [], thread);
    const session = matchesSession && project.session
      ? {
        ...project.session,
        threads: upsertThreadSummary(project.session.threads ?? [], thread)
      }
      : project.session;
    return {
      ...project,
      lastThreadId: thread.threadId,
      running: threads.some((item) => item.running || item.status === "running"),
      session,
      threads
    };
  });

export const removeSessionsThread = (sessionList: SessionView[], threadId: string) =>
  sessionList.map((session) => ({
    ...session,
    threads: (session.threads ?? []).filter((thread) => thread.threadId !== threadId)
  }));

export const removeProjectsThread = (projects: ProjectSummary[], threadId: string) =>
  projects.map((project) => {
    const threads = (project.threads ?? []).filter((thread) => thread.threadId !== threadId);
    const session = project.session
      ? {
        ...project.session,
        threads: (project.session.threads ?? []).filter((thread) => thread.threadId !== threadId)
      }
      : project.session;
    const sessions = (project.sessions ?? []).map((session) => ({
      ...session,
      threads: (session.threads ?? []).filter((thread) => thread.threadId !== threadId)
    }));
    return {
      ...project,
      lastThreadId: project.lastThreadId === threadId ? threads[0]?.threadId : project.lastThreadId,
      running: threads.some((thread) => thread.running || thread.status === "running"),
      session,
      sessions,
      threads
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
  composerMode: ComposerMode
) => ({
  model: model === "auto" ? null : model,
  modelReasoningEffort: reasoning === "auto" ? null : reasoning,
  ...(composerMode === "plan" ? { collaborationMode: "plan" as const } : {}),
  ...(composerMode === "goal" ? { goalMode: true } : {})
});

export const isModelCommand = (text: string) => /^\/model\s*$/i.test(text);

export const rawModelLabel = (model: ModelSelection) => model === "auto" ? "Auto" : model;

export const modelOptionLabel = (option: { value: ModelSelection; label: string }) =>
  option.value === "auto" ? option.label : option.value;

export const reasoningOptionLabel = (option: { value: ReasoningSelection; label: string }) =>
  option.value === "auto" ? option.label : option.value;

export const modelOptionsForSelection = (model: ModelSelection) => {
  if (!model || modelOptions.some((option) => option.value === model)) return modelOptions;
  return [...modelOptions, { value: model, label: model }];
};
