import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { resolveCodexAppServerLaunchOptions } from "../src/cli/codexAppServerProcess.js";
import {
  accountRateLimitsPayloadFromValue,
  fiveHourRateLimitWindowMinutes,
  rateLimitUsageForWindowMinutes,
  sevenDayRateLimitWindowMinutes
} from "../src/core/threadUsage.js";
import type { MachineDirectoryEntry } from "../src/shared/machineTypes.js";
import type { CodexRecord } from "../src/shared/recordTypes.js";
import type { SessionEventInput, ThreadSummary } from "../src/shared/threadTypes.js";
import type { OpenThreadState, ProjectMachineGroup, ProjectSummary, RuntimeSummary } from "../src/web/types.js";
import { assertNoWorkerId, findKey } from "./smoke/support/assertions.js";
import { apiJson } from "./smoke/support/http.js";
import { findFreePort } from "./smoke/support/network.js";
import { delay } from "./smoke/support/time.js";
import {
  appServerTurn,
  executionChanged,
  turnCompleted,
  turnSnapshot
} from "./test-support/appServerEvents.js";

type MachineSummary = {
  machineId: string;
  type?: string;
  online?: boolean;
  capabilities?: {
    projectLauncher?: boolean;
  };
};

type ProjectThreadStartResponse = {
  project?: {
    projectId?: string;
  };
  result?: {
    machineId?: string;
    threadId?: string;
    cwd?: string;
  };
};

type ProjectsPayload = {
  projects?: unknown[];
};

type RuntimesPayload = {
  runtimes?: Array<{
    machineId?: string;
    online?: boolean;
  }>;
};

type ThreadDetail = {
  threadId: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  records?: unknown[];
};

type CommandPalettePayload = {
  palette?: {
    entries?: unknown[];
  };
};

type RealtimeMessage = {
  type?: string;
  kind?: string;
  threadId?: string;
  thread?: {
    threadId?: string;
  };
};

type LocalTask = {
  taskId: string;
  name: string;
  enabled: boolean;
  schedule: string;
  machineId: string;
  projectPath: string;
  threadId?: string;
  input: string;
  lastStatus?: "queued" | "completed" | "failed" | "skipped";
};

type SshHost = {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  proxyJump?: string;
};

type SshConnection = {
  connectionId: string;
  host: string;
  status: "starting" | "running" | "exited";
  remotePort: number;
  localHost: string;
  localPort: number;
  remoteClientHash: string;
};

type TaskResponse = {
  task?: LocalTask;
};

type TaskRunResponse = TaskResponse & {
  machineId?: string;
  threadId?: string;
  command?: string;
};

const assertTaskThreadSearchMatches = async () => {
  const globalWithWindow = globalThis as unknown as { window?: { location: { search: string } } };
  const previousWindow = globalWithWindow.window;
  globalWithWindow.window = { location: { search: "" } };
  try {
    const { taskThreadSearchMatches } = await import("../src/web/helpers/core.js");
    const thread = {
      threadId: "thread-release-abcdef",
      title: "Release planning",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    if (!taskThreadSearchMatches(thread, "")) throw new Error("task thread search should match an empty query");
    if (!taskThreadSearchMatches(thread, "release")) throw new Error("task thread search should match titles");
    if (!taskThreadSearchMatches(thread, "abcdef")) throw new Error("task thread search should match thread ids");
    if (taskThreadSearchMatches(thread, "billing")) throw new Error("task thread search should reject unrelated queries");
  } finally {
    if (previousWindow) globalWithWindow.window = previousWindow;
    else delete globalWithWindow.window;
  }
};

const assertStatusUsageFormatting = async () => {
  const runtimeGlobal = globalThis as Record<string, unknown>;
  const previousWindow = runtimeGlobal.window;
  if (!previousWindow) runtimeGlobal.window = { location: { search: "" } };
  try {
    const {
      activityStatusesFromRecords,
      activityStatusSnapshotsFromRecords,
      withActivityStatusSnapshots
    } = await import("../src/web/helpers/records.js");
    const { recordsToViews } = await import("../src/core/codexRecordView.js");
    const { recordsToDetailedViews } = await import("../src/web/detailedRecordViews.js");
    const records: CodexRecord[] = [
      {
        id: "app:thread:turn:statusUsage:scope",
        order: 2,
        type: "event_msg",
        payload: {
          type: "status_usage",
          usage: { input_tokens: 1700, output_tokens: 180, total_tokens: 1880 }
        }
      },
      {
        id: "app:thread:turn:usage",
        order: 3,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 200, output_tokens: 50, total_tokens: 250 },
            model_context_window: 353400
          }
        }
      }
    ];
    const usageStatuses = activityStatusesFromRecords(records).filter((status) => status.key === "usage");
    if (usageStatuses.length !== 1 || usageStatuses[0].text !== "total 1.9k · input 1.7k · output 180") {
      throw new Error(`status usage formatting mismatch: ${JSON.stringify(usageStatuses)}`);
    }
    if (usageStatuses[0].text.includes("window")) {
      throw new Error(`status usage should not include window: ${JSON.stringify(usageStatuses[0])}`);
    }
    if (usageStatuses[0].summaryText !== "1.9k · in 1.7k · out 180") {
      throw new Error(`status usage summary formatting mismatch: ${JSON.stringify(usageStatuses[0])}`);
    }

    const perMessageUsageRecords: CodexRecord[] = [
      {
        id: "app:thread:turn:agent:commentary",
        order: 1,
        type: "event_msg",
        payload: { type: "agent_message", phase: "commentary", message: "checking" }
      },
      {
        id: "app:thread:turn:usage:commentary",
        order: 2,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 29323, output_tokens: 66, total_tokens: 29389 } }
        }
      },
      {
        id: "app:thread:turn:agent:final",
        order: 3,
        type: "event_msg",
        payload: { type: "agent_message", phase: "final_answer", message: "done" }
      },
      {
        id: "app:thread:turn:usage:final",
        order: 4,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 29484, output_tokens: 80, total_tokens: 29564 } }
        }
      }
    ];
    for (const views of [recordsToViews(perMessageUsageRecords), recordsToDetailedViews(perMessageUsageRecords)]) {
      const commentary = views.find((view) => view.role === "codex" && view.label === "commentary");
      const finalAnswer = views.find((view) => view.role === "codex" && view.label === "final_answer");
      if (commentary?.usage?.total_tokens !== 29389 || finalAnswer?.usage?.total_tokens !== 29564) {
        throw new Error(`message usage was not bound by model call: ${JSON.stringify(views)}`);
      }
    }

    const scopedRecords: CodexRecord[] = [
      {
        id: "app:thread:goal:user-1",
        order: 1,
        type: "event_msg",
        payload: { type: "user_message", message: "first run" }
      },
      {
        id: "app:thread:goal:file-1",
        order: 2,
        type: "response_item",
        payload: {
          type: "file_change",
          status: "completed",
          changes: [{ path: "src/example.ts", diff: "--- a/src/example.ts\n+++ b/src/example.ts\n-old\n+new\n+extra" }]
        }
      },
      {
        id: "app:thread:goal:usage-1",
        order: 3,
        type: "event_msg",
        payload: { type: "status_usage", usage: { input_tokens: 3000, output_tokens: 120, total_tokens: 3120 } }
      },
      {
        id: "app:thread:goal:final-1",
        order: 4,
        type: "event_msg",
        payload: { type: "agent_message", phase: "final_answer", message: "first complete" }
      },
      {
        id: "app:thread:goal:user-2",
        order: 5,
        type: "event_msg",
        payload: { type: "user_message", message: "second run" }
      },
      {
        id: "app:thread:goal:usage-2",
        order: 6,
        type: "event_msg",
        payload: { type: "status_usage", usage: { input_tokens: 800, output_tokens: 40, total_tokens: 840 } }
      },
      {
        id: "app:thread:goal:final-2",
        order: 7,
        type: "event_msg",
        payload: { type: "agent_message", phase: "final_answer", message: "second complete" }
      }
    ];
    const runningSnapshots = activityStatusSnapshotsFromRecords(scopedRecords, true);
    if (runningSnapshots.length !== 1 || runningSnapshots[0].targetRecordId !== "app:thread:goal:final-1") {
      throw new Error(`running scope should only clone completed status snapshots: ${JSON.stringify(runningSnapshots)}`);
    }
    const firstFiles = runningSnapshots[0].statuses.find((status) => status.key === "files");
    const firstUsage = runningSnapshots[0].statuses.find((status) => status.key === "usage");
    if (firstFiles?.summaryText !== "1 · +2 -1" || firstFiles.files?.[0]?.path !== "src/example.ts") {
      throw new Error(`completed file status snapshot mismatch: ${JSON.stringify(firstFiles)}`);
    }
    if (firstUsage?.text !== "total 3.1k · input 3.0k · output 120") {
      throw new Error(`completed usage status snapshot mismatch: ${JSON.stringify(firstUsage)}`);
    }
    for (const views of [recordsToViews(scopedRecords), recordsToDetailedViews(scopedRecords)]) {
      const viewsWithSnapshots = withActivityStatusSnapshots(views, runningSnapshots);
      const firstFinal = viewsWithSnapshots.find((view) => view.record.id === "app:thread:goal:final-1");
      const secondFinal = viewsWithSnapshots.find((view) => view.record.id === "app:thread:goal:final-2");
      if (firstFinal?.activityStatuses?.length !== 2 || secondFinal?.activityStatuses) {
        throw new Error(`status snapshots were not bound to the correct message view: ${JSON.stringify(viewsWithSnapshots)}`);
      }
    }
    const completedSnapshots = activityStatusSnapshotsFromRecords(scopedRecords, false);
    if (completedSnapshots.length !== 2 || completedSnapshots[1].targetRecordId !== "app:thread:goal:final-2") {
      throw new Error(`completed current scope should clone its status snapshot: ${JSON.stringify(completedSnapshots)}`);
    }
  } finally {
    if (previousWindow) runtimeGlobal.window = previousWindow;
    else delete runtimeGlobal.window;
  }
};

