import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  authorityBuildId,
  createAuthorityRestartCoordinator,
  parseAuthorityRestartHandoff,
  runAuthorityRestartSupervisor,
  type AuthorityRestartHandoffV1,
  shouldStopOwnedAuthorityProcess
} from "../src/core/embeddedAuthority.js";
import { embeddedSurfaceProtocolVersion } from "../src/shared/surfaceTypes.js";

test("authority restart rejects a surface-only build candidate and coalesces concurrent requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-restart-coordinator."));
  const servicePath = path.join(root, "authority-service.cjs");
  const staticDirectory = path.join(root, "dist");
  await mkdir(staticDirectory);
  await writeFile(servicePath, "service");
  await writeFile(path.join(staticDirectory, "index.html"), "index");
  const input = {
    servicePath,
    staticDirectory,
    dataDir: root,
    authorityId: "authority-restart-test",
    authorityKind: "linux" as const,
    host: "127.0.0.1",
    port: 43123,
    projectCatalog: "fixed" as const,
    buildId: await authorityBuildId([servicePath, path.join(staticDirectory, "index.html")]),
    protocolVersion: embeddedSurfaceProtocolVersion,
    nodeCommand: process.execPath,
    nodeSource: "host-fallback" as const,
    authRequired: true,
    oldPid: process.pid,
    serverInstanceId: "old-instance",
    authorityBuildFiles: [servicePath, path.join(staticDirectory, "index.html")],
    authToken: "secret-that-must-not-be-reported",
    onClose: () => undefined,
    spawnSupervisor: async () => undefined
  };
  try {
    const coordinator = createAuthorityRestartCoordinator(input);
    const [first, second] = await Promise.all([
      coordinator.request("surface-only-build"),
      coordinator.request("surface-only-build")
    ]);
    assert.deepEqual(first, second);
    assert.equal(first.ok, false);
    assert.match(first.error, /Invalid successor build id/);
    assert.doesNotMatch(JSON.stringify(first), /secret-that-must-not-be-reported/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("V1 handoff parses and is consumed even when the spec is invalid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-handoff-v1."));
  const handoffPath = path.join(root, "handoff.json");
  const envelope: AuthorityRestartHandoffV1 = {
    version: 1,
    spec: {} as AuthorityRestartHandoffV1["spec"],
    authToken: "handoff-secret"
  };
  try {
    assert.deepEqual(parseAuthorityRestartHandoff(JSON.stringify(envelope)), envelope);
    await writeFile(handoffPath, JSON.stringify(envelope), { mode: 0o600 });
    await assert.rejects(() => runAuthorityRestartSupervisor(handoffPath), /Invalid authority restart spec/);
    await assert.rejects(() => readFile(handoffPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown or missing handoff versions are rejected and deleted without token leakage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-handoff-version."));
  const token = "version-secret";
  try {
    for (const [name, envelope, expected] of [
      ["unknown.json", { version: 99, spec: {}, authToken: token }, /Unsupported authority restart handoff version: 99/],
      ["missing.json", { spec: {}, authToken: token }, /Unsupported authority restart handoff version: missing/]
    ] as const) {
      const handoffPath = path.join(root, name);
      await writeFile(handoffPath, JSON.stringify(envelope), { mode: 0o600 });
      await assert.rejects(() => runAuthorityRestartSupervisor(handoffPath), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, new RegExp(token));
        return true;
      });
      await assert.rejects(() => readFile(handoffPath));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful restart requests share one supervisor forever", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-restart-success."));
  const servicePath = path.join(root, "authority-service.cjs");
  const staticDirectory = path.join(root, "dist");
  await mkdir(staticDirectory);
  await writeFile(servicePath, "service");
  await writeFile(path.join(staticDirectory, "index.html"), "index");
  let supervisors = 0;
  const input = {
    servicePath, staticDirectory, dataDir: root, authorityId: "authority-restart-test", authorityKind: "linux" as const,
    host: "127.0.0.1", port: 43124, projectCatalog: "fixed" as const,
    buildId: await authorityBuildId([servicePath, path.join(staticDirectory, "index.html")]),
    protocolVersion: embeddedSurfaceProtocolVersion, nodeCommand: process.execPath, nodeSource: "host-fallback" as const,
    authRequired: false, oldPid: process.pid, serverInstanceId: "old-instance", authorityBuildFiles: [servicePath, path.join(staticDirectory, "index.html")],
    authToken: "", onClose: () => undefined, spawnSupervisor: async () => { supervisors += 1; }
  };
  try {
    const coordinator = createAuthorityRestartCoordinator(input);
    const first = coordinator.request();
    const second = coordinator.request();
    assert.deepEqual(await first, { ok: true, restarting: true });
    assert.deepEqual(await second, { ok: true, restarting: true });
    assert.equal(supervisors, 1);
    assert.deepEqual(await coordinator.request(), { ok: true, restarting: true });
    assert.equal(supervisors, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authority stop decisions preserve recovery reason after a transient null probe", () => {
  const handle = { startedByCaller: true, pid: 123, serverInstanceId: "generation-a" };
  // The first probe was null, but the second probe sees this same generation.
  // Recovery must attach rather than kill.
  assert.equal(shouldStopOwnedAuthorityProcess(handle, { serverInstanceId: "generation-a" }, "recovery"), false);
  assert.equal(shouldStopOwnedAuthorityProcess(handle, null, "recovery"), true);
  assert.equal(shouldStopOwnedAuthorityProcess(handle, { serverInstanceId: "generation-b" }, "recovery"), false);
  assert.equal(shouldStopOwnedAuthorityProcess(handle, null, "shutdown"), true);
  assert.equal(shouldStopOwnedAuthorityProcess(handle, { serverInstanceId: "generation-a" }, "shutdown"), true);
  assert.equal(shouldStopOwnedAuthorityProcess(handle, { serverInstanceId: "generation-b" }, "shutdown"), false);
});
