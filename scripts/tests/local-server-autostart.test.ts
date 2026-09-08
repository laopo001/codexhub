import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { access, stat } from "node:fs/promises";
import test from "node:test";
import { defaultLocalServerUrl } from "../../src/cli/localServerBootstrap.js";
import {
  createLocalServerAutostartFixture,
  waitForFixture
} from "../test-support/localServerAutostartFixture.js";

test("local endpoint validation only accepts IP loopback and handles an explicit port 80", () => {
  assert.equal(defaultLocalServerUrl("127.0.0.1", "80"), "http://127.0.0.1:80");
  assert.equal(defaultLocalServerUrl("0.0.0.0", "80"), "http://127.0.0.1:80");
  assert.throws(() => defaultLocalServerUrl("127.example.com", "8788"), /Cannot auto-start/);
});

test("start auto-starts one standalone server, keeps it alive, reuses it, and send resumes the thread", { timeout: 60_000 }, async () => {
  const fixture = await createLocalServerAutostartFixture();
  try {
    const first = await fixture.runCli(["start", "first local input", "--name", "Local first", "--no-wait", "--json"]);
    assert.equal(first.code, 0, first.stderr || first.stdout);
    assert.match(first.stderr, /codexhub backend: .*\(started\)/);
    const started = JSON.parse(first.stdout) as { threadId: string; machineId: string };
    assert.match(started.threadId, /^local-thread-/);
    assert.ok(started.machineId);

    const stats = await waitForFixture(fixture.readStats, (value) => value.startCount === 1, "one fake app-server start");
    assert.equal(stats.startCount, 1);
    assert.ok(stats.pids[0] && processAlive(stats.pids[0]), "fake app-server must outlive the CLI");
    const serverPid = await waitForFixture(fixture.serverPid, (value) => typeof value === "number", "detached CodexHub server PID");
    assert.ok(serverPid && processAlive(serverPid), "detached CodexHub server must outlive the CLI");

    const second = await fixture.runCli(["send", started.threadId, "second local input", "--no-wait", "--json"]);
    assert.equal(second.code, 0, second.stderr || second.stdout);
    assert.match(second.stderr, /codexhub backend: .*\(reused\)/);
    const sent = JSON.parse(second.stdout) as { threadId: string };
    assert.equal(sent.threadId, started.threadId);
    assert.equal((await fixture.readStats()).startCount, 1);

    const logInfo = await stat(`${fixture.dataDir}/local-server-${fixture.port}.log`);
    assert.equal(logInfo.mode & 0o777, 0o600);
  } finally {
    await fixture.close();
  }
});

test("concurrent start commands share one detached server and one runtime", { timeout: 60_000 }, async () => {
  const fixture = await createLocalServerAutostartFixture();
  try {
    const results = await Promise.all([
      fixture.runCli(["start", "concurrent one", "--name", "Concurrent one", "--no-wait", "--json"]),
      fixture.runCli(["start", "concurrent two", "--name", "Concurrent two", "--no-wait", "--json"])
    ]);
    for (const result of results) assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.ok(results.some((result) => /\(started\)/.test(result.stderr)));
    assert.ok(results.some((result) => /\(reused\)/.test(result.stderr)));
    assert.equal((await fixture.readStats()).startCount, 1);
    assert.equal((await fixture.serverPid()) !== undefined, true);
  } finally {
    await fixture.close();
  }
});

test("empty input and invalid conversation options do not start the local server", { timeout: 20_000 }, async () => {
  const fixture = await createLocalServerAutostartFixture();
  try {
    const empty = await fixture.runCli(["start", "", "--name", "Empty", "--no-wait"]);
    assert.notEqual(empty.code, 0);
    assert.match(empty.stderr, /input must not be empty/);
    const invalid = await fixture.runCli(["start", "invalid option", "--name", "Invalid", "--model", ""]);
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.stderr, /Invalid conversation turn options/);
    assert.equal((await fixture.readStats()).startCount, 0);
    await assert.rejects(access(fixture.dataDir));
  } finally {
    await fixture.close();
  }
});

test("explicit and environment backend addresses only connect and never auto-start", { timeout: 30_000 }, async () => {
  const fixture = await createLocalServerAutostartFixture();
  try {
    const explicit = await fixture.runCli(["start", "explicit backend", "--name", "Explicit", "--no-wait"], { env: { CODEX_HUB_SERVER_URL: fixture.url } });
    assert.notEqual(explicit.code, 0);
    assert.doesNotMatch(explicit.stderr, /\((?:started|reused)\)/);
    const flag = await fixture.runCli(["--connect", fixture.url, "start", "flag backend", "--name", "Flag", "--no-wait"], { env: {}, built: false });
    assert.notEqual(flag.code, 0);
    assert.equal((await fixture.readStats()).startCount, 0);
  } finally {
    await fixture.close();
  }
});

test("a non-CodexHub service on the default port is reported and left running", { timeout: 20_000 }, async () => {
  const fixture = await createLocalServerAutostartFixture();
  const occupied = await listenOccupied((request, response) => {
    response.writeHead(request.url === "/api/health" ? 200 : 404, { "content-type": "application/json" });
    response.end(request.url === "/api/health" ? JSON.stringify({ ok: true, service: "other" }) : "not codexhub");
  }, fixture.port);
  try {
    const result = await fixture.runCli(["start", "occupied", "--name", "Occupied", "--no-wait"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /non-matching|invalid CodexHub health|profile mismatch/);
    assert.equal(occupied.listening, true);
    assert.equal((await fixture.readStats()).startCount, 0);
  } finally {
    await closeServer(occupied);
    await fixture.close();
  }
});

test("a remote CODEX_HUB_HOST refuses auto-start without contacting a remote server", { timeout: 20_000 }, async () => {
  const fixture = await createLocalServerAutostartFixture();
  try {
    const result = await fixture.runCli(["start", "remote host", "--name", "Remote host", "--no-wait"], {
      env: { CODEX_HUB_HOST: "192.0.2.44", CODEX_HUB_SERVER_URL: "" }
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Cannot auto-start.*CODEX_HUB_HOST/);
    assert.equal((await fixture.readStats()).startCount, 0);
  } finally {
    await fixture.close();
  }
});

test("failed runtime startup is diagnosed with a redacted log tail and cleaned up", { timeout: 30_000 }, async () => {
  const fixture = await createLocalServerAutostartFixture();
  try {
    const result = await fixture.runCli(["start", "runtime failure", "--name", "Failure", "--no-wait"], {
      env: { MOCK_CODEX_FAIL: "1", CODEX_HUB_LOCAL_SERVER_START_TIMEOUT_MS: "1500" }
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /local server log|runtime|timed out/i);
    assert.equal(result.stderr.includes(fixture.authToken), false);
    await waitForFixture(async () => isPortOpen(fixture.port), (value) => value === false, "failed local server cleanup", 10_000);
    assert.equal((await fixture.readStats()).startCount, 0);
  } finally {
    await fixture.close();
  }
});

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const listenOccupied = async (
  handler: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void,
  port: number
) => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
};

const closeServer = async (server: Server) => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
};

const isPortOpen = async (port: number) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(100) });
    await response.arrayBuffer();
    return true;
  } catch {
    return false;
  }
};