const main = async () => {
  await assertTaskThreadSearchMatches();
  await assertStatusUsageFormatting();

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state."));
  const pluginDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-plugins."));
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-project."));
  const secondProjectDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-project-shared."));
  const sshDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-ssh."));
  const fakeSshDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-bin."));
  const fakeSshArgsPath = path.join(fakeSshDir, "ssh-args.txt");
  await writeExternalPlugin(pluginDir);
  const sshConfigPath = await writeSshConfigFixture(sshDir);
  const remoteClient = await writeRemoteClientFixture(sshDir);
  await writeFakeSsh(fakeSshDir);

  process.env.CODEX_HUB_DATA_DIR = dataDir;
  process.env.CODEX_HUB_PLUGIN_DIR = pluginDir;
  process.env.CODEX_HUB_SSH_CONFIG = sshConfigPath;
  process.env.CODEX_HUB_SSH_REMOTE_CLIENT_PATH = remoteClient.path;
  process.env.CODEXHUB_FAKE_SSH_ARGS_FILE = fakeSshArgsPath;
  process.env.PATH = `${fakeSshDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.CODEX_HUB_LOCAL_MACHINE = "1";
  process.env.CODEX_HUB_PLUGIN_TELEGRAM = "1";
  process.env.CODEX_HUB_APP_SERVER_APPROVAL_POLICY = "on-request";
  delete process.env.CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER;
  process.env.TELEGRAM_BOT_TOKEN = "";

  assertAppServerLaunchOverrides();
  await assertEmbeddedServerDataDirOptionOverridesEnvironment();
  await assertTaskCronSemantics();
  await assertComposerAttachmentClear();
  await assertProjectDirectorySearchMatches();
  await assertProjectMachineGroupSearchMatches();
  await assertTaskSearchMatches();
  await assertSshHostSearch();
  await assertModelOptionSearch();
  await assertServerStateSnapshotPure();
  await assertServerStateDoesNotPersistThreadHistory();
  await assertTransientProjectsStayInMemory();
  await assertVscodeLocalMachineStaysInMemory();
  await assertRegisteredMachinesStayRuntimeOnly();
  await assertProjectSessionIdsAreNotPersisted();
  await assertProjectNamesArePathBasenames();
  await assertProjectSessionProjection();
  await assertAppServerTurnLifecycleRecords();
  await assertAppServerGoalRecords();
  await assertMalformedGoalRunPolicyIgnored();
  await assertAppServerServiceTierSettings();
  await assertAppServerTurnSnapshotPreservesAgentMessages();
  await assertAppServerAgentMessageDeltaStreams();
  await assertAppServerReasoningItemStatusViews();
  await assertSessionAccountRateLimits();
  await assertLocalShellExitStatusView();
  await assertThreadCandidateFiltering();
  await assertAppServerApprovalRequestFlow();
  await assertHistoricalToolBatchCollapse();
  await assertForkPreservesKeptTurnToolRecords();
  await assertProjectDeleteDoesNotWriteTombstone();
  await writeStartupSshHostState(dataDir, "included-host");

  const port = await findFreePort();
  const { startServer } = await import("../src/server/index.js");
  const server = await startServer({ host: "127.0.0.1", port });
  const apiBase = `http://127.0.0.1:${port}`;

  try {
    const machine = await waitForLocalMachine(apiBase);
    console.log(`machine ok: ${machine.machineId}`);
    const removedSessionsRoute = await fetch(new URL("/api/sessions", apiBase));
    if (removedSessionsRoute.status !== 404) {
      throw new Error(`removed /api/sessions route returned HTTP ${removedSessionsRoute.status}`);
    }
    console.log("session-scoped public API removed");

    await assertSshStartupConnect(apiBase, port, fakeSshArgsPath, sshConfigPath, remoteClient.hash);
    console.log("ssh startup connect ok");

    await assertSshHosts(apiBase);
    console.log("ssh hosts ok");

    await assertSshRemoteClientEndpoint(apiBase, remoteClient);
    console.log("ssh remote client endpoint ok");

    await assertSshConnect(apiBase, port, fakeSshArgsPath, sshConfigPath, remoteClient.hash);
    console.log("ssh connect ok");

    const projectsBeforeEnsure = await apiJson<ProjectsPayload>(apiBase, "/api/projects");
    const ensured = await apiJson<{ runtime?: { machineId?: string; online?: boolean } }>(
      apiBase,
      `/api/machines/${encodeURIComponent(machine.machineId)}/runtime/ensure`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: projectDir })
      },
      90_000
    );
    if (ensured.runtime?.machineId !== machine.machineId || ensured.runtime.online !== true || "sessionId" in asRecord(ensured.runtime)) {
      throw new Error(`machine runtime ensure exposed an invalid public result: ${JSON.stringify(ensured)}`);
    }
    const projectsAfterEnsure = await apiJson<ProjectsPayload>(apiBase, "/api/projects");
    if ((projectsAfterEnsure.projects ?? []).length !== (projectsBeforeEnsure.projects ?? []).length) {
      throw new Error("machine runtime ensure mutated the project catalog");
    }
    console.log("machine runtime ensure ok");

    const open = await apiJson<ProjectThreadStartResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: machine.machineId, path: projectDir })
    });
    assertNoWorkerId(open, "/api/projects/open");
    assertNoCurrentThread(open, "/api/projects/open");
    assertNoSessionId(open, "/api/projects/open");
    const machineId = open.result?.machineId;
    const threadId = open.result?.threadId;
    const projectId = open.project?.projectId;
    if (machineId !== machine.machineId || !threadId || !projectId) throw new Error("project thread start did not return machine/thread ids");
    await assertProjectRuntimeView(apiBase, projectId, machineId);
    console.log(`project ok: ${machineId} ${threadId}`);
    await assertCoreCommandPalette(apiBase, machineId, projectDir);
    console.log("command palette ok");

    await assertWebRealtime(apiBase, threadId, async () => {
      await apiJson(apiBase, `/api/threads/${encodeURIComponent(threadId)}/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "/status", source: "web" })
      });
    });
    console.log("web realtime ok");

    const runtimes = await apiJson(apiBase, "/api/runtimes");
    assertNoWorkerId(runtimes, "/api/runtimes");
    assertNoCurrentThread(runtimes, "/api/runtimes");
    assertNoSessionId(runtimes, "/api/runtimes");
    const thread = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    assertNoWorkerId(thread, "/api/threads/:threadId");
    assertNoSessionId(thread, "/api/threads/:threadId");
    if ((thread.records ?? []).length < 2) throw new Error("/status did not write thread records");
    assertStatusMarkdown(thread);
    await assertThreadApprovalSettings(apiBase, threadId, "on-request", "auto_review");
    console.log("app-server launch approval settings ok");
    console.log("thread stream ok");

    const task = await createAndRunTask(apiBase, {
      machineId: machine.machineId,
      projectDir,
      threadId
    });
    assertNoWorkerId(task, "/api/tasks");
    const taskThread = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    if ((taskThread.records ?? []).length < 4) throw new Error("task /status did not append thread records");
    console.log("task ok");

    await assertInvalidTaskSchedule(apiBase, machine.machineId, projectDir);
    console.log("task validation ok");

    const plugins = await apiJson(apiBase, "/api/plugins");
    assertNoWorkerId(plugins, "/api/plugins");
    await assertPluginState(apiBase, plugins);
    console.log("plugins ok");

    const secondOpen = await apiJson<ProjectThreadStartResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: machine.machineId, path: secondProjectDir })
    }, 90_000);
    const secondProjectId = secondOpen.project?.projectId;
    const secondThreadId = secondOpen.result?.threadId;
    if (secondOpen.result?.machineId !== machineId || !secondProjectId || !secondThreadId) {
      throw new Error(`second project did not reuse machine runtime: ${JSON.stringify(secondOpen)}`);
    }
    if (secondOpen.result?.cwd !== secondProjectDir) {
      throw new Error(`second project thread started unexpected cwd: ${secondOpen.result?.cwd}`);
    }
    if (secondThreadId === threadId) {
      throw new Error("second project reused the first project thread");
    }
    await assertProjectRuntimeView(apiBase, secondProjectId, machineId);
    console.log("shared machine runtime ok");

    await assertProjectDeleteKeepsSharedRuntime(apiBase, projectId, machineId);
    console.log("project delete kept shared runtime ok");

    await assertRuntimeStaysOnlineAfterWatcherIdle(apiBase, machine.machineId);
    console.log("runtime stays online after watcher idle ok");

    const legacyError = await sendLegacySessionRegistration(port);
    if (!legacyError.includes("workerId") || !legacyError.includes("unrecognized_keys")) {
      throw new Error(`legacy session registration was not rejected as expected: ${legacyError}`);
    }
    console.log("legacy registration rejected");
  } finally {
    await server.stop();
  }
};

const assertEmbeddedServerDataDirOptionOverridesEnvironment = async () => {
  const explicitDataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-embedded-state."));
  const port = await findFreePort();
  const { startEmbeddedServer } = await import("../src/server/embedded.js");
  const server = await startEmbeddedServer({
    host: "127.0.0.1",
    portMode: "preferred",
    preferredPort: port,
    dataDir: explicitDataDir,
    features: {
      localMachine: false,
      ssh: false,
      tasks: false,
      integrations: false
    }
  });
  try {
    const health = await apiJson<{ configPath?: string }>(`http://127.0.0.1:${port}`, "/api/health");
    const expectedConfigPath = path.join(explicitDataDir, "config.yaml");
    if (health.configPath !== expectedConfigPath) {
      throw new Error(`embedded server used unexpected config path: ${JSON.stringify(health)}, expected ${expectedConfigPath}`);
    }
    if ("statePath" in health) {
      throw new Error(`embedded server exposed removed statePath alias: ${JSON.stringify(health)}`);
    }
  } finally {
    await server.stop();
  }
};

const assertTaskCronSemantics = async () => {
  const { cronMatches, cronMinuteKey, cronMinuteKeyFromIso, nextCronRun } = await import("../src/core/taskCron.js");
  const mondayNotFirst = new Date("2026-06-08T09:00:00.000Z");
  const mondayFirst = new Date("2026-06-01T09:00:00.000Z");
  if (!cronMatches("0 9 1 * 1", mondayNotFirst, "UTC")) {
    throw new Error("cron day-of-month/day-of-week should match when day-of-week matches");
  }
  if (!cronMatches("0 9 1 * 2", mondayFirst, "UTC")) {
    throw new Error("cron day-of-month/day-of-week should match when day-of-month matches");
  }
  if (cronMatches("0 9 1 * *", mondayNotFirst, "UTC")) {
    throw new Error("cron day-of-month with wildcard day-of-week matched the wrong date");
  }
  if (!cronMatches("0 9 * * 1", mondayNotFirst, "UTC")) {
    throw new Error("cron day-of-week with wildcard day-of-month did not match");
  }
  if (cronMinuteKeyFromIso(mondayNotFirst.toISOString(), "UTC") !== cronMinuteKey(mondayNotFirst, "UTC")) {
    throw new Error("cron lastRunAt minute key did not match date minute key");
  }
  const sameDayRun = nextCronRun("0 9 * * *", new Date("2026-06-08T08:59:30.000Z"), "UTC");
  if (sameDayRun?.toISOString() !== "2026-06-08T09:00:00.000Z") {
    throw new Error(`cron next run did not select the next matching minute: ${sameDayRun?.toISOString()}`);
  }
  const nextDayRun = nextCronRun("0 9 * * *", mondayNotFirst, "UTC");
  if (nextDayRun?.toISOString() !== "2026-06-09T09:00:00.000Z") {
    throw new Error(`cron next run did not advance past the current minute: ${nextDayRun?.toISOString()}`);
  }
  if (nextCronRun("invalid", mondayNotFirst, "UTC") !== null) {
    throw new Error("invalid cron expression unexpectedly produced a next run");
  }
};

const assertComposerAttachmentClear = async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { search: "" },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined
      },
      history: {
        state: null,
        replaceState: () => undefined
      }
    }
  });
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  try {
    const { createComposerActions } = await import("../src/web/appActions/composerActions.js");
    const { openThreadReducer } = await import("../src/web/openThreadReducer.js");
    const { createComposerDraftStore } = await import("../src/web/helpers/composer.js");
    const { createSidebarDraftStore } = await import("../src/web/helpers/sidebarDrafts.js");
    const { mergeRecord } = await import("../src/web/helpers/records.js");
    const { patchProjectsThread, patchRuntimesThread } = await import("../src/web/helpers/core.js");
    const composerDraftStore = createComposerDraftStore();
    const sidebarDraftStore = createSidebarDraftStore();
    let sidebarDraftNotifications = 0;
    const unsubscribeSidebarDrafts = sidebarDraftStore.subscribe(() => {
      sidebarDraftNotifications += 1;
    });
    sidebarDraftStore.set("projectSearch", "codexhub");
    sidebarDraftStore.set("taskDraft", (current) => ({ ...current, input: "isolated task draft" }));
    unsubscribeSidebarDrafts();
    if (
      sidebarDraftStore.getSnapshot().projectSearch !== "codexhub"
      || sidebarDraftStore.getSnapshot().taskDraft.input !== "isolated task draft"
      || sidebarDraftNotifications !== 2
    ) {
      throw new Error("sidebar draft store did not isolate high-frequency form state");
    }
    const orderedRecords: CodexRecord[] = [
      { id: "record-a", timestamp: "2026-06-08T09:00:00.000Z", type: "event_msg", payload: {} },
      { id: "record-b", timestamp: "2026-06-08T09:02:00.000Z", type: "event_msg", payload: {} }
    ];
    const reorderedRecords = mergeRecord(orderedRecords, {
      ...orderedRecords[1],
      timestamp: "2026-06-08T08:59:00.000Z"
    });
    const appendedRecords = mergeRecord(reorderedRecords, {
      id: "record-c",
      timestamp: "2026-06-08T09:03:00.000Z",
      type: "event_msg",
      payload: {}
    });
    if (appendedRecords.map((record) => record.id).join(",") !== "record-b,record-a,record-c") {
      throw new Error(`incremental record merge lost ordering: ${appendedRecords.map((record) => record.id).join(",")}`);
    }
    const project = { projectId: "project-a", path: "/tmp/a", lastThreadId: "thread-a", running: true } as ProjectSummary;
    const unchangedProjects = [project];
    const patchedProjects = patchProjectsThread(unchangedProjects, {
      threadId: "thread-a",
      workingDirectory: "/tmp/a",
      status: "running",
      running: true
    } as ThreadSummary);
    if (patchedProjects !== unchangedProjects) {
      throw new Error("unchanged project thread projection did not preserve the project array");
    }
    const threadSummary = {
      threadId: "thread-a",
      workingDirectory: "/tmp/a",
      status: "running",
      running: true,
      runtime: { machineId: "machine-a", online: true, runnable: true }
    } as ThreadSummary;
    const unchangedRuntimes = [{
      machineId: "machine-a",
      workingDirectory: "/tmp/a",
      online: true,
      status: "online",
      lastSeenAt: "2026-06-08T09:03:00.000Z",
      threads: [threadSummary]
    }] as RuntimeSummary[];
    if (patchRuntimesThread(unchangedRuntimes, threadSummary) !== unchangedRuntimes) {
      throw new Error("unchanged runtime thread projection did not preserve the runtime array");
    }
    let openThreads = [
      {
        threadId: "thread-a",
        imageAttachments: [
          { id: "image-a", file: {} as File, name: "image-a.png", previewUrl: "blob:image-a" }
        ],
        textAttachments: [
          { id: "text-a", text: "File: a.txt\n\nhello" }
        ]
      },
      {
        threadId: "thread-b",
        imageAttachments: [
          { id: "image-b", file: {} as File, name: "image-b.png", previewUrl: "blob:image-b" }
        ],
        textAttachments: [
          { id: "text-b", text: "keep" }
        ]
      }
    ] as OpenThreadState[];
    const actions = createComposerActions({
      commandPaletteByScope: {},
      commandPaletteLoadingScopes: {},
      composerDraftStore,
      composerHistoryRef: { current: null },
      messageContextMenu: null,
      openThreads,
      resizeComposerTextarea: () => undefined,
      setCommandPaletteByScope: () => undefined,
      setCommandPaletteLoadingScopes: () => undefined,
      setComposerMenuOpen: () => undefined,
      setInspectMessage: () => undefined,
      setMessageContextMenu: () => undefined,
      setMessageRenderModes: () => undefined,
      setThreadControlsMenuOpen: () => undefined,
      dispatchOpenThreads: (action) => {
        openThreads = openThreadReducer(openThreads, action);
      }
    }, {
      send: async () => undefined
    });
    actions.updateThreadInput("thread-a", "isolated draft");
    if (composerDraftStore.get("thread-a") !== "isolated draft") {
      throw new Error("composer draft store did not retain the thread-scoped input");
    }
    const threadWithDraft = openThreads.find((thread) => thread.threadId === "thread-a");
    if (threadWithDraft && "input" in threadWithDraft) {
      throw new Error("composer input unexpectedly appeared in the open thread state");
    }
    actions.clearThreadAttachments("thread-a");
    const cleared = openThreads.find((thread) => thread.threadId === "thread-a");
    const untouched = openThreads.find((thread) => thread.threadId === "thread-b");
    if (cleared?.imageAttachments.length || cleared?.textAttachments.length) {
      throw new Error("composer clear attachments did not clear the target thread");
    }
    if (untouched?.imageAttachments.length !== 1 || untouched.textAttachments.length !== 1) {
      throw new Error("composer clear attachments changed another thread");
    }
    if (revoked.join(",") !== "blob:image-a") {
      throw new Error(`composer clear attachments did not revoke target image previews: ${revoked.join(",")}`);
    }
  } finally {
    URL.revokeObjectURL = originalRevoke;
    if (hadWindow) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
};

const assertProjectDirectorySearchMatches = async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { search: "" },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined
      },
      history: {
        state: null,
        replaceState: () => undefined
      }
    }
  });
  try {
    const { filterProjectDirectoryEntries } = await import("../src/web/helpers/core.js");
    const entries: MachineDirectoryEntry[] = [
      { name: "alpha-risk", path: "/workspace/client-alpha/alpha-risk" },
      { name: "Beta Reports", path: "/workspace/beta/reports" },
      { name: "codexhub", path: "/home/laop/projects/codexhub" }
    ];
    if (filterProjectDirectoryEntries(entries, "").length !== entries.length) {
      throw new Error("empty project directory search should keep all entries visible");
    }
    if (filterProjectDirectoryEntries(entries, "ALPHA").map((entry) => entry.name).join(",") !== "alpha-risk") {
      throw new Error("project directory search should match names case-insensitively");
    }
    if (filterProjectDirectoryEntries(entries, "projects codex").map((entry) => entry.name).join(",") !== "codexhub") {
      throw new Error("project directory search should match path tokens");
    }
    if (filterProjectDirectoryEntries(entries, "client risk").map((entry) => entry.name).join(",") !== "alpha-risk") {
      throw new Error("project directory search should require every query token");
    }
    if (filterProjectDirectoryEntries(entries, "missing-token").length !== 0) {
      throw new Error("project directory search should expose empty results");
    }
  } finally {
    if (hadWindow) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
};

const assertProjectMachineGroupSearchMatches = async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { search: "" },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined
      },
      history: {
        state: null,
        replaceState: () => undefined
      }
    }
  });
  try {
    const { filterProjectMachineGroupsBySearch } = await import("../src/web/helpers/core.js");
    const alpha = {
      projectId: "project-alpha",
      machineId: "remote-a",
      name: "alpha-api",
      path: "/work/alpha-api"
    } as ProjectSummary;
    const beta = {
      projectId: "project-beta",
      machineId: "remote-a",
      name: "beta-web",
      path: "/work/beta-web"
    } as ProjectSummary;
    const local = {
      projectId: "project-local",
      machineId: "local",
      name: "local-tool",
      path: "/work/local-tool"
    } as ProjectSummary;
    const groups: ProjectMachineGroup[] = [
      {
        key: "remote-a",
        machineId: "remote-a",
        machineType: "registered",
        label: "Builder Box",
        online: true,
        projectLauncher: true,
        badgeLabel: "registered",
        projects: [alpha, beta]
      },
      {
        key: "local",
        machineId: "local",
        machineType: "local",
        label: "local",
        online: true,
        projectLauncher: true,
        badgeLabel: "local",
        projects: [local]
      }
    ];

    const byMachineLabel = filterProjectMachineGroupsBySearch(groups, "builder");
    if (byMachineLabel.length !== 1 || byMachineLabel[0]?.projects.map((project) => project.name).join(",") !== "alpha-api,beta-web") {
      throw new Error("project search should keep projects visible when the machine label matches");
    }
    const byProject = filterProjectMachineGroupsBySearch(groups, "beta");
    if (byProject.length !== 1 || byProject[0]?.projects.map((project) => project.name).join(",") !== "beta-web") {
      throw new Error("project search should still narrow projects when only a project matches");
    }
    const byMachineId = filterProjectMachineGroupsBySearch(groups, "remote-a");
    if (byMachineId.length !== 1 || byMachineId[0]?.projects.length !== 2) {
      throw new Error("project search should keep projects visible when the machine id matches");
    }
    if (filterProjectMachineGroupsBySearch(groups, "missing-project").length !== 0) {
      throw new Error("project search should expose empty results for unmatched queries");
    }
  } finally {
    if (hadWindow) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
};

const assertTaskSearchMatches = async () => {
  const runtimeGlobal = globalThis as unknown as { window?: { location: { search: string } } };
  const previousWindow = runtimeGlobal.window;
  if (!previousWindow) runtimeGlobal.window = { location: { search: "" } };
  try {
    const { taskSearchMatches } = await import("../src/web/helpers/core.js");
    const projects = [{
      projectId: "project-alpha",
      machineId: "machine-local",
      path: "/work/alpha",
      name: "alpha",
      machineOnline: true,
      running: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: "2026-01-01T00:00:00.000Z"
    }];
    const machines = [{
      machineId: "machine-local",
      type: "local" as const,
      name: "local dev",
      hostname: "devhost",
      online: true,
      status: "online" as const,
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      capabilities: { projectLauncher: true }
    }];
    const task = {
      taskId: "task-daily-risk",
      name: "daily-risk",
      enabled: true,
      schedule: "0 9 * * 1-5",
      machineId: "machine-local",
      projectPath: "/work/alpha",
      input: "检查最近的变更并总结风险",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastStatus: "failed" as const,
      lastError: "model catalog timeout",
      runs: [{
        runId: "run-1",
        status: "failed" as const,
        startedAt: "2026-01-02T00:00:00.000Z",
        finishedAt: "2026-01-02T00:00:05.000Z",
        durationMs: 5000,
        threadId: "thread-risk-12345678",
        error: "model catalog timeout"
      }]
    };
    if (!taskSearchMatches(task, "", projects, machines)) throw new Error("empty task search should keep tasks visible");
    if (!taskSearchMatches(task, "daily risk", projects, machines)) throw new Error("task search should match task name tokens");
    if (!taskSearchMatches(task, "1-5 alpha", projects, machines)) throw new Error("task search should match schedule target context");
    if (!taskSearchMatches(task, "catalog timeout", projects, machines)) throw new Error("task search should match recent errors");
    if (!taskSearchMatches(task, "总结 风险", projects, machines)) throw new Error("task search should match prompt text");
    if (taskSearchMatches(task, "missing-token", projects, machines)) throw new Error("task search should expose empty results");
  } finally {
    if (previousWindow) runtimeGlobal.window = previousWindow;
    else delete runtimeGlobal.window;
  }
};

const assertSshHostSearch = async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "" } }
  });
  try {
    const { sshHostSearchMatches } = await import("../src/web/helpers/core.js");
    const prodHost = {
      alias: "prod-db",
      hostName: "db.example.com",
      user: "deploy",
      identityFiles: [],
      port: 2202,
      proxyJump: "bastion"
    };
    const localHost = {
      alias: "local-dev",
      hostName: "127.0.0.1",
      identityFiles: [],
      user: "dev"
    };
    for (const query of ["prod", "db.example", "deploy", "2202", "bastion"]) {
      if (!sshHostSearchMatches(prodHost, query)) {
        throw new Error(`SSH host search did not match ${query}`);
      }
    }
    if (!sshHostSearchMatches(localHost, "")) throw new Error("empty SSH host search should match");
    if (sshHostSearchMatches(prodHost, "staging")) throw new Error("SSH host search matched an unrelated query");
  } finally {
    if (hadWindow) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
};

