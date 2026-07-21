import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { CodexhubServerState } from "../src/core/serverState.js";
import { emptyThreadUsage } from "../src/core/threadUsage.js";
import {
  NotificationHookRunner,
  parseNotificationCommand
} from "../src/core/notificationHooks.js";
import { startServer } from "../src/server/index.js";
import type { CodexRecord } from "../src/shared/recordTypes.js";
import type { ThreadStreamEvent, ThreadSummary } from "../src/shared/threadTypes.js";

const tmpdir = await mkdtemp(path.join(os.tmpdir(), "codexhub-notification-hooks-"));
const defaultConfigLines = [
  "config:",
  "  ui:",
  "    selectedPetId: red-spark",
  "    showFloatingPet: false",
  "    taskCompleteSystemNotifications: false"
];

try {
  const commandOutput = path.join(tmpdir, "command-output.jsonl");
  const commandScript = path.join(tmpdir, "notify-command.mjs");
  await writeFile(commandScript, [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "appendFileSync(process.argv[2], readFileSync(0, 'utf8'));"
  ].join("\n"));

  const errors: string[] = [];
  const runner = new NotificationHookRunner({
    command: `${process.execPath} ${commandScript} ${commandOutput}`,
    timeoutMs: 3000
  }, {
    error: (message) => errors.push(message)
  });

  const records = notificationRecords();
  const event = notificationEvent(records.at(-1)!);
  runner.handleThreadEvent(event, records);
  await eventually(async () => {
    const commandBodies = await commandPayloads(commandOutput);
    if (commandBodies.length !== 1) throw new Error(`expected 1 command body, saw ${commandBodies.length}`);
  });

  runner.handleThreadEvent(event, records);
  runner.handleThreadEvent({ ...event, seq: 2, historical: true }, records);
  await delay(250);
  const commandBodies = await commandPayloads(commandOutput);
  if (commandBodies.length !== 1) throw new Error(`duplicate/historical event sent ${commandBodies.length} command bodies`);
  if (errors.length) throw new Error(errors.join("\n"));

  const payload = commandBodies[0] as Record<string, unknown>;
  if (payload.type !== "task_complete") throw new Error(`unexpected payload type: ${payload.type}`);
  if (payload.threadId !== "thread-test") throw new Error(`unexpected payload threadId: ${payload.threadId}`);
  if (payload.turnId !== "turn-test") throw new Error(`unexpected payload turnId: ${payload.turnId}`);
  if (payload.body !== "Smoke hook final answer") throw new Error(`unexpected payload body: ${payload.body}`);
  if (payload.duration !== "2.5s") throw new Error(`unexpected payload duration: ${payload.duration}`);

  const parsed = parseNotificationCommand(String.raw`C:\Tools\notify.cmd --flag "two words"`);
  if (JSON.stringify(parsed) !== JSON.stringify([String.raw`C:\Tools\notify.cmd`, "--flag", "two words"])) {
    throw new Error(`notification command parser mangled Windows path: ${JSON.stringify(parsed)}`);
  }

  await assertServerStateEnv(tmpdir);
  await assertServerUiConfig(tmpdir);
  await assertExternalEnvEditsSurviveStateSave(tmpdir);
} finally {
  await rm(tmpdir, { recursive: true, force: true });
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
    "  CODEX_HUB_NOTIFICATION_COMMAND: \"from-state\"",
    "  CODEX_HUB_NOTIFICATION_TIMEOUT_MS: 1234",
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
  const targetEnv: NodeJS.ProcessEnv = { CODEX_HUB_NOTIFICATION_COMMAND: "from-process" };
  state.applyEnvToProcess(targetEnv);
  if (targetEnv.CODEX_HUB_NOTIFICATION_COMMAND !== "from-process") {
    throw new Error("config env overrode an existing process env value");
  }
  if (targetEnv.CODEX_HUB_HOST !== "127.0.0.1") throw new Error("config env did not apply host");
  if (targetEnv.CODEX_HUB_NOTIFICATION_TIMEOUT_MS !== "1234") {
    throw new Error(`config numeric env was not stringified: ${targetEnv.CODEX_HUB_NOTIFICATION_TIMEOUT_MS}`);
  }
  if ("BAD-NAME" in targetEnv || "OBJECT_VALUE" in targetEnv) throw new Error("config env kept invalid entries");

  const previous = {
    host: process.env.CODEX_HUB_HOST,
    notificationCommand: process.env.CODEX_HUB_NOTIFICATION_COMMAND,
    notificationTimeoutMs: process.env.CODEX_HUB_NOTIFICATION_TIMEOUT_MS
  };
  delete process.env.CODEX_HUB_HOST;
  delete process.env.CODEX_HUB_NOTIFICATION_COMMAND;
  delete process.env.CODEX_HUB_NOTIFICATION_TIMEOUT_MS;

  const port = await freePort();
  const handle = await startServer({
    dataDir,
    port,
    features: { localMachine: false, ssh: false, tasks: false, integrations: false }
  });
  try {
    if (handle.host !== "127.0.0.1") throw new Error(`config env was not applied before loadConfig: ${handle.host}`);
    if (process.env.CODEX_HUB_NOTIFICATION_COMMAND !== "from-state") {
      throw new Error("config notification command was not loaded during server init");
    }
  } finally {
    await handle.stop();
    restoreEnv("CODEX_HUB_HOST", previous.host);
    restoreEnv("CODEX_HUB_NOTIFICATION_COMMAND", previous.notificationCommand);
    restoreEnv("CODEX_HUB_NOTIFICATION_TIMEOUT_MS", previous.notificationTimeoutMs);
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
  if (state.config().ui.selectedPetId !== "red-spark") {
    throw new Error("missing UI config did not default the selected pet to red-spark");
  }
  if (state.config().ui.showFloatingPet !== false) {
    throw new Error("missing UI config did not default floating pet to false");
  }
  if (state.config().ui.taskCompleteSystemNotifications !== false) {
    throw new Error("missing UI config did not default task complete notifications to false");
  }
  const migrated = YAML.parse(await readFile(configPath, "utf8")) as {
    config?: { ui?: { selectedPetId?: unknown; showFloatingPet?: unknown; taskCompleteSystemNotifications?: unknown } };
  };
  if (migrated.config?.ui?.selectedPetId !== "red-spark") {
    throw new Error(`missing selected pet config was not written to config.yaml: ${JSON.stringify(migrated.config)}`);
  }
  if (migrated.config?.ui?.showFloatingPet !== false) {
    throw new Error(`missing floating pet config was not written to config.yaml: ${JSON.stringify(migrated.config)}`);
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
      config?: { ui?: { selectedPetId?: unknown; showFloatingPet?: unknown; taskCompleteSystemNotifications?: unknown } };
    }>(`${base}/api/config`);
    if (initial.config?.ui?.selectedPetId !== "red-spark") {
      throw new Error(`server selected pet config did not use the fallback: ${JSON.stringify(initial.config)}`);
    }
    if (initial.config?.ui?.showFloatingPet !== false) {
      throw new Error(`server floating pet config default was not false: ${JSON.stringify(initial.config)}`);
    }
    if (initial.config?.ui?.taskCompleteSystemNotifications !== false) {
      throw new Error(`server UI config default was not false: ${JSON.stringify(initial.config)}`);
    }
    const updated = await jsonFetch<{
      config?: { ui?: { selectedPetId?: unknown; showFloatingPet?: unknown; taskCompleteSystemNotifications?: unknown } };
    }>(`${base}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ui: { selectedPetId: "custom-pet", showFloatingPet: true, taskCompleteSystemNotifications: true } })
    });
    if (updated.config?.ui?.selectedPetId !== "custom-pet") {
      throw new Error(`server selected pet config patch did not return the selection: ${JSON.stringify(updated.config)}`);
    }
    if (updated.config?.ui?.showFloatingPet !== true) {
      throw new Error(`server floating pet config patch did not return true: ${JSON.stringify(updated.config)}`);
    }
    if (updated.config?.ui?.taskCompleteSystemNotifications !== true) {
      throw new Error(`server UI config patch did not return true: ${JSON.stringify(updated.config)}`);
    }
  } finally {
    await handle.stop();
  }

  const saved = YAML.parse(await readFile(configPath, "utf8")) as {
    config?: { ui?: { selectedPetId?: unknown; showFloatingPet?: unknown; taskCompleteSystemNotifications?: unknown } };
  };
  if (saved.config?.ui?.selectedPetId !== "custom-pet") {
    throw new Error(`server selected pet config patch was not saved: ${JSON.stringify(saved.config)}`);
  }
  if (saved.config?.ui?.showFloatingPet !== true) {
    throw new Error(`server floating pet config patch was not saved: ${JSON.stringify(saved.config)}`);
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
    "  CODEX_HUB_NOTIFICATION_COMMAND: \"from-loaded-state\"",
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
    "  CODEX_HUB_NOTIFICATION_COMMAND: \"from-user-edit\"",
    "  CODEX_HUB_NOTIFICATION_TIMEOUT_MS: 7000",
    "machines: []",
    "projects: []",
    "tasks: []",
    "sshHosts: []",
    ""
  ].join("\n"));
  state.upsertSshHost({ alias: "external-env-edit-smoke" });
  await state.flush();
  const saved = YAML.parse(await readFile(configPath, "utf8")) as { env?: Record<string, unknown> };
  if (saved.env?.CODEX_HUB_NOTIFICATION_COMMAND !== "from-user-edit") {
    throw new Error(`state save clobbered external env edit: ${JSON.stringify(saved.env)}`);
  }
  if (saved.env?.CODEX_HUB_NOTIFICATION_TIMEOUT_MS !== "7000") {
    throw new Error(`state save did not preserve external env timeout edit: ${JSON.stringify(saved.env)}`);
  }
}

function notificationRecords(): CodexRecord[] {
  return [
    {
      id: "app:thread-test:turn-test:agent:message",
      timestamp: "2026-06-17T00:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        phase: "final_answer",
        message: "Smoke hook final answer"
      }
    },
    {
      id: "app:thread-test:turn-test:event:task_complete",
      timestamp: "2026-06-17T00:00:02.500Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-test",
        duration_ms: 2500
      }
    }
  ];
}

function notificationEvent(record: CodexRecord): ThreadStreamEvent {
  return {
    seq: 1,
    threadId: "thread-test",
    kind: "record",
    thread: testThread(),
    record
  };
}

function testThread(): ThreadSummary {
  return {
    threadId: "thread-test",
    workingDirectory: "/tmp/codexhub-test",
    session: {
      sessionId: "session-test",
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

async function commandPayloads(filePath: string) {
  const text = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
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

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
