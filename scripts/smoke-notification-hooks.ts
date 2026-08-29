import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { CodexhubServerState } from "../src/core/serverState.js";
import { emptyThreadUsage } from "../src/core/threadUsage.js";
import { NtfyNotificationRunner } from "../src/core/notificationHooks.js";
import { startServer } from "../src/server/index.js";
import type { CodexRecord } from "../src/shared/recordTypes.js";
import type { ThreadStreamEvent, ThreadSummary } from "../src/shared/threadTypes.js";

const tmpdir = await mkdtemp(path.join(os.tmpdir(), "codexhub-notification-hooks-"));
const defaultConfigLines = [
  "config:",
  "  ui:",
  "    selectedPetId: guga",
  "    showFloatingPet: false",
  "    taskCompleteSystemNotifications: false"
];

try {
  await assertNtfyLifecycle();
  await assertNtfyTerminalRecovery();
  await assertNtfyGlobalPacing();

  await assertServerStateEnv(tmpdir);
  await assertServerUiConfig(tmpdir);
  await assertExternalEnvEditsSurviveStateSave(tmpdir);
} finally {
  await rm(tmpdir, { recursive: true, force: true });
}

async function assertNtfyLifecycle() {
  const requests: Array<{ path: string; title: string; tags: string; body: string }> = [];
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        path: request.url ?? "",
        title: String(request.headers.title ?? ""),
        tags: String(request.headers.tags ?? ""),
        body: Buffer.concat(chunks).toString("utf8")
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const port = await listenHttp(server);
  const runner = new NtfyNotificationRunner({
    url: `http://127.0.0.1:${port}/codexhub-smoke`,
    timeoutMs: 1000,
    updateIntervalMs: 20,
    requestIntervalMs: 5
  });
  const started = lifecycleRecord("task_started", "turn-ntfy", "2026-06-17T00:00:00.000Z");
  const progress = lifecycleRecord("turn_plan_updated", "turn-ntfy", "2026-06-17T00:00:00.500Z", undefined, {
    plan: [
      { step: "first", status: "completed" },
      { step: "second", status: "inProgress" },
      { step: "third", status: "pending" },
      { step: "fourth", status: "pending" }
    ]
  });
  const finalAnswer = lifecycleRecord("agent_message", "turn-ntfy", "2026-06-17T00:00:00.800Z");
  const completed = lifecycleRecord("task_complete", "turn-ntfy", "2026-06-17T00:00:01.000Z", 1000);
  runner.handleThreadEvent(lifecycleEvent(started, runningThread("turn-ntfy", "Running smoke")), [started]);
  await eventually(async () => {
    if (requests.length !== 1) throw new Error(`expected ntfy start request, saw ${requests.length}`);
  });
  runner.handleThreadEvent(lifecycleEvent(progress, runningThread("turn-ntfy", "Progress smoke")), [started, progress]);
  await eventually(async () => {
    if (requests.length !== 2) throw new Error(`expected ntfy progress request, saw ${requests.length}`);
  });
  runner.handleThreadEvent(lifecycleEvent(completed, idleThread()), [started, progress, finalAnswer, completed]);
  await eventually(async () => {
    if (requests.length !== 3) throw new Error(`expected ntfy completion request, saw ${requests.length}`);
  });
  const sequencePaths = requests.map((request) => request.path);
  if (new Set(sequencePaths).size !== 1) throw new Error(`ntfy sequence changed: ${JSON.stringify(sequencePaths)}`);
  const titles = requests.map((request) => decodeNtfyHeader(request.title));
  if (titles[0] !== "Running smoke"
    || titles[1] !== "Progress smoke"
    || !requests[0].body.includes("codexhub-test")
    || !requests[0].body.includes("运行中")
    || !requests[1].body.includes("codexhub-test")
    || !requests[1].body.includes("运行中")) {
    throw new Error(`ntfy running activity was not preserved: ${JSON.stringify(requests)}`);
  }
  if (!requests[1].body.includes("进度 2/4")) {
    throw new Error(`ntfy plan progress was not included: ${requests[1].body}`);
  }
  if (titles[2] !== "Smoke hook"
    || !requests[2].body.includes("codexhub-test")
    || !requests[2].body.includes("已完成")
    || requests[2].tags !== "white_check_mark") {
    throw new Error(`ntfy completion update was wrong: ${JSON.stringify(requests[2])}`);
  }
  if (!requests[2].body.includes("Smoke hook final answer")) {
    throw new Error(`ntfy completion body missed final answer: ${requests[2].body}`);
  }

  const failedStart = lifecycleRecord("task_started", "turn-ntfy-failed", "2026-06-17T00:00:02.000Z");
  const failed = lifecycleRecord("turn_aborted", "turn-ntfy-failed", "2026-06-17T00:00:03.000Z", undefined, {
    status: "failed",
    reason: "Smoke failure"
  });
  runner.handleThreadEvent(
    lifecycleEvent(failedStart, runningThread("turn-ntfy-failed", "Failure smoke")),
    [failedStart]
  );
  await eventually(async () => {
    if (requests.length !== 4) throw new Error(`expected ntfy failure start request, saw ${requests.length}`);
  });
  runner.handleThreadEvent(lifecycleEvent(failed, idleThread()), [failedStart, failed]);
  await eventually(async () => {
    if (requests.length !== 5) throw new Error(`expected ntfy failure request, saw ${requests.length}`);
  });
  const failureTitles = requests.slice(3).map((request) => decodeNtfyHeader(request.title));
  if (failureTitles[0] !== "Failure smoke"
    || failureTitles[1] !== "Smoke hook"
    || !requests[4].body.includes("codexhub-test")
    || !requests[4].body.includes("失败")
    || requests[4].tags !== "x"
    || !requests[4].body.includes("Smoke failure")) {
    throw new Error(`ntfy failure update was wrong: ${JSON.stringify(requests.slice(3))}`);
  }
  if (requests[3].path !== requests[4].path || requests[3].path === requests[0].path) {
    throw new Error(`ntfy failure sequence was not isolated: ${JSON.stringify(requests.slice(3))}`);
  }
  await closeHttp(server);
}