const writeFakeSsh = async (root: string) => {
  const filePath = path.join(root, "ssh");
  await writeFile(filePath, [
    "#!/bin/sh",
    "if [ -n \"$CODEXHUB_FAKE_SSH_ARGS_FILE\" ]; then",
    "  : > \"$CODEXHUB_FAKE_SSH_ARGS_FILE\"",
    "  for arg in \"$@\"; do",
    "    printf '%s\\000' \"$arg\" >> \"$CODEXHUB_FAKE_SSH_ARGS_FILE\"",
    "  done",
    "fi",
    "echo 'fake ssh started'",
    "trap 'exit 0' TERM INT",
    "while :; do",
    "  sleep 0.2 &",
    "  wait $!",
    "done",
    ""
  ].join("\n"), "utf8");
  await chmod(filePath, 0o755);
};

const writeSshConfigFixture = async (root: string) => {
  const includeDir = path.join(root, "conf.d");
  await mkdir(includeDir, { recursive: true });
  await writeFile(path.join(root, "config"), [
    "Include conf.d/*.conf",
    "Host direct-host",
    "  HostName 192.0.2.10",
    "  User direct",
    "  Port 2222",
    "Host *",
    "  User ignored",
    ""
  ].join("\n"), "utf8");
  await writeFile(path.join(includeDir, "remote.conf"), [
    "Host included-host",
    "  HostName included.example.com",
    "  User ubuntu",
    "  ProxyJump jump-host",
    ""
  ].join("\n"), "utf8");
  return path.join(root, "config");
};

const writeRemoteClientFixture = async (root: string) => {
  const filePath = path.join(root, "remote-client.cjs");
  const content = [
    "#!/usr/bin/env node",
    "console.error('codexhub remote client smoke fixture');",
    ""
  ].join("\n");
  await writeFile(filePath, content, "utf8");
  return {
    path: filePath,
    hash: createHash("sha256").update(content).digest("hex")
  };
};

const assertModelOptionSearch = async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const {
    modelOptionSearchMatches,
    modelOptionsForSelection,
    modelSupportsReasoningEffort,
    reasoningOptionLabel,
    reasoningOptionsForSelection
  } = await import("../src/web/helpers/core.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  const options = modelOptionsForSelection("auto", [
    {
      id: "catalog-gpt-codex",
      model: "gpt-5.3-codex",
      displayName: "Codex Max",
      description: "Deep agent model",
      hidden: false,
      supportedReasoningEfforts: [],
      serviceTiers: []
    },
    {
      id: "hidden-model",
      model: "hidden-model",
      displayName: "Hidden Model",
      hidden: true,
      supportedReasoningEfforts: [],
      serviceTiers: []
    }
  ]);
  const codexOption = options.find((option) => option.value === "gpt-5.3-codex");
  if (!codexOption) throw new Error("model catalog option missing");
  if (!modelOptionSearchMatches(codexOption, "codex max")) {
    throw new Error(`model option search did not match display name: ${JSON.stringify(codexOption)}`);
  }
  if (!modelOptionSearchMatches(codexOption, "deep agent")) {
    throw new Error(`model option search did not match description: ${JSON.stringify(codexOption)}`);
  }
  if (modelOptionSearchMatches(codexOption, "hidden")) {
    throw new Error(`model option search matched unrelated text: ${JSON.stringify(codexOption)}`);
  }
  if (options.some((option) => option.value === "hidden-model")) {
    throw new Error("hidden model catalog option should not be searchable");
  }

  const manualOptions = modelOptionsForSelection("manual-model", []);
  if (manualOptions.some((option) => option.value.startsWith("gpt-"))) {
    throw new Error(`model options should not fall back to static models: ${JSON.stringify(manualOptions)}`);
  }
  const manualOption = manualOptions.find((option) => option.value === "manual-model");
  if (!modelOptionSearchMatches(manualOption, "manual")) {
    throw new Error(`manual model option should be searchable: ${JSON.stringify(manualOption)}`);
  }

  const reasoningOptions = reasoningOptionsForSelection("ultra", [{
    id: "catalog-gpt-5.6-sol",
    model: "gpt-5.6-sol",
    hidden: false,
    supportedReasoningEfforts: [
      { value: "xhigh", label: "xhigh", description: "Extended reasoning" },
      {
        value: "ultra",
        label: "ultra",
        description: "Maximum reasoning with automatic task delegation"
      }
    ],
    serviceTiers: []
  }], "gpt-5.6-sol");
  const ultraOption = reasoningOptions.find((option) => option.value === "ultra");
  const xhighOption = reasoningOptions.find((option) => option.value === "xhigh");
  if (
    !ultraOption
    || ultraOption.description !== "Maximum reasoning with automatic task delegation"
    || reasoningOptionLabel(ultraOption) !== "Ultra"
    || !xhighOption
    || reasoningOptionLabel(xhighOption) !== "Extra High"
  ) {
    throw new Error(`reasoning catalog labels/descriptions were not preserved: ${JSON.stringify(reasoningOptions)}`);
  }
  const modelSpecificCatalog = [
    {
      id: "catalog-gpt-5.6-sol",
      model: "gpt-5.6-sol",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: [{ value: "ultra", label: "ultra" }],
      serviceTiers: []
    },
    {
      id: "catalog-gpt-5.6-luna",
      model: "gpt-5.6-luna",
      hidden: false,
      supportedReasoningEfforts: [{ value: "max", label: "max" }],
      serviceTiers: []
    }
  ];
  if (modelSupportsReasoningEffort(modelSpecificCatalog, "gpt-5.6-luna", "ultra")) {
    throw new Error("model-specific reasoning guard allowed Luna + Ultra");
  }
  const automaticReasoningOptions = reasoningOptionsForSelection("auto", modelSpecificCatalog, "auto");
  if (
    !automaticReasoningOptions.some((option) => option.value === "ultra")
    || automaticReasoningOptions.some((option) => option.value === "max")
  ) {
    throw new Error(`auto model reasoning options did not follow the default model: ${JSON.stringify(automaticReasoningOptions)}`);
  }
};

const writeStartupSshHostState = async (dataDir: string, alias: string) => {
  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  state.upsertSshHost({ alias });
  await state.flush();
};

const assertSshHosts = async (apiBase: string) => {
  const configData = await apiJson<{ hosts?: SshHost[] }>(apiBase, "/api/ssh/config-hosts");
  assertNoWorkerId(configData, "/api/ssh/config-hosts");
  const configHosts = configData.hosts ?? [];
  const direct = configHosts.find((host) => host.alias === "direct-host");
  if (!direct || direct.hostName !== "192.0.2.10" || direct.user !== "direct" || direct.port !== 2222) {
    throw new Error(`direct ssh host fixture was not parsed: ${JSON.stringify(direct)}`);
  }
  const included = configHosts.find((host) => host.alias === "included-host");
  if (!included || included.hostName !== "included.example.com" || included.user !== "ubuntu" || included.proxyJump !== "jump-host") {
    throw new Error(`included ssh host fixture was not parsed: ${JSON.stringify(included)}`);
  }
  if (configHosts.some((host) => host.alias === "*")) throw new Error("wildcard ssh host was exposed");

  const savedData = await apiJson<{ hosts?: SshHost[] }>(apiBase, "/api/ssh/hosts");
  assertNoWorkerId(savedData, "/api/ssh/hosts");
  const existing = savedData.hosts?.find((host) => host.alias === "included-host");
  if (!existing || existing.hostName !== "included.example.com" || existing.user !== "ubuntu") {
    throw new Error(`codexhub ssh hosts did not load saved alias from state: ${JSON.stringify(savedData.hosts)}`);
  }

  const added = await apiJson<{ hosts?: SshHost[] }>(apiBase, "/api/ssh/hosts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ alias: "included-host" })
  });
  assertNoWorkerId(added, "POST /api/ssh/hosts");
  const saved = added.hosts?.find((host) => host.alias === "included-host");
  if (!saved || saved.hostName !== "included.example.com" || saved.user !== "ubuntu") {
    throw new Error(`codexhub ssh host was not stored as an alias backed by ssh config: ${JSON.stringify(saved)}`);
  }
};

const assertSshConnect = async (
  apiBase: string,
  serverPort: number,
  argsPath: string,
  sshConfigPath: string,
  remoteClientHash: string
) => {
  const invalidResponse = await fetch(`${apiBase}/api/ssh/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  const invalidBody = await invalidResponse.json().catch(() => null) as { error?: unknown } | null;
  if (invalidResponse.status !== 400 || invalidBody?.error !== "invalid_request") {
    throw new Error(
      `invalid ssh connect request was not rejected as invalid_request: HTTP ${invalidResponse.status} ${JSON.stringify(invalidBody)}`
    );
  }

  const customCommandResponse = await fetch(`${apiBase}/api/ssh/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ host: "included-host", remoteCommand: "custom command" })
  });
  const customCommandBody = await customCommandResponse.json().catch(() => null) as { error?: unknown } | null;
  if (customCommandResponse.status !== 400 || customCommandBody?.error !== "invalid_request") {
    throw new Error(
      `removed ssh remoteCommand was not rejected: HTTP ${customCommandResponse.status} ${JSON.stringify(customCommandBody)}`
    );
  }

  const remotePort = 19001;
  const started = await apiJson<{ connection?: SshConnection }>(apiBase, "/api/ssh/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      host: "included-host",
      name: "Included Host",
      remotePort
    })
  });
  assertNoWorkerId(started, "POST /api/ssh/connect");
  const connection = started.connection;
  if (!connection?.connectionId || connection.host !== "included-host" || connection.remotePort !== remotePort) {
    throw new Error(`ssh connect did not return expected connection: ${JSON.stringify(connection)}`);
  }
  if (connection.remoteClientHash !== remoteClientHash) {
    throw new Error(`ssh connect did not use bootstrap remote client: ${JSON.stringify(connection)}`);
  }

  const args = await waitForFakeSshArgs(argsPath);
  const configIndex = args.indexOf("-F");
  if (configIndex < 0 || args[configIndex + 1] !== sshConfigPath) {
    throw new Error(`fake ssh args did not include configured ssh config: ${JSON.stringify(args)}`);
  }
  const reverseIndex = args.indexOf("-R");
  if (reverseIndex < 0) throw new Error(`fake ssh args did not include -R: ${JSON.stringify(args)}`);
  const expectedReverse = `127.0.0.1:${remotePort}:127.0.0.1:${serverPort}`;
  if (args[reverseIndex + 1] !== expectedReverse) {
    throw new Error(`unexpected ssh reverse tunnel: ${args[reverseIndex + 1]} expected ${expectedReverse}`);
  }
  if (!args.includes("ExitOnForwardFailure=yes")) throw new Error("ssh args missing ExitOnForwardFailure=yes");
  if (!args.includes("included-host")) throw new Error(`ssh args missing target host: ${JSON.stringify(args)}`);
  const remoteCommand = args.at(-1) ?? "";
  if (remoteCommand.includes("codexhub machine")
    || !remoteCommand.includes("sh -lc")
    || !remoteCommand.includes(`/api/ssh/remote-client/${remoteClientHash}`)
    || !remoteCommand.includes("CODEXHUB_REMOTE_CLIENT_HASH")
    || !remoteCommand.includes("CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER=")
    || !remoteCommand.includes("auto_review")
    || !remoteCommand.includes("export CODEXHUB_REMOTE_CLIENT_HASH CODEXHUB_REMOTE_CLIENT_URL")
    || !remoteCommand.includes("node \"$client\"")
    || !remoteCommand.includes("http://127.0.0.1:19001")
    || !remoteCommand.includes("--type ssh")
    || !remoteCommand.includes("Included Host")) {
    throw new Error(`unexpected ssh remote command: ${remoteCommand}`);
  }

  const listed = await apiJson<{ connections?: SshConnection[] }>(apiBase, "/api/ssh/connections");
  assertNoWorkerId(listed, "GET /api/ssh/connections");
  const listedConnection = listed.connections?.find((item) => item.connectionId === connection.connectionId);
  if (!listedConnection || listedConnection.status === "exited") {
    throw new Error(`ssh connection was not listed as active: ${JSON.stringify(listedConnection)}`);
  }

  const stopped = await apiJson<{ connection?: SshConnection }>(
    apiBase,
    `/api/ssh/connections/${encodeURIComponent(connection.connectionId)}`,
    { method: "DELETE" }
  );
  if (stopped.connection?.status !== "exited") {
    throw new Error(`ssh connection did not stop: ${JSON.stringify(stopped.connection)}`);
  }
};

const assertSshStartupConnect = async (
  apiBase: string,
  serverPort: number,
  argsPath: string,
  sshConfigPath: string,
  remoteClientHash: string
) => {
  const connection = await waitForSshConnection(apiBase, "included-host");
  if (connection.remoteClientHash !== remoteClientHash) {
    throw new Error(`startup ssh connection did not use bootstrap remote client: ${JSON.stringify(connection)}`);
  }
  const args = await waitForFakeSshArgs(argsPath);
  const configIndex = args.indexOf("-F");
  if (configIndex < 0 || args[configIndex + 1] !== sshConfigPath) {
    throw new Error(`startup fake ssh args did not include configured ssh config: ${JSON.stringify(args)}`);
  }
  const reverseIndex = args.indexOf("-R");
  if (reverseIndex < 0) throw new Error(`startup fake ssh args did not include -R: ${JSON.stringify(args)}`);
  const reverse = args[reverseIndex + 1];
  if (!reverse.startsWith("127.0.0.1:") || !reverse.endsWith(`:127.0.0.1:${serverPort}`)) {
    throw new Error(`startup ssh reverse tunnel did not target server port ${serverPort}: ${reverse}`);
  }
  const remoteCommand = args.at(-1) ?? "";
  if (!remoteCommand.includes(`/api/ssh/remote-client/${remoteClientHash}`)
    || !remoteCommand.includes("CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER=")
    || !remoteCommand.includes("auto_review")
    || !remoteCommand.includes("--type ssh")) {
    throw new Error(`startup ssh remote command did not use remote client: ${remoteCommand}`);
  }
  await apiJson(apiBase, `/api/ssh/connections/${encodeURIComponent(connection.connectionId)}`, { method: "DELETE" });
  await writeFile(argsPath, "", "utf8");
};

const assertSshRemoteClientEndpoint = async (
  apiBase: string,
  remoteClient: { path: string; hash: string }
) => {
  const response = await fetch(new URL(`/api/ssh/remote-client/${remoteClient.hash}`, apiBase));
  const text = await response.text();
  if (!response.ok) throw new Error(`remote client endpoint returned HTTP ${response.status}: ${text}`);
  const expected = await readFile(remoteClient.path, "utf8");
  if (text !== expected) throw new Error("remote client endpoint returned unexpected content");
  if (response.headers.get("x-codexhub-remote-client-sha256") !== remoteClient.hash) {
    throw new Error("remote client endpoint returned unexpected checksum header");
  }
};

const waitForFakeSshArgs = async (argsPath: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const text = await readFile(argsPath, "utf8").catch(() => "");
    const args = text.split("\0").filter(Boolean);
    if (args.length) return args;
    await delay(50);
  }
  throw new Error("fake ssh did not receive arguments");
};

const waitForSshConnection = async (apiBase: string, host: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const listed = await apiJson<{ connections?: SshConnection[] }>(apiBase, "/api/ssh/connections").catch(() => ({ connections: [] }));
    const connection = listed.connections?.find((item) => item.host === host && item.status !== "exited");
    if (connection) return connection;
    await delay(50);
  }
  throw new Error(`SSH host did not autoconnect: ${host}`);
};

const assertWebRealtime = async (apiBase: string, threadId: string, trigger: () => Promise<void>) => {
  const messages: RealtimeMessage[] = [];
  const ws = new WebSocket(webRealtimeUrl(apiBase));
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as RealtimeMessage);
  });

  try {
    await waitForWebSocketOpen(ws, "web realtime websocket failed");
    ws.send(JSON.stringify({ type: "hello", runtimesAfter: 0, projectsAfter: 0, tasksAfter: 0, connectionsAfter: 0 }));
    await waitForRealtimeMessage(messages, (message) => message.type === "ready", "web realtime ready");

    ws.send(JSON.stringify({ type: "subscribe_thread", threadId, after: 0 }));
    await waitForRealtimeMessage(
      messages,
      (message) => message.type === "thread_subscribed" && message.threadId === threadId,
      "web realtime thread subscription"
    );

    const startIndex = messages.length;
    await trigger();
    await waitForRealtimeMessage(
      messages,
      (message) => (message.type ?? message.kind) === "record" && message.thread?.threadId === threadId,
      "web realtime thread record",
      startIndex
    );
    const controlSnapshot = messages
      .slice(startIndex)
      .find((message) => message.type === "runtimes" || message.type === "projects");
    if (controlSnapshot) {
      throw new Error(`thread realtime emitted ${controlSnapshot.type} snapshot after record trigger`);
    }
  } finally {
    await closeWebSocket(ws);
  }
};

