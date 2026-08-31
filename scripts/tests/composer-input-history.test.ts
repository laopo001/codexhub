import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COMPOSER_INPUT_HISTORY_STORAGE_KEY,
  COMPOSER_INPUT_HISTORY_MAX_ENTRIES,
  parseComposerInputHistory,
  serializeComposerInputHistory,
  createComposerInputHistoryStore,
  formatComposerInputHistoryTime,
  type ComposerInputHistoryEntry
} from "../../src/web/helpers/composerInputHistory.js";
import {
  createComposerDraftStore,
  composeUserInputText,
  userMessageHistoryFromRecords
} from "../../src/web/helpers/composer.js";
import { createThreadActions } from "../../src/web/appActions/threadActions.js";
import type { OpenThreadState } from "../../src/web/types.js";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import { InputHistorySettingsPanel } from "../../src/web/AppDialogs.js";

test("parseComposerInputHistory validates schema, filters invalid entries, and enforces strict types", () => {
  assert.deepEqual(parseComposerInputHistory(null), []);
  assert.deepEqual(parseComposerInputHistory(undefined), []);
  assert.deepEqual(parseComposerInputHistory("invalid-json{"), []);
  assert.deepEqual(parseComposerInputHistory({}), []);
  assert.deepEqual(parseComposerInputHistory(123), []);

  const mixedPayload = [
    null,
    123,
    "string-item",
    {},
    { text: "" },
    { text: "   \n\t  " },
    { id: "1", text: "valid text 1", createdAt: "2026-08-28T10:00:00.000Z" },
    { text: "missing id", createdAt: "2026-08-28T10:30:00.000Z" },
    { id: "invalid-date", text: "invalid date", createdAt: "invalid-date" },
    { id: "2", text: "valid text 2", createdAt: "2026-08-28T10:45:00.000Z" },
    { id: "2", text: "duplicate id", createdAt: "2026-08-28T10:46:00.000Z" },
    { id: "3", text: "  valid text 1  ", createdAt: "2026-08-28T11:00:00.000Z" } // Duplicate trimmed
  ];

  const parsed = parseComposerInputHistory(mixedPayload);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, "1");
  assert.equal(parsed[0].text, "valid text 1");
  assert.equal(parsed[0].createdAt, "2026-08-28T10:00:00.000Z");

  assert.equal(parsed[1].text, "valid text 2");
  assert.equal(parsed[1].id, "2");
  assert.equal(parsed[1].createdAt, "2026-08-28T10:45:00.000Z");
});

test("parseComposerInputHistory truncates entries beyond 100", () => {
  const largeArray = Array.from({ length: 150 }, (_, i) => ({
    id: `item-${i}`,
    text: `prompt ${i}`,
    createdAt: new Date().toISOString()
  }));

  const parsed = parseComposerInputHistory(largeArray);
  assert.equal(parsed.length, COMPOSER_INPUT_HISTORY_MAX_ENTRIES);
  assert.equal(parsed[0].text, "prompt 0");
  assert.equal(parsed[99].text, "prompt 99");
});

test("createComposerInputHistoryStore records, dedupes by trimmed text, updates timestamp, and caps at 100 newest-first", () => {
  const store = createComposerInputHistoryStore([]);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  store.record("first prompt\nwith newline");
  store.record("second prompt");
  assert.equal(notifications, 2);
  let entries = store.get();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, "second prompt");
  assert.equal(entries[1].text, "first prompt\nwith newline");

  // Re-submitting "first prompt\nwith newline" with extra whitespace should dedupe and move to front
  const earlierCreatedAt = entries[1].createdAt;
  store.record("  first prompt\nwith newline  ");
  entries = store.get();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, "  first prompt\nwith newline  ");
  assert.equal(entries[1].text, "second prompt");
  assert.ok(entries[0].createdAt >= earlierCreatedAt);

  // Blank records should be ignored
  store.record("   \n\t  ");
  assert.equal(store.get().length, 2);

  // Exceed 100 items
  for (let i = 0; i < 110; i += 1) {
    store.record(`bulk item ${i}`);
  }
  assert.equal(store.get().length, 100);
  assert.equal(store.get()[0].text, "bulk item 109");

  unsubscribe();
});

