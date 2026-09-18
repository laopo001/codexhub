import type {
  HealthPayload,
  FilePreviewPayload,
  MachineDirectoryListing,
  MachineThreadInput,
  MachinesPayload,
  DeveloperInstructionsPayload,
  DeveloperInstructionMutationPayload,
  DeveloperInstructionCreateInput,
  DeveloperInstructionUpdateInput,
  ParentRegistrationConnectInput,
  ParentRegistrationPayload,
  PetMutationPayload,
  PetsPayload,
  PluginsPayload,
  CommandPalettePayload,
  CommitMessageGenerationInput,
  CommitMessageGenerationPayload,
  ProjectMutationPayload,
  ProjectThreadStartPayload,
  ProjectUpdateInput,
  ProjectsPayload,
  ServerConfigPayload,
  ServerConfigUpdateInput,
  RuntimeEnsurePayload,
  RuntimeModelsPayload,
  RuntimePermissionProfilesPayload,
  RuntimesPayload,
  RestartPayload,
  SshConnectionPayload,
  SshConnectionsPayload,
  SshHostsPayload,
  TaskCreateInput,
  TaskMutationPayload,
  TasksPayload,
  TaskUpdateInput,
  ThreadCandidatesPayload,
  ThreadDeletePayload,
  ThreadDetail,
  ThreadEndPayload,
  ThreadBackgroundTerminalTerminatePayload,
  ThreadApprovalDecisionInput,
  ThreadApprovalPayload,
  ThreadCompactPayload,
  ThreadGoalMutationPayload,
  ThreadGoalUpdateInput,
  ThreadRenameInput,
  ThreadRenamePayload,
  ThreadTitleSuggestionPayload,
  ThreadReviewPayload,
  ThreadStopPayload,
  ThreadQueueCancelPayload,
  ThreadTurnPayload,
  ThreadUserInputPayload,
  ThreadUserInputResponseInput,
  WorktreeThreadStartInput,
  WorktreeThreadStartPayload,
  EmbeddedSurfacePayload,
  EmbeddedSurfaceRegistrationInput,
  WebClientHeartbeatInput,
  WebClientHeartbeatPayload
} from "./apiContract.js";
import type { ProxyInput } from "./inputTypes.js";
import type { CommandPalettePart, ThreadRunOptions } from "./threadTypes.js";

/** HTTP method 枚举，作为 typed API route map 的 method 维度。 */
export type ApiHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** route 的 path 可以是固定字符串，也可以是带参数的 path builder。 */
export type ApiRoutePath = string | ((...args: never[]) => string);

/** 单个 API route 的类型描述；request/response 只用于类型推导，不进入运行时对象。 */
export type ApiRouteSpec<
  Method extends ApiHttpMethod,
  Path extends ApiRoutePath,
  Request,
  Response,
  HasBody extends boolean
> = {
  method: Method;
  path: Path;
  hasBody: HasBody;
  readonly __request?: Request;
  readonly __response?: Response;
};

/** 任意 typed API route。 */
export type AnyApiRoute = ApiRouteSpec<ApiHttpMethod, ApiRoutePath, unknown, unknown, boolean>;

/** 从 route 推导请求 body 类型。 */
export type ApiRouteRequest<Route extends AnyApiRoute> =
  Route extends ApiRouteSpec<ApiHttpMethod, ApiRoutePath, infer Request, unknown, boolean> ? Request : never;

/** 从 route 推导响应 JSON 类型。 */
export type ApiRouteResponse<Route extends AnyApiRoute> =
  Route extends ApiRouteSpec<ApiHttpMethod, ApiRoutePath, unknown, infer Response, boolean> ? Response : never;

/** 从 route path builder 推导路径参数。 */
export type ApiRoutePathArgs<Route extends AnyApiRoute> =
  Route["path"] extends (...args: infer Args) => string ? Args : [];

/** typed client 调用参数：path 参数在前，有 body 的 route 最后追加 request body。 */
export type ApiRouteCallArgs<Route extends AnyApiRoute> =
  Route["hasBody"] extends true
    ? [...ApiRoutePathArgs<Route>, ApiRouteRequest<Route>]
    : ApiRoutePathArgs<Route>;

type FixedOrBuilder<Args extends unknown[] = never[]> = string | ((...args: Args) => string);

const get = <Response, const Path extends FixedOrBuilder = FixedOrBuilder>(path: Path) =>
  ({ method: "GET", path, hasBody: false }) as ApiRouteSpec<"GET", Path, undefined, Response, false>;

const post = <Request, Response, const Path extends FixedOrBuilder = FixedOrBuilder>(path: Path) =>
  ({ method: "POST", path, hasBody: true }) as ApiRouteSpec<"POST", Path, Request, Response, true>;

const postNoBody = <Response, const Path extends FixedOrBuilder = FixedOrBuilder>(path: Path) =>
  ({ method: "POST", path, hasBody: false }) as ApiRouteSpec<"POST", Path, undefined, Response, false>;

const patch = <Request, Response, const Path extends FixedOrBuilder = FixedOrBuilder>(path: Path) =>
  ({ method: "PATCH", path, hasBody: true }) as ApiRouteSpec<"PATCH", Path, Request, Response, true>;

