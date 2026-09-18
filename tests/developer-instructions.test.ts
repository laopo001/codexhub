import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { CodexhubServerState } from "../src/core/serverState.js";
import {
  developerInstructionCreateSchema,
  developerInstructionUpdateSchema,
  machineThreadInputSchema,
  threadRunOptionsSchema
} from "../src/shared/apiContract.js";
import { dispatchAppServerCommand, type AppServerCommandHost } from "../src/cli/appServerCommandDispatcher.js";
import { registerDeveloperInstructionRoutes } from "../src/server/developerInstructionRoutes.js";
import { registerThreadRoutes } from "../src/server/threadRoutes.js";
import type { SessionCommand } from "../src/shared/threadTypes.js";

test("serverState: Developer Instructions migration, backward compatibility, and CRUD", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexhub-dev-inst-test-"));
  const statePath = join(dir, "config.yaml");

  try {
    // 1. Backward compatibility: existing config without developerInstructions
    writeFileSync(statePath, "version: 1\nmachines: []\nprojects: []\n", "utf8");
    const state = await CodexhubServerState.load({ filePath: statePath });
    assert.deepEqual(state.listDeveloperInstructions(), []);

    // 2. Create instruction template
    const created1 = state.createDeveloperInstruction({
      name: "Code Reviewer",
      description: "Reviews PRs and changes",
      instructions: "You are an expert reviewer."
    });
    assert.ok(created1.id);
    assert.equal(created1.name, "Code Reviewer");
    assert.equal(created1.description, "Reviews PRs and changes");
    assert.equal(created1.instructions, "You are an expert reviewer.");
    assert.ok(created1.createdAt);
    assert.ok(created1.updatedAt);

    // 3. Create another template
    const created2 = state.createDeveloperInstruction({
      name: "Python Expert",
      instructions: "Follow PEP 8 and use modern type hints."
    });
    assert.ok(created2.id);
    assert.equal(created2.description, undefined);

    // 4. List templates
    const list = state.listDeveloperInstructions();
    assert.equal(list.length, 2);
    assert.equal(state.getDeveloperInstruction(created1.id)?.name, "Code Reviewer");
    assert.equal(state.getDeveloperInstruction(created2.id)?.name, "Python Expert");

    // 5. Update template
    const updated1 = state.updateDeveloperInstruction(created1.id, {
      name: "Senior Code Reviewer",
      description: "In-depth code reviews",
      instructions: "Review code thoroughly."
    });
    assert.ok(updated1);
    assert.equal(updated1.id, created1.id);
    assert.equal(updated1.name, "Senior Code Reviewer");
    assert.equal(updated1.description, "In-depth code reviews");
    assert.equal(updated1.instructions, "Review code thoroughly.");
    assert.equal(updated1.createdAt, created1.createdAt);

    // 6. Delete template
    assert.equal(state.deleteDeveloperInstruction("non-existent-id"), false);
    assert.equal(state.deleteDeveloperInstruction(created2.id), true);
    assert.equal(state.getDeveloperInstruction(created2.id), null);
    assert.equal(state.listDeveloperInstructions().length, 1);

    // 7. Reload from file to verify persistence
    await state.flush();
    const reloadedState = await CodexhubServerState.load({ filePath: statePath });
    const reloadedList = reloadedState.listDeveloperInstructions();
    assert.equal(reloadedList.length, 1);
    assert.equal(reloadedList[0].id, created1.id);
    assert.equal(reloadedList[0].name, "Senior Code Reviewer");

    // 8. The create call takes a transient snapshot without adding thread data to config.
    const templateSnapshot = state.getDeveloperInstruction(created1.id)?.instructions;
    assert.equal(templateSnapshot, "Review code thoroughly.");

    state.updateDeveloperInstruction(created1.id, {
      name: "Senior Code Reviewer",
      instructions: "New instruction v2"
    });
    assert.equal(templateSnapshot, "Review code thoroughly.");
    assert.equal(state.getDeveloperInstruction(created1.id)?.instructions, "New instruction v2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API schemas: developer instruction validation and strict rules", () => {
  // Create schema
  assert.equal(
    developerInstructionCreateSchema.safeParse({
      name: "Reviewer",
      instructions: "Review all diffs"
    }).success,
    true
  );

  assert.equal(developerInstructionCreateSchema.safeParse({
    id: "client-controlled-id",
    name: "Reviewer",
    instructions: "Review all diffs"
  }).success, false);

  // Reject missing instructions or name
  assert.equal(
    developerInstructionCreateSchema.safeParse({
      name: "Reviewer"
    }).success,
    false
  );

  // Reject empty string
  assert.equal(
    developerInstructionCreateSchema.safeParse({
      name: "  ",
      instructions: "Review all diffs"
    }).success,
    false
  );

  // Reject unknown fields
  assert.equal(
    developerInstructionCreateSchema.safeParse({
      name: "Reviewer",
      instructions: "Review all diffs",
      unknownField: "malicious"
    }).success,
    false
  );

  // Update schema
  assert.equal(
    developerInstructionUpdateSchema.safeParse({
      name: "Updated Name"
    }).success,
    true
  );

  assert.equal(
    developerInstructionUpdateSchema.safeParse({
      description: null
    }).success,
    true
  );

  // Reject empty update object
  assert.equal(developerInstructionUpdateSchema.safeParse({}).success, false);

  // Reject unknown fields
  assert.equal(
    developerInstructionUpdateSchema.safeParse({
      name: "Updated",
      extra: true
    }).success,
    false
  );
});

test("API schemas: machineThreadInputSchema strict action discrimination", () => {
  // action: "new" allows developerInstructionsId
  assert.equal(
    machineThreadInputSchema.safeParse({
      action: "new",
      developerInstructionsId: "inst-123"
    }).success,
    true
  );

  // action: "new" allows omission of developerInstructionsId
  assert.equal(
    machineThreadInputSchema.safeParse({
      action: "new",
      cwd: "/home/user/project"
    }).success,
    true
  );

  // action: "new" rejects unknown fields
  assert.equal(
    machineThreadInputSchema.safeParse({
      action: "new",
      extra: "not-allowed"
    }).success,
    false
  );

  // action: "resume" rejects developerInstructionsId (strict schema contract)
  assert.equal(
    machineThreadInputSchema.safeParse({
      action: "resume",
      threadId: "th-123",
      developerInstructionsId: "inst-123"
    }).success,
    false
  );

  // action: "resume" valid without developerInstructionsId
  assert.equal(
    machineThreadInputSchema.safeParse({
      action: "resume",
      threadId: "th-123",
      cwd: "/home/user/project"
    }).success,
    true
  );
});

test("Isolation: threadRunOptionsSchema rejects developerInstructions", () => {
  const parsed = threadRunOptionsSchema.safeParse({
    model: "gpt-5-preview",
    developerInstructions: "should be strictly rejected"
  });
  assert.equal(parsed.success, false);
});

test("Execution link: AppServerCommandDispatcher passes developerInstructions to startThread", async () => {
  let capturedCwd = "";
  let capturedModel: string | null | undefined;
  let capturedCommand: unknown;

  const mockHost: Partial<AppServerCommandHost> = {
    defaultModel: "default-model",
    startThread: async (cwd, model, command) => {
      capturedCwd = cwd;
      capturedModel = model;
      capturedCommand = command;
      return { threadId: "th-new-1" };
    }
  };

  const commandWithInstructions: SessionCommand = {
    seq: 1,
    commandId: "cmd-1",
    type: "start_thread",
    workingDirectory: "/test/dir",
    createdAt: new Date().toISOString(),
    creationOptions: {
      developerInstructions: "You are a test assistant."
    }
  };

  await dispatchAppServerCommand(commandWithInstructions, mockHost as AppServerCommandHost);

  assert.equal(capturedCwd, "/test/dir");
  assert.equal(capturedModel, "default-model");
  const passedCommand = capturedCommand as { creationOptions?: { developerInstructions?: string } };
  assert.equal(passedCommand?.creationOptions?.developerInstructions, "You are a test assistant.");

  // Clean start without developer instructions
  const commandWithoutInstructions: SessionCommand = {
    seq: 2,
    commandId: "cmd-2",
    type: "start_thread",
    workingDirectory: "/test/dir",
    createdAt: new Date().toISOString()
  };

  await dispatchAppServerCommand(commandWithoutInstructions, mockHost as AppServerCommandHost);
  const passedCommand2 = capturedCommand as { creationOptions?: unknown };
  assert.equal(passedCommand2?.creationOptions, undefined);
});

test("Developer Instructions HTTP routes create, update, list, and delete server-owned templates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codexhub-dev-inst-http-"));
  const state = await CodexhubServerState.load({ filePath: join(dir, "config.yaml") });
  const app = Fastify();
  registerDeveloperInstructionRoutes(app, { state });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/developer-instructions",
      payload: {
        name: "Reviewer",
        description: "Read-only review",
        instructions: "Review without editing."
      }
    });
    assert.equal(created.statusCode, 200);
    const createdPayload = created.json() as { template?: { id?: string } };
    const id = createdPayload.template?.id;
    if (!id) assert.fail("create response must include a template id");
    assert.ok(id.startsWith("inst-"));

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/developer-instructions/${encodeURIComponent(id)}`,
      payload: { instructions: "Review the complete call path." }
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().template.instructions, "Review the complete call path.");

    const listed = await app.inject({ method: "GET", url: "/api/developer-instructions" });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().templates.map((item: { id: string }) => item.id), [id]);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/developer-instructions/${encodeURIComponent(id)}`
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(state.getDeveloperInstruction(id), null);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Machine thread route resolves one immutable template snapshot only for action new", async () => {
  const app = Fastify();
  await app.register(websocket);
  const starts: Array<{ machineId: string; cwd?: string; creationOptions?: { developerInstructions?: string } }> = [];
  const resumes: Array<{ machineId: string; threadId: string; cwd?: string }> = [];
  let currentInstructions = "Reviewer v1";
  const page = { threadId: "thread-result" };
  registerThreadRoutes(app, {
    connectionSnapshotEvent: () => ({ seq: 0, kind: "connections" }),
    connectionSubscribers: new Set(),
    forceReleaseThreadRecordSubscription: () => undefined,
    markStaleSessions: () => ({ offline: 0, removed: 0 }),
    machines: {},
    projectSnapshotEvent: () => ({ seq: 0, kind: "projects" }),
    projectSubscribers: new Set(),
    publishProjects: () => undefined,
    releaseThreadRecordSubscription: () => undefined,
    retainThreadRecordSubscription: () => undefined,
    resolveDeveloperInstruction: (id: string) => id === "reviewer" ? {
      id,
      name: "Reviewer",
      instructions: currentInstructions,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    } : null,
    taskSnapshotEvent: () => ({ seq: 0, kind: "tasks" }),
    taskSubscribers: new Set(),
    threads: {
      startMachineThread: async (machineId: string, cwd?: string, creationOptions?: { developerInstructions?: string }) => {
        starts.push({ machineId, cwd, creationOptions });
        return page;
      },
      resumeMachineThread: async (machineId: string, threadId: string, cwd?: string) => {
        resumes.push({ machineId, threadId, cwd });
        return page;
      },
      getThreadPage: () => page
    },
    waitForSession: async () => undefined
  } as never);
  try {
    const plain = await app.inject({
      method: "POST",
      url: "/api/machines/machine-1/threads",
      payload: { action: "new", cwd: "/tmp/project" }
    });
    assert.equal(plain.statusCode, 200);
    assert.deepEqual(starts[0], { machineId: "machine-1", cwd: "/tmp/project", creationOptions: undefined });
    assert.equal(plain.json().developerInstruction, undefined);

    const instructed = await app.inject({
      method: "POST",
      url: "/api/machines/machine-1/threads",
      payload: { action: "new", cwd: "/tmp/project", developerInstructionsId: "reviewer" }
    });
    assert.equal(instructed.statusCode, 200);
    assert.equal(starts[1].creationOptions?.developerInstructions, "Reviewer v1");
    assert.equal(instructed.json().developerInstruction.templateName, "Reviewer");
    assert.equal(instructed.json().developerInstruction.instructions, "Reviewer v1");
    currentInstructions = "Reviewer v2";
    assert.equal(starts[1].creationOptions?.developerInstructions, "Reviewer v1");

    const missing = await app.inject({
      method: "POST",
      url: "/api/machines/machine-1/threads",
      payload: { action: "new", developerInstructionsId: "missing" }
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(starts.length, 2);

    const resumed = await app.inject({
      method: "POST",
      url: "/api/machines/machine-1/threads",
      payload: { action: "resume", threadId: "thread-existing", cwd: "/tmp/project" }
    });
    assert.equal(resumed.statusCode, 200);
    assert.deepEqual(resumes, [{ machineId: "machine-1", threadId: "thread-existing", cwd: "/tmp/project" }]);
    assert.equal(resumed.json().developerInstruction, undefined);

    const invalidResume = await app.inject({
      method: "POST",
      url: "/api/machines/machine-1/threads",
      payload: {
        action: "resume",
        threadId: "thread-existing",
        developerInstructionsId: "reviewer"
      }
    });
    assert.notEqual(invalidResume.statusCode, 200);
    assert.equal(resumes.length, 1);
  } finally {
    await app.close();
  }
});

test("thread tabs mark and disclose injected Developer Instructions", () => {
  const selectorSource = readFileSync(new URL("../src/web/appViewSelectors.tsx", import.meta.url), "utf8");
  const styleSource = readFileSync(new URL("../src/web/styles/composer.css", import.meta.url), "utf8");

  assert.match(selectorSource, /hasDeveloperInstruction/);
  assert.match(selectorSource, /Developer Instruction/);
  assert.match(selectorSource, /developerInstruction\.templateName/);
  assert.match(selectorSource, /developerInstruction\.instructions/);
  assert.match(styleSource, /\.openThreadTabLabel\.hasDeveloperInstruction/);
  assert.match(styleSource, /box-shadow:\s*inset 3px 0 #d97706/);
  assert.match(styleSource, /\.openThreadTabInstructionDetails pre/);
});