async function assertNtfyTerminalRecovery() {
  const requests: Array<{ at: number; path: string; body: string }> = [];
  let terminalAttempts = 0;
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ at: Date.now(), path: request.url ?? "", body });
      if (!body.includes("已完成")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      terminalAttempts += 1;
      if (terminalAttempts === 1) {
        // The first terminal request exercises timeout recovery.
        setTimeout(() => {
          if (response.destroyed) return;
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
        }, 80).unref?.();
        return;
      }
      if (terminalAttempts === 2) {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0.01"
        });
        response.end(JSON.stringify({ error: "rate limited" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const port = await listenHttp(server);
  const errors: string[] = [];
  const runner = new NtfyNotificationRunner({
    url: `http://127.0.0.1:${port}/codexhub-retry-smoke`,
    timeoutMs: 20,
    updateIntervalMs: 5,
    requestIntervalMs: 100
  }, {
    error: (message) => errors.push(message)
  });
  const turnId = "turn-ntfy-retry";
  const started = lifecycleRecord("task_started", turnId, "2026-06-17T00:00:04.000Z");
  const progress = lifecycleRecord("agent_message", turnId, "2026-06-17T00:00:04.500Z");
  const completed = lifecycleRecord("task_complete", turnId, "2026-06-17T00:00:05.000Z", 1000);
  runner.handleThreadEvent(lifecycleEvent(started, runningThread(turnId, "Retry smoke")), [started]);
  await eventually(async () => {
    if (requests.length !== 1) throw new Error(`expected ntfy retry start request, saw ${requests.length}`);
  });
  runner.handleThreadEvent(
    lifecycleEvent(progress, runningThread(turnId, "Retry progress")),
    [started, progress]
  );
  runner.handleThreadEvent(lifecycleEvent(completed, idleThread()), [started, progress, completed]);
  await eventually(async () => {
    if (terminalAttempts !== 3) {
      throw new Error(`expected timeout and 429 terminal retries, saw ${terminalAttempts}`);
    }
  });

  const terminalRequests = requests.filter((request) => request.body.includes("已完成"));
  if (terminalRequests.length !== 3 || new Set(requests.map((request) => request.path)).size !== 1) {
    throw new Error(`ntfy terminal retry sequence changed: ${JSON.stringify(requests)}`);
  }
  if (requests.some((request) => request.body.includes("Retry progress"))) {
    throw new Error(`queued progress was not superseded by terminal delivery: ${JSON.stringify(requests)}`);
  }
  if (requests.slice(1).some((request, index) => request.at - requests[index].at < 75)) {
    throw new Error(`ntfy global request pacing was not applied: ${JSON.stringify(requests)}`);
  }
  if (errors.length !== 2
    || !errors[0].includes("retrying")
    || !errors[1].includes("HTTP 429")
    || !errors[1].includes("retrying")) {
    throw new Error(`ntfy terminal retry diagnostics were incomplete: ${JSON.stringify(errors)}`);
  }

  // A late live record for a completed Turn must never replace its terminal
  // notification with "running" again.
  runner.handleThreadEvent(
    lifecycleEvent(progress, runningThread(turnId, "Late progress")),
    [started, progress, completed]
  );
  await delay(150);
  if (requests.length !== 4) {
    throw new Error(`late ntfy progress revived a completed notification: ${JSON.stringify(requests)}`);
  }
  await closeHttp(server);
}

async function assertNtfyGlobalPacing() {
  const requests: Array<{ at: number; path: string; body: string }> = [];
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        at: Date.now(),
        path: request.url ?? "",
        body: Buffer.concat(chunks).toString("utf8")
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  const port = await listenHttp(server);
  const runner = new NtfyNotificationRunner({
    url: `http://127.0.0.1:${port}/codexhub-global-smoke`,
    timeoutMs: 1000,
    updateIntervalMs: 5,
    requestIntervalMs: 60
  });
  const turnA = "turn-global-a";
  const turnB = "turn-global-b";
  const startedA = lifecycleRecord("task_started", turnA, "2026-06-17T00:00:06.000Z");
  const startedB = lifecycleRecord("task_started", turnB, "2026-06-17T00:00:06.100Z");
  const completedA = lifecycleRecord("task_complete", turnA, "2026-06-17T00:00:07.000Z", 1000);
  const threadA = { ...runningThread(turnA, "Global A"), threadId: "thread-global-a" };
  const threadB = { ...runningThread(turnB, "Global B"), threadId: "thread-global-b" };

  runner.handleThreadEvent(lifecycleEvent(startedA, threadA), [startedA]);
  runner.handleThreadEvent(lifecycleEvent(startedB, threadB), [startedB]);
  runner.handleThreadEvent(
    lifecycleEvent(completedA, { ...idleThread(), threadId: threadA.threadId }),
    [startedA, completedA]
  );
  await eventually(async () => {
    if (requests.length !== 3) throw new Error(`expected three globally paced ntfy requests, saw ${requests.length}`);
  });

  if (!requests[0].body.includes("运行中")
    || !requests[1].body.includes("已完成")
    || !requests[2].body.includes("运行中")
    || requests[0].path !== requests[1].path
    || requests[1].path === requests[2].path) {
    throw new Error(`ntfy terminal did not take global queue priority: ${JSON.stringify(requests)}`);
  }
  if (requests.slice(1).some((request, index) => request.at - requests[index].at < 45)) {
    throw new Error(`ntfy requests from different Turns bypassed global pacing: ${JSON.stringify(requests)}`);
  }
  await closeHttp(server);
}

async function assertServerStateEnv(root: string) {
  const dataDir = path.join(root, "state-env");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "config.yaml"), [
    "version: 1",
    "updatedAt: \"2026-06-17T00:00:00.000Z\"",
    ...defaultConfigLines,
    "env:",
    "  CODEX_HUB_HOST: \"127.0.0.1\"",
    "  CODEX_HUB_NTFY_URL: \"https://ntfy.sh/from-state\"",
    "  CODEX_HUB_NTFY_TIMEOUT_MS: 1234",
    "  BAD-NAME: \"ignored\"",
    "  OBJECT_VALUE:",
    "    nested: \"ignored\"",
    "machines: []",
    "projects: []",
    "tasks: []",
    "sshHosts: []",
    ""
  ].join("\n"));

  const state = await CodexhubServerState.load({ dataDir });
  const targetEnv: NodeJS.ProcessEnv = { CODEX_HUB_NTFY_URL: "from-process" };
  state.applyEnvToProcess(targetEnv);
  if (targetEnv.CODEX_HUB_NTFY_URL !== "from-process") {
    throw new Error("config env overrode an existing process env value");
  }
  if (targetEnv.CODEX_HUB_HOST !== "127.0.0.1") throw new Error("config env did not apply host");
  if (targetEnv.CODEX_HUB_NTFY_TIMEOUT_MS !== "1234") {
    throw new Error(`config numeric env was not stringified: ${targetEnv.CODEX_HUB_NTFY_TIMEOUT_MS}`);
  }
  if ("BAD-NAME" in targetEnv || "OBJECT_VALUE" in targetEnv) throw new Error("config env kept invalid entries");

  const previous = {
    host: process.env.CODEX_HUB_HOST,
    ntfyUrl: process.env.CODEX_HUB_NTFY_URL,
    ntfyTimeoutMs: process.env.CODEX_HUB_NTFY_TIMEOUT_MS
  };
  delete process.env.CODEX_HUB_HOST;
  delete process.env.CODEX_HUB_NTFY_URL;
  delete process.env.CODEX_HUB_NTFY_TIMEOUT_MS;

  const port = await freePort();
  const handle = await startServer({
    dataDir,
    port,
    features: { localMachine: false, ssh: false, tasks: false, integrations: false }
  });
  try {
    if (handle.host !== "127.0.0.1") throw new Error(`config env was not applied before loadConfig: ${handle.host}`);
    if (process.env.CODEX_HUB_NTFY_URL !== "https://ntfy.sh/from-state") {
      throw new Error("config ntfy URL was not loaded during server init");
    }
  } finally {
    await handle.stop();
    restoreEnv("CODEX_HUB_HOST", previous.host);
    restoreEnv("CODEX_HUB_NTFY_URL", previous.ntfyUrl);
    restoreEnv("CODEX_HUB_NTFY_TIMEOUT_MS", previous.ntfyTimeoutMs);
  }
}