const del = <Response, const Path extends FixedOrBuilder = FixedOrBuilder>(path: Path) =>
  ({ method: "DELETE", path, hasBody: false }) as ApiRouteSpec<"DELETE", Path, undefined, Response, false>;

const encode = (value: string) => encodeURIComponent(value);

const queryString = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
};

export type ProjectThreadStartInput = {
  path: string;
  machineId?: string;
  reuse?: boolean;
  persist?: boolean;
  source?: { kind: "vscode" | "electron"; groupId: string; label?: string };
};

export type { MachineThreadInput };

export type ThreadForkInput = {
  messageId: string;
};

export type ThreadTurnInput = {
  submissionId?: string;
  input: ProxyInput;
  source?: "web" | "telegram" | "task";
  options?: ThreadRunOptions;
};

/** 前后端共享的 HTTP API route map。 */
export const apiRoutes = {
  health: get<HealthPayload>("/api/health"),
  restartAuthority: postNoBody<RestartPayload>("/api/restart"),
  config: get<ServerConfigPayload>("/api/config"),
  updateConfig: patch<ServerConfigUpdateInput, ServerConfigPayload>("/api/config"),
  machines: get<MachinesPayload>("/api/machines"),
  /** @deprecated Use `machines` and read each machine's nested `runtime`. */
  runtimes: get<RuntimesPayload>("/api/runtimes"),
  projects: get<ProjectsPayload>("/api/projects"),
  tasks: get<TasksPayload>("/api/tasks"),
  plugins: get<PluginsPayload>("/api/plugins"),
  pets: get<PetsPayload>("/api/pets"),
  deletePet: del<PetMutationPayload, (petId: string) => string>(
    (petId) => `/api/pets/${encode(petId)}`
  ),
  sshHosts: get<SshHostsPayload>("/api/ssh/hosts"),
  sshConfigHosts: get<SshHostsPayload>("/api/ssh/config-hosts"),
  sshConnections: get<SshConnectionsPayload>("/api/ssh/connections"),
  parentRegistration: get<ParentRegistrationPayload>("/api/registered/parent"),
  registerEmbeddedSurface: post<EmbeddedSurfaceRegistrationInput, EmbeddedSurfacePayload>("/api/embedded/surfaces"),
  heartbeatWebClient: post<WebClientHeartbeatInput, WebClientHeartbeatPayload>("/api/web-clients/heartbeat"),
  unregisterEmbeddedSurface: del<EmbeddedSurfacePayload, (surfaceId: string, leaseId: string) => string>(
    (surfaceId, leaseId) => `/api/embedded/surfaces/${encode(surfaceId)}/${encode(leaseId)}`
  ),
  machineDirectories: get<MachineDirectoryListing, (machineId: string, path?: string) => string>(
    (machineId, path) => `/api/machines/${encode(machineId)}/directories${queryString({ path })}`
  ),
  machineFilePreview: post<{ path: string }, FilePreviewPayload, (machineId: string) => string>(
    (machineId) => `/api/machines/${encode(machineId)}/files/preview`
  ),
  ensureRuntime: post<{ cwd: string }, RuntimeEnsurePayload, (machineId: string) => string>(
    (machineId) => `/api/machines/${encode(machineId)}/runtime/ensure`
  ),
  threadCandidates: get<ThreadCandidatesPayload, (machineId: string, cwd?: string, limit?: number) => string>(
    (machineId, cwd, limit = 20) => `/api/machines/${encode(machineId)}/thread-candidates${queryString({ limit, cwd })}`
  ),
  runtimeModels: get<RuntimeModelsPayload, (machineId: string, includeHidden?: boolean, refresh?: boolean) => string>(
    (machineId, includeHidden, refresh) => `/api/machines/${encode(machineId)}/models${queryString({
      includeHidden: includeHidden ? "true" : undefined,
      refresh: refresh ? "true" : undefined
    })}`
  ),
  runtimePermissionProfiles: get<
    RuntimePermissionProfilesPayload,
    (machineId: string, cwd: string) => string
  >(
    (machineId, cwd) => `/api/machines/${encode(machineId)}/permission-profiles${queryString({ cwd })}`
  ),
  commandPalette: get<CommandPalettePayload, (machineId: string, cwd?: string, part?: CommandPalettePart) => string>(
    (machineId, cwd, part) =>
      `/api/machines/${encode(machineId)}/command-palette${queryString({ cwd, part })}`
  ),
  machineApps: get<import("./apiContract.js").MachineAppsPayload, (machineId: string, threadId?: string) => string>(
    (machineId, threadId) => `/api/machines/${encode(machineId)}/apps${queryString({ threadId })}`
  ),
  reconcileMachinePlugins: post<{ reason?: string }, import("./apiContract.js").MachinePluginReconcilePayload, (machineId: string) => string>(
    (machineId) => `/api/machines/${encode(machineId)}/plugins/reconcile`
  ),
  generateCommitMessage: post<
    CommitMessageGenerationInput,
    CommitMessageGenerationPayload,
    (machineId: string) => string
  >(
    (machineId) => `/api/machines/${encode(machineId)}/commit-message`
  ),
  thread: get<ThreadDetail, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}`
  ),
  threadHistory: get<ThreadDetail, (threadId: string, before?: string, limit?: number) => string>(
    (threadId, before, limit) => `/api/threads/${encode(threadId)}/history${queryString({ before, limit })}`
  ),
  createMachineThread: post<MachineThreadInput, ThreadDetail, (machineId: string) => string>(
    (machineId) => `/api/machines/${encode(machineId)}/threads`
  ),
  startProjectThread: post<ProjectThreadStartInput, ProjectThreadStartPayload>("/api/projects/open"),
  startWorktreeThread: post<WorktreeThreadStartInput, WorktreeThreadStartPayload>("/api/projects/worktree/open"),
  createTask: post<TaskCreateInput, TaskMutationPayload>("/api/tasks"),
  updateTask: patch<TaskUpdateInput, TaskMutationPayload, (taskId: string) => string>(
    (taskId) => `/api/tasks/${encode(taskId)}`
  ),
  deleteTask: del<{ ok?: boolean; deleted?: boolean }, (taskId: string) => string>(
    (taskId) => `/api/tasks/${encode(taskId)}`
  ),
  runTask: postNoBody<TaskMutationPayload, (taskId: string) => string>(
    (taskId) => `/api/tasks/${encode(taskId)}/run`
  ),
  deleteProject: del<ProjectMutationPayload, (projectId: string) => string>(
    (projectId) => `/api/projects/${encode(projectId)}`
  ),
  updateProject: patch<ProjectUpdateInput, ProjectMutationPayload, (projectId: string) => string>(
    (projectId) => `/api/projects/${encode(projectId)}`
  ),
  forkThread: post<ThreadForkInput, ThreadDetail, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}/fork`
  ),
  sendThreadTurn: post<ThreadTurnInput, ThreadTurnPayload, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}/turn`
  ),
  cancelQueuedThreadTurn: del<ThreadQueueCancelPayload, (threadId: string, submissionId: string) => string>(
    (threadId, submissionId) => `/api/threads/${encode(threadId)}/queue/${encode(submissionId)}`
  ),
  stopThreadTurn: postNoBody<ThreadStopPayload, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}/stop`
  ),
  endThread: postNoBody<ThreadEndPayload, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}/end`
  ),
  terminateBackgroundTerminal: postNoBody<
    ThreadBackgroundTerminalTerminatePayload,
    (threadId: string, processId: string) => string
  >(
    (threadId, processId) => `/api/threads/${encode(threadId)}/background-terminals/${encode(processId)}/terminate`
  ),
  compactThread: postNoBody<ThreadCompactPayload, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}/compact`
  ),
  reviewThread: postNoBody<ThreadReviewPayload, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}/review`
  ),
  respondThreadApproval: post<ThreadApprovalDecisionInput, ThreadApprovalPayload, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}/approval`
  ),
  respondThreadUserInput: post<ThreadUserInputResponseInput, ThreadUserInputPayload, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}/user-input`
  ),
  renameThread: patch<ThreadRenameInput, ThreadRenamePayload, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}/name`
  ),
  suggestThreadTitle: postNoBody<ThreadTitleSuggestionPayload, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}/name/suggest`
  ),
  updateThreadGoal: post<ThreadGoalUpdateInput, ThreadGoalMutationPayload, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}/goal`
  ),
  clearThreadGoal: del<ThreadGoalMutationPayload, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}/goal`
  ),
  deleteThread: del<ThreadDeletePayload, (threadId: string) => string>(
    (threadId) => `/api/threads/${encode(threadId)}`
  ),
  connectSsh: post<{ host: string; name?: string }, SshConnectionPayload>("/api/ssh/connect"),
  stopSshConnection: del<SshConnectionPayload, (connectionId: string) => string>(
    (connectionId) => `/api/ssh/connections/${encode(connectionId)}`
  ),
  addSshHost: post<{ alias: string }, SshHostsPayload>("/api/ssh/hosts"),
  removeSshHost: del<SshHostsPayload, (alias: string) => string>(
    (alias) => `/api/ssh/hosts/${encode(alias)}`
  ),
  connectParentRegistration: post<ParentRegistrationConnectInput, ParentRegistrationPayload>("/api/registered/parent"),
  disconnectParentRegistration: del<ParentRegistrationPayload>("/api/registered/parent"),
  developerInstructions: get<DeveloperInstructionsPayload>("/api/developer-instructions"),
  createDeveloperInstruction: post<DeveloperInstructionCreateInput, DeveloperInstructionMutationPayload>("/api/developer-instructions"),
  updateDeveloperInstruction: patch<DeveloperInstructionUpdateInput, DeveloperInstructionMutationPayload, (id: string) => string>(
    (id) => `/api/developer-instructions/${encode(id)}`
  ),
  deleteDeveloperInstruction: del<DeveloperInstructionMutationPayload, (id: string) => string>(
    (id) => `/api/developer-instructions/${encode(id)}`
  )
} as const;
