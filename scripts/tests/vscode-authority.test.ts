import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexHubApiError, createCodexHubApiClient } from "../../src/shared/apiClient.js";
import type { HealthPayload, ProjectsPayload, RuntimesPayload } from "../../src/shared/apiContract.js";
import { apiRoutes } from "../../src/shared/apiRoutes.js";
import { embeddedSurfaceProtocolVersion } from "../../src/shared/surfaceTypes.js";
import { codexhubVersion } from "../../src/shared/version.js";
import { findFreePort, localServerUrl } from "../../src/server/embedded.js";
import { startServer } from "../../src/server/index.js";

test("one embedded authority accepts VSCode and Electron surfaces after runtime startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-vscode-authority."));
  const dataDir = path.join(root, "data");
  const workspaceA = path.join(root, "workspace-a");
  const workspaceB = path.join(root, "workspace-b");
  await Promise.all([mkdir(workspaceA, { recursive: true }), mkdir(workspaceB, { recursive: true })]);
  const server = await startServer({
    host: "127.0.0.1",
    port: await findFreePort("127.0.0.1"),
    dataDir,
    authToken: "",
    surface: "default",
    authority: {
      authorityId: "authority-test",
      kind: "linux",
      surfaceProtocolVersion: embeddedSurfaceProtocolVersion
    },
    embeddedSurfaceLeaseTimeoutMs: 60_000,
    webClientTimeoutMs: 60_000,
    features: {
      localMachine: true,
      ssh: false,
      tasks: false,
      integrations: false
    }
  });
  const serverUrl = localServerUrl(server);
  const client = createCodexHubApiClient({ baseUrl: serverUrl });
  try {
    const health = await client.route(apiRoutes.health) as HealthPayload;
    assert.equal(health.version, codexhubVersion);
    assert.deepEqual(health.authority, {
      authorityId: "authority-test",
      kind: "linux",
      surfaceProtocolVersion: embeddedSurfaceProtocolVersion
    });
    assert.equal(health.authRequired, false);
    assert.equal(health.authenticated, true);
    assert.equal(health.authorityRuntime?.nodePath, process.execPath);
    assert.equal(health.authorityRuntime?.nodeVersion, process.version);
    assert.equal((await fetch(`${serverUrl}/api/projects`)).status, 200);

    const first = await registerSurfaceWithRetry(client, {
      surface: "vscode",
      surfaceId: "window-a",
      leaseId: "lease-a",
      protocolVersion: embeddedSurfaceProtocolVersion,
      workspacePaths: [workspaceA],
      activeWorkspacePath: workspaceA,
      label: "VSCode: A"
    });
    const second = await registerSurfaceWithRetry(client, {
      surface: "vscode",
      surfaceId: "window-b",
      leaseId: "lease-b",
      protocolVersion: embeddedSurfaceProtocolVersion,
      workspacePaths: [workspaceB],
      activeWorkspacePath: workspaceB,
      label: "VSCode: B"
    });
    assert.equal(first.surface?.machineId, second.surface?.machineId);

    const electron = await registerSurfaceWithRetry(client, {
      surface: "electron",
      surfaceId: "electron-window",
      leaseId: "electron-lease",
      protocolVersion: embeddedSurfaceProtocolVersion,
      workspacePaths: [],
      label: "Codex Hub Electron"
    });
    assert.equal(electron.surface?.machineId, first.surface?.machineId);

    let projects = await client.route(apiRoutes.projects) as ProjectsPayload;
    assert.deepEqual(
      projects.projects.filter((project) => project.transient).map((project) => project.path).sort(),
      [workspaceA, workspaceB].sort()
    );

    const heartbeat = await client.route(apiRoutes.heartbeatWebClient, {
      clientId: "web-window-b",
      embeddedSurface: {
        surfaceId: "window-b",
        leaseId: "lease-b",
        protocolVersion: embeddedSurfaceProtocolVersion
      }
    });
    assert.equal(heartbeat.embeddedSurfaceLeaseActive, true);
    await client.route(apiRoutes.unregisterEmbeddedSurface, "window-a", "lease-a");
    await client.route(apiRoutes.unregisterEmbeddedSurface, "electron-window", "electron-lease");
    projects = await client.route(apiRoutes.projects) as ProjectsPayload;
    assert.deepEqual(
      projects.projects.filter((project) => project.transient).map((project) => project.path),
      [workspaceB]
    );

    const runtimes = await waitForRuntime(client);
    assert.ok(runtimes.runtimes?.some((runtime) => runtime.online && runtime.cliVersion));
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded authority without a launch spec rejects restart without closing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-vscode-authority-restart."));
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    server = await startServer({
      host: "127.0.0.1",
      port: await findFreePort("127.0.0.1"),
      dataDir: path.join(root, "data"),
      authToken: "",
      surface: "default",
      authority: {
        authorityId: "authority-restart-test",
        kind: "linux",
        surfaceProtocolVersion: embeddedSurfaceProtocolVersion
      },
      features: {
        localMachine: false,
        ssh: false,
        tasks: false,
        integrations: false
      }
    });
    const client = createCodexHubApiClient({ baseUrl: localServerUrl(server) });
    await assert.rejects(
      () => client.route(apiRoutes.restartAuthority),
      (error: unknown) => error instanceof Error && "status" in error && error.status === 409
    );
    assert.equal((await client.route(apiRoutes.health) as HealthPayload).serverInstanceId, server.serverInstanceId);
  } finally {
    await server?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Web heartbeat revives an expired surface without changing authority generation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-vscode-authority-expired-lease."));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const server = await startServer({
    host: "127.0.0.1",
    port: await findFreePort("127.0.0.1"),
    dataDir: path.join(root, "data"),
    authToken: "",
    surface: "default",
    authority: {
      authorityId: "authority-expired-lease-test",
      kind: "linux",
      surfaceProtocolVersion: embeddedSurfaceProtocolVersion
    },
    embeddedSurfaceLeaseTimeoutMs: 10,
    webClientTimeoutMs: 1_500,
    webClientRetryMs: 50,
    features: {
      localMachine: true,
      ssh: false,
      tasks: false,
      integrations: false
    }
  });
  const client = createCodexHubApiClient({ baseUrl: localServerUrl(server) });
  try {
    await registerSurfaceWithRetry(client, {
      surface: "vscode",
      surfaceId: "window-expiring",
      leaseId: "lease-expiring",
      protocolVersion: embeddedSurfaceProtocolVersion,
      workspacePaths: [workspace],
      activeWorkspacePath: workspace,
      label: "VSCode: Expiring"
    });
    assert.equal((await client.route(apiRoutes.heartbeatWebClient, {
      clientId: "web-expiring",
      embeddedSurface: {
        surfaceId: "window-expiring",
        leaseId: "lease-expiring",
        protocolVersion: embeddedSurfaceProtocolVersion
      }
    })).embeddedSurfaceLeaseActive, true);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const recoveredHealth = await client.route(apiRoutes.health) as HealthPayload;
    assert.equal(recoveredHealth.serverInstanceId, server.serverInstanceId);
    assert.equal((await client.route(apiRoutes.heartbeatWebClient, {
      clientId: "web-expiring",
      embeddedSurface: {
        surfaceId: "window-expiring",
        leaseId: "lease-expiring",
        protocolVersion: embeddedSurfaceProtocolVersion
      }
    })).embeddedSurfaceLeaseActive, false);

    const recoveredSurface = await registerSurfaceWithRetry(client, {
      surface: "vscode",
      surfaceId: "window-expiring",
      leaseId: "lease-recovered",
      protocolVersion: embeddedSurfaceProtocolVersion,
      workspacePaths: [workspace],
      activeWorkspacePath: workspace,
      label: "VSCode: Recovered"
    });
    assert.equal(recoveredSurface.surface?.leaseId, "lease-recovered");
    assert.equal((await client.route(apiRoutes.heartbeatWebClient, {
      clientId: "web-expiring",
      embeddedSurface: {
        surfaceId: "window-expiring",
        leaseId: "lease-recovered",
        protocolVersion: embeddedSurfaceProtocolVersion
      }
    })).embeddedSurfaceLeaseActive, true);
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal((await client.route(apiRoutes.health) as HealthPayload).serverInstanceId, server.serverInstanceId);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded authority reports a replacement build without closing automatically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-vscode-authority-update."));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const server = await startServer({
    host: "127.0.0.1",
    port: await findFreePort("127.0.0.1"),
    dataDir: path.join(root, "data"),
    authToken: "",
    surface: "default",
    buildId: "build-old",
    authority: {
      authorityId: "authority-update-test",
      kind: "linux",
      surfaceProtocolVersion: embeddedSurfaceProtocolVersion
    },
    embeddedSurfaceLeaseTimeoutMs: 60_000,
    webClientTimeoutMs: 60_000,
    features: {
      localMachine: true,
      ssh: false,
      tasks: false,
      integrations: false
    }
  });
  const client = createCodexHubApiClient({ baseUrl: localServerUrl(server) });
  try {
    assert.equal((await client.route(apiRoutes.health) as HealthPayload).authorityUpdate, undefined);
    await registerSurfaceWithRetry(client, {
      surface: "vscode",
      surfaceId: "window-new-build",
      leaseId: "lease-new-build",
      protocolVersion: embeddedSurfaceProtocolVersion,
      workspacePaths: [workspace],
      activeWorkspacePath: workspace,
      label: "VSCode: New build",
      buildId: "build-new"
    });
    const updateHealth = await client.route(apiRoutes.health) as HealthPayload;
    assert.equal(updateHealth.authorityUpdate?.buildId, "build-new");
    assert.ok(Date.parse(updateHealth.authorityUpdate?.detectedAt ?? "") > 0);

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await client.route(apiRoutes.health) as HealthPayload).serverInstanceId, server.serverInstanceId);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

type Client = ReturnType<typeof createCodexHubApiClient>;

const waitForRuntime = async (client: Client) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const runtimes = await client.request<RuntimesPayload>("/api/runtimes?includeOffline=true");
    if (runtimes.runtimes?.some((runtime) => runtime.online)) return runtimes;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Codex runtime did not connect during embedded authority startup");
};

const registerSurfaceWithRetry = async (
  client: Client,
  registration: {
    surface: "vscode" | "electron";
    surfaceId: string;
    leaseId: string;
    protocolVersion: number;
    workspacePaths: string[];
    activeWorkspacePath?: string;
    label: string;
    buildId?: string;
  }
) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await client.route(apiRoutes.registerEmbeddedSurface, registration);
    } catch (error) {
      lastError = error;
      if (!(error instanceof CodexHubApiError) || error.status !== 409) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
};
