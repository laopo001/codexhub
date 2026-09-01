import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import { threadConversationProjection } from "../../src/web/helpers/threadConversationProjection.js";
import type { OpenThreadState } from "../../src/web/types.js";

const thread = (threadId: string, message: string): OpenThreadState => ({
  threadId,
  workingDirectory: "/workspace/root",
  runtime: { machineId: "machine-a", online: true, runnable: true },
  status: "idle",
  running: false,
  title: threadId,
  updatedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 2,
  threadUsage: emptyThreadUsage(),
  records: [
    {
      id: `${threadId}:user`,
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message }
    }
  ],
  lastSeq: 0,
  composerMode: "chat",
  modelDraft: "auto",
  reasoningDraft: "auto",
  serviceTierDraft: "auto",
  approvalPolicyDraft: "auto",
  approvalsReviewerDraft: "auto",
  permissionProfileDraft: null,
  imageAttachments: [],
  textAttachments: [],
  queuedTurns: [],
  pendingUserMessages: []
});

test("thread conversation projection is independent for each thread id", () => {
  const first = threadConversationProjection(thread("thread-a", "message A"));
  const second = threadConversationProjection(thread("thread-b", "message B"));

  assert.notStrictEqual(first.views, second.views);
  assert.deepEqual(first.userMessageHistory, ["message A"]);
  assert.deepEqual(second.userMessageHistory, ["message B"]);
  assert.notEqual(first.latestTurnActivity.key, second.latestTurnActivity.key);
  assert.equal(first.showSendButton, true);
  assert.equal(second.showSendButton, true);
});
