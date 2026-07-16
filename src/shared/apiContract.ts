import { z } from "zod";
import { isCronExpression } from "./taskCron.js";
import type {
  MachineDirectoryListing,
  MachineGitWorktreeResult,
  MachineStartSessionResult,
  MachineStopSessionResult,
  MachineSummary
} from "./machineTypes.js";
import type { PluginSummary } from "./pluginTypes.js";
import type {
  ProjectSource,
  ProjectSummary,
  ServerConfig,
  ServerUiConfig,
  StoredMachine,
  StoredProject,
  StoredTask,
  StoredTaskRun,
  TaskRunStatus
} from "./projectTypes.js";
import type { SshHostConfig, SshMachineConnectInput, SshMachineConnection } from "./sshTypes.js";
import type { ModelReasoningEffort, ThreadRateLimits, ThreadRateLimitUsage, ThreadUsage, Usage } from "./usageTypes.js";
import type { CodexHubSurface } from "./surfaceTypes.js";
import type {
  AppServerApprovalDecision,
  AppServerUserInputAnswers,
  CommandPalette,
  CommandPaletteEntry,
  CommandPalettePart,
  ModelCatalogItem,
  SessionStreamEvent,
  SessionSummary,
  ThreadGoalRunPolicy,
  ThreadCandidateSummary,
  ThreadDetail,
  ThreadGoalStatus,
  ThreadRunOptions,
  ThreadStreamEvent,
  ThreadSummary
} from "./threadTypes.js";

export type {
  MachineDirectoryListing,
  MachineGitWorktreeResult,
  MachineStartSessionResult,
  MachineStopSessionResult,
  MachineSummary,
  PluginSummary,
  ProjectSummary,
  ServerConfig,
  ServerUiConfig,
  AppServerApprovalDecision,
  AppServerUserInputAnswers,
  CommandPalette,
  CommandPaletteEntry,
  CommandPalettePart,
  ModelCatalogItem,
  StoredMachine,
  StoredProject,
  SessionStreamEvent,
  SessionSummary,
  StoredTask,
  StoredTaskRun,
  TaskRunStatus,
  ThreadCandidateSummary,
  ThreadDetail,
  ThreadGoalRunPolicy,
  ThreadGoalStatus,
  ThreadRateLimitUsage,
  ThreadRateLimits,
  ThreadRunOptions,
  ThreadStreamEvent,
  ThreadSummary,
  ThreadUsage,
  Usage
};

/** OpenAI reasoning effort 的 Web/API 别名。 */
export type ReasoningEffort = ModelReasoningEffort;

/** Web 使用的 session view；保持 sessionId 必填以兼容历史 UI 代码。 */
export type SessionView = SessionSummary & {
  sessionId: string;
};

