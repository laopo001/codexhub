import { z } from "zod";
import type { MachineDirectoryListing, MachineStartSessionResult, MachineStopSessionResult, MachineSummary } from "../core/machineHub.js";
import type { PluginSummary } from "../core/pluginHub.js";
import type { ProjectSummary, StoredTask, StoredTaskRun, TaskRunStatus } from "../core/serverState.js";
import type { SshHostConfig } from "../core/sshConfig.js";
import type { SshMachineConnectInput, SshMachineConnection } from "../core/sshMachine.js";
import { isCronExpression } from "../core/taskCron.js";
import type { ModelReasoningEffort, Usage } from "../core/threadOptions.js";
import type { ThreadRateLimitUsage, ThreadRateLimits, ThreadUsage } from "../core/threadUsage.js";
import type { SessionSummary, ThreadDetail, ThreadGoalStatus, ThreadRunOptions, ThreadSummary } from "../core/threadHub.js";

export type {
  MachineDirectoryListing,
  MachineStartSessionResult,
  MachineStopSessionResult,
  MachineSummary,
  PluginSummary,
  ProjectSummary,
  SessionSummary,
  StoredTask,
  StoredTaskRun,
  TaskRunStatus,
  ThreadDetail,
  ThreadGoalStatus,
  ThreadRateLimitUsage,
  ThreadRateLimits,
  ThreadRunOptions,
  ThreadSummary,
  ThreadUsage,
  Usage
};

export type ReasoningEffort = ModelReasoningEffort;

export type SessionView = SessionSummary & {
  sessionId: string;
};

export type SshHostSummary = SshHostConfig & {
  configured?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type SshConnectionSummary = SshMachineConnection;

export type ParentRegistrationStatus = {
  status: "idle" | "starting" | "connecting" | "online" | "offline" | "stopped";
  url?: string;
  machineId?: string;
  name?: string;
  message?: string;
  updatedAt?: string;
};

export type ProjectsPayload = {
  seq?: number;
  kind?: "projects";
  statePath?: string;
  machines?: MachineSummary[];
  projects?: ProjectSummary[];
};

export type SessionsPayload = {
  sessions?: SessionSummary[];
};

export type TasksPayload = {
  tasks?: StoredTask[];
};

export type PluginsPayload = {
  plugins?: PluginSummary[];
};

export type SshHostsPayload = {
  hosts?: SshHostSummary[];
};

export type SshConnectionsPayload = {
  connections?: SshConnectionSummary[];
};

export type ParentRegistrationPayload = {
  registration?: ParentRegistrationStatus;
};

export type ThreadCandidatesPayload = {
  threads?: ThreadCandidateSummary[];
};

export type ProjectOpenPayload = ProjectsPayload & {
  result?: {
    cwd?: string;
    sessionId?: string;
    threadId?: string;
  };
};

export type TaskMutationPayload = {
  task?: StoredTask;
};

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

export const threadRunOptionsSchema = z.object({
  model: z.string().min(1).nullable().optional(),
  modelReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().optional(),
  collaborationMode: z.enum(["default", "plan"]).nullable().optional(),
  goalMode: z.boolean().nullable().optional(),
  goalObjective: z.string().min(1).nullable().optional(),
  goalTokenBudget: z.number().int().positive().nullable().optional()
});

export const threadGoalStatusSchema = z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);

export const threadGoalUpdateSchema = z.object({
  objective: z.string().min(1).nullable().optional(),
  status: threadGoalStatusSchema.nullable().optional(),
  tokenBudget: z.number().int().positive().nullable().optional()
});

export const projectSourceSchema = z.object({
  kind: z.literal("vscode"),
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
    modelReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullable().optional(),
    heartbeat: z.boolean().optional()
  }),
  z.object({
    type: z.literal("account_rate_limits_updated"),
    rateLimits: z.unknown(),
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
    result: z.union([machineStartSessionResultSchema, machineDirectoryListingSchema, machineStopSessionResultSchema])
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
    cwd: z.string().min(1)
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

export type ProxyInputPayload = z.infer<typeof inputSchema>;
export type WebEventsMessage = z.infer<typeof webEventsMessageSchema>;
export type MachineTransportIncomingMessage = z.infer<typeof machineTransportMessageSchema>;
export type ParentRegistrationConnectInput = z.infer<typeof parentRegistrationConnectSchema>;
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
export type ThreadGoalUpdateInput = z.infer<typeof threadGoalUpdateSchema>;

export type ThreadCandidateSummary = {
  threadId: string;
  cwd: string;
  path: string;
  updatedAt: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
  artifactCount: number;
  messageCount: number;
};