const waitForRealtimeMessage = async (
  messages: RealtimeMessage[],
  predicate: (message: RealtimeMessage) => boolean,
  label: string,
  startIndex = 0,
  timeoutMs = 3_000
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const found = messages.slice(startIndex).find(predicate);
    if (found) return found;
    await delay(50);
  }
  throw new Error(`${label} did not arrive: ${JSON.stringify(messages.slice(startIndex))}`);
};

const createAndRunTask = async (
  apiBase: string,
  input: { machineId: string; projectDir: string; threadId: string }
) => {
  const created = await apiJson<TaskResponse>(apiBase, "/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Smoke status",
      enabled: false,
      schedule: "* * * * *",
      machineId: input.machineId,
      projectPath: input.projectDir,
      threadId: input.threadId,
      input: "/status"
    })
  });
  assertNoWorkerId(created, "POST /api/tasks");
  assertNoSessionId(created, "POST /api/tasks");
  const taskId = created.task?.taskId;
  if (!taskId) throw new Error("task create did not return taskId");

  const run = await apiJson<TaskRunResponse>(apiBase, `/api/tasks/${encodeURIComponent(taskId)}/run`, {
    method: "POST"
  });
  assertNoWorkerId(run, "POST /api/tasks/:taskId/run");
  assertNoSessionId(run, "POST /api/tasks/:taskId/run");
  if (run.machineId !== input.machineId || run.threadId !== input.threadId) {
    throw new Error("task run did not target the expected machine/thread");
  }
  if (run.command !== "status") throw new Error("task /status was not handled as a local command");
  if (run.task?.lastStatus !== "completed") throw new Error("task run did not complete");

  const listed = await apiJson<{ tasks?: LocalTask[] }>(apiBase, "/api/tasks");
  assertNoWorkerId(listed, "GET /api/tasks");
  assertNoSessionId(listed, "GET /api/tasks");
  const stored = listed.tasks?.find((task) => task.taskId === taskId);
  if (!stored || stored.lastStatus !== "completed" || stored.threadId !== input.threadId) {
    throw new Error("task state was not persisted after run");
  }
  return run;
};

const assertNoSessionId = (value: unknown, label: string) => {
  const found = findKey(value, "sessionId");
  if (found) throw new Error(`${label} exposed internal sessionId at ${found}`);
};

const assertInvalidTaskSchedule = async (apiBase: string, machineId: string, projectDir: string) => {
  const response = await fetch(new URL("/api/tasks", apiBase), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Invalid schedule",
      enabled: false,
      schedule: "*/0 * * * *",
      machineId,
      projectPath: projectDir,
      input: "/status"
    })
  });
  const text = await response.text();
  if (response.ok) throw new Error("invalid task cron schedule was accepted");
  if (!text.includes("Invalid cron schedule")) {
    throw new Error(`invalid task cron schedule returned unexpected error: HTTP ${response.status} ${text}`);
  }
};

const writeExternalPlugin = async (pluginDir: string) => {
  const root = path.join(pluginDir, "external-channel");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "plugin.yaml"), [
    "version: 1",
    "id: external-channel",
    "name: External Channel",
    "enabled: true",
    "contributes:",
    "  web:",
    "    styles:",
    "      - style.css",
    "  integrations:",
    "    - type: external-channel",
    "      label: External Channel",
    "      requiredEnv:",
    "        - EXTERNAL_CHANNEL_TOKEN",
    ""
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "style.css"), [
    ":root {",
    "  --codexhub-smoke-plugin: #123456;",
    "}",
    ""
  ].join("\n"), "utf8");
};

const waitForLocalMachine = async (apiBase: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const data = await apiJson<{ machines?: MachineSummary[] }>(apiBase, "/api/machines").catch(() => ({ machines: [] }));
    const machine = data.machines?.find((item) =>
      item.type === "local" && item.online && item.capabilities?.projectLauncher
    );
    if (machine) return machine;
    await delay(200);
  }
  throw new Error("local machine did not register");
};

const assertServerStateSnapshotPure = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-pure."));
  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  state.upsertMachine({
    machineId: "machine-pure-smoke",
    type: "local",
    hostname: "pure-smoke",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    capabilities: { projectLauncher: true }
  });
  state.upsertProject({
    machineId: "machine-pure-smoke",
    path: "/tmp/codexhub-pure-smoke",
    now: "2026-01-01T00:00:00.000Z"
  });
  await state.flush();
  const before = await readFile(state.path, "utf8");
  state.snapshot({
    machines: [{
      machineId: "machine-pure-smoke",
      type: "local",
      hostname: "pure-smoke",
      online: true,
      status: "online",
      lastSeenAt: "2026-01-01T00:10:00.000Z",
      capabilities: { projectLauncher: true }
    }],
    sessions: [],
    threads: []
  });
  await state.flush();
  const after = await readFile(state.path, "utf8");
  if (after !== before) throw new Error("CodexhubServerState.snapshot mutated config.yaml");
};

const assertServerStateDoesNotPersistThreadHistory = async () => {
  const legacyDataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-thread-history-legacy."));
  await writeFile(path.join(legacyDataDir, "server-state.yaml"), [
    "version: 1",
    "updatedAt: 2026-01-01T00:00:00.000Z",
    "machines: []",
    "projects: []",
    "threads:",
    "  - threadId: legacy-thread",
    "    projectId: legacy-project",
    "    title: legacy",
    "    updatedAt: 2026-01-01T00:00:00.000Z",
    "    status: idle",
    "    messageCount: 1",
    "tasks: []",
    "sshHosts: []",
    ""
  ].join("\n"), "utf8");
  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const legacyState = await CodexhubServerState.load({ dataDir: legacyDataDir });
  if (legacyState.path !== path.join(legacyDataDir, "config.yaml")) {
    throw new Error(`legacy config should migrate to config.yaml, got ${legacyState.path}`);
  }
  const migrated = await readFile(legacyState.path, "utf8");
  if (migrated.includes("\nthreads:")) throw new Error(`legacy thread history was not migrated out:\n${migrated}`);

  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-thread-history."));
  const state = await CodexhubServerState.load({ dataDir });
  const machineId = "machine-thread-history-smoke";
  const projectPath = "/tmp/codexhub-thread-history-smoke";
  const machine = {
    machineId,
    type: "local" as const,
    hostname: "thread-history-smoke",
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:01:00.000Z",
    capabilities: { projectLauncher: true }
  };
  const session = {
    sessionId: "session-thread-history-smoke",
    machineId,
    name: "thread-history-smoke",
    workingDirectory: projectPath,
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:02:00.000Z",
    hostname: "thread-history-smoke",
    threads: []
  };
  const thread = {
    threadId: "thread-history-smoke",
    workingDirectory: projectPath,
    runtime: {
      machineId,
      name: session.name,
      online: true,
      runnable: true,
      lastSeenAt: session.lastSeenAt
    },
    status: "idle" as const,
    running: false,
    title: "external codex thread",
    updatedAt: "2026-01-01T00:03:00.000Z",
    messageCount: 3,
    threadUsage: {
      context: null,
      primaryRateLimit: null,
      secondaryRateLimit: null,
      observedAt: null
    }
  };
  const project = state.upsertProject({ machineId, path: projectPath, now: "2026-01-01T00:00:00.000Z" });
  if (!project) throw new Error("thread history smoke project upsert failed");
  state.captureSessions({ sessions: [session], threads: [thread] });
  const snapshot = state.snapshot({ machines: [machine], sessions: [session], threads: [thread] });
  const projected = snapshot.projects.find((item) => item.projectId === project.projectId);
  if (!projected) throw new Error("thread history smoke project missing from snapshot");
  if ("threads" in asRecord(projected)) throw new Error("project snapshot exposed runtime thread list");
  if ("session" in asRecord(projected)) throw new Error("project snapshot exposed runtime session");
  if ("storedThreads" in asRecord(projected)) throw new Error("project snapshot exposed persisted thread history");
  await state.flush();
  const saved = await readFile(state.path, "utf8");
  if (saved.includes("\nthreads:")) throw new Error(`config persisted thread history:\n${saved}`);
};

const assertTransientProjectsStayInMemory = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-transient-project."));
  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  const machineId = "machine-transient-project-smoke";
  const transientPath = "/tmp/codexhub-transient-project-smoke";
  const persistedPath = "/tmp/codexhub-persisted-project-smoke";
  const machine = {
    machineId,
    type: "local" as const,
    hostname: "transient-project-smoke",
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:01:00.000Z",
    capabilities: { projectLauncher: true }
  };
  state.upsertTransientProject({
    machineId,
    path: transientPath,
    threadId: "thread-transient-project-smoke",
    source: {
      kind: "vscode",
      groupId: "workspace",
      label: "VSCode: smoke"
    }
  });
  const transientSnapshot = state.snapshot({ machines: [machine], sessions: [], threads: [] });
  const transientProject = transientSnapshot.projects.find((project) => project.path === transientPath);
  if (!transientProject?.transient) throw new Error(`transient project missing from snapshot: ${JSON.stringify(transientSnapshot.projects)}`);
  if (transientProject.source?.kind !== "vscode") throw new Error(`transient project source missing: ${JSON.stringify(transientProject)}`);
  await state.flush();
  const statePath = path.join(dataDir, "config.yaml");
  const transientSaved = await readFile(statePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  if (transientSaved.includes(transientPath)) throw new Error(`transient project was persisted:\n${transientSaved}`);

  state.upsertProject({ machineId, path: persistedPath, now: "2026-01-01T00:02:00.000Z" });
  await state.flush();
  const persistedSaved = await readFile(statePath, "utf8");
  if (!persistedSaved.includes(persistedPath)) throw new Error(`persisted project was not saved:\n${persistedSaved}`);
  if (persistedSaved.includes(transientPath)) throw new Error(`transient project leaked into state after persistent save:\n${persistedSaved}`);

  state.upsertTransientProject({
    machineId,
    path: persistedPath,
    threadId: "thread-persisted-vscode-overlay-smoke",
    source: {
      kind: "vscode",
      groupId: "workspace",
      label: "VSCode: smoke"
    }
  });
  const overlaySnapshot = state.snapshot({ machines: [machine], sessions: [], threads: [] });
  const overlayProject = overlaySnapshot.projects.find((project) => project.path === persistedPath);
  if (overlayProject?.source?.kind !== "vscode") {
    throw new Error(`persisted project missing VSCode overlay source: ${JSON.stringify(overlayProject)}`);
  }
  if (overlayProject.transient) throw new Error(`persisted project should not become transient: ${JSON.stringify(overlayProject)}`);
  await state.flush();
  const overlaySaved = await readFile(statePath, "utf8");
  if (overlaySaved.includes("VSCode: smoke") || overlaySaved.includes("source:")) {
    throw new Error(`VSCode overlay was persisted:\n${overlaySaved}`);
  }
};

const assertVscodeLocalMachineStaysInMemory = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-vscode-machine."));
  const port = await findFreePort();
  const { startServer } = await import("../src/server/index.js");
  const server = await startServer({
    host: "127.0.0.1",
    port,
    dataDir,
    surface: "vscode",
    buildId: "vscode-machine-smoke",
    features: {
      localMachine: true,
      ssh: false,
      tasks: false,
      integrations: false
    }
  });
  const apiBase = `http://127.0.0.1:${port}`;
  let machineId = "";
  try {
    const machine = await waitForLocalMachine(apiBase);
    machineId = machine.machineId;
    await delay(1000);
    const listed = await apiJson<{ machines?: MachineSummary[] }>(apiBase, "/api/machines");
    if (!listed.machines?.some((item) => item.machineId === machine.machineId && item.type === "local" && item.online)) {
      throw new Error(`VSCode local machine was not projected in memory: ${JSON.stringify(listed)}`);
    }
    const saved = await readFile(path.join(dataDir, "config.yaml"), "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    if (saved.includes(machine.machineId) || saved.includes("\nmachines:\n  -")) {
      throw new Error(`VSCode local machine was persisted before shutdown:\n${saved}`);
    }
  } finally {
    await server.stop();
  }

  const saved = await readFile(path.join(dataDir, "config.yaml"), "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  if (machineId && (saved.includes(machineId) || saved.includes("\nmachines:\n  -"))) {
    throw new Error(`VSCode local machine was persisted on shutdown:\n${saved}`);
  }
};

const assertRegisteredMachinesStayRuntimeOnly = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-registered-machine."));
  const configPath = path.join(dataDir, "config.yaml");
  const registeredMachineId = "machine-registered-history-smoke";
  await writeFile(configPath, [
    "version: 1",
    "updatedAt: 2026-01-01T00:00:00.000Z",
    "machines:",
    "  - machineId: machine-local-history-smoke",
    "    type: local",
    "    hostname: local-history-smoke",
    "    lastSeenAt: 2026-01-01T00:00:00.000Z",
    "    capabilities:",
    "      projectLauncher: true",
    `  - machineId: ${registeredMachineId}`,
    "    type: registered",
    "    name: stale registered machine",
    "    hostname: registered-history-smoke",
    "    lastSeenAt: 2026-01-01T00:00:00.000Z",
    "    capabilities:",
    "      projectLauncher: true",
    "projects:",
    "  - projectId: project-registered-history-smoke",
    `    machineId: ${registeredMachineId}`,
    "    path: /tmp/registered-history-smoke",
    "    createdAt: 2026-01-01T00:00:00.000Z",
    "    lastOpenedAt: 2026-01-01T00:00:00.000Z",
    "tasks: []",
    "sshHosts: []",
    ""
  ].join("\n"), "utf8");

  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  if (state.listStoredMachines().some((machine) => machine.machineId === registeredMachineId)) {
    throw new Error("legacy registered machine metadata survived config migration");
  }
  if (!state.listStoredProjects().some((project) => project.machineId === registeredMachineId)) {
    throw new Error("registered machine migration removed its persisted project metadata");
  }

  state.upsertMachine({
    machineId: registeredMachineId,
    type: "registered",
    name: "runtime registered machine",
    hostname: "registered-history-smoke",
    capabilities: { projectLauncher: true }
  });
  state.captureSessions({
    sessions: [{
      sessionId: "session-registered-history-smoke",
      machineId: registeredMachineId,
      name: "runtime registered machine",
      workingDirectory: "/tmp/registered-history-smoke",
      online: true,
      status: "online",
      lastSeenAt: "2026-01-01T00:01:00.000Z",
      hostname: "registered-history-smoke",
      threads: []
    }],
    threads: []
  });
  await state.flush();

  const saved = await readFile(configPath, "utf8");
  const parsed = YAML.parse(saved) as { machines?: Array<{ machineId?: string }> };
  if ((parsed.machines ?? []).some((machine) => machine.machineId === registeredMachineId)) {
    throw new Error(`registered machine metadata was persisted again:\n${saved}`);
  }
  if (!saved.includes("machine-local-history-smoke")) {
    throw new Error(`local machine metadata was removed with registered history:\n${saved}`);
  }
  if (!saved.includes("project-registered-history-smoke")) {
    throw new Error(`registered machine project metadata was removed:\n${saved}`);
  }
};

const assertProjectSessionIdsAreNotPersisted = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-project-session-id."));
  await writeFile(path.join(dataDir, "config.yaml"), [
    "version: 1",
    "updatedAt: 2026-01-01T00:00:00.000Z",
    "machines: []",
    "projects:",
    "  - projectId: project-session-id-smoke",
    "    machineId: machine-session-id-smoke",
    "    path: /tmp/codexhub-session-id-smoke",
    "    createdAt: 2026-01-01T00:00:00.000Z",
    "    lastOpenedAt: 2026-01-01T00:00:00.000Z",
    "    lastSessionId: stale-session-id",
    "    lastThreadId: codex-thread-id",
    "tasks:",
    "  - taskId: task-session-id-smoke",
    "    name: legacy task run",
    "    enabled: false",
    "    schedule: '* * * * *'",
    "    machineId: machine-session-id-smoke",
    "    projectPath: /tmp/codexhub-session-id-smoke",
    "    input: /status",
    "    createdAt: 2026-01-01T00:00:00.000Z",
    "    updatedAt: 2026-01-01T00:00:00.000Z",
    "    runs:",
    "      - runId: legacy-run",
    "        status: completed",
    "        startedAt: 2026-01-01T00:00:00.000Z",
    "        sessionId: stale-session-id",
    "        threadId: codex-thread-id",
    "sshHosts: []",
    ""
  ].join("\n"), "utf8");
  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  const migrated = await readFile(state.path, "utf8");
  if (migrated.includes("lastSessionId")) throw new Error(`project lastSessionId was not migrated out:\n${migrated}`);
  if (!migrated.includes("lastThreadId: codex-thread-id")) throw new Error(`project lastThreadId was not preserved:\n${migrated}`);
  if (migrated.includes("sessionId:")) throw new Error(`task run sessionId was not migrated out:\n${migrated}`);
  const migratedRun = state.getTask("task-session-id-smoke")?.runs?.[0];
  if (migratedRun?.machineId !== "machine-session-id-smoke") {
    throw new Error(`task run did not inherit stable machineId: ${JSON.stringify(migratedRun)}`);
  }

  state.upsertProject({
    machineId: "machine-session-id-smoke",
    path: "/tmp/codexhub-session-id-smoke",
    threadId: "codex-thread-id-2",
    now: "2026-01-01T00:01:00.000Z"
  });
  await state.flush();
  const saved = await readFile(state.path, "utf8");
  if (saved.includes("lastSessionId")) throw new Error(`project upsert persisted lastSessionId:\n${saved}`);
};

