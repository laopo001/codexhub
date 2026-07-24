import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openEmbeddedWorkspaceProjects } from "../../src/core/embeddedWorkspaceProjects.js";
import { findFreePort, localServerUrl } from "../../src/server/embedded.js";
import { startServer } from "../../src/server/index.js";
import type { ProjectsPayload, RuntimesPayload } from "../../src/shared/apiContract.js";

test("embedded workspace startup registers projects without starting a Codex runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-embedded-workspace."));
  const dataDir = path.join(root, "data");
  const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const port = await findFreePort("127.0.0.1");
  const server = await startServer({
    host: "127.0.0.1",
    port,
    dataDir,
    surface: "vscode",
    features: {
      localMachine: true,
      ssh: false,
      tasks: false,
      integrations: false
    }
  });
  const serverUrl = localServerUrl(server);
  try {
    await openEmbeddedWorkspaceProjects({
      serverUrl,
      workspacePaths: [workspacePath],
      activeWorkspacePath: workspacePath,
      source: {
        kind: "vscode",
        groupId: "workspace",
        label: "VSCode: workspace"
      },
      attempts: 30,
      retryDelayMs: 25
    });

    const projects = await getJson<ProjectsPayload>(`${serverUrl}/api/projects`);
    assert.ok(projects.projects?.some((project) =>
      project.path === workspacePath
      && project.transient === true
      && project.source?.kind === "vscode"
    ));
    const runtimes = await getJson<RuntimesPayload>(`${serverUrl}/api/runtimes?includeOffline=true`);
    assert.deepEqual(runtimes.runtimes, []);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

const getJson = async <T>(url: string) => {
  const response = await fetch(url);
  const body = await response.text();
  assert.equal(response.ok, true, `${response.status} ${body}`);
  return JSON.parse(body) as T;
};