/** SSH host 列表接口返回的 host 摘要，合并 SSH config 和 CodexHub 收纳状态。 */
export type SshHostSummary = SshHostConfig & {
  configured?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

/** SSH connection 列表和 mutation 接口返回的连接摘要。 */
export type SshConnectionSummary = SshMachineConnection;

/** registered parent 连接状态，供 Web Registered 面板展示。 */
export type ParentRegistrationStatus = {
  status: "idle" | "starting" | "connecting" | "online" | "offline" | "stopped";
  url?: string;
  machineId?: string;
  name?: string;
  message?: string;
  updatedAt?: string;
};

/** 认证状态接口返回值。 */
export type AuthStatusPayload = {
  authRequired: boolean;
  authenticated: boolean;
};

export type ServerConfigPayload = {
  config: ServerConfig;
};

export type ServerConfigUpdateInput = {
  ui?: Partial<ServerUiConfig>;
};

/** `/api/health` 返回的 server 运行状态和默认配置。 */
export type HealthPayload = AuthStatusPayload & {
  ok?: boolean;
  serverInstanceId?: string;
  env?: string;
  build?: string | null;
  host?: string;
  port?: number;
  surface?: CodexHubSurface;
  features?: Record<string, boolean>;
  staticDirectory?: string;
  configPath?: string;
  statePath?: string;
  model: string | null;
  modelReasoningEffort: ModelReasoningEffort | null;
  serviceTier: string | null;
  contextWindowTokens: number | null;
  defaultWorkingDirectory?: string;
  ssh?: {
    connections?: SshConnectionSummary[];
  };
  telegram?: {
    started?: boolean;
  };
};

/** Web 展示用 task，额外包含 server 按当前时间计算的下一次运行时间。 */
export type TaskView = StoredTask & {
  nextRunAt?: string | null;
};

/** project mutation 中直接返回的 state 层项目记录。 */
export type ProjectRecordPayload = StoredProject & {
  transient?: boolean;
  source?: ProjectSource;
};

/** `/api/projects` 和 projects realtime 事件共享的项目列表 payload。 */
export type ProjectsPayload = {
  seq?: number;
  kind?: "projects";
  configPath: string;
  statePath: string;
  machines: Array<MachineSummary | StoredMachine>;
  projects: ProjectSummary[];
};

/** `/api/machines` 返回的机器列表 payload。 */
export type MachinesPayload = {
  machines?: MachineSummary[];
};

/** `/api/sessions` 返回的 session 列表 payload。 */
export type SessionsPayload = {
  sessions?: SessionSummary[];
  offline?: number;
  removed?: number;
};

/** `/api/threads` 返回的 thread 列表 payload。 */
export type ThreadsPayload = {
  threads?: ThreadSummary[];
  offline?: number;
  removed?: number;
};

/** `/api/tasks` 返回的 task 列表 payload。 */
export type TasksPayload = {
  tasks?: TaskView[];
};

/** `/api/plugins` 返回的插件列表 payload。 */
export type PluginsPayload = {
  plugins?: PluginSummary[];
};

/** `/api/ssh/hosts` 和 `/api/ssh/config-hosts` 返回的 host 列表 payload。 */
export type SshHostsPayload = {
  hosts?: SshHostSummary[];
  ok?: boolean;
  deleted?: boolean;
};

/** `/api/ssh/connections` 返回的 SSH 连接列表 payload。 */
export type SshConnectionsPayload = {
  connections?: SshConnectionSummary[];
};

/** SSH connect/delete mutation 返回的单个连接 payload。 */
export type SshConnectionPayload = {
  ok?: boolean;
  connection?: SshConnectionSummary;
};

/** registered parent 查询、连接和断开接口返回的 payload。 */
export type ParentRegistrationPayload = {
  registration?: ParentRegistrationStatus;
};

/** thread picker 候选接口返回的 payload。 */
export type ThreadCandidatesPayload = {
  threads?: ThreadCandidateSummary[];
};

/** app-server model catalog 接口返回的 payload。 */
export type SessionModelsPayload = {
  models?: ModelCatalogItem[];
};

/** app-server backed composer command palette 接口返回的 payload。 */
export type CommandPalettePayload = {
  palette?: CommandPalette;
};

/** session/thread turn mutation 返回值。 */
export type ThreadTurnPayload = {
  ok?: boolean;
  queued?: boolean;
  thread?: ThreadSummary | ThreadDetail;
  command?: string;
};

/** thread delete mutation 返回值。 */
export type ThreadDeletePayload = {
  deleted?: boolean;
};

/** thread stop mutation 返回值。 */
export type ThreadStopPayload = {
  stopped?: boolean;
};

/** thread context compact mutation 返回值。 */
export type ThreadCompactPayload = {
  ok?: boolean;
};

/** thread review mutation 返回值。 */
export type ThreadReviewPayload = {
  ok?: boolean;
  reviewThreadId?: string;
};

/** thread approval mutation 返回值。 */
export type ThreadApprovalPayload = {
  ok?: boolean;
  status?: "approved" | "denied" | "cancelled";
  decision?: AppServerApprovalDecision;
  thread?: ThreadDetail;
};

/** thread user input mutation 返回值。 */
export type ThreadUserInputPayload = {
  ok?: boolean;
  status?: "answered" | "failed";
  thread?: ThreadDetail;
};

/** thread goal set/clear mutation 返回值。 */
export type ThreadGoalMutationPayload = {
  ok?: boolean;
};

/** thread rename mutation 返回值。 */
export type ThreadRenamePayload = {
  ok?: boolean;
  thread?: ThreadDetail;
};

/** 基于 project path 启动/复用 machine runtime 并创建或恢复 thread 的返回值。 */
export type ProjectThreadStartPayload = ProjectsPayload & {
  ok?: boolean;
  machine?: MachineSummary;
  project?: ProjectRecordPayload | ProjectSummary;
  result?: {
    cwd?: string;
    sessionId?: string;
    threadId?: string;
  };
};

/** 创建 git worktree project 并启动对应 Codex thread 的请求 body。 */
export type WorktreeThreadStartInput = {
  parentProjectId: string;
  branch: string;
  baseRef?: string;
  path?: string;
  reuse?: boolean;
  persist?: boolean;
};

/** worktree thread 启动返回值，包含创建出的 worktree 路径。 */
export type WorktreeThreadStartPayload = ProjectThreadStartPayload & {
  worktree?: MachineGitWorktreeResult;
};

/** project update/delete mutation 返回值，包含更新后的项目快照。 */
export type ProjectMutationPayload = ProjectsPayload & {
  ok?: boolean;
  deleted?: boolean;
  transient?: boolean;
  project?: ProjectRecordPayload | ProjectSummary;
};

/** task create/update/run mutation 返回值；run 可能额外返回定位到的 session/thread。 */
export type TaskMutationPayload = {
  ok?: boolean;
  skipped?: boolean;
  task?: TaskView;
  sessionId?: string;
  threadId?: string;
  command?: string;
};

/** `/api/events/ws` 的 projects 控制面事件。 */
export type ProjectsStreamEvent = Omit<ProjectsPayload, "seq" | "kind"> & {
  seq: number;
  kind: "projects";
};

/** `/api/events/ws` 的 tasks 控制面事件。 */
export type TasksStreamEvent = {
  seq: number;
  kind: "tasks";
  tasks: TaskView[];
};

/** `/api/events/ws` 的 connections 控制面事件。 */
export type ConnectionsStreamEvent = {
  seq: number;
  kind: "connections";
  connections: SshConnectionSummary[];
  registration?: ParentRegistrationStatus;
};

/** WebSocket 从 server 发给 Web 的所有入站消息。 */
export type RealtimeMessage =
  | ({ type: "sessions" } & SessionStreamEvent)
  | ({ type: "projects" } & ProjectsStreamEvent)
  | ({ type: "tasks" } & TasksStreamEvent)
  | ({ type: "connections" } & ConnectionsStreamEvent)
  | ({ type: ThreadStreamEvent["kind"] } & ThreadStreamEvent)
  | { type: "ready" }
  | { type: "thread_subscribed" | "thread_unsubscribed"; threadId: string }
  | { type: "error"; message: string; scope?: string; threadId?: string };

/** Web 通过 `/api/events/ws` 发给 server 的出站消息。 */
export type RealtimeOutgoingMessage = WebEventsMessage;

export const inputSchema = z.union([
  z.string(),
  z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("image"),
        url: z.string().min(1),
        detail: z.enum(["auto", "low", "high", "original"]).optional()
      })
    ])
  )
]);

const approvalPolicySchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);

const sandboxPolicySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("dangerFullAccess")
  }).strict(),
  z.object({
    type: z.literal("readOnly"),
    networkAccess: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("workspaceWrite"),
    writableRoots: z.array(z.string().min(1)),
    networkAccess: z.boolean(),
    excludeTmpdirEnvVar: z.boolean(),
    excludeSlashTmp: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("externalSandbox"),
    networkAccess: z.enum(["restricted", "enabled"])
  }).strict()
]);

export const modelReasoningEffortSchema = z.string().min(1);

export const threadRunOptionsSchema = z.object({
  model: z.string().min(1).nullable().optional(),
  modelReasoningEffort: modelReasoningEffortSchema.nullable().optional(),
  serviceTier: z.string().min(1).nullable().optional(),
  approvalPolicy: approvalPolicySchema.nullable().optional(),
  sandboxPolicy: sandboxPolicySchema.nullable().optional(),
  collaborationMode: z.enum(["default", "plan"]).nullable().optional(),
  goalMode: z.boolean().nullable().optional(),
  goalObjective: z.string().min(1).nullable().optional(),
  goalTokenBudget: z.number().int().positive().nullable().optional()
});

export const threadGoalStatusSchema = z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);

export const threadGoalRunPolicySchema = z.object({
  type: z.literal("consumeUntilWeeklyRemainingAtOrBelow"),
  targetRemainingPercent: z.number().finite().min(0).lt(100)
}).strict();