const assertProjectNamesArePathBasenames = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-project-name."));
  const projectPath = "/tmp/codexhub-custom-name-smoke";
  await writeFile(path.join(dataDir, "config.yaml"), [
    "version: 1",
    "updatedAt: 2026-01-01T00:00:00.000Z",
    "machines: []",
    "projects:",
    "  - projectId: project-custom-name-smoke",
    "    machineId: machine-custom-name-smoke",
    `    path: ${projectPath}`,
    "    name: Custom Project Label",
    "    createdAt: 2026-01-01T00:00:00.000Z",
    "    lastOpenedAt: 2026-01-01T00:00:00.000Z",
    "tasks: []",
    "sshHosts: []",
    ""
  ].join("\n"), "utf8");

  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  const snapshot = state.snapshot({ machines: [], sessions: [], threads: [] });
  const project = snapshot.projects.find((item) => item.projectId === "project-custom-name-smoke");
  if (project?.name !== "codexhub-custom-name-smoke") {
    throw new Error(`project name should be the folder basename: ${JSON.stringify(project)}`);
  }
  const migrated = await readFile(state.path, "utf8");
  if (migrated.includes("Custom Project Label")) {
    throw new Error(`custom project name was not migrated out:\n${migrated}`);
  }
  if (migrated.includes("\n    name:")) {
    throw new Error(`project name should not be persisted separately:\n${migrated}`);
  }
};

const assertProjectSessionProjection = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-session."));
  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  const machineId = "machine-session-smoke";
  const projectPath = "/tmp/codexhub-session-smoke";
  const runtimePath = "/tmp/codexhub-runtime-smoke";
  const machine = {
    machineId,
    type: "local" as const,
    hostname: "session-smoke",
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:01:00.000Z",
    capabilities: { projectLauncher: true }
  };
  const session = {
    sessionId: "session-projection-smoke",
    machineId,
    name: "session-smoke",
    workingDirectory: runtimePath,
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:02:00.000Z",
    hostname: "session-smoke",
    threads: []
  };
  const thread = {
    threadId: "thread-projection-smoke",
    workingDirectory: projectPath,
    runtime: {
      machineId,
      name: session.name,
      online: true,
      runnable: true,
      lastSeenAt: session.lastSeenAt
    },
    status: "idle" as const,
    running: false,
    title: "session projection thread",
    updatedAt: "2026-01-01T00:02:30.000Z",
    messageCount: 0,
    threadUsage: {
      context: null,
      primaryRateLimit: null,
      secondaryRateLimit: null,
      observedAt: null
    }
  };

  state.captureSessions({ sessions: [session], threads: [] });
  const missingProjectSnapshot = state.snapshot({ machines: [machine], sessions: [session], threads: [] });
  if (missingProjectSnapshot.projects.length !== 0) {
    throw new Error("session created a project without an explicit project");
  }

  const project = state.upsertProject({
    machineId,
    path: projectPath,
    now: "2026-01-01T00:03:00.000Z"
  });
  if (!project) throw new Error("session projection project upsert failed");
  state.captureSessions({ sessions: [session], threads: [thread] });
  const onlineSnapshot = state.snapshot({ machines: [machine], sessions: [session], threads: [thread] });
  const onlineProject = onlineSnapshot.projects.find((item) => item.projectId === project.projectId);
  if (!onlineProject?.machineOnline) throw new Error("project snapshot did not expose machineOnline");
  if ("online" in asRecord(onlineProject)) {
    throw new Error(`project snapshot exposed removed online alias: ${JSON.stringify(onlineProject)}`);
  }
  if ("session" in asRecord(onlineProject)) {
    throw new Error(`project snapshot should not expose runtime session: ${JSON.stringify(onlineProject)}`);
  }
  if ("threads" in asRecord(onlineProject)) {
    throw new Error(`project snapshot should not expose runtime threads: ${JSON.stringify(onlineProject)}`);
  }

  const offlineSession = {
    ...session,
    online: false,
    status: "offline" as const,
    offlineSinceAt: "2026-01-01T00:04:00.000Z",
    offlineReason: "unregistered" as const
  };
  const offlineThread = {
    ...thread,
    runtime: {
      ...thread.runtime,
      online: false
    }
  };
  const offlineSnapshot = state.snapshot({ machines: [machine], sessions: [offlineSession], threads: [offlineThread] });
  const offlineProject = offlineSnapshot.projects.find((item) => item.projectId === project.projectId);
  if (!offlineProject) throw new Error("project disappeared when session went offline");
  if ("session" in asRecord(offlineProject)) {
    throw new Error(`offline session should not be projected on project: ${JSON.stringify(offlineProject)}`);
  }
};

const assertAppServerTurnLifecycleRecords = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const hub = new ThreadHub();
  const sessionId = "app-server-lifecycle-session";
  const threadId = "app-server-lifecycle-thread";
  const turnId = "app-server-lifecycle-turn";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-app-server-lifecycle"
  });
  hub.applySessionEvent(sessionId, turnSnapshot(threadId, [
    appServerTurn(turnId, {
      completedAt: 3.5,
      durationMs: 2500,
      items: [{
        id: "user-1",
        type: "userMessage",
        content: [{ type: "text", text: "hello" }]
      }, {
        id: "agent-1",
        type: "agentMessage",
        text: "done"
      }]
    })
  ]));
  const thread = hub.getThread(threadId);
  const records = thread?.records ?? [];
  const started = records.find((record) => asRecord(record).id === `app:${threadId}:${turnId}:event:task_started`);
  const completed = records.find((record) => asRecord(record).id === `app:${threadId}:${turnId}:event:task_complete`);
  const startedPayload = asRecord(asRecord(started).payload);
  const completedPayload = asRecord(asRecord(completed).payload);
  if (!started || startedPayload.type !== "task_started") {
    throw new Error(`app-server turn snapshot did not create task_started: ${JSON.stringify(records)}`);
  }
  if (
    !completed
    || completedPayload.type !== "task_complete"
    || completedPayload.duration_ms !== 2500
  ) {
    throw new Error(`app-server turn snapshot did not create task_complete duration: ${JSON.stringify(records)}`);
  }
};

const assertAppServerGoalRecords = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const hub = new ThreadHub();
  const sessionId = "app-server-goal-session";
  const threadId = "app-server-goal-thread";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-app-server-goal"
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    heartbeat: false,
    message: {
      id: "set-goal-response",
      result: {
        goal: {
          threadId,
          objective: "goal from app-server response",
          status: "active",
          tokenBudget: 111,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1
        }
      }
    }
  });
  let records = hub.getThread(threadId)?.records ?? [];
  let goalRecords = records.filter((record) => asRecord(asRecord(record).payload).type === "thread_goal_updated");
  let goalPayload = asRecord(asRecord(goalRecords[0]).payload);
  let goal = asRecord(goalPayload.goal);
  if (
    goalRecords.length !== 1
    || goalPayload.threadId !== threadId
    || goal.objective !== "goal from app-server response"
    || goal.status !== "active"
    || goal.tokenBudget !== 111
  ) {
    throw new Error(`app-server goal response did not create goal record: ${JSON.stringify(records)}`);
  }

  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    heartbeat: false,
    message: {
      method: "thread/goal/updated",
      params: {
        threadId,
        turnId: null,
        goal: {
          threadId,
          objective: "keep the goal strip visible",
          status: "active",
          tokenBudget: 123,
          tokensUsed: 1,
          timeUsedSeconds: 1,
          createdAt: 1,
          updatedAt: 2
        }
      }
    }
  });
  records = hub.getThread(threadId)?.records ?? [];
  goalRecords = records.filter((record) => asRecord(asRecord(record).payload).type === "thread_goal_updated");
  goalPayload = asRecord(asRecord(goalRecords[goalRecords.length - 1]).payload);
  goal = asRecord(goalPayload.goal);
  if (
    goalRecords.length !== 2
    || goalPayload.threadId !== threadId
    || goal.objective !== "keep the goal strip visible"
    || goal.status !== "active"
    || goal.tokenBudget !== 123
  ) {
    throw new Error(`app-server goal notification did not create goal record: ${JSON.stringify(records)}`);
  }

  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    heartbeat: false,
    historical: true,
    message: {
      result: {
        goal: {
          threadId,
          objective: "goal from app-server snapshot",
          status: "paused",
          tokenBudget: 456,
          tokensUsed: 12,
          timeUsedSeconds: 34,
          createdAt: 2,
          updatedAt: 3
        }
      }
    }
  });
  records = hub.getThread(threadId)?.records ?? [];
  goalRecords = records.filter((record) => asRecord(asRecord(record).payload).type === "thread_goal_updated");
  goalPayload = asRecord(asRecord(goalRecords[goalRecords.length - 1]).payload);
  goal = asRecord(goalPayload.goal);
  if (
    goalRecords.length !== 3
    || goal.objective !== "goal from app-server snapshot"
    || goal.status !== "paused"
    || goal.tokenBudget !== 456
  ) {
    throw new Error(`app-server goal/get snapshot did not create goal record: ${JSON.stringify(records)}`);
  }

  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    heartbeat: false,
    historical: true,
    message: {
      result: {
        goal: null
      }
    }
  });
  records = hub.getThread(threadId)?.records ?? [];
  const latestGoalPayload = asRecord(asRecord(records[records.length - 1]).payload);
  if (latestGoalPayload.type !== "thread_goal_cleared" || latestGoalPayload.threadId !== threadId) {
    throw new Error(`app-server empty goal/get snapshot did not clear goal record: ${JSON.stringify(records)}`);
  }
};

const assertMalformedGoalRunPolicyIgnored = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const hub = new ThreadHub();
  const sessionId = "goal-policy-normalization-session";
  const threadId = "goal-policy-normalization-thread";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-goal-policy-normalization"
  });
  hub.attachSessionThread(sessionId, threadId);
  await hub.setGoal(threadId, {
    runPolicy: {
      type: "consumeUntilWeeklyRemainingAtOrBelow",
      targetRemainingPercent: 25
    }
  });
  if (hub.getThread(threadId)?.goalRunPolicy?.targetRemainingPercent !== 25) {
    throw new Error(`valid goal run policy was not retained: ${JSON.stringify(hub.getThread(threadId)?.goalRunPolicy)}`);
  }
  await hub.setGoal(threadId, {
    runPolicy: {
      type: "consumeUntilWeeklyRemainingAtOrBelow",
      targetRemainingPercent: Number.NaN
    }
  });
  if (hub.getThread(threadId)?.goalRunPolicy !== null) {
    throw new Error(`malformed goal run policy was retained: ${JSON.stringify(hub.getThread(threadId)?.goalRunPolicy)}`);
  }
  await hub.setGoal(threadId, {
    runPolicy: {
      type: "consumeUntilWeeklyRemainingAtOrBelow",
      targetRemainingPercent: 100
    }
  });
  if (hub.getThread(threadId)?.goalRunPolicy !== null) {
    throw new Error(`100 percent goal run policy was retained: ${JSON.stringify(hub.getThread(threadId)?.goalRunPolicy)}`);
  }
};

const assertAppServerServiceTierSettings = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const hub = new ThreadHub();
  const sessionId = "app-server-service-tier-session";
  const threadId = "app-server-service-tier-thread";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-app-server-service-tier"
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_settings_changed",
    threadId,
    heartbeat: false,
    model: "gpt-service-tier-smoke",
    modelReasoningEffort: "ultra",
    serviceTier: "fast",
    approvalPolicy: "untrusted",
    sandboxPolicy: {
      type: "readOnly",
      networkAccess: false
    }
  });
  let thread = hub.getThread(threadId);
  if (
    thread?.model !== "gpt-service-tier-smoke"
    || thread.modelReasoningEffort !== "ultra"
    || thread.serviceTier !== "fast"
    || thread.approvalPolicy !== "untrusted"
    || thread.sandboxPolicy?.type !== "readOnly"
  ) {
    throw new Error(`app-server service tier settings were not mirrored: ${JSON.stringify(thread)}`);
  }
  const sandboxPolicy = {
    type: "workspaceWrite" as const,
    writableRoots: ["/tmp/codexhub-app-server-service-tier"],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
  const turn = hub.runTurn(threadId, "permission options smoke", "web", {
    modelReasoningEffort: "max",
    approvalPolicy: "on-request",
    sandboxPolicy
  });
  const batch = await hub.waitSessionCommands(sessionId, 0, 1);
  const turnCommand = batch.commands[0];
  if (
    !turnCommand
    || turnCommand.type !== "turn"
    || turnCommand.options?.modelReasoningEffort !== "max"
    || turnCommand.options?.approvalPolicy !== "on-request"
    || JSON.stringify(turnCommand.options.sandboxPolicy) !== JSON.stringify(sandboxPolicy)
  ) {
    throw new Error(`approval/sandbox turn options were not forwarded: ${JSON.stringify(turnCommand)}`);
  }
  hub.applySessionEvent(sessionId, turnCompleted(threadId, "app-server-service-tier-turn"));
  await turn;
  thread = hub.getThread(threadId);
  if (
    thread?.modelReasoningEffort !== "max"
    || thread.approvalPolicy !== "on-request"
    || JSON.stringify(thread.sandboxPolicy) !== JSON.stringify(sandboxPolicy)
  ) {
    throw new Error(`approval/sandbox turn options were not retained: ${JSON.stringify(thread)}`);
  }
  const rejectedTurn = hub.runTurn(threadId, "unsupported effort smoke", "web", {
    modelReasoningEffort: "unsupported-effort"
  });
  const rejectedBatch = await hub.waitSessionCommands(sessionId, turnCommand.seq, 1);
  const rejectedCommand = rejectedBatch.commands[0];
  if (!rejectedCommand || rejectedCommand.type !== "turn") {
    throw new Error(`unsupported effort turn command missing: ${JSON.stringify(rejectedCommand)}`);
  }
  hub.failSessionCommand(sessionId, rejectedCommand.commandId, "unsupported effort");
  await rejectedTurn.then(
    () => { throw new Error("unsupported effort turn unexpectedly succeeded"); },
    () => undefined
  );
  thread = hub.getThread(threadId);
  if (thread?.modelReasoningEffort !== "max") {
    throw new Error(`rejected effort override was not rolled back: ${JSON.stringify(thread)}`);
  }
  const submissionFailure = thread.records.filter((record) =>
    asRecord(record.payload).type === "submission_failed"
  );
  if (
    submissionFailure.length !== 1
    || asRecord(submissionFailure[0]?.payload).input_text !== "unsupported effort smoke"
  ) {
    throw new Error(`rejected turn did not produce one submission_failed record: ${JSON.stringify(submissionFailure)}`);
  }
  hub.applySessionEvent(sessionId, {
    type: "thread_settings_changed",
    threadId,
    heartbeat: false,
    model: "gpt-service-tier-smoke",
    modelReasoningEffort: "max",
    serviceTier: "fast"
  });
  thread = hub.getThread(threadId);
  if (thread?.approvalPolicy !== "on-request" || JSON.stringify(thread.sandboxPolicy) !== JSON.stringify(sandboxPolicy)) {
    throw new Error(`missing approval/sandbox settings fields should not clear existing options: ${JSON.stringify(thread)}`);
  }
  let command = hub.runLocalCommand(threadId, "/fast off");
  thread = hub.getThread(threadId);
  if (!command.handled || command.command !== "fast" || thread?.serviceTier) {
    throw new Error(`local /fast off did not clear service tier: ${JSON.stringify({ command, thread })}`);
  }
  command = hub.runLocalCommand(threadId, "/fast on");
  thread = hub.getThread(threadId);
  if (!command.handled || command.command !== "fast" || thread?.serviceTier !== "priority") {
    throw new Error(`local /fast on did not set service tier: ${JSON.stringify({ command, thread })}`);
  }
};

