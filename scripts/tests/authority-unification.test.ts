import assert from "node:assert/strict";
import { access, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createLocalServerAutostartFixture,
  waitForFixture
} from "../test-support/localServerAutostartFixture.js";
import { findFreePort } from "../../src/server/embedded.js";
import { authorityBuildId, ensureEmbeddedAuthority } from "../../src/core/embeddedAuthority.js";

test("CLI-first and host-first share one authority identity, runtime, and surface projection", { timeout: 90_000 }, async () => {
  await assertCliFirstReuse();
  await assertHostFirstReuse();
});

test("a server management client remains usable when localMachine is disabled", { timeout: 45_000 }, async () => {
  const fixture = await createLocalServerAutostartFixture();
  let server: Awaited<ReturnType<typeof fixture.startCli>> | undefined;
  try {
    server = await fixture.startCli([
      "server",
      "--host", "127.0.0.1",
      "--port", String(fixture.port)
    ], { env: { CODEX_HUB_LOCAL_MACHINE: "0" } });
    const health = await waitForAuthority(fixture.url, fixture.authToken, (value) => value.features?.localMachine === false);
    assert.equal(health.features?.localMachine, false);
    assert.equal(server.child.exitCode, null, server.output());
    await server.stop();
    await waitForAuthority(fixture.url, fixture.authToken, (value) => value.serverInstanceId === health.serverInstanceId);
  } finally {
    await server?.stop();
    await fixture.close();
  }
});

test("authority startup recovers a stale corrupt lock and rejects profile/auth/connect mismatches", { timeout: 90_000 }, async () => {
  const fixture = await createLocalServerAutostartFixture();
  try {
    await mkdir(fixture.dataDir, { recursive: true });
    const lockPath = path.join(fixture.dataDir, `authority-${fixture.port}.lock`);
    await writeFile(lockPath, "");
    const stale = Date.now() - 60_000;
    await utimes(lockPath, stale / 1000, stale / 1000);

    const started = await Promise.all([
      fixture.startPersistent(["stale lock one", "--name", "Stale lock one"]),
      fixture.startPersistent(["stale lock two", "--name", "Stale lock two"])
    ]);
    assert.equal((await fixture.readStats()).startCount, 1);
    for (const start of started) {
      const ended = await fixture.runCli(["end", start.threadId, "--timeout", "5", "--json"]);
      assert.equal(ended.code, 0, ended.stderr || ended.stdout);
      await waitForFixture(async () => start.running.child.exitCode, (code) => code === 0, "stale-lock start natural exit");
    }

    const alternateAssets = path.join(fixture.root, "alternate-assets");
    await mkdir(alternateAssets, { recursive: true });
    await writeFile(path.join(alternateAssets, "index.html"), "<html>alternate</html>");
    const staticMismatch = await fixture.runCli(["server", "--serve-static", alternateAssets]);
    assert.notEqual(staticMismatch.code, 0);
    assert.match(staticMismatch.stderr, /static directory/i);

    const launchMismatch = await fixture.runCli(["server", "--approvals-reviewer", "user"]);
    assert.notEqual(launchMismatch.code, 0);
    assert.match(launchMismatch.stderr, /app-server.*approvalsReviewer/i);
    await assert.rejects(access(lockPath));

    const wrongAuth = await fixture.runCli(["send", "missing-thread", "wrong auth"], {
      env: { CODEX_HUB_AUTH_TOKEN: "wrong-authority-token" }
    });
    assert.notEqual(wrongAuth.code, 0);
    assert.match(wrongAuth.stderr, /auth|401|unauthorized/i);

    const wrongDataDir = path.join(fixture.root, "different-data");
    const wrongProfile = await fixture.runCli(["send", "missing-thread", "wrong profile"], {
      env: { CODEX_HUB_DATA_DIR: wrongDataDir }
    });
    assert.notEqual(wrongProfile.code, 0);
    assert.match(wrongProfile.stderr, /authority|profile|mismatch/i);
    assert.equal((await fixture.readStats()).startCount, 1);

    const unreachablePort = await findFreePort("127.0.0.1");
    const unreachable = await fixture.runCli(
      ["--connect", `http://127.0.0.1:${unreachablePort}`, "start", "remote", "--name", "Remote"],
      { env: { CODEX_HUB_DATA_DIR: path.join(fixture.root, "connect-data") } }
    );
    assert.notEqual(unreachable.code, 0);
    assert.doesNotMatch(unreachable.stderr, /started|authority startup/i);
    assert.equal((await fixture.readStats()).startCount, 1);
  } finally {
    await fixture.close();
  }
});