export const threadGoalUpdateSchema = z.object({
  objective: z.string().min(1).nullable().optional(),
  status: threadGoalStatusSchema.nullable().optional(),
  tokenBudget: z.number().int().positive().nullable().optional(),
  runPolicy: threadGoalRunPolicySchema.nullable().optional()
});

export const threadApprovalDecisionSchema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["approve", "approve_for_session", "deny", "cancel"])
}).strict();

const threadUserInputAnswerSchema = z.object({
  answers: z.array(z.string())
}).strict();

export const threadUserInputResponseSchema = z.object({
  userInputId: z.string().min(1),
  answers: z.record(z.string(), threadUserInputAnswerSchema)
}).strict();

const appServerApprovalRequestSchema = z.object({
  approvalId: z.string().min(1),
  method: z.string().min(1),
  requestId: z.union([z.string().min(1), z.number()]),
  kind: z.enum(["command_execution", "file_change", "mcp_elicitation", "permissions_request", "legacy_exec_command", "legacy_apply_patch"]),
  threadId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  params: z.unknown()
}).strict();

const appServerUserInputQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string(),
  question: z.string(),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(z.object({
    label: z.string(),
    description: z.string().optional()
  }).strict()).nullable()
}).strict();

const appServerUserInputRequestSchema = z.object({
  userInputId: z.string().min(1),
  method: z.string().min(1),
  requestId: z.union([z.string().min(1), z.number()]),
  threadId: z.string().min(1),
  turnId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  questions: z.array(appServerUserInputQuestionSchema),
  params: z.unknown()
}).strict();

export const threadRenameSchema = z.object({
  title: z.string().trim().min(1).max(200)
}).strict();

export const projectSourceSchema = z.object({
  kind: z.enum(["vscode", "theia"]),
  groupId: z.string().min(1),
  label: z.string().min(1).optional()
}).strict();

export const machineRegistrationProjectSchema = z.object({
  path: z.string().min(1),
  source: projectSourceSchema.optional()
}).strict();

export const sessionRegistrationSchema = z.object({
  machineId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  workingDirectory: z.string().min(1),
  appServerUrl: z.string().min(1).optional(),
  pid: z.number().int().optional(),
  hostname: z.string().min(1).optional(),
  currentThreadId: z.string().min(1).optional()
}).strict();

export const sessionHeartbeatSchema = sessionRegistrationSchema.partial();

export const sessionEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("thread_event"),
    threadId: z.string().min(1),
    commandId: z.string().min(1).optional(),
    heartbeat: z.boolean().optional(),
    message: z.unknown()
  }),
  z.object({
    type: z.literal("thread_turns_snapshot"),
    threadId: z.string().min(1),
    heartbeat: z.boolean().optional(),
    turns: z.array(z.unknown())
  }),
  z.object({
    type: z.literal("thread_execution_changed"),
    threadId: z.string().min(1),
    running: z.boolean(),
    turnId: z.string().min(1).optional(),
    heartbeat: z.boolean().optional()
  }),
  z.object({
    type: z.literal("thread_settings_changed"),
    threadId: z.string().min(1),
    model: z.string().min(1).nullable().optional(),
    modelReasoningEffort: modelReasoningEffortSchema.nullable().optional(),
    serviceTier: z.string().min(1).nullable().optional(),
    approvalPolicy: approvalPolicySchema.nullable().optional(),
    sandboxPolicy: sandboxPolicySchema.nullable().optional(),
    heartbeat: z.boolean().optional()
  }),
  z.object({
    type: z.literal("account_rate_limits_updated"),
    rateLimits: z.unknown(),
    heartbeat: z.boolean().optional()
  }),
  z.object({
    type: z.literal("approval_request"),
    threadId: z.string().min(1),
    approval: appServerApprovalRequestSchema,
    heartbeat: z.boolean().optional()
  }),
  z.object({
    type: z.literal("user_input_request"),
    threadId: z.string().min(1),
    userInput: appServerUserInputRequestSchema,
    heartbeat: z.boolean().optional()
  })
]);