async function assertServerUiConfig(root: string) {
  const dataDir = path.join(root, "state-ui-config");
  const configPath = path.join(dataDir, "config.yaml");
  await mkdir(dataDir, { recursive: true });
  await writeFile(configPath, [
    "version: 1",
    "updatedAt: \"2026-06-17T00:00:00.000Z\"",
    "env: {}",
    "machines: []",
    "projects: []",
    "tasks: []",
    "sshHosts: []",
    ""
  ].join("\n"));

  const state = await CodexhubServerState.load({ dataDir });
  if (state.config().ui.selectedPetId !== "guga") {
    throw new Error("missing UI config did not default the selected pet to guga");
  }
  if (state.config().ui.showFloatingPet !== false) {
    throw new Error("missing UI config did not default floating pet to false");
  }
  if (state.config().ui.showDesktopPet !== false) {
    throw new Error("missing UI config did not default desktop pet to false");
  }
  if (state.config().ui.taskCompleteSystemNotifications !== false) {
    throw new Error("missing UI config did not default task complete notifications to false");
  }
  const migrated = YAML.parse(await readFile(configPath, "utf8")) as {
    config?: { ui?: { selectedPetId?: unknown; showFloatingPet?: unknown; showDesktopPet?: unknown; taskCompleteSystemNotifications?: unknown } };
  };
  if (migrated.config?.ui?.selectedPetId !== "guga") {
    throw new Error(`missing selected pet config was not written to config.yaml: ${JSON.stringify(migrated.config)}`);
  }
  if (migrated.config?.ui?.showFloatingPet !== false) {
    throw new Error(`missing floating pet config was not written to config.yaml: ${JSON.stringify(migrated.config)}`);
  }
  if (migrated.config?.ui?.showDesktopPet !== false) {
    throw new Error(`missing desktop pet config was not written to config.yaml: ${JSON.stringify(migrated.config)}`);
  }
  if (migrated.config?.ui?.taskCompleteSystemNotifications !== false) {
    throw new Error(`missing UI config was not written to config.yaml: ${JSON.stringify(migrated.config)}`);
  }

  const port = await freePort();
  const handle = await startServer({
    dataDir,
    port,
    features: { localMachine: false, ssh: false, tasks: false, integrations: false }
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const initial = await jsonFetch<{
      config?: { ui?: { selectedPetId?: unknown; showFloatingPet?: unknown; showDesktopPet?: unknown; taskCompleteSystemNotifications?: unknown } };
    }>(`${base}/api/config`);
    if (initial.config?.ui?.selectedPetId !== "guga") {
      throw new Error(`server selected pet config did not use the fallback: ${JSON.stringify(initial.config)}`);
    }
    if (initial.config?.ui?.showFloatingPet !== false) {
      throw new Error(`server floating pet config default was not false: ${JSON.stringify(initial.config)}`);
    }
    if (initial.config?.ui?.showDesktopPet !== false) {
      throw new Error(`server desktop pet config default was not false: ${JSON.stringify(initial.config)}`);
    }
    if (initial.config?.ui?.taskCompleteSystemNotifications !== false) {
      throw new Error(`server UI config default was not false: ${JSON.stringify(initial.config)}`);
    }
    const updated = await jsonFetch<{
      config?: { ui?: { selectedPetId?: unknown; showFloatingPet?: unknown; showDesktopPet?: unknown; taskCompleteSystemNotifications?: unknown } };
    }>(`${base}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ui: { selectedPetId: "custom-pet", showFloatingPet: true, showDesktopPet: true, taskCompleteSystemNotifications: true } })
    });
    if (updated.config?.ui?.selectedPetId !== "custom-pet") {
      throw new Error(`server selected pet config patch did not return the selection: ${JSON.stringify(updated.config)}`);
    }
    if (updated.config?.ui?.showFloatingPet !== true) {
      throw new Error(`server floating pet config patch did not return true: ${JSON.stringify(updated.config)}`);
    }
    if (updated.config?.ui?.showDesktopPet !== true) {
      throw new Error(`server desktop pet config patch did not return true: ${JSON.stringify(updated.config)}`);
    }
    if (updated.config?.ui?.taskCompleteSystemNotifications !== true) {
      throw new Error(`server UI config patch did not return true: ${JSON.stringify(updated.config)}`);
    }
  } finally {
    await handle.stop();
  }

  const saved = YAML.parse(await readFile(configPath, "utf8")) as {
    config?: { ui?: { selectedPetId?: unknown; showFloatingPet?: unknown; showDesktopPet?: unknown; taskCompleteSystemNotifications?: unknown } };
  };
  if (saved.config?.ui?.selectedPetId !== "custom-pet") {
    throw new Error(`server selected pet config patch was not saved: ${JSON.stringify(saved.config)}`);
  }
  if (saved.config?.ui?.showFloatingPet !== true) {
    throw new Error(`server floating pet config patch was not saved: ${JSON.stringify(saved.config)}`);
  }
  if (saved.config?.ui?.showDesktopPet !== true) {
    throw new Error(`server desktop pet config patch was not saved: ${JSON.stringify(saved.config)}`);
  }
  if (saved.config?.ui?.taskCompleteSystemNotifications !== true) {
    throw new Error(`server UI config patch was not saved: ${JSON.stringify(saved.config)}`);
  }
}

async function assertExternalEnvEditsSurviveStateSave(root: string) {
  const dataDir = path.join(root, "state-env-external-edit");
  const configPath = path.join(dataDir, "config.yaml");
  await mkdir(dataDir, { recursive: true });
  await writeFile(configPath, [
    "version: 1",
    "updatedAt: \"2026-06-17T00:00:00.000Z\"",
    ...defaultConfigLines,
    "env:",
    "  CODEX_HUB_NTFY_URL: \"https://ntfy.sh/from-loaded-state\"",
    "machines: []",
    "projects: []",
    "tasks: []",
    "sshHosts: []",
    ""
  ].join("\n"));
  const state = await CodexhubServerState.load({ dataDir });
  await writeFile(configPath, [
    "version: 1",
    "updatedAt: \"2026-06-17T00:00:01.000Z\"",
    ...defaultConfigLines,
    "env:",
    "  CODEX_HUB_NTFY_URL: \"https://ntfy.sh/from-user-edit\"",
    "  CODEX_HUB_NTFY_TIMEOUT_MS: 7000",
    "machines: []",
    "projects: []",
    "tasks: []",
    "sshHosts: []",
    ""
  ].join("\n"));
  state.upsertSshHost({ alias: "external-env-edit-smoke" });
  await state.flush();
  const saved = YAML.parse(await readFile(configPath, "utf8")) as { env?: Record<string, unknown> };
  if (saved.env?.CODEX_HUB_NTFY_URL !== "https://ntfy.sh/from-user-edit") {
    throw new Error(`state save clobbered external env edit: ${JSON.stringify(saved.env)}`);
  }
  if (saved.env?.CODEX_HUB_NTFY_TIMEOUT_MS !== "7000") {
    throw new Error(`state save did not preserve external env timeout edit: ${JSON.stringify(saved.env)}`);
  }
}

function lifecycleRecord(
  type: "task_started" | "agent_message" | "turn_plan_updated" | "task_complete" | "turn_aborted",
  turnId: string,
  timestamp: string,
  durationMs?: number,
  extraPayload: Record<string, unknown> = {}
): CodexRecord {
  const suffix = type === "task_started"
    ? "event:task_started"
    : type === "task_complete"
      ? "event:task_complete"
      : type === "turn_aborted"
        ? "event:turn_aborted"
        : type === "turn_plan_updated"
          ? "event:turn_plan_updated"
          : "agent:progress";
  return {
    id: `app:thread-test:${turnId}:${suffix}`,
    timestamp,
    type: "event_msg",
    payload: {
      type,
      turn_id: turnId,
      ...(type === "agent_message" ? { phase: "final_answer", message: "Smoke hook final answer" } : {}),
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
      ...extraPayload
    }
  };
}

function lifecycleEvent(record: CodexRecord, thread: ThreadSummary): ThreadStreamEvent {
  return {
    seq: 1,
    threadId: thread.threadId,
    kind: "record",
    thread,
    record
  };
}

function runningThread(turnId: string, activityTitle: string): ThreadSummary {
  return {
    ...testThread(),
    status: "running",
    running: true,
    activeTurnId: turnId,
    activeTurnStartedAt: "2026-06-17T00:00:00.000Z",
    activityTitle
  };
}

function idleThread(): ThreadSummary {
  return {
    ...testThread(),
    updatedAt: "2026-06-17T00:00:01.000Z"
  };
}

function testThread(): ThreadSummary {
  return {
    threadId: "thread-test",
    workingDirectory: "/tmp/codexhub-test",
    runtime: {
      machineId: "session-test",
      online: true,
      runnable: true
    },
    status: "idle",
    running: false,
    title: "Smoke hook",
    updatedAt: "2026-06-17T00:00:02.500Z",
    messageCount: 1,
    threadUsage: emptyThreadUsage()
  };
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

async function eventually(check: () => Promise<void>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() <= deadline) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function delay(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate a free TCP port")));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function listenHttp(server: ReturnType<typeof createHttpServer>) {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate an HTTP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeHttp(server: ReturnType<typeof createHttpServer>) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function decodeNtfyHeader(value: string) {
  const match = value.match(/^=\?UTF-8\?B\?([^?]+)\?=$/i);
  return match ? Buffer.from(match[1], "base64").toString("utf8") : value;
}