test("source and built CLI use the shared authority entry when the built artifact is available", { timeout: 90_000 }, async (t) => {
  const builtEntry = path.resolve("dist-node/authority-service.cjs");
  const builtCli = path.resolve("dist-node/src/cli/codexhub.js");
  try {
    await access(builtEntry);
    await access(builtCli);
    const [builtServiceSource, builtCliSource] = await Promise.all([
      readFile(builtEntry, "utf8"),
      readFile(builtCli, "utf8")
    ]);
    if (!builtServiceSource.includes("runAuthorityService") || !builtCliSource.includes("ensureLocalAuthority")) {
      t.skip("built authority/CLI artifacts predate the authority unification; rerun after pnpm build");
      return;
    }
  } catch {
    t.skip("built authority entry is produced by pnpm build; this check is exercised after the build stage");
    return;
  }
  const fixture = await createLocalServerAutostartFixture();
  try {
    const started = await fixture.startPersistent(["built local input", "--name", "Built local"], { built: true });
    const health = await waitForAuthority(fixture.url, fixture.authToken);
    assert.ok(health.authority?.authorityId);
    assert.ok(health.serverInstanceId);
    assert.equal((await fixture.readStats()).startCount, 1);
    const ended = await fixture.runCli(["end", started.threadId, "--timeout", "5", "--json"], { built: true });
    assert.equal(ended.code, 0, ended.stderr || ended.stdout);
    await waitForFixture(async () => started.running.child.exitCode, (code) => code === 0, "built start natural exit");
  } finally {
    await fixture.close();
  }
});

const assertCliFirstReuse = async () => {
  const fixture = await createLocalServerAutostartFixture();
  let host: Awaited<ReturnType<typeof fixture.startCli>> | undefined;
  try {
    const firstStart = await fixture.startPersistent(["cli first", "--name", "CLI first"]);
    const result = await fetchJson<{ runtime?: { machineId?: string } }>(fixture.url, fixture.authToken, `/api/threads/${encodeURIComponent(firstStart.threadId)}`);
    const firstHealth = await waitForAuthority(fixture.url, fixture.authToken);
    assert.ok(firstHealth.authority?.authorityId);
    assert.ok(firstHealth.serverInstanceId);

    await registerSurface(fixture.url, fixture.authToken, fixture.root, firstHealth.build ?? undefined);
    const [machines, runtimes] = await Promise.all([
      fetchJson<{ machines?: Array<{ machineId: string; type: string; online: boolean }> }>(fixture.url, fixture.authToken, "/api/machines"),
      fetchJson<{ runtimes?: Array<{ machineId: string; online: boolean }> }>(fixture.url, fixture.authToken, "/api/runtimes")
    ]);
    const onlineMachines = (machines.machines ?? []).filter((machine) => machine.type === "local" && machine.online);
    const onlineRuntimes = (runtimes.runtimes ?? []).filter((runtime) => runtime.online);
    assert.equal(onlineMachines.length, 1);
    assert.equal(onlineRuntimes.length, 1);
    assert.equal(result.runtime?.machineId, onlineMachines[0]?.machineId);
    assert.equal(onlineMachines[0]?.machineId, onlineRuntimes[0]?.machineId);
    const ended = await fixture.runCli(["end", firstStart.threadId, "--timeout", "5", "--json"]);
    assert.equal(ended.code, 0, ended.stderr || ended.stdout);
    await waitForFixture(async () => firstStart.running.child.exitCode, (code) => code === 0, "CLI-first start natural exit");

    host = await fixture.startCli(["server", "--host", "127.0.0.1", "--port", String(fixture.port)]);
    await waitForOutput(host, /codexhub server managing shared authority/);
    const reusedHealth = await waitForAuthority(fixture.url, fixture.authToken);
    assert.equal(reusedHealth.authority?.authorityId, firstHealth.authority?.authorityId);
    assert.equal(reusedHealth.serverInstanceId, firstHealth.serverInstanceId);
    assert.equal((await fixture.authorityPids()).length > 0, true);
    await host.stop();
    await waitForAuthority(fixture.url, fixture.authToken, (health) => health.serverInstanceId === firstHealth.serverInstanceId);
  } finally {
    await host?.stop();
    await fixture.close();
  }
};