export const machineRegistrationSchema = z.object({
  machineId: z.string().min(1).optional(),
  type: z.enum(["local", "ssh", "registered"]).optional(),
  name: z.string().min(1).optional(),
  hostname: z.string().min(1),
  pid: z.number().int().optional(),
  platform: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  capabilities: z.object({
    projectLauncher: z.boolean().optional(),
    projectCatalog: z.enum(["editable", "fixed"]).optional()
  }).optional(),
  projects: z.array(machineRegistrationProjectSchema).optional()
});

export const machineHeartbeatSchema = machineRegistrationSchema.partial();

export const machineStartSessionResultSchema = z.object({
  sessionId: z.string().min(1),
  threadId: z.string().min(1),
  appServerUrl: z.string().min(1),
  cwd: z.string().min(1),
  reused: z.boolean().optional()
});

export const machineDirectoryListingSchema = z.object({
  cwd: z.string().min(1),
  parent: z.string().min(1).optional(),
  home: z.string().min(1),
  entries: z.array(z.object({
    name: z.string().min(1),
    path: z.string().min(1)
  }))
});

export const machineGitWorktreeResultSchema = z.object({
  parentCwd: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  baseRef: z.string().min(1).optional(),
  createdBranch: z.boolean()
});

export const machineStopSessionResultSchema = z.object({
  sessionId: z.string().min(1),
  stopped: z.boolean(),
  cwd: z.string().min(1).optional()
});

export const appServerTunnelFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("app_server_tunnel_open"),
    streamId: z.string().min(1),
    appServerId: z.string().min(1)
  }),
  z.object({
    type: z.literal("app_server_tunnel_opened"),
    streamId: z.string().min(1)
  }),
  z.object({
    type: z.literal("app_server_tunnel_message"),
    streamId: z.string().min(1),
    data: z.string()
  }),
  z.object({
    type: z.literal("app_server_tunnel_close"),
    streamId: z.string().min(1),
    reason: z.string().optional()
  }),
  z.object({
    type: z.literal("app_server_tunnel_error"),
    streamId: z.string().min(1),
    message: z.string().min(1)
  })
]);

export const parentRegistrationConnectSchema = z.object({
  url: z.string().url(),
  authToken: z.string().optional(),
  machineId: z.string().min(1).optional(),
  name: z.string().min(1).optional()
}).strict();

