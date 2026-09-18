import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  apiJson,
  createBackendRegistrationFixture,
  waitFor,
  type BackendRegistrationFixture
} from "../test-support/backendRegistrationFixture.js";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const tsxCli = path.join(projectRoot, "node_modules/tsx/dist/cli.mjs");

test("conversation CLI creates, resumes, names, and sends through --connect with bearer auth", { timeout: 45_000 }, async () => {
  const fixture = await createBackendRegistrationFixture();
  const cliDataDir = await mkdtemp(path.join(fixture.root, "cli-conversation-data-"));
  let persistent: Awaited<ReturnType<typeof startPersistentCli>> | undefined;
  try {
    const cwd = process.cwd();
    persistent = await startPersistentCli(fixture, cliDataDir, [
      "--connect", fixture.childUrl,
      "start", "first cli input",
      "--name", "CLI conversation",
      "--cwd", cwd
    ]);
    const first = { threadId: persistent.threadId };
    assert.match(first.threadId, /^mock-thread-/);

    await waitFor(
      async () => apiJson<{ threadId?: string; records?: Array<{ payload?: unknown }> }>(
        fixture.childUrl,
        `/api/threads/${encodeURIComponent(first.threadId)}`,
        fixture.childAuthToken
      ),
      (detail) => detail.status === 200 && JSON.stringify(detail.body.records).includes("mock response"),
      "first no-wait turn completion"
    );

    const sent = await runCli(fixture, cliDataDir, [
      "--server", fixture.childUrl,
      "send", first.threadId, "second cli input",
      "--cwd", cwd,
      "--json"
    ]);
    assert.equal(sent.code, 0, sent.stderr || sent.stdout);
    const second = parseJson(sent.stdout);
    assert.equal(second.threadId, first.threadId);
    assert.equal(second.waited, false);

    await waitFor(
      async () => apiJson<{ records?: Array<{ payload?: unknown }> }>(
        fixture.childUrl,
        `/api/threads/${encodeURIComponent(first.threadId)}`,
        fixture.childAuthToken
      ),
      (detail) => detail.status === 200 && JSON.stringify(detail.body.records).includes("second cli input"),
      "second no-wait turn completion"
    );

    const ended = await runCli(fixture, cliDataDir, [
      "--connect", fixture.childUrl,
      "end", first.threadId, "--timeout", "20", "--json"
    ]);
    assert.equal(ended.code, 0, ended.stderr || ended.stdout);
    assert.equal((await persistent.exit).code, 0, (await persistent.exit).stderr);
  } finally {
    if (persistent && persistent.child.exitCode === null) await persistent.stop();
    await rm(cliDataDir, { recursive: true, force: true });
    await fixture.stop();
  }
});

test("conversation CLI rejects conflicting --connect and --server without contacting either backend", { timeout: 15_000 }, async () => {
  const fixture = await createBackendRegistrationFixture();
  const cliDataDir = await mkdtemp(path.join(fixture.root, "cli-conversation-conflict-"));
  try {
    const result = await runCli(fixture, cliDataDir, [
      "--connect", fixture.childUrl,
      "--server", `${fixture.childUrl}/different`,
      "start", "should not submit",
      "--name", "Conflict"
    ]);
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /different CodexHub backends/);
  } finally {
    await rm(cliDataDir, { recursive: true, force: true });
    await fixture.stop();
  }
});

const runCli = async (fixture: BackendRegistrationFixture, dataDir: string, args: string[]) => {
  const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_HUB_DATA_DIR: dataDir,
      CODEX_HUB_AUTH_TOKEN: fixture.childAuthToken,
      CODEX_HUB_PLUGIN_TELEGRAM: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8").trim(),
    stderr: Buffer.concat(stderr).toString("utf8").trim()
  };
};

const startPersistentCli = async (fixture: BackendRegistrationFixture, dataDir: string, args: string[]) => {
  const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_HUB_DATA_DIR: dataDir,
      CODEX_HUB_AUTH_TOKEN: fixture.childAuthToken,
      CODEX_HUB_PLUGIN_TELEGRAM: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  await waitFor(
    async () => ({ status: 200, body: { output: stdout } }),
    (value) => /Thread ID:\s*\S+/.test(value.body.output),
    "persistent CLI thread id"
  );
  await waitFor(
    async () => ({ status: 200, body: { output: stdout } }),
    (value) => /mock response/.test(value.body.output),
    "persistent CLI first response"
  );
  const threadId = stdout.match(/Thread ID:\s*(\S+)/)?.[1];
  if (!threadId) throw new Error("Persistent CLI did not print a thread ID.");
  const exit = new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
  return {
    child,
    threadId,
    exit,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exit.catch(() => undefined);
    }
  };
};

const parseJson = (value: string): any => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`CLI did not print JSON: ${value}\n${error instanceof Error ? error.message : String(error)}`);
  }
};
