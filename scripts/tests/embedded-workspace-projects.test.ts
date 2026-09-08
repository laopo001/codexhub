import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openEmbeddedWorkspaceProjects } from "../../src/core/embeddedWorkspaceProjects.js";
import {
  groupProjectsByMachine,
  normalizeEmbeddedWorkspaceLabel,
  projectMachineBadgeToneClass
} from "../../src/web/helpers/core.js";
import { findFreePort, localServerUrl } from "../../src/server/embedded.js";
import { startServer } from "../../src/server/index.js";
import type { ProjectsPayload, RuntimesPayload } from "../../src/shared/apiContract.js";
import type { ProjectSummary } from "../../src/shared/projectTypes.js";
import type { MachineSummary } from "../../src/shared/machineTypes.js";

test("embedded workspace startup registers projects after the machine runtime connects", async () => {
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
        label: "VSCode: workspace",
        workspaceFile: path.join(workspacePath, "multi.code-workspace")
      },
      attempts: 30,
      retryDelayMs: 25
    });

    const projects = await getJson<ProjectsPayload>(`${serverUrl}/api/projects`);
    assert.ok(projects.projects?.some((project) =>
      project.path === workspacePath
      && project.transient === true
      && project.source?.kind === "vscode"
      && project.source?.workspaceFile === path.join(workspacePath, "multi.code-workspace")
    ));
    const runtimes = await waitForRuntime(serverUrl);
    assert.ok(runtimes.runtimes?.some((runtime) => runtime.online && runtime.cliVersion));
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

const waitForRuntime = async (serverUrl: string) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const runtimes = await getJson<RuntimesPayload>(`${serverUrl}/api/runtimes?includeOffline=true`);
    if (runtimes.runtimes?.some((runtime) => runtime.online)) return runtimes;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Codex runtime did not connect during embedded workspace startup");
};

test("normalizeEmbeddedWorkspaceLabel normalizes stale and legacy labels based on vscodeChannel", () => {
  // Legacy VSCode: prefix on Insiders
  assert.equal(
    normalizeEmbeddedWorkspaceLabel("VSCode: codexhub", { kind: "vscode", groupId: "g1", vscodeChannel: "insiders" }),
    "VS Code Insiders: codexhub"
  );
  // Stale VS Code Insiders on stable
  assert.equal(
    normalizeEmbeddedWorkspaceLabel("VS Code Insiders: codexhub", { kind: "vscode", groupId: "g1", vscodeChannel: "stable" }),
    "VS Code: codexhub"
  );
  // Default workspace label
  assert.equal(
    normalizeEmbeddedWorkspaceLabel("VSCode Workspace", { kind: "vscode", groupId: "g1", vscodeChannel: "insiders" }),
    "VS Code Insiders Workspace"
  );
  assert.equal(
    normalizeEmbeddedWorkspaceLabel("VSCode Workspace", { kind: "vscode", groupId: "g1", vscodeChannel: "stable" }),
    "VS Code Workspace"
  );
  // Non-vscode sources are left untouched
  assert.equal(
    normalizeEmbeddedWorkspaceLabel("Electron Workspace", { kind: "electron", groupId: "g2" }),
    "Electron Workspace"
  );
});

test("groupProjectsByMachine groups embedded workspaces with normalized labels and compact badges", () => {
  const machines: MachineSummary[] = [
    {
      machineId: "m1",
      name: "jx",
      hostname: "jx",
      type: "registered",
      online: true,
      status: "online",
      capabilities: { projectLauncher: true },
      lastSeenAt: "2026-01-01T00:00:00.000Z"
    }
  ];

  const projects: ProjectSummary[] = [
    {
      projectId: "p-insiders",
      machineId: "m1",
      path: "/home/laop/projects/codexhub",
      name: "codexhub",
      machineOnline: true,
      running: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
      source: {
        kind: "vscode",
        groupId: "window-insiders",
        label: "VSCode: codexhub [WSL: Ubuntu]",
        vscodeChannel: "insiders"
      }
    },
    {
      projectId: "p-stable",
      machineId: "m1",
      path: "/home/laop/projects/webapp",
      name: "webapp",
      machineOnline: true,
      running: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
      source: {
        kind: "vscode",
        groupId: "window-stable",
        label: "VSCode: webapp",
        vscodeChannel: "stable"
      }
    }
  ];

  const groups = groupProjectsByMachine(projects, machines);
  assert.equal(groups.length, 2);

  const insidersGroup = groups.find((g) => g.key === "vscode:window-insiders");
  assert.ok(insidersGroup);
  assert.equal(insidersGroup.badgeLabel, "vsc-i");
  assert.equal(projectMachineBadgeToneClass(insidersGroup), "vscode-insiders");
  assert.equal(insidersGroup.label, "VS Code Insiders: codexhub [WSL: Ubuntu]");

  const stableGroup = groups.find((g) => g.key === "vscode:window-stable");
  assert.ok(stableGroup);
  assert.equal(stableGroup.badgeLabel, "vsc");
  assert.equal(projectMachineBadgeToneClass(stableGroup), "vscode-stable");
  assert.equal(stableGroup.label, "VS Code: webapp");
});