test("createComposerInputHistoryStore supports delete, clear, and serialization", () => {
  const initial: ComposerInputHistoryEntry[] = [
    { id: "a", text: "prompt A", createdAt: "2026-08-28T00:00:00.000Z" },
    { id: "b", text: "prompt B", createdAt: "2026-08-28T00:01:00.000Z" }
  ];
  const store = createComposerInputHistoryStore(initial);

  assert.equal(serializeComposerInputHistory(store.get()), JSON.stringify(initial));

  store.delete("a");
  assert.equal(store.get().length, 1);
  assert.equal(store.get()[0].id, "b");

  store.delete("non-existent");
  assert.equal(store.get().length, 1);

  store.clear();
  assert.equal(store.get().length, 0);
  assert.equal(serializeComposerInputHistory(store.get()), "[]");
});

test("threadActions.send records typedText including slash commands, but excludes pure attachments and expanded references", async () => {
  const composerDraftStore = createComposerDraftStore();
  const inputHistoryStore = createComposerInputHistoryStore([]);
  const threadId = "test-thread-1";

  const threadState: OpenThreadState = {
    threadId,
    workingDirectory: "/repo",
    runtime: { online: true, runnable: true, machineId: "m1" },
    status: "idle",
    running: false,
    title: "Test Thread",
    updatedAt: "2026-08-28T00:00:00.000Z",
    messageCount: 0,
    threadUsage: emptyThreadUsage(),
    records: [],
    backgroundTerminals: [],
    lastSeq: 0,
    modelDraft: "auto",
    reasoningDraft: "auto",
    serviceTierDraft: "auto",
    approvalPolicyDraft: "auto",
    approvalsReviewerDraft: "auto",
    composerMode: "chat",
    permissionProfileDraft: null,
    imageAttachments: [],
    textAttachments: [],
    pendingUserMessages: [],
    queuedTurns: []
  };

  const conversationThreadsRef = { current: new Map([[threadId, threadState]]) };
  let localCommandHandled = false;
  let modelDialogOpened = false;

  const actions = createThreadActions({
    activeTabThreadId: threadId,
    closedThreadIds: { current: new Set() },
    composerDraftStore,
    composerInputHistoryStore: inputHistoryStore,
    conversationThreadsRef,
    expandedToolBatchKeys: {},
    forkingMessageKey: "",
    goalDialog: null,
    threadRenameDialog: null,
    threadRenameRequestTokens: { current: new Map() },
    latestRequestedThreadId: { current: threadId },
    notificationRecordsByThread: { current: new Map() },
    openThreadIdsRef: { current: new Set([threadId]) },
    openingThreads: { current: new Map() },
    realtimeThreadSubscriptions: { current: new Set() },
    selectedProjectKey: "",
    openThreads: [threadState],
    threadLastSeqs: { current: new Map() },
    setActiveMachineId: () => undefined,
    setActiveTabThreadByMachine: () => undefined,
    setActiveTabThreadId: () => undefined,
    setActiveWorkspacePath: () => undefined,
    setForkingMessageKey: () => undefined,
    setGoalDialog: () => undefined,
    setProjects: () => undefined,
    openThreadModelDialog: () => { modelDialogOpened = true; },
    setThreadRenameDialog: () => undefined,
    setRuntimeList: () => undefined,
    dispatchOpenThreads: () => undefined,
    dispatchConversationThread: () => undefined,
    setThreadOrderByMachine: () => undefined
  }, {
    handleLocalComposerCommand: (cmd) => {
      if (cmd.startsWith("/pet")) {
        localCommandHandled = true;
        return true;
      }
      return false;
    },
    primeTaskCompletionFeedback: () => undefined,
    refreshProjects: async () => ({ projects: [], configPath: "/path", machines: [] }),
    refreshRuntimes: async () => [],
    resetComposerHistory: () => undefined,
    sendRealtime: () => true,
    showActionError: () => undefined,
    showForkError: () => undefined
  });

  // 1. Local slash command (e.g. /pet) should be recorded
  composerDraftStore.set(threadId, "/pet cat");
  await actions.send(threadId);
  assert.equal(localCommandHandled, true);
  assert.equal(inputHistoryStore.get().length, 1);
  assert.equal(inputHistoryStore.get()[0].text, "/pet cat");

  // 2. /model command should be recorded
  composerDraftStore.set(threadId, "/model");
  await actions.send(threadId);
  assert.equal(modelDialogOpened, true);
  assert.equal(inputHistoryStore.get().length, 2);
  assert.equal(inputHistoryStore.get()[0].text, "/model");

  // 3. Pure attachments without typed text should NOT be recorded
  composerDraftStore.set(threadId, "   ");
  threadState.textAttachments = [{ id: "t1", text: "some attached code" }];
  await actions.send(threadId);
  assert.equal(inputHistoryStore.get().length, 2); // Still 2, not recorded

  // 4. Normal prompt with attachments: only typed text is recorded, expanded reference is not in input history
  composerDraftStore.set(threadId, "Please review this\nand improve it");
  threadState.textAttachments = [{ id: "t2", text: "File: file.ts\n\nconst x = 1;" }];
  const expandedText = composeUserInputText(composerDraftStore.get(threadId), threadState.textAttachments);
  assert.ok(expandedText.includes("## Reference 1"));

  await actions.send(threadId);
  assert.equal(inputHistoryStore.get().length, 3);
  assert.equal(inputHistoryStore.get()[0].text, "Please review this\nand improve it");
  assert.ok(!inputHistoryStore.get()[0].text.includes("## Reference"));
});

