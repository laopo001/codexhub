import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { codexRecordFromAppServerItem } from "../src/core/threadAppServerRecords.js";
import { recordToView } from "../src/core/codexRecordView.js";
import type { CodexRecord } from "../src/shared/recordTypes.js";
import { canRenderMarkdown, MessageCard } from "../src/web/helpers/components.js";
import {
  formatAgentQuestionAnswers,
  rememberAgentQuestionAnswers,
  storedAgentQuestionAnswers
} from "../src/web/helpers/agentQuestions.js";
import {
  activityStatusFromRecord,
  latestTurnStatusFromRecords,
  recordHasPendingInteraction,
  recordsHavePendingInteraction
} from "../src/web/helpers/records.js";
import { petStatusForThread } from "../src/web/pets/petStatus.js";
import type { OpenThreadState } from "../src/web/types.js";

const agentRecord = () => codexRecordFromAppServerItem(
  "agent-thread",
  "turn-1",
  {
    type: "agentMessage",
    id: "agent-1",
    text: "I need a little more context.",
    delivery: "async",
    questions: [
      { title: "Scope", options: ["Small", "Large"] },
      { title: "Notes", options: null }
    ]
  },
  "2026-09-05T01:00:00.000Z"
);

test("async agent questions survive projection and render an actionable form", () => {
  const record = agentRecord();
  assert.ok(record);
  const view = recordToView(record);
  assert.equal(view?.label, "agent_question");
  assert.equal(view?.canFork, false);
  assert.equal(canRenderMarkdown(view!), true);
  assert.deepEqual(view?.agentQuestions, [
    { title: "Scope", options: ["Small", "Large"] },
    { title: "Notes", options: null }
  ]);
  const markup = renderToStaticMarkup(createElement(MessageCard, {
    message: view!,
    renderMode: "raw",
    markdownEnabled: false,
    threadId: "agent-thread",
    threadMachineId: "machine-1",
    onAgentQuestionResponse: async () => true
  }));
  assert.match(markup, /I need a little more context\./);
  assert.match(markup, /Scope/);
  assert.match(markup, /Small/);
  assert.match(markup, /Notes/);
  assert.match(markup, /回答/);
  assert.match(markup, /disabled/);
});

test("duplicate question titles keep separate stable-index answers and blank answers stay disabled", () => {
  const record = agentRecord();
  assert.ok(record);
  const view = recordToView({
    ...record,
    payload: {
      ...(record.payload as Record<string, unknown>),
      questions: [{ title: "Same", options: ["One"] }, { title: "Same", options: ["Two"] }]
    }
  });
  assert.equal(formatAgentQuestionAnswers([
    { title: "Same", options: ["One"] },
    { title: "Same", options: ["Two"] }
  ], { 0: "One", 1: "Two" }), "Answers to the agent's questions:\n- Same: One\n- Same: Two");
  const markup = renderToStaticMarkup(createElement(MessageCard, {
    message: view!,
    renderMode: "raw",
    markdownEnabled: false,
    threadId: "agent-thread",
    threadMachineId: "machine-1",
    onAgentQuestionResponse: async () => true
  }));
  assert.equal((markup.match(/name="agent-question-/g) ?? []).length, 2);
  assert.match(markup, /disabled/);
});

test("agent answer text keeps every question explicit", () => {
  assert.equal(
    formatAgentQuestionAnswers([
      { title: "Scope", options: ["Small"] },
      { title: "Notes", options: null }
    ], { 0: "Small", 1: "Use the existing path" }),
    "Answers to the agent's questions:\n- Scope: Small\n- Notes: Use the existing path"
  );
});

test("answered agent questions use durable thread and record association", () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const values = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }
  };
  try {
    rememberAgentQuestionAnswers("thread-a", "record-a", { 0: "Small" });
    assert.deepEqual(storedAgentQuestionAnswers("thread-a", "record-a"), { 0: "Small" });
    assert.equal(storedAgentQuestionAnswers("thread-a", "record-b"), null);
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test("storage getItem failures do not break answer persistence fallback", () => {
  let writes = 0;
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: () => { throw new Error("storage unavailable"); },
      setItem: () => { writes += 1; }
    }
  };
  try {
    assert.doesNotThrow(() => rememberAgentQuestionAnswers("thread-a", "record-a", { 0: "Small" }));
    assert.equal(writes, 1);
    assert.equal(storedAgentQuestionAnswers("thread-a", "record-a"), null);
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  }
});

const userInputRecord = (isBlocking: boolean): CodexRecord => ({
  id: `input-${isBlocking ? "blocking" : "async"}`,
  timestamp: "2026-09-05T01:00:00.000Z",
  type: "response_item",
  payload: {
    type: "user_input_request",
    isBlocking,
    status: "pending_user_input",
    userInput: { userInputId: "input-1", status: "pending" },
    questions: []
  }
});

test("non-blocking user input remains visible but does not block execution surfaces", () => {
  const asyncRecord = userInputRecord(false);
  assert.equal(activityStatusFromRecord(asyncRecord)?.key, "userInputAsync");
  assert.equal(recordHasPendingInteraction(asyncRecord), false);
  assert.equal(recordsHavePendingInteraction([asyncRecord]), false);
  assert.equal(latestTurnStatusFromRecords([asyncRecord]), null);
  assert.equal(petStatusForThread({ records: [asyncRecord], running: false } as OpenThreadState), "idle");

  const blockingRecord = userInputRecord(true);
  assert.equal(activityStatusFromRecord(blockingRecord)?.key, "userInput");
  assert.equal(recordsHavePendingInteraction([blockingRecord]), true);
});