export const machineTransportMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("register"),
    commandCursor: z.number().int().min(0).optional(),
    registration: machineRegistrationSchema
  }),
  z.object({
    type: z.literal("unregister")
  }),
  z.object({
    type: z.literal("heartbeat"),
    registration: machineHeartbeatSchema.optional()
  }),
  z.object({
    type: z.literal("command_result"),
    commandId: z.string().min(1),
    result: z.union([
      machineStartSessionResultSchema,
      machineDirectoryListingSchema,
      machineGitWorktreeResultSchema,
      machineStopSessionResultSchema
    ])
  }),
  z.object({
    type: z.literal("command_error"),
    commandId: z.string().min(1),
    message: z.string().min(1)
  }),
  z.object({
    type: z.literal("session_register"),
    sessionId: z.string().min(1),
    commandCursor: z.number().int().min(0).optional(),
    registration: sessionRegistrationSchema
  }),
  z.object({
    type: z.literal("session_unregister"),
    sessionId: z.string().min(1)
  }),
  z.object({
    type: z.literal("session_heartbeat"),
    sessionId: z.string().min(1),
    registration: sessionHeartbeatSchema.optional()
  }),
  z.object({
    type: z.literal("session_event"),
    sessionId: z.string().min(1),
    event: sessionEventSchema
  }),
  z.object({
    type: z.literal("session_command_result"),
    sessionId: z.string().min(1),
    commandId: z.string().min(1),
    result: z.unknown()
  }),
  z.object({
    type: z.literal("session_command_error"),
    sessionId: z.string().min(1),
    commandId: z.string().min(1),
    message: z.string().min(1)
  }),
  z.object({
    type: z.literal("app_server_ready"),
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    appServerId: z.string().min(1),
    cwd: z.string().min(1),
    appServerUrl: z.string().min(1)
  }),
  z.object({
    type: z.literal("app_server_start_thread"),
    commandId: z.string().min(1),
    sessionId: z.string().min(1),
    cwd: z.string().min(1),
    threadId: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal("app_server_stopped"),
    sessionId: z.string().min(1)
  }),
  ...appServerTunnelFrameSchema.options
]);

export const webEventsMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    sessionsAfter: z.number().int().min(0).optional(),
    projectsAfter: z.number().int().min(0).optional(),
    tasksAfter: z.number().int().min(0).optional(),
    connectionsAfter: z.number().int().min(0).optional()
  }).strict(),
  z.object({
    type: z.literal("subscribe_thread"),
    threadId: z.string().min(1),
    after: z.number().int().min(0).optional()
  }).strict(),
  z.object({
    type: z.literal("unsubscribe_thread"),
    threadId: z.string().min(1)
  }).strict()
]);

export const sshConnectSchema = z.object({
  host: z.string().min(1),
  name: z.string().min(1).optional(),
  remotePort: z.number().int().min(1).max(65535).optional(),
  remoteCommand: z.string().min(1).optional()
}) satisfies z.ZodType<SshMachineConnectInput>;

export const sshHostAliasSchema = z.object({
  alias: z.string().min(1)
}).strict();

export const cronScheduleSchema = z.string().min(1).refine(isCronExpression, {
  message: "Invalid cron schedule. Use five fields such as \"0 9 * * *\"."
});

export const taskCreateSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  schedule: cronScheduleSchema,
  machineId: z.string().min(1),
  projectPath: z.string().min(1),
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  input: z.string().min(1)
});

export const taskUpdateSchema = taskCreateSchema.partial();

export const projectUpdateSchema = z.object({
  pinned: z.boolean().nullable().optional()
}).strict();

/** 用户输入 payload，可为纯文本或文本/图片混合输入。 */
export type ProxyInputPayload = z.infer<typeof inputSchema>;

/** Web 订阅 realtime WebSocket 时发送的消息。 */
export type WebEventsMessage = z.infer<typeof webEventsMessageSchema>;

/** machine WebSocket 发给 server 的入站消息。 */
export type MachineTransportIncomingMessage = z.infer<typeof machineTransportMessageSchema>;

/** registered parent 连接请求 body。 */
export type ParentRegistrationConnectInput = z.infer<typeof parentRegistrationConnectSchema>;

/** 创建 task 的请求 body。 */
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

/** 更新 task 的请求 body。 */
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

/** 更新 project 元数据的请求 body。 */
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

/** 更新 thread goal 的请求 body。 */
export type ThreadGoalUpdateInput = z.infer<typeof threadGoalUpdateSchema>;

/** 响应 app-server approval request 的请求 body。 */
export type ThreadApprovalDecisionInput = z.infer<typeof threadApprovalDecisionSchema>;

/** 响应 app-server request_user_input 的请求 body。 */
export type ThreadUserInputResponseInput = z.infer<typeof threadUserInputResponseSchema>;

/** 更新 thread 展示名称的请求 body。 */
export type ThreadRenameInput = z.infer<typeof threadRenameSchema>;