test("transcript history for arrow keys remains completely decoupled from composerInputHistory", () => {
  const records = [
    {
      id: "rec-1",
      timestamp: "2026-08-28T00:00:00.000Z",
      type: "event_msg" as const,
      payload: { type: "user_message" as const, message: "transcript turn 1" }
    },
    {
      id: "rec-2",
      timestamp: "2026-08-28T00:01:00.000Z",
      type: "event_msg" as const,
      payload: { type: "agent_message" as const, message: "response 1" }
    }
  ];

  // activeUserMessageHistory from records
  const arrowHistory = userMessageHistoryFromRecords(records);
  assert.deepEqual(arrowHistory, ["transcript turn 1"]);

  // An input history store with separate items (e.g. slash commands) does not alter transcript history
  const inputStore = createComposerInputHistoryStore([
    { id: "h1", text: "/rename", createdAt: "2026-08-28T00:00:00.000Z" },
    { id: "h2", text: "independent input", createdAt: "2026-08-28T00:01:00.000Z" }
  ]);

  assert.deepEqual(arrowHistory, ["transcript turn 1"]);
  assert.equal(inputStore.get().length, 2);
});

test("composerInputHistoryStore handles storage event, key constant, and tolerates malformed data", () => {
  assert.equal(COMPOSER_INPUT_HISTORY_STORAGE_KEY, "codexhub-composer-input-history-v1");

  const store = createComposerInputHistoryStore([]);
  let updateCount = 0;
  store.subscribe(() => {
    updateCount += 1;
  });

  const validPayload = JSON.stringify([
    { id: "ext-1", text: "from another tab", createdAt: "2026-08-28T12:00:00.000Z" }
  ]);
  store.syncFromStorage(validPayload);
  assert.equal(updateCount, 1);
  assert.equal(store.get().length, 1);
  assert.equal(store.get()[0].text, "from another tab");
  assert.ok(formatComposerInputHistoryTime(store.get()[0].createdAt).length > 0);

  // Syncing same content again should be a no-op
  store.syncFromStorage(validPayload);
  assert.equal(updateCount, 1);

  // Syncing invalid json should reset to empty gracefully without throw
  store.syncFromStorage("broken{json");
  assert.equal(updateCount, 2);
  assert.deepEqual(store.get(), []);
});

test("Input history Settings panel exposes copy and cleanup without composer restore controls", () => {
  const store = createComposerInputHistoryStore([{
    id: "history-1",
    text: "first line\nsecond line",
    createdAt: "2026-08-28T12:00:00.000Z"
  }]);
  const markup = renderToStaticMarkup(createElement(InputHistorySettingsPanel, {
    store,
    copyText: async () => undefined
  }));

  assert.match(markup, /Clear all/);
  assert.match(markup, /aria-label="Copy input text"/);
  assert.match(markup, /aria-label="Delete input history entry"/);
  assert.match(markup, /first line\nsecond line/);
  assert.doesNotMatch(markup, /textarea|Restore|Use in composer/);
});
