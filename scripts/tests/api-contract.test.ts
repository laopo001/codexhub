import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  machineHeartbeatSchema,
  machineRegistrationSchema,
  sessionHeartbeatSchema,
  sessionRegistrationSchema,
  sshConnectSchema,
  threadGoalUpdateSchema,
  threadRunOptionsSchema
} from "../../src/shared/apiContract.js";
import {
  parseCodexApprovalPolicy,
  parseCodexApprovalsReviewer,
  parseCodexModelCatalogJsonPath,
  resolveCodexAppServerLaunchOptions,
  resolveCodexModelCatalogJsonPath
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
  assert.equal(machineHeartbeatSchema.safeParse({ workerId: "legacy-worker" }).success, false);
});

test("session registration and heartbeat reject currentThreadId", () => {
  const registration = {
    workingDirectory: "/tmp/project",
    currentThreadId: "legacy-thread"
  };

  assert.equal(sessionRegistrationSchema.safeParse(registration).success, false);
  assert.equal(sessionHeartbeatSchema.safeParse({ currentThreadId: "legacy-thread" }).success, false);
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

test("app-server model catalog override requires an absolute path", () => {
  assert.throws(() => parseCodexModelCatalogJsonPath("models.json"), /must be an absolute path/);
  assert.equal(parseCodexModelCatalogJsonPath(" /tmp/models.json "), "/tmp/models.json");
});

test("app-server model catalog defaults to the active Codex home cache", async () => {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhub-model-catalog."));
  const defaultCatalog = path.join(homeDirectory, ".codex", "models_cache.json");
  const customCodexHome = path.join(homeDirectory, "custom-codex-home");
  const customCatalog = path.join(customCodexHome, "models_cache.json");
  const explicitCatalog = path.join(homeDirectory, "explicit-models.json");
  try {
    assert.equal(resolveCodexModelCatalogJsonPath({}, homeDirectory), undefined);
    await mkdir(path.dirname(defaultCatalog), { recursive: true });
    await writeFile(defaultCatalog, "{}");
    assert.equal(resolveCodexModelCatalogJsonPath({}, homeDirectory), defaultCatalog);

    await mkdir(customCodexHome, { recursive: true });
    await writeFile(customCatalog, "{}");
    assert.equal(resolveCodexModelCatalogJsonPath({ CODEX_HOME: customCodexHome }, homeDirectory), customCatalog);
    assert.equal(resolveCodexModelCatalogJsonPath({
      CODEX_HOME: customCodexHome,
      CODEX_HUB_APP_SERVER_MODEL_CATALOG_JSON: explicitCatalog
    }, homeDirectory), explicitCatalog);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
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