const assertAppServerTurnSnapshotPreservesAgentMessages = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const hub = new ThreadHub();
  const sessionId = "app-server-order-session";
  const threadId = "app-server-order-thread";
  const turnId = "app-server-order-turn";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-app-server-order"
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    heartbeat: false,
    message: {
      method: "thread/goal/cleared",
      params: { threadId }
    }
  });
  hub.applySessionEvent(sessionId, turnSnapshot(threadId, [
    appServerTurn(turnId, {
      items: [{
        id: "user-1",
        type: "userMessage",
        content: [{ type: "text", text: "run" }]
      }, {
        id: "agent-1",
        type: "agentMessage",
        text: "first commentary"
      }, {
        id: "agent-2",
        type: "agentMessage",
        text: "second commentary"
      }, {
        id: "agent-3",
        type: "agentMessage",
        text: "final",
        phase: "final_answer"
      }]
    })
  ]));
  const records = hub.getThread(threadId)?.records ?? [];
  const messages = records
    .map((record) => asRecord(asRecord(record).payload))
    .filter((payload) => payload.type === "agent_message")
    .map((payload) => payload.message);
  if (JSON.stringify(messages) !== JSON.stringify(["first commentary", "second commentary", "final"])) {
    throw new Error(`app-server snapshot collapsed or reordered agent messages: ${JSON.stringify(records)}`);
  }
  const goalIndex = records.findIndex((record) => asRecord(asRecord(record).payload).type === "thread_goal_cleared");
  const startedIndex = records.findIndex((record) => asRecord(asRecord(record).payload).type === "task_started");
  if (goalIndex !== records.length - 1 || startedIndex !== 0) {
    throw new Error(`thread records were not timestamp ordered after snapshot: ${JSON.stringify(records)}`);
  }

  const untimedHub = new ThreadHub();
  const untimedSessionId = "app-server-untimed-order-session";
  const untimedThreadId = "app-server-untimed-order-thread";
  untimedHub.registerSession({
    sessionId: untimedSessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-app-server-untimed-order"
  });
  untimedHub.applySessionEvent(untimedSessionId, turnSnapshot(untimedThreadId, [
    appServerTurn("app-server-untimed-order-old-turn", {
      startedAt: null,
      completedAt: null,
      durationMs: null,
      items: [{
        id: "agent-untimed",
        type: "agentMessage",
        text: "untimed old commentary"
      }]
    })
  ]));
  untimedHub.applySessionEvent(untimedSessionId, {
    type: "thread_event",
    threadId: untimedThreadId,
    heartbeat: false,
    message: {
      method: "item/completed",
      params: {
        threadId: untimedThreadId,
        turnId: "app-server-untimed-order-new-turn",
        completedAtMs: 3000,
        item: {
          id: "agent-later",
          type: "agentMessage",
          text: "later timestamped commentary"
        }
      }
    }
  });
  const untimedMessages = (untimedHub.getThread(untimedThreadId)?.records ?? [])
    .map((record) => asRecord(asRecord(record).payload))
    .filter((payload) => payload.type === "agent_message")
    .map((payload) => payload.message);
  if (JSON.stringify(untimedMessages) !== JSON.stringify(["untimed old commentary", "later timestamped commentary"])) {
    throw new Error(`untimed app-server records sank below newer timestamped records: ${JSON.stringify(untimedHub.getThread(untimedThreadId)?.records ?? [])}`);
  }
};

const assertAppServerAgentMessageDeltaStreams = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const { recordsToViews } = await import("../src/core/codexRecordView.js");
  const hub = new ThreadHub();
  const sessionId = "app-server-agent-delta-session";
  const threadId = "app-server-agent-delta-thread";
  const turnId = "app-server-agent-delta-turn";
  const itemId = "agent-delta-1";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-app-server-agent-delta"
  });
  hub.applySessionEvent(sessionId, executionChanged(threadId, true, turnId));
  const events: Array<{ kind: string; record?: unknown }> = [];
  const unsubscribe = hub.subscribe(threadId, 0, (event) => {
    events.push(event);
  });
  try {
    for (const delta of ["你", "好"]) {
      hub.applySessionEvent(sessionId, {
        type: "thread_event",
        threadId,
        heartbeat: false,
        message: {
          method: "item/agentMessage/delta",
          params: {
            threadId,
            turnId,
            itemId,
            delta
          }
        }
      });
    }
    const deltaRecord = agentMessageRecord(hub.getThread(threadId)?.records ?? [], itemId);
    const deltaPayload = asRecord(asRecord(deltaRecord).payload);
    if (!deltaRecord || deltaPayload.message !== "你好" || deltaPayload.status !== "in_progress") {
      throw new Error(`agent message delta did not stream into record: ${JSON.stringify(hub.getThread(threadId)?.records)}`);
    }
    const deltaViews = recordsToViews([deltaRecord]);
    if (deltaViews[0]?.status !== "in_progress" || deltaViews[0]?.statusText !== "in_progress") {
      throw new Error(`in-progress final_answer should expose in_progress status: ${JSON.stringify(deltaViews[0])}`);
    }
    if (deltaViews[0]?.canFork) {
      throw new Error(`in-progress final_answer should not be forkable: ${JSON.stringify(deltaViews[0])}`);
    }
    const deltaRecordEvents = events.filter((event) => event.kind === "record" && asRecord(event.record)?.id === deltaRecord.id);
    if (deltaRecordEvents.length < 2) {
      throw new Error(`agent message delta did not publish record updates: ${JSON.stringify(events)}`);
    }

    hub.applySessionEvent(sessionId, {
      type: "thread_event",
      threadId,
      heartbeat: false,
      message: {
        method: "item/completed",
        params: {
          threadId,
          turnId,
          completedAtMs: 2000,
          item: {
            id: itemId,
            type: "agentMessage",
            text: "你好。",
            phase: "final_answer"
          }
        }
      }
    });
    const records = hub.getThread(threadId)?.records ?? [];
    const agentRecords = records.filter((record) => asRecord(asRecord(record).payload).type === "agent_message");
    const completedRecord = agentMessageRecord(records, itemId);
    const completedPayload = asRecord(asRecord(completedRecord).payload);
    if (!completedRecord || agentRecords.length !== 1 || completedPayload.message !== "你好。" || completedPayload.status !== "completed") {
      throw new Error(`agent message completion did not replace streamed record: ${JSON.stringify(records)}`);
    }
    const completedViews = recordsToViews([completedRecord]);
    if (completedViews[0]?.status !== "completed" || completedViews[0]?.statusText !== "completed") {
      throw new Error(`completed final_answer should expose completed status: ${JSON.stringify(completedViews[0])}`);
    }
    if (!completedViews[0]?.canFork) {
      throw new Error(`completed final_answer should be forkable: ${JSON.stringify(completedViews[0])}`);
    }
  } finally {
    unsubscribe();
  }
};

const assertAppServerReasoningItemStatusViews = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const { recordsToViews } = await import("../src/core/codexRecordView.js");
  const hub = new ThreadHub();
  const sessionId = "app-server-reasoning-status-session";
  const threadId = "app-server-reasoning-status-thread";
  const turnId = "app-server-reasoning-status-turn";
  const itemId = "reasoning-status-1";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-app-server-reasoning-status"
  });

  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    heartbeat: false,
    message: {
      method: "item/started",
      params: {
        threadId,
        turnId,
        startedAtMs: 1000,
        item: {
          id: itemId,
          type: "reasoning",
          summary: ["thinking"],
          content: []
        }
      }
    }
  });
  let record = reasoningRecord(hub.getThread(threadId)?.records ?? [], itemId);
  let view = record ? recordsToViews([record])[0] : undefined;
  if (!record || view?.role !== "thinking" || view.status !== "in_progress" || view.statusText !== "in_progress") {
    throw new Error(`started reasoning item should expose in_progress status: ${JSON.stringify({ record, view })}`);
  }

  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    heartbeat: false,
    message: {
      method: "item/completed",
      params: {
        threadId,
        turnId,
        completedAtMs: 2000,
        item: {
          id: itemId,
          type: "reasoning",
          summary: ["done thinking"],
          content: []
        }
      }
    }
  });
  record = reasoningRecord(hub.getThread(threadId)?.records ?? [], itemId);
  view = record ? recordsToViews([record])[0] : undefined;
  if (!record || view?.role !== "thinking" || view.status !== "completed" || view.statusText !== "completed") {
    throw new Error(`completed reasoning item should expose completed status: ${JSON.stringify({ record, view })}`);
  }
};

const assertSessionAccountRateLimits = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const hub = new ThreadHub();
  const sessionId = "account-rate-limit-session";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-account-rate-limits"
  });
  hub.applySessionEvent(sessionId, {
    type: "account_rate_limits_updated",
    heartbeat: false,
    rateLimits: {
      primary: {
        usedPercent: 25,
        windowDurationMins: 300,
        resetsAt: 1781058359
      },
      secondary: {
        usedPercent: 50,
        windowDurationMins: 10080,
        resetsAt: 1781140554
      }
    }
  });

  const session = hub.listSessions().find((item) => item.sessionId === sessionId);
  const primary = session?.accountRateLimits?.primaryRateLimit;
  const secondary = session?.accountRateLimits?.secondaryRateLimit;
  if (
    primary?.usedPercent !== 25
    || primary.windowMinutes !== 300
    || primary.resetsAt !== 1781058359
    || secondary?.usedPercent !== 50
    || secondary.windowMinutes !== 10080
    || secondary.resetsAt !== 1781140554
    || !session?.accountRateLimits?.observedAt
  ) {
    throw new Error(`session account rate limits missing from session summary: ${JSON.stringify(session)}`);
  }

  const selected = accountRateLimitsPayloadFromValue({
    result: {
      rateLimits: {
        limitId: "codex_bengalfox",
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1782208264 },
        secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1782795064 }
      },
      rateLimitsByLimitId: {
        codex_bengalfox: {
          limitId: "codex_bengalfox",
          primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1782208264 },
          secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1782795064 }
        },
        codex: {
          limitId: "codex",
          primary: { usedPercent: 47, windowDurationMins: 300, resetsAt: 1782190868 },
          secondary: { usedPercent: 81, windowDurationMins: 10080, resetsAt: 1782338417 }
        }
      }
    }
  });
  hub.applySessionEvent(sessionId, {
    type: "account_rate_limits_updated",
    heartbeat: false,
    rateLimits: selected
  });

  const updated = hub.listSessions().find((item) => item.sessionId === sessionId);
  const updatedPrimary = updated?.accountRateLimits?.primaryRateLimit;
  const updatedSecondary = updated?.accountRateLimits?.secondaryRateLimit;
  if (
    updatedPrimary?.usedPercent !== 47
    || updatedPrimary.windowMinutes !== 300
    || updatedPrimary.resetsAt !== 1782190868
    || updatedSecondary?.usedPercent !== 81
    || updatedSecondary.windowMinutes !== 10080
    || updatedSecondary.resetsAt !== 1782338417
  ) {
    throw new Error(`session account rate limits should prefer codex aggregate limit: ${JSON.stringify(updated)}`);
  }

  const weeklyOnlySelected = accountRateLimitsPayloadFromValue({
    result: {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1784487618 },
        secondary: null
      }
    }
  });
  hub.applySessionEvent(sessionId, {
    type: "account_rate_limits_updated",
    heartbeat: false,
    rateLimits: weeklyOnlySelected
  });
  const weeklyOnly = hub.listSessions().find((item) => item.sessionId === sessionId)?.accountRateLimits;
  const fiveHourWindow = rateLimitUsageForWindowMinutes(weeklyOnly, fiveHourRateLimitWindowMinutes);
  const sevenDayWindow = rateLimitUsageForWindowMinutes(weeklyOnly, sevenDayRateLimitWindowMinutes);
  if (
    fiveHourWindow !== null
    || sevenDayWindow?.usedPercent !== 1
    || sevenDayWindow.windowMinutes !== 10080
    || sevenDayWindow.resetsAt !== 1784487618
  ) {
    throw new Error(`weekly-only primary rate limit was classified incorrectly: ${JSON.stringify(weeklyOnly)}`);
  }
};

const agentMessageRecord = (records: unknown[], itemId: string): CodexRecord | undefined => {
  const found = records.find((record) => {
    const item = asRecord(record);
    const payload = asRecord(item.payload);
    return typeof item.id === "string" && item.id.endsWith(`:agent:${itemId}`) && payload.type === "agent_message";
  });
  return found as CodexRecord | undefined;
};

const reasoningRecord = (records: unknown[], itemId: string): CodexRecord | undefined => {
  const found = records.find((record) => {
    const item = asRecord(record);
    const payload = asRecord(item.payload);
    return typeof item.id === "string" && item.id.endsWith(`:item:reasoning:${itemId}`) && payload.type === "reasoning";
  });
  return found as CodexRecord | undefined;
};

const assertLocalShellExitStatusView = async () => {
  const { recordsToViews } = await import("../src/core/codexRecordView.js");
  const finishedRecord: CodexRecord = {
    id: "shell-exit-1",
    type: "response_item",
    payload: {
      type: "local_shell_call",
      call_id: "shell-call-1",
      status: "failed",
      action: { type: "exec", command: ["rg", "missing"] },
      aggregated_output: "",
      exit_code: 1
    }
  };
  const runningRecord: CodexRecord = {
    id: "shell-running",
    type: "response_item",
    payload: {
      type: "local_shell_call",
      call_id: "shell-call-running",
      status: "in_progress",
      action: { type: "exec", command: ["sleep", "1"] },
      aggregated_output: "",
      exit_code: null
    }
  };
  const pendingCommandRecord: CodexRecord = {
    id: "shell-command-pending",
    type: "response_item",
    payload: {
      type: "local_shell_call",
      call_id: "shell-call-pending",
      status: "in_progress",
      action: { type: "exec", command: [] },
      aggregated_output: "",
      exit_code: null
    }
  };
  const views = recordsToViews([finishedRecord, runningRecord]);
  if (views[0]?.status !== "completed" || views[0]?.statusText !== "failed" || views[1]?.status !== "in_progress" || views[1]?.statusText !== "in_progress") {
    throw new Error(`local shell status views were not normalized: ${JSON.stringify(views)}`);
  }
  const [pendingView] = recordsToViews([pendingCommandRecord]);
  if (pendingView?.status !== "in_progress" || pendingView.statusText !== "in_progress") {
    throw new Error(`pending shell command should expose in_progress status: ${JSON.stringify(pendingView)}`);
  }
  if (pendingView?.text !== "$ <empty>") {
    throw new Error(`pending shell command view was not descriptive: ${JSON.stringify(pendingView)}`);
  }
};

const assertThreadCandidateFiltering = async () => {
  const runtimeGlobal = globalThis as unknown as { window?: { location: { search: string } } };
  const previousWindow = runtimeGlobal.window;
  if (!previousWindow) runtimeGlobal.window = { location: { search: "" } };
  try {
    const { filterThreadCandidates } = await import("../src/web/helpers/core.js");
    const candidates = [
      {
        threadId: "abc12345-worktree-thread",
        cwd: "/repo",
        path: "/repo",
        title: "Fix login flow",
        updatedAt: "2026-01-01T00:00:00.000Z",
        firstUserMessage: "Please inspect auth",
        lastAssistantMessage: "Ready for review",
        artifactCount: 0,
        messageCount: 4
      },
      {
        threadId: "def67890-weekly-thread",
        cwd: "/repo",
        path: "/repo",
        title: "",
        updatedAt: "2026-01-02T00:00:00.000Z",
        firstUserMessage: "Plan weekly report",
        lastAssistantMessage: "",
        artifactCount: 0,
        messageCount: 2
      },
      {
        threadId: "fedcba98-ssh-thread",
        cwd: "/repo",
        path: "/repo",
        title: "Remote machine notes",
        updatedAt: "2026-01-03T00:00:00.000Z",
        firstUserMessage: "",
        lastAssistantMessage: "Ready to ship SSH loopback",
        artifactCount: 0,
        messageCount: 6
      }
    ];
    if (filterThreadCandidates(candidates, "").length !== candidates.length) {
      throw new Error("empty thread candidate search should keep all candidates");
    }
    if (filterThreadCandidates(candidates, "login fix")[0]?.threadId !== "abc12345-worktree-thread") {
      throw new Error("thread candidate search should match title tokens");
    }
    if (filterThreadCandidates(candidates, "weekly report")[0]?.threadId !== "def67890-weekly-thread") {
      throw new Error("thread candidate search should match first user message");
    }
    if (filterThreadCandidates(candidates, "ssh loopback")[0]?.threadId !== "fedcba98-ssh-thread") {
      throw new Error("thread candidate search should match assistant summary");
    }
    if (filterThreadCandidates(candidates, "abc12345")[0]?.threadId !== "abc12345-worktree-thread") {
      throw new Error("thread candidate search should match short thread id");
    }
    if (filterThreadCandidates(candidates, "missing").length !== 0) {
      throw new Error("thread candidate search should expose empty results");
    }
  } finally {
    if (previousWindow) runtimeGlobal.window = previousWindow;
    else delete runtimeGlobal.window;
  }
};

