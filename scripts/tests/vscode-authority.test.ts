import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexHubApiError, createCodexHubApiClient } from "../../src/shared/apiClient.js";
import type { HealthPayload, ProjectsPayload, RuntimesPayload } from "../../src/shared/apiContract.js";
import { apiRoutes } from "../../src/shared/apiRoutes.js";
import { vscodeSurfaceProtocolVersion } from "../../src/shared/surfaceTypes.js";
import { findFreePort, localServerUrl } from "../../src/server/embedded.js";
import { startServer } from "../../src/server/index.js";

test("one VSCode authority accepts multiple window surfaces without starting a runtime", async () => {
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
    surface: "vscode",
    authority: {
      authorityId: "authority-test",
      kind: "linux",
      surfaceProtocolVersion: vscodeSurfaceProtocolVersion
    },
    vscodeSurfaceLeaseTimeoutMs: 60_000,
    vscodeSurfaceIdleShutdownMs: 60_000,
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
    assert.deepEqual(health.authority, {
      authorityId: "authority-test",
      kind: "linux",
      surfaceProtocolVersion: vscodeSurfaceProtocolVersion
    });
    assert.equal(health.authRequired, false);
    assert.equal(health.authenticated, true);
    assert.equal((await fetch(`${serverUrl}/api/projects`)).status, 200);

    const first = await registerSurfaceWithRetry(client, {
      surfaceId: "window-a",
      leaseId: "lease-a",
      protocolVersion: vscodeSurfaceProtocolVersion,
      workspacePaths: [workspaceA],
      activeWorkspacePath: workspaceA,
      label: "VSCode: A"
    });
    const second = await registerSurfaceWithRetry(client, {
      surfaceId: "window-b",
      leaseId: "lease-b",
      protocolVersion: vscodeSurfaceProtocolVersion,
      workspacePaths: [workspaceB],
      activeWorkspacePath: workspaceB,
      label: "VSCode: B"
    });
    assert.equal(first.surface?.machineId, second.surface?.machineId);

    let projects = await client.route(apiRoutes.projects) as ProjectsPayload;
    assert.deepEqual(
      projects.projects.filter((project) => project.transient).map((project) => project.path).sort(),
      [workspaceA, workspaceB].sort()
    );

    await client.route(apiRoutes.heartbeatVscodeSurface, "window-b", {
      leaseId: "lease-b",
      protocolVersion: vscodeSurfaceProtocolVersion
    });
    await client.route(apiRoutes.unregisterVscodeSurface, "window-a", "lease-a");
    projects = await client.route(apiRoutes.projects) as ProjectsPayload;
    assert.deepEqual(
      projects.projects.filter((project) => project.transient).map((project) => project.path),
      [workspaceB]
    );

    const runtimes = await client.request<RuntimesPayload>("/api/runtimes?includeOffline=true");
    assert.deepEqual(runtimes.runtimes, []);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

type Client = ReturnType<typeof createCodexHubApiClient>;

const registerSurfaceWithRetry = async (
  client: Client,
  registration: {
    surfaceId: string;
    leaseId: string;
    protocolVersion: number;
    workspacePaths: string[];
    activeWorkspacePath: string;
    label: string;
  }
) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await client.route(apiRoutes.registerVscodeSurface, registration);
    } catch (error) {
      lastError = error;
      if (!(error instanceof CodexHubApiError) || error.status !== 409) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
};
