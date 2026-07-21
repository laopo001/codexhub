import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import type { OpenThreadState } from "../../src/web/types.js";
import { petAnimationRows, petAtlas, petAtlasBackgroundPosition } from "../../src/web/pets/petAtlas.js";
import { parsePetCommand } from "../../src/web/pets/petCommands.js";
import { derivePetActivities, petAnimationForStatus, petStatusForThread } from "../../src/web/pets/petStatus.js";
import { parsePetManifest } from "../../src/web/pets/petStore.js";

const thread = (threadId: string, records: CodexRecord[] = [], running = false): OpenThreadState => ({
  threadId,
  workingDirectory: `/tmp/${threadId}`,
  session: { online: true, runnable: true, sessionId: "session-1" },
  status: running ? "running" : "idle",
  running,
  title: threadId,
  updatedAt: `2026-01-01T00:00:0${threadId.slice(-1)}.000Z`,
  messageCount: records.length,
  threadUsage: emptyThreadUsage(),
  records,
  lastSeq: records.length,
  composerMode: "chat",
  modelDraft: "auto",
  reasoningDraft: "auto",
  serviceTierDraft: "auto",
  approvalPolicyDraft: "auto",
  approvalsReviewerDraft: "auto",
  permissionProfileDraft: null,
  imageAttachments: [],
  textAttachments: [],
});

test("pet atlas matches the Codex 8 x 9 sprite contract", () => {
  assert.deepEqual(
    [petAtlas.width, petAtlas.height, petAtlas.columns, petAtlas.rows, petAtlas.cellWidth, petAtlas.cellHeight],
    [1536, 1872, 8, 9, 192, 208]
  );
  assert.equal(petAnimationRows.running.durationsMs.length, 6);
  assert.equal(petAnimationRows.failed.durationsMs.length, 8);
  assert.deepEqual(petAtlasBackgroundPosition("idle", 0), { x: "0%", y: "0%" });
  assert.deepEqual(petAtlasBackgroundPosition("review", 5), { x: `${(5 / 7) * 100}%`, y: "100%" });
});

test("pet commands stay local and support toggle, picker, off, and direct selection", () => {
  assert.deepEqual(parsePetCommand("/pet"), { action: "toggle" });
  assert.deepEqual(parsePetCommand(" /pets "), { action: "open_picker" });
  assert.deepEqual(parsePetCommand("/pets off"), { action: "off" });
  assert.deepEqual(parsePetCommand("/pets Little Spud"), { action: "select", query: "Little Spud" });
  assert.equal(parsePetCommand("please /pet"), null);
});

test("Codex pet manifests use safe ids and the selected spritesheet", () => {
  assert.deepEqual(parsePetManifest({
    id: "My Pet",
    displayName: "My Pet",
    description: "A helper",
    spritesheetPath: "spritesheet.webp",
  }, "spritesheet.webp"), {
    id: "my-pet",
    displayName: "My Pet",
    description: "A helper",
    spritesheetPath: "spritesheet.webp",
  });
  assert.throws(
    () => parsePetManifest({ id: "bad", spritesheetPath: "other.webp" }, "spritesheet.webp"),
    /expects other\.webp/
  );
});

test("pet status prioritizes input, failure, ready, and running", () => {
  const pendingApproval: CodexRecord = {
    id: "approval",
    type: "response_item",
    payload: { type: "local_shell_call", approval: { status: "pending" } },
  };
  const failed: CodexRecord = {
    id: "failure",
    type: "event_msg",
    payload: { type: "turn_aborted", status: "failed" },
  };
  assert.equal(petStatusForThread(thread("thread-1", [pendingApproval], true), true), "needs_input");
  assert.equal(petStatusForThread(thread("thread-2", [failed]), true), "blocked");
  assert.equal(petStatusForThread(thread("thread-3"), true), "ready");
  assert.equal(petStatusForThread(thread("thread-4", [], true), false), "running");
  assert.equal(petStatusForThread(thread("thread-5"), false), "idle");
  assert.equal(petAnimationForStatus("needs_input"), "waiting");
  assert.equal(petAnimationForStatus("blocked"), "failed");
});

test("pet activities sort using the official attention priority", () => {
  const pendingInput: CodexRecord = {
    id: "input",
    type: "response_item",
    payload: { type: "user_input_request", status: "pending_user_input", userInput: { status: "pending" } },
  };
  const failed: CodexRecord = { id: "failed", type: "error", payload: { message: "boom" } };
  const activities = derivePetActivities([
    thread("thread-4", [], true),
    thread("thread-3"),
    thread("thread-2", [failed]),
    thread("thread-1", [pendingInput], true),
  ], new Set(["thread-3"]));
  assert.deepEqual(activities.map((activity) => activity.status), ["needs_input", "blocked", "ready", "running"]);
});
