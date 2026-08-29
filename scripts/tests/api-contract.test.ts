import assert from "node:assert/strict";
import test from "node:test";
import {
  embeddedSurfaceRegistrationSchema,
  machineHeartbeatSchema,
  machineRegistrationSchema,
  projectSourceSchema,
  sessionEventSchema,
  sessionHeartbeatSchema,
  sessionRegistrationSchema,
  sshConnectSchema,
  threadGoalUpdateSchema,
  threadRunOptionsSchema
} from "../../src/shared/apiContract.js";
import {
  formatVscodeChannelBadge,
  formatVscodeSurfacePrefix,
  resolveVscodeChannel
} from "../../src/shared/surfaceTypes.js";
import {
  linuxAppServerSupervisorLaunch,
  linuxAppServerSupervisorScript,
  parseCodexApprovalPolicy,
  parseCodexApprovalsReviewer,
  resolveCodexAppServerLaunchOptions
} from "../../src/cli/codexAppServerProcess.js";

test("machine registration and heartbeat reject unknown compatibility fields", () => {
  const registration = {
    hostname: "test-host",
    capabilities: { projectLauncher: true }
  };

  assert.equal(machineRegistrationSchema.safeParse({ ...registration, workerId: "legacy-worker" }).success, false);
  assert.equal(machineRegistrationSchema.safeParse({
    ...registration,
    capabilities: { projectLauncher: true, workerMode: "legacy" }
  }).success, false);
  assert.equal(machineRegistrationSchema.safeParse({
    ...registration,
    type: "ssh",
    sshConnectionId: "1a111111-2222-4333-8444-555555555555"
  }).success, true);
  assert.equal(machineRegistrationSchema.safeParse({
    ...registration,
    type: "ssh",
    sshConnectionId: "not-a-uuid"
  }).success, false);
  assert.equal(machineHeartbeatSchema.safeParse({ workerId: "legacy-worker" }).success, false);
});

test("machine activity summaries accept the compact Goal or user-input hint", () => {
  assert.equal(machineRegistrationSchema.safeParse({
    hostname: "test-host",
    activities: [{
      threadId: "thread-1",
      title: "Old thread title",
      activityTitle: "Goal: finish the smoke tests",
      activeTurnStartedAt: "2026-01-01T00:00:01.000Z",
      latestAgentMessage: "正在执行 smoke tests",
      workingDirectory: "/tmp/project",
      updatedAt: "2026-01-01T00:00:00.000Z",
      status: "running"
    }]
  }).success, true);
});

test("session registration and heartbeat reject currentThreadId", () => {
  const registration = {
    machineId: "machine-test",
    workingDirectory: "/tmp/project",
    currentThreadId: "legacy-thread"
  };

  assert.equal(sessionRegistrationSchema.safeParse({ workingDirectory: "/tmp/project" }).success, false);
  assert.equal(sessionRegistrationSchema.safeParse(registration).success, false);
  assert.equal(sessionHeartbeatSchema.safeParse({ currentThreadId: "legacy-thread" }).success, false);
});

test("thread turns snapshots accept stable pagination identity", () => {
  assert.deepEqual(sessionEventSchema.parse({
    type: "thread_turns_snapshot",
    threadId: "thread-1",
    turns: [],
    head: true,
    complete: false,
    snapshotId: "snapshot-1",
    page: 0
  }), {
    type: "thread_turns_snapshot",
    threadId: "thread-1",
    turns: [],
    head: true,
    complete: false,
    snapshotId: "snapshot-1",
    page: 0
  });
});

test("SSH connect rejects the removed custom remote command", () => {
  assert.equal(sshConnectSchema.safeParse({ host: "example", remoteCommand: "custom command" }).success, false);
  assert.deepEqual(sshConnectSchema.parse({ host: "example", remotePort: 22022 }), {
    host: "example",
    remotePort: 22022
  });
});

test("thread goal updates reject removed snake_case fields", () => {
  assert.equal(threadGoalUpdateSchema.safeParse({ token_budget: 1000 }).success, false);
  assert.equal(threadGoalUpdateSchema.safeParse({ objective: "finish", thread_id: "thread-1" }).success, false);
  assert.equal(threadGoalUpdateSchema.safeParse({
    runPolicy: { type: "consumeUntilWeeklyRemainingAtOrBelow", targetRemainingPercent: 20 }
  }).success, false);
  assert.deepEqual(threadGoalUpdateSchema.parse({ objective: "finish", tokenBudget: 1000 }), {
    objective: "finish",
    tokenBudget: 1000
  });
});

