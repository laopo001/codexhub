import assert from "node:assert/strict";
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
import { parseCodexApprovalPolicy } from "../../src/cli/codexAppServerProcess.js";

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