const assertAppServerApprovalRequestFlow = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const { recordsToViews } = await import("../src/core/codexRecordView.js");
  const { machineTransportMessageSchema } = await import("../src/shared/apiContract.js");
  const runtimeGlobal = globalThis as Record<string, unknown>;
  const previousWindow = runtimeGlobal.window;
  if (!previousWindow) runtimeGlobal.window = { location: { search: "" } };
  const { activityStatusesFromRecords, latestTurnStatusFromRecords } = await import("../src/web/helpers/records.js");
  if (!previousWindow) delete runtimeGlobal.window;
  const hub = new ThreadHub();
  const sessionId = "approval-session";
  const threadId = "approval-thread";
  const cwd = process.cwd();
  hub.registerSession({ sessionId, workingDirectory: cwd });
  hub.attachSessionThread(sessionId, threadId, cwd);
  let cursor = 0;
  const exerciseApproval = async (
    approvalId: string,
    decision: "approve" | "approve_for_session" | "deny" | "cancel",
    approval: {
      method: string;
      requestId: number;
      kind: "command_execution" | "file_change" | "mcp_elicitation" | "permissions_request";
      turnId?: string;
      itemId: string;
      params: Record<string, unknown>;
    },
    assertPendingPayload: (payload: Record<string, unknown>) => void,
    assertResolvedPayload: (payload: Record<string, unknown>) => void = () => undefined
  ) => {
    const event = {
      type: "approval_request",
      threadId,
      approval: {
        approvalId,
        method: approval.method,
        requestId: approval.requestId,
        kind: approval.kind,
        threadId,
        ...(approval.turnId ? { turnId: approval.turnId } : {}),
        itemId: approval.itemId,
        createdAt: "2026-06-16T00:00:00.000Z",
        params: approval.params
      }
    } as const;
    machineTransportMessageSchema.parse({ type: "session_event", sessionId, event });
    hub.applySessionEvent(sessionId, event);

    let records = hub.getThread(threadId)?.records ?? [];
    let record = records.find((item) => asRecord(asRecord(item)?.payload).approval && asRecord(asRecord(asRecord(item)?.payload).approval).approvalId === approvalId);
    let approvalPayload = asRecord(asRecord(record)?.payload);
    let approvalRecord = asRecord(approvalPayload.approval);
    if (approvalRecord.status !== "pending") throw new Error(`approval request record missing pending status: ${JSON.stringify(records)}`);
    assertPendingPayload(approvalPayload);
    const pendingView = recordsToViews([record as CodexRecord])[0];
    if (pendingView?.status !== "pending" || pendingView.statusText !== "pending_approval") {
      throw new Error(`approval request view was not pending: ${JSON.stringify(pendingView)}`);
    }

    const response = hub.respondToApproval(threadId, approvalId, decision);
    const batch = await hub.waitSessionCommands(sessionId, cursor, 100);
    cursor = batch.cursor;
    const command = batch.commands.find((item) => item.type === "approval_decision" && item.approvalId === approvalId);
    if (!command || command.approvalDecision !== decision) {
      throw new Error(`approval decision command missing: ${JSON.stringify(batch)}`);
    }
    hub.resolveSessionCommand(sessionId, command.commandId, { ok: true });
    const result = await response;
    const expectedStatus = decision === "approve" || decision === "approve_for_session"
      ? "approved"
      : decision === "cancel" ? "cancelled" : "denied";
    if (result.status !== expectedStatus) throw new Error(`approval response was not ${expectedStatus}: ${JSON.stringify(result)}`);
    records = hub.getThread(threadId)?.records ?? [];
    record = records.find((item) => asRecord(asRecord(item)?.payload).approval && asRecord(asRecord(asRecord(item)?.payload).approval).approvalId === approvalId);
    approvalPayload = asRecord(asRecord(record)?.payload);
    approvalRecord = asRecord(approvalPayload.approval);
    if (approvalRecord.status !== expectedStatus) throw new Error(`approval record was not marked ${expectedStatus}: ${JSON.stringify(records)}`);
    if (approvalRecord.decision !== decision) throw new Error(`approval decision metadata was not preserved: ${JSON.stringify(approvalRecord)}`);
    assertResolvedPayload(approvalPayload);
  };

  await exerciseApproval(
    "approval-1",
    "approve_for_session",
    {
      method: "item/commandExecution/requestApproval",
      requestId: 99,
      kind: "command_execution",
      turnId: "approval-turn",
      itemId: "shell-1",
      params: {
        threadId,
        turnId: "approval-turn",
        itemId: "shell-1",
        command: "touch /tmp/codexhub-approval",
        cwd,
        reason: "requires elevated permissions"
      }
    },
    (payload) => {
      const action = asRecord(payload.action);
      const command = action.command;
      if (payload.type !== "local_shell_call" || !Array.isArray(command) || command.join(" ") !== "touch /tmp/codexhub-approval") {
        throw new Error(`command approval payload was not rendered as shell call: ${JSON.stringify(payload)}`);
      }
    },
    (payload) => {
      const approval = asRecord(payload.approval);
      if (approval.decision !== "approve_for_session") {
        throw new Error(`command approval did not preserve session decision: ${JSON.stringify(payload)}`);
      }
    }
  );

  await exerciseApproval(
    "file-change-approval",
    "cancel",
    {
      method: "item/fileChange/requestApproval",
      requestId: 100,
      kind: "file_change",
      turnId: "approval-turn",
      itemId: "file-change-1",
      params: {
        threadId,
        turnId: "approval-turn",
        itemId: "file-change-1",
        reason: "needs write permission",
        grantRoot: cwd
      }
    },
    (payload) => {
      const approval = asRecord(payload.approval);
      if (payload.type !== "file_change" || approval.kind !== "file_change" || approval.itemId !== "file-change-1") {
        throw new Error(`file change approval payload was not rendered as file change: ${JSON.stringify(payload)}`);
      }
    }
  );

  await exerciseApproval(
    "permissions-approval",
    "approve_for_session",
    {
      method: "item/permissions/requestApproval",
      requestId: 101,
      kind: "permissions_request",
      turnId: "approval-turn",
      itemId: "permissions-1",
      params: {
        threadId,
        turnId: "approval-turn",
        itemId: "permissions-1",
        cwd,
        reason: "needs network",
        permissions: {
          network: { enabled: true },
          fileSystem: null
        }
      }
    },
    (payload) => {
      const approval = asRecord(payload.approval);
      const permissions = asRecord(payload.permissions);
      const network = asRecord(permissions.network);
      if (payload.type !== "permission_request" || approval.kind !== "permissions_request" || network.enabled !== true) {
        throw new Error(`permissions approval payload was not rendered as permission request: ${JSON.stringify(payload)}`);
      }
    },
    (payload) => {
      const result = asRecord(payload.result);
      const permissions = asRecord(result.permissions);
      const network = asRecord(permissions.network);
      if (result.scope !== "session" || network.enabled !== true) {
        throw new Error(`permissions approval result did not preserve grant and scope: ${JSON.stringify(payload)}`);
      }
    }
  );

  await exerciseApproval(
    "mcp-elicitation-approval",
    "cancel",
    {
      method: "mcpServer/elicitation/request",
      requestId: 102,
      kind: "mcp_elicitation",
      turnId: "approval-turn",
      itemId: "google-calendar-create-event",
      params: {
        threadId,
        turnId: "approval-turn",
        itemId: "google-calendar-create-event",
        serverName: "codex_apps",
        message: "Allow Google Calendar to create this event?",
        requestedSchema: {
          type: "object",
          properties: {},
          required: []
        }
      }
    },
    (payload) => {
      const args = asRecord(payload.arguments);
      const approval = asRecord(payload.approval);
      if (payload.type !== "mcp_tool_call" || payload.server !== "codex_apps" || payload.tool !== "elicitation.request") {
        throw new Error(`mcp elicitation approval payload was not rendered as MCP tool call: ${JSON.stringify(payload)}`);
      }
      if (args.message !== "Allow Google Calendar to create this event?") {
        throw new Error(`mcp elicitation message was not preserved: ${JSON.stringify(payload)}`);
      }
      if (approval.kind !== "mcp_elicitation" || approval.itemId !== "google-calendar-create-event") {
        throw new Error(`mcp elicitation approval metadata was not preserved: ${JSON.stringify(payload)}`);
      }
    }
  );

  const userInputEvent: SessionEventInput = {
    type: "user_input_request",
    threadId,
    userInput: {
      userInputId: "user-input-1",
      method: "item/tool/requestUserInput",
      requestId: 105,
      threadId,
      turnId: "approval-turn",
      itemId: "tool-input-1",
      createdAt: "2026-06-16T00:00:00.000Z",
      questions: [{
        id: "choice",
        header: "Mode",
        question: "Choose a mode",
        isOther: false,
        isSecret: false,
        options: [
          { label: "Fast", description: "Use fast mode" },
          { label: "Careful", description: "Use careful mode" }
        ]
      }],
      params: {
        threadId,
        turnId: "approval-turn",
        itemId: "tool-input-1",
        questions: []
      }
    }
  };
  machineTransportMessageSchema.parse({ type: "session_event", sessionId, event: userInputEvent });
  hub.applySessionEvent(sessionId, userInputEvent);
  let records = hub.getThread(threadId)?.records ?? [];
  let userInputRecord = records.find((item) => {
    const payload = asRecord(asRecord(item)?.payload);
    const userInput = asRecord(payload.userInput);
    return userInput.userInputId === "user-input-1";
  });
  let userInputPayload = asRecord(asRecord(userInputRecord)?.payload);
  let userInputMeta = asRecord(userInputPayload.userInput);
  if (userInputPayload.type !== "user_input_request" || userInputMeta.status !== "pending") {
    throw new Error(`user input request record missing pending status: ${JSON.stringify(records)}`);
  }
  const userInputView = recordsToViews([userInputRecord as CodexRecord])[0];
  if (userInputView?.status !== "pending" || userInputView.statusText !== "pending_user_input") {
    throw new Error(`user input view was not pending: ${JSON.stringify(userInputView)}`);
  }
  const pendingUserInputStatuses = activityStatusesFromRecords(records);
  const pendingUserInputStatus = pendingUserInputStatuses.find((item) => item.key === "userInput");
  if (pendingUserInputStatus?.status !== "pending" || !pendingUserInputStatus.text.includes("Choose a mode")) {
    throw new Error(`user input status was not pending: ${JSON.stringify(pendingUserInputStatuses)}`);
  }
  const pendingLatestStatus = latestTurnStatusFromRecords(records);
  if (pendingLatestStatus?.key !== "userInput" || pendingLatestStatus.status !== "pending") {
    throw new Error(`latest turn status did not surface pending user input: ${JSON.stringify(pendingLatestStatus)}`);
  }
  const answers = { choice: { answers: ["Careful"] } };
  const userInputResponse = hub.respondToUserInput(threadId, "user-input-1", answers);
  const userInputBatch = await hub.waitSessionCommands(sessionId, cursor, 100);
  cursor = userInputBatch.cursor;
  const userInputCommand = userInputBatch.commands.find((item) => item.type === "user_input_response" && item.userInputId === "user-input-1");
  if (!userInputCommand || JSON.stringify(userInputCommand.userInputAnswers) !== JSON.stringify(answers)) {
    throw new Error(`user input response command missing: ${JSON.stringify(userInputBatch)}`);
  }
  hub.resolveSessionCommand(sessionId, userInputCommand.commandId, { ok: true });
  const userInputResult = await userInputResponse;
  if (userInputResult.status !== "answered") throw new Error(`user input response was not answered: ${JSON.stringify(userInputResult)}`);
  records = hub.getThread(threadId)?.records ?? [];
  userInputRecord = records.find((item) => {
    const payload = asRecord(asRecord(item)?.payload);
    const userInput = asRecord(payload.userInput);
    return userInput.userInputId === "user-input-1";
  });
  userInputPayload = asRecord(asRecord(userInputRecord)?.payload);
  userInputMeta = asRecord(userInputPayload.userInput);
  const response = asRecord(userInputPayload.response);
  const choice = asRecord(response.choice);
  if (userInputMeta.status !== "answered" || JSON.stringify(choice.answers) !== JSON.stringify(["Careful"])) {
    throw new Error(`user input response was not recorded: ${JSON.stringify(userInputPayload)}`);
  }
  const answeredUserInputStatuses = activityStatusesFromRecords(records);
  const answeredUserInputStatus = answeredUserInputStatuses.find((item) => item.key === "userInput");
  if (answeredUserInputStatus) {
    throw new Error(`answered user input should not remain in status details: ${JSON.stringify(answeredUserInputStatuses)}`);
  }
  const answeredLatestStatus = latestTurnStatusFromRecords(records);
  if (answeredLatestStatus?.key !== "userInput" || answeredLatestStatus.status !== "completed") {
    throw new Error(`latest turn status did not surface answered user input: ${JSON.stringify(answeredLatestStatus)}`);
  }
};

const assertHistoricalToolBatchCollapse = async () => {
  const { collapseHistoricalToolBatches } = await import("../src/shared/compactRecordViews.js");
  const turnId = "tool-batch-turn";
  const toolView = (id: string, label: string): Awaited<ReturnType<typeof collapseHistoricalToolBatches>>[number] => ({
    id,
    role: "tool",
    label,
    text: label,
    status: "completed",
    statusText: "completed",
    record: {
      id: `app:thread:${turnId}:item:function_call:${id}`,
      type: "response_item",
      payload: { type: "function_call", call_id: id, status: "completed" }
    }
  });
  const commentary = (id: string, text: string): Awaited<ReturnType<typeof collapseHistoricalToolBatches>>[number] => ({
    id,
    role: "codex",
    label: "commentary",
    text,
    record: {
      id: `app:thread:${turnId}:item:agent_message:${id}`,
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary", message: text }
    }
  });
  const views = [
    commentary("c1", "first tool round"),
    toolView("tool-a", "tool: shell"),
    toolView("tool-aa", "tool: shell"),
    toolView("tool-b", "tool: apply_patch"),
    commentary("c2", "second tool round"),
    toolView("tool-c", "tool: shell")
  ];
  const collapsed = collapseHistoricalToolBatches(views);
  const collapsedBatch = collapsed.find((view) => view.toolBatch);
  if (!collapsedBatch?.toolBatch || collapsedBatch.toolBatch.count !== 3 || collapsed.some((view) => view.id === "tool-a" || view.id === "tool-aa" || view.id === "tool-b")) {
    throw new Error(`historical tool batch was not collapsed: ${JSON.stringify(collapsed)}`);
  }
  if (JSON.stringify(collapsedBatch.toolBatch.labels) !== JSON.stringify(["2 shell", "1 apply_patch"])) {
    throw new Error(`historical tool batch labels were not counted by tool type: ${JSON.stringify(collapsedBatch.toolBatch.labels)}`);
  }
  if (!collapsed.some((view) => view.id === "tool-c")) {
    throw new Error(`latest tool batch should remain expanded: ${JSON.stringify(collapsed)}`);
  }
  const expanded = collapseHistoricalToolBatches(views, new Set([collapsedBatch.toolBatch.key]));
  const expandedBatch = expanded.find((view) => view.toolBatch);
  if (!expandedBatch?.toolBatch?.expanded || !expanded.some((view) => view.id === "tool-a") || !expanded.some((view) => view.id === "tool-aa") || !expanded.some((view) => view.id === "tool-b")) {
    throw new Error(`expanded historical tool batch did not restore original tools: ${JSON.stringify(expanded)}`);
  }
  const collapsedAgain = collapseHistoricalToolBatches(views, new Set());
  if (collapsedAgain.some((view) => view.id === "tool-a" || view.id === "tool-aa" || view.id === "tool-b") || collapsedAgain.some((view) => view.toolBatch?.expanded)) {
    throw new Error(`historical tool batch did not collapse again: ${JSON.stringify(collapsedAgain)}`);
  }
};

const assertForkPreservesKeptTurnToolRecords = async () => {
  const { ThreadHub } = await import("../src/core/threadHub.js");
  const hub = new ThreadHub();
  const sessionId = "fork-tool-session";
  const sourceThreadId = "fork-source-thread";
  const forkedThreadId = "fork-child-thread";
  const keptTurnId = "fork-kept-turn";
  const removedTurnId = "fork-removed-turn";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/codexhub-fork-tool"
  });
  hub.applySessionEvent(sessionId, turnSnapshot(sourceThreadId, [
    appServerTurn(keptTurnId, {
      items: [{
        id: "kept-user",
        type: "userMessage",
        content: [{ type: "text", text: "run fork tool" }]
      }, {
        id: "kept-tool",
        type: "commandExecution",
        command: "pwd",
        status: "completed",
        output: "/tmp/codexhub-fork-tool",
        exitCode: 0
      }, {
        id: "kept-agent",
        type: "agentMessage",
        text: "kept",
        phase: "final_answer"
      }]
    }),
    appServerTurn(removedTurnId, {
      startedAt: 3,
      completedAt: 4,
      items: [{
        id: "removed-user",
        type: "userMessage",
        content: [{ type: "text", text: "remove me" }]
      }, {
        id: "removed-agent",
        type: "agentMessage",
        text: "removed",
        phase: "final_answer"
      }]
    })
  ]));
  const fork = hub.forkThread(sourceThreadId, `app:${sourceThreadId}:${keptTurnId}:agent:kept-agent`);
  const forkBatch = await hub.waitSessionCommands(sessionId, 0, 1);
  const forkCommand = forkBatch.commands[0];
  if (
    !forkCommand
    || forkCommand.type !== "fork_thread"
    || forkCommand.threadId !== sourceThreadId
    || asRecord(forkCommand).lastTurnId !== keptTurnId
  ) {
    throw new Error(`fork command did not target the expected source turn: ${JSON.stringify(forkCommand)}`);
  }
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId: forkedThreadId,
    commandId: forkCommand.commandId,
    heartbeat: false,
    message: {
      result: {
        thread: {
          id: forkedThreadId,
          cwd: "/tmp/codexhub-fork-tool",
          turns: [appServerTurn(keptTurnId, {
            items: [{
              id: "kept-user",
              type: "userMessage",
              content: [{ type: "text", text: "run fork tool" }]
            }, {
              id: "kept-agent",
              type: "agentMessage",
              text: "kept",
              phase: "final_answer"
            }]
          })]
        }
      }
    }
  });
  const detail = await fork;
  const records = detail.records ?? [];
  if (!records.some((record) => asRecord(record).id === `app:${forkedThreadId}:${keptTurnId}:item:commandExecution:kept-tool`)) {
    throw new Error(`fork dropped kept turn tool record: ${JSON.stringify(records)}`);
  }
  if (records.some((record) => String(asRecord(record).id).includes(removedTurnId))) {
    throw new Error(`fork kept records from removed turn: ${JSON.stringify(records)}`);
  }
  if (records.some((record) => String(asRecord(record).id).startsWith(`app:${sourceThreadId}:`))) {
    throw new Error(`fork leaked source thread record ids: ${JSON.stringify(records)}`);
  }
  const sourceRecords = hub.getThread(sourceThreadId)?.records ?? [];
  if (!sourceRecords.some((record) => String(asRecord(record).id).includes(removedTurnId))) {
    throw new Error(`fork destructively cropped the source thread: ${JSON.stringify(sourceRecords)}`);
  }
  const followUpBatch = await hub.waitSessionCommands(sessionId, forkCommand.seq, 1);
  if (followUpBatch.commands.length) {
    throw new Error(`fork-at-record unexpectedly issued a follow-up command: ${JSON.stringify(followUpBatch.commands)}`);
  }
};