test("approval policy rejects the removed on-failure value", () => {
  assert.equal(threadRunOptionsSchema.safeParse({ approvalPolicy: "on-failure" }).success, false);
  assert.equal(threadRunOptionsSchema.safeParse({ multiAgentMode: "auto" }).success, false);
  assert.throws(() => parseCodexApprovalPolicy("on-failure"), /Invalid approval policy/);
  assert.equal(parseCodexApprovalPolicy("on-request"), "on-request");
});

test("app-server launch reviewer follows the current protocol values", () => {
  assert.equal(parseCodexApprovalsReviewer("auto_review"), "auto_review");
  assert.equal(parseCodexApprovalsReviewer("guardian_subagent"), "guardian_subagent");
  assert.throws(() => parseCodexApprovalsReviewer("future-reviewer"), /Invalid approvals reviewer/);
});

test("app-server launch reviewer defaults to auto review and preserves overrides", () => {
  const previous = process.env.CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER;
  try {
    delete process.env.CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER;
    assert.equal(resolveCodexAppServerLaunchOptions().approvalsReviewer, "auto_review");

    process.env.CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER = "user";
    assert.equal(resolveCodexAppServerLaunchOptions().approvalsReviewer, "user");
    assert.equal(resolveCodexAppServerLaunchOptions({
      approvalsReviewer: "guardian_subagent"
    }).approvalsReviewer, "guardian_subagent");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER;
    else process.env.CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER = previous;
  }
});

test("Linux app-server supervisor forwards parent death to the complete Codex process group", () => {
  const launch = linuxAppServerSupervisorLaunch("/opt/codex/bin/codex", [
    "app-server",
    "--listen",
    "ws://127.0.0.1:12345"
  ]);
  assert.equal(launch.command, "/usr/bin/setpriv");
  assert.deepEqual(launch.args.slice(0, 5), [
    "--pdeathsig",
    "TERM",
    "/bin/bash",
    "-c",
    linuxAppServerSupervisorScript
  ]);
  assert.deepEqual(launch.args.slice(5), [
    "codexhub-app-server-supervisor",
    "/opt/codex/bin/codex",
    "app-server",
    "--listen",
    "ws://127.0.0.1:12345"
  ]);
  assert.match(linuxAppServerSupervisorScript, /setsid "\$@"/);
  assert.match(linuxAppServerSupervisorScript, /kill -TERM -- "-\$child_pid"/);
});

test("thread permissions follow the current granular, reviewer, and named-profile protocol", () => {
  const granular = {
    granular: {
      sandbox_approval: true,
      rules: false,
      skill_approval: true,
      request_permissions: false,
      mcp_elicitations: true
    }
  };
  assert.deepEqual(threadRunOptionsSchema.parse({
    approvalPolicy: granular,
    approvalsReviewer: "auto_review",
    permissions: "team-safe"
  }), {
    approvalPolicy: granular,
    approvalsReviewer: "auto_review",
    permissions: "team-safe"
  });
  assert.equal(threadRunOptionsSchema.safeParse({ approvalsReviewer: "future-reviewer" }).success, false);
  assert.equal(threadRunOptionsSchema.safeParse({
    permissions: ":workspace",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  }).success, false);
});