const assertHostFirstReuse = async () => {
  const fixture = await createLocalServerAutostartFixture();
  const servicePath = path.resolve("dist-node/authority-service.cjs");
  const staticDirectory = path.resolve("dist");
  try {
    try {
      await access(servicePath);
      await stat(staticDirectory);
    } catch {
      return;
    }
    const buildId = await authorityBuildId([servicePath, path.join(staticDirectory, "index.html")]);
    const authority = await ensureEmbeddedAuthority({
      dataDir: fixture.dataDir,
      authorityServicePath: servicePath,
      staticDirectory,
      buildId,
      authToken: fixture.authToken,
      projectCatalog: "editable",
      environment: fixture.environment(),
      startupTimeoutMs: 20_000
    });
    const firstHealth = await waitForAuthority(fixture.url, fixture.authToken);
    assert.equal(authority.serverInstanceId, firstHealth.serverInstanceId);
    const firstAuthorityPid = (await fixture.authorityPids())[0];
    assert.ok(firstAuthorityPid);

    const cli = await fixture.startPersistent(["host first", "--name", "Host first"]);
    const secondHealth = await waitForAuthority(fixture.url, fixture.authToken);
    assert.equal(secondHealth.authority?.authorityId, firstHealth.authority?.authorityId);
    assert.equal(secondHealth.serverInstanceId, firstHealth.serverInstanceId);
    assert.equal((await fixture.authorityPids()).filter((pid) => pid === firstAuthorityPid).length, 1);
    assert.equal((await fixture.readStats()).startCount, 1);
    const ended = await fixture.runCli(["end", cli.threadId, "--timeout", "5", "--json"]);
    assert.equal(ended.code, 0, ended.stderr || ended.stdout);
    await waitForFixture(async () => cli.running.child.exitCode, (code) => code === 0, "host-first start natural exit");
  } finally {
    await fixture.close();
  }
};

const waitForOutput = async (running: { output: () => string }, pattern: RegExp, timeoutMs = 20_000) => {
  await waitForFixture(
    async () => running.output(),
    (output) => pattern.test(output),
    `CLI output ${pattern}`,
    timeoutMs
  );
};

const waitForAuthority = async (
  url: string,
  authToken: string,
  predicate: (health: AuthorityHealth) => boolean = () => true
) => await waitForFixture(
  async () => {
    try {
      return await fetchJson<AuthorityHealth>(url, authToken, "/api/health");
    } catch {
      return {};
    }
  },
  (health) => Boolean(health.serverInstanceId) && predicate(health),
  "shared authority health",
  20_000
);

const registerSurface = async (url: string, authToken: string, workspacePath: string, buildId?: string) => {
  const response = await fetch(new URL("/api/embedded/surfaces", url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${authToken}`
    },
    body: JSON.stringify({
      surface: "vscode",
      surfaceId: "integration-vscode-surface",
      leaseId: "integration-vscode-lease",
      protocolVersion: 2,
      workspacePaths: [workspacePath],
      activeWorkspacePath: workspacePath,
      label: "Authority integration",
      ...(buildId ? { buildId } : {})
    })
  });
  assert.equal(response.status, 200, await response.text());
};

const fetchJson = async <T>(url: string, authToken: string, pathname: string) => {
  const response = await fetch(new URL(pathname, url), {
    headers: { authorization: `Bearer ${authToken}` }
  });
  const body = await response.text();
  assert.equal(response.ok, true, `${pathname}: HTTP ${response.status} ${body}`);
  return JSON.parse(body) as T;
};

type AuthorityHealth = {
  serverInstanceId?: string;
  build?: string | null;
  features?: { localMachine?: boolean };
  authority?: { authorityId?: string };
};