const assertProjectDeleteDoesNotWriteTombstone = async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-state-delete."));
  const { CodexhubServerState } = await import("../src/core/serverState.js");
  const state = await CodexhubServerState.load({ dataDir });
  const machineId = "machine-delete-smoke";
  const projectPath = "/tmp/codexhub-delete-smoke";
  const now = "2026-01-01T00:00:00.000Z";
  const project = state.upsertProject({ machineId, path: projectPath, now });
  if (!project) throw new Error("explicit project upsert was suppressed");
  if (!state.deleteProject(project.projectId)) throw new Error("project delete did not report success");
  if (state.deleteProject(project.projectId)) throw new Error("project delete should not be idempotent without tombstones");

  const machine = {
    machineId,
    type: "local" as const,
    hostname: "delete-smoke",
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:01:00.000Z",
    capabilities: { projectLauncher: true }
  };
  const session = {
    sessionId: "session-delete-smoke",
    machineId,
    name: "delete-smoke",
    workingDirectory: projectPath,
    online: true,
    status: "online" as const,
    lastSeenAt: "2026-01-01T00:01:00.000Z",
    hostname: "delete-smoke",
    threads: []
  };
  state.captureSessions({ sessions: [session], threads: [] });
  const deletedSnapshot = state.snapshot({ machines: [machine], sessions: [session], threads: [] });
  if (deletedSnapshot.projects.some((item) => item.projectId === project.projectId)) {
    throw new Error("deleted project was restored by session capture");
  }
  await state.flush();
  const deletedSaved = await readFile(state.path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (deletedSaved.includes("deletedProjects")) throw new Error(`project delete wrote a tombstone:\n${deletedSaved}`);

  const restored = state.upsertProject({
    machineId,
    path: projectPath,
    now: "2026-01-01T00:02:00.000Z"
  });
  if (!restored || restored.projectId !== project.projectId) throw new Error("explicit project reopen did not restore deleted project");
  const restoredSnapshot = state.snapshot({ machines: [machine], sessions: [session], threads: [] });
  if (!restoredSnapshot.projects.some((item) => item.projectId === project.projectId)) {
    throw new Error("restored project was missing from snapshot");
  }
};

const assertAppServerLaunchOverrides = () => {
  const previousApprovalPolicy = process.env.CODEX_HUB_APP_SERVER_APPROVAL_POLICY;
  const previousApprovalsReviewer = process.env.CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER;
  try {
    delete process.env.CODEX_HUB_APP_SERVER_APPROVAL_POLICY;
    delete process.env.CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER;
    const defaults = resolveCodexAppServerLaunchOptions();
    if (defaults.approvalPolicy !== undefined || defaults.approvalsReviewer !== "auto_review") {
      throw new Error(`app-server launch did not default approval reviewer to auto_review: ${JSON.stringify(defaults)}`);
    }
    const explicit = resolveCodexAppServerLaunchOptions({
      approvalPolicy: "on-request",
      approvalsReviewer: "user"
    });
    if (explicit.approvalPolicy !== "on-request" || explicit.approvalsReviewer !== "user") {
      throw new Error(`explicit app-server launch approval settings were not preserved: ${JSON.stringify(explicit)}`);
    }
    process.env.CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER = "guardian_subagent";
    const configured = resolveCodexAppServerLaunchOptions();
    if (configured.approvalsReviewer !== "guardian_subagent") {
      throw new Error(`configured app-server approval reviewer was not preserved: ${JSON.stringify(configured)}`);
    }
  } finally {
    if (previousApprovalPolicy === undefined) delete process.env.CODEX_HUB_APP_SERVER_APPROVAL_POLICY;
    else process.env.CODEX_HUB_APP_SERVER_APPROVAL_POLICY = previousApprovalPolicy;
    if (previousApprovalsReviewer === undefined) delete process.env.CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER;
    else process.env.CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER = previousApprovalsReviewer;
  }
};

const assertProjectRuntimeView = async (apiBase: string, projectId: string, machineId: string) => {
  const payload = await apiJson<ProjectsPayload>(apiBase, "/api/projects");
  assertNoWorkerId(payload, "/api/projects");
  if ("statePath" in asRecord(payload)) throw new Error("/api/projects exposed removed statePath alias");
  const project = (payload.projects ?? []).map(asRecord).find((item) => item.projectId === projectId);
  if (!project) throw new Error(`/api/projects missing opened project ${projectId}`);
  if (project.machineOnline !== true) throw new Error(`/api/projects did not expose machineOnline for ${projectId}`);
  if ("online" in project || "session" in project || "sessions" in project || "threads" in project) {
    throw new Error(`/api/projects exposed runtime fields for ${projectId}: ${JSON.stringify(project)}`);
  }
  const runtimesPayload = await apiJson<RuntimesPayload>(apiBase, "/api/runtimes");
  const runtime = (runtimesPayload.runtimes ?? []).find((item) => item.machineId === machineId);
  if (!runtime?.online) {
    throw new Error(`/api/runtimes did not expose online runtime ${machineId}: ${JSON.stringify(runtimesPayload.runtimes)}`);
  }
};

const assertThreadApprovalSettings = async (
  apiBase: string,
  threadId: string,
  expectedPolicy: string,
  expectedReviewer: string
) => {
  const startedAt = Date.now();
  let latest: ThreadDetail | null = null;
  while (Date.now() - startedAt < 5000) {
    latest = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    if (latest.approvalPolicy === expectedPolicy && latest.approvalsReviewer === expectedReviewer) return;
    await delay(100);
  }
  throw new Error(
    `thread approval settings did not sync to ${expectedPolicy}/${expectedReviewer}: ${JSON.stringify(latest)}`
  );
};

const assertProjectDeleteKeepsSharedRuntime = async (apiBase: string, projectId: string, machineId: string) => {
  const deleted = await apiJson<unknown>(apiBase, `/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE"
  });
  assertNoWorkerId(deleted, "DELETE /api/projects/:projectId");

  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    const payload = await apiJson<{ runtimes?: unknown[] }>(apiBase, "/api/runtimes?includeOffline=true");
    const runtime = (payload.runtimes ?? []).map(asRecord).find((item) => item.machineId === machineId);
    if (runtime?.online === true) return;
    await delay(100);
  }
  const payload = await apiJson<{ runtimes?: unknown[] }>(apiBase, "/api/runtimes?includeOffline=true");
  throw new Error(`machine runtime went offline after deleting project metadata: ${JSON.stringify(payload.runtimes)}`);
};

const assertRuntimeStaysOnlineAfterWatcherIdle = async (apiBase: string, machineId: string) => {
  const previousTimeout = process.env.CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS;
  process.env.CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS = "25";
  try {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-smoke-idle-project."));
    const open = await apiJson<ProjectThreadStartResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId, path: projectDir })
    }, 90_000);
    const threadId = open.result?.threadId;
    if (open.result?.machineId !== machineId || !threadId) throw new Error(`idle project thread start did not return machine/thread ids: ${JSON.stringify(open)}`);
    await subscribeThreadOnce(apiBase, threadId);

    const startedAt = Date.now();
    while (Date.now() - startedAt < 6000) {
      const payload = await apiJson<{ runtimes?: unknown[] }>(apiBase, "/api/runtimes?includeOffline=true");
      const runtime = (payload.runtimes ?? []).map(asRecord).find((item) => item.machineId === machineId);
      if (!runtime || runtime.online !== true) {
        throw new Error(`runtime went offline after watcher idle: ${JSON.stringify(payload.runtimes)}`);
      }
      await delay(100);
    }
  } finally {
    if (previousTimeout === undefined) delete process.env.CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS;
    else process.env.CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS = previousTimeout;
  }
};

const subscribeThreadOnce = async (apiBase: string, threadId: string) => {
  const messages: RealtimeMessage[] = [];
  const ws = new WebSocket(webRealtimeUrl(apiBase));
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as RealtimeMessage);
  });
  try {
    await waitForWebSocketOpen(ws, "idle websocket failed");
    ws.send(JSON.stringify({ type: "hello", runtimesAfter: 0, projectsAfter: 0, tasksAfter: 0, connectionsAfter: 0 }));
    await waitForRealtimeMessage(messages, (message) => message.type === "ready", "idle websocket ready");
    ws.send(JSON.stringify({ type: "subscribe_thread", threadId, after: 0 }));
    await waitForRealtimeMessage(
      messages,
      (message) => message.type === "thread_subscribed" && message.threadId === threadId,
      "idle thread subscription"
    );
  } finally {
    await closeWebSocket(ws);
  }
};

const assertCoreCommandPalette = async (apiBase: string, machineId: string, cwd: string) => {
  const payload = await apiJson<CommandPalettePayload>(
    apiBase,
    `/api/machines/${encodeURIComponent(machineId)}/command-palette?cwd=${encodeURIComponent(cwd)}&part=core`
  );
  assertNoWorkerId(payload, "/api/machines/:machineId/command-palette");
  assertNoCurrentThread(payload, "/api/machines/:machineId/command-palette");
  const entries = Array.isArray(payload.palette?.entries) ? payload.palette.entries.map(asRecord) : [];
  if (!entries.length) throw new Error("command palette did not return entries");
  const builtins = entries.filter((entry) => entry.kind === "builtin");
  const skills = entries.filter((entry) => entry.kind === "skill");
  if (!builtins.some((entry) => entry.name === "model" && entry.insertText === "/model")) {
    throw new Error(`command palette missing /model builtin: ${JSON.stringify(entries.slice(0, 10))}`);
  }
  if (!skills.length) throw new Error("command palette did not include app-server skills");
  if (entries.some((entry) => entry.kind === "plugin")) {
    throw new Error(`command palette core part included plugin entries: ${JSON.stringify(entries.filter((entry) => entry.kind === "plugin").slice(0, 5))}`);
  }
  const staleDollar = skills.find((entry) => typeof entry.insertText === "string" && entry.insertText.startsWith("$"));
  if (staleDollar) throw new Error(`command palette still uses $ trigger: ${JSON.stringify(staleDollar)}`);
  const nonAtEntry = skills.find((entry) => typeof entry.insertText !== "string" || !entry.insertText.startsWith("@"));
  if (nonAtEntry) throw new Error(`command palette plugin/skill entry does not use @ trigger: ${JSON.stringify(nonAtEntry)}`);
};

const assertStatusMarkdown = (thread: ThreadDetail) => {
  const messages = (thread.records ?? [])
    .map((record) => asRecord(asRecord(record).payload))
    .filter((payload) => payload.type === "agent_message")
    .map((payload) => typeof payload.message === "string" ? payload.message : "");
  const statusMessage = messages.find((message) => message.includes("Codex Hub Status"));
  if (!statusMessage) throw new Error(`status markdown message was missing: ${JSON.stringify(messages)}`);
  const requiredSnippets = [
    "## Codex Hub Status",
    "**Thread**",
    "- ID: `",
    "- Folder: `",
    "- State: `",
    "**Runtime**",
    "- Machine runtime: `",
    "- Model: `",
    "**Policy**",
    "- Approval: `",
    "- Approval reviewer: `",
    "- Permissions: `",
    "**Usage**",
    "- Tokens: `",
    "- Context: `",
    "- 5h limit: `",
    "- 7d limit: `",
    "- Observed: `"
  ];
  for (const snippet of requiredSnippets) {
    if (!statusMessage.includes(snippet)) {
      throw new Error(`status markdown missing ${JSON.stringify(snippet)}: ${JSON.stringify(statusMessage)}`);
    }
  }
  if (statusMessage.includes("Codex Hub status\nthread:")) {
    throw new Error(`status still used the old plaintext format: ${JSON.stringify(statusMessage)}`);
  }
};

const assertNoCurrentThread = (value: unknown, label: string) => {
  const currentThreadId = findKey(value, "currentThreadId");
  if (currentThreadId) throw new Error(`${label} exposed currentThreadId at ${currentThreadId}`);
  const currentThread = findKey(value, "currentThread");
  if (currentThread) throw new Error(`${label} exposed currentThread at ${currentThread}`);
};

const assertPluginState = async (apiBase: string, value: unknown) => {
  const plugins = asRecord(value).plugins;
  if (!Array.isArray(plugins)) throw new Error("/api/plugins did not return plugins");
  const telegram = plugins.find((plugin) => asRecord(plugin).pluginId === "codexhub.telegram");
  if (!telegram) throw new Error("builtin Telegram plugin missing");
  const telegramIntegration = integrationsOf(telegram).find((integration) => asRecord(integration).type === "telegram");
  if (!telegramIntegration) throw new Error("Telegram integration missing");
  const telegramRecord = asRecord(telegramIntegration);
  if (telegramRecord.runner !== "builtin") throw new Error("Telegram integration is not builtin");
  if (telegramRecord.configured !== false || telegramRecord.started !== false) {
    throw new Error("Telegram integration should be unconfigured and stopped without TELEGRAM_BOT_TOKEN");
  }

  const external = plugins.find((plugin) => asRecord(plugin).pluginId === "external-channel");
  if (!external) throw new Error("external integration fixture missing");
  const externalIntegration = integrationsOf(external).find((integration) => asRecord(integration).type === "external-channel");
  if (!externalIntegration || asRecord(externalIntegration).runner !== "external") {
    throw new Error("external integration fixture was not reported as external");
  }
  const style = stylesOf(external).find((item) => asRecord(item).path === "style.css");
  const styleUrl = asRecord(style).url;
  if (typeof styleUrl !== "string" || !styleUrl.includes("/api/plugins/external-channel/assets/style.css")) {
    throw new Error(`external plugin style fixture missing url: ${JSON.stringify(style)}`);
  }
  const response = await fetch(new URL(styleUrl, apiBase));
  const css = await response.text();
  if (!response.ok || !css.includes("--codexhub-smoke-plugin")) {
    throw new Error(`external plugin style asset did not load: HTTP ${response.status} ${css}`);
  }
};

const integrationsOf = (plugin: unknown) => {
  const contributions = asRecord(asRecord(plugin).contributions);
  const integrations = contributions.integrations;
  return Array.isArray(integrations) ? integrations : [];
};

const stylesOf = (plugin: unknown) => {
  const contributions = asRecord(asRecord(plugin).contributions);
  const web = asRecord(contributions.web);
  const styles = web.styles;
  return Array.isArray(styles) ? styles : [];
};

const sendLegacySessionRegistration = async (port: number) => {
  const messages: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/machines/connect`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("legacy websocket failed")), { once: true });
  });

  ws.addEventListener("message", (event) => {
    const text = String(event.data);
    messages.push(text);
    const data = JSON.parse(text) as { type?: string };
    if (data.type === "registered") {
      ws.send(JSON.stringify({
        type: "session_register",
        sessionId: "legacy-session",
        registration: {
          workerId: "legacy-worker",
          workingDirectory: os.tmpdir(),
          name: "legacy",
          hostname: "legacy-host"
        }
      }));
    }
  });

  ws.send(JSON.stringify({
    type: "register",
    registration: {
      machineId: "legacy-machine",
      hostname: "legacy-host",
      type: "registered",
      capabilities: { projectLauncher: true }
    }
  }));

  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    const error = messages.find((message) => message.includes("invalid machine transport message"));
    if (error) {
      await closeWebSocket(ws);
      return error;
    }
    await delay(50);
  }
  await closeWebSocket(ws);
  return messages.join("\n");
};

const webRealtimeUrl = (apiBase: string) => {
  const url = new URL("/api/events/ws", apiBase);
  url.protocol = "ws:";
  return url.toString();
};

const waitForWebSocketOpen = async (ws: WebSocket, label: string) => await new Promise<void>((resolve, reject) => {
  if (ws.readyState === WebSocket.OPEN) {
    resolve();
    return;
  }
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", () => reject(new Error(label)), { once: true });
});

const closeWebSocket = async (ws: WebSocket) => {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    ws.addEventListener("close", finish, { once: true });
    ws.close();
  });
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