test("resolveVscodeChannel prioritizes uriScheme and falls back to appName", () => {
  assert.equal(resolveVscodeChannel("vscode-insiders", "Visual Studio Code"), "insiders");
  assert.equal(resolveVscodeChannel("vscode", "Visual Studio Code - Insiders"), "stable");
  assert.equal(resolveVscodeChannel("vscode-insiders"), "insiders");
  assert.equal(resolveVscodeChannel("vscode"), "stable");

  // Controlled fallback for unknown scheme
  assert.equal(resolveVscodeChannel("vscode-oss", "Visual Studio Code - Insiders"), "insiders");
  assert.equal(resolveVscodeChannel("vscode-oss", "Visual Studio Code"), "stable");
  assert.equal(resolveVscodeChannel("vscode-oss", "VSCodium"), null);
  assert.equal(resolveVscodeChannel(undefined, "VS Code Insiders"), "insiders");
  assert.equal(resolveVscodeChannel(undefined, "Code"), "stable");
  assert.equal(resolveVscodeChannel(undefined, undefined), null);

  assert.equal(formatVscodeChannelBadge("insiders"), "Insiders");
  assert.equal(formatVscodeChannelBadge("stable"), "VS Code");
  assert.equal(formatVscodeChannelBadge(undefined), "VS Code");

  assert.equal(formatVscodeSurfacePrefix("insiders"), "VS Code Insiders");
  assert.equal(formatVscodeSurfacePrefix("stable"), "VS Code");
  assert.equal(formatVscodeSurfacePrefix(undefined), "VS Code");
});

test("embedded surface registration and project source schemas strictly validate vscodeChannel", () => {
  const baseVscode = {
    surface: "vscode" as const,
    surfaceId: "surf-1",
    leaseId: "lease-1",
    protocolVersion: 2,
    workspacePaths: ["/tmp/ws"],
    label: "VSCode: ws"
  };

  assert.equal(embeddedSurfaceRegistrationSchema.safeParse({ ...baseVscode, vscodeChannel: "stable" }).success, true);
  assert.equal(embeddedSurfaceRegistrationSchema.safeParse({ ...baseVscode, vscodeChannel: "insiders" }).success, true);
  assert.equal(embeddedSurfaceRegistrationSchema.safeParse({ ...baseVscode, vscodeChannel: "nightly" }).success, false);
  assert.equal(embeddedSurfaceRegistrationSchema.safeParse({ ...baseVscode, unknownField: true }).success, false);

  const baseElectron = {
    surface: "electron" as const,
    surfaceId: "surf-el",
    leaseId: "lease-el",
    protocolVersion: 2,
    workspacePaths: [],
    label: "Electron"
  };
  assert.equal(embeddedSurfaceRegistrationSchema.safeParse(baseElectron).success, true);
  // Electron surface cannot declare vscodeChannel
  assert.equal(embeddedSurfaceRegistrationSchema.safeParse({ ...baseElectron, vscodeChannel: "stable" }).success, false);

  // projectSourceSchema
  assert.equal(projectSourceSchema.safeParse({ kind: "vscode", groupId: "g1", vscodeChannel: "stable" }).success, true);
  assert.equal(projectSourceSchema.safeParse({ kind: "vscode", groupId: "g1", vscodeChannel: "insiders" }).success, true);
  assert.equal(projectSourceSchema.safeParse({ kind: "vscode", groupId: "g1", vscodeChannel: "unknown" }).success, false);
  assert.equal(projectSourceSchema.safeParse({ kind: "electron", groupId: "g1" }).success, true);
  assert.equal(projectSourceSchema.safeParse({ kind: "electron", groupId: "g1", vscodeChannel: "stable" }).success, false);
});

test("machineRegistrationSchema preserves projects[].source.vscodeChannel and strictly validates it", () => {
  const parsed = machineRegistrationSchema.parse({
    hostname: "test-host",
    projects: [{
      path: "/home/laop/projects/codexhub",
      source: {
        kind: "vscode",
        groupId: "surface-1",
        label: "VSCode: codexhub [WSL: Ubuntu]",
        vscodeChannel: "insiders"
      }
    }]
  });
  assert.equal(parsed.projects?.[0]?.source?.vscodeChannel, "insiders");

  // Invalid vscodeChannel rejected
  assert.equal(machineRegistrationSchema.safeParse({
    hostname: "test-host",
    projects: [{
      path: "/home/laop/projects/codexhub",
      source: {
        kind: "vscode",
        groupId: "surface-1",
        vscodeChannel: "nightly"
      }
    }]
  }).success, false);

  // Electron source cannot declare vscodeChannel
  assert.equal(machineRegistrationSchema.safeParse({
    hostname: "test-host",
    projects: [{
      path: "/home/laop/projects/codexhub",
      source: {
        kind: "electron",
        groupId: "surface-electron",
        vscodeChannel: "insiders"
      }
    }]
  }).success, false);
});
