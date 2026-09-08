import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import type { ThreadDetail } from "../../src/shared/threadTypes.js";

const loadReducer = async () => {
  const globalWithWindow = globalThis as unknown as { window?: { location: { search: string } } };
  globalWithWindow.window = { location: { search: "" } };
  return (await import("../../src/web/openThreadReducer.js")).openThreadReducer;
};

const detail = (threadId: string): ThreadDetail => ({
  threadId,
  workingDirectory: `/tmp/${threadId}`,
  runtime: { online: true, runnable: true, machineId: "session-1" },
  status: "idle",
  running: false,
  title: threadId,
  updatedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 0,
  threadUsage: emptyThreadUsage(),
  records: [],
  backgroundTerminals: [],
  lastSeq: 0
});

const record: CodexRecord = {
  id: "record-1",
  type: "event_msg",
  timestamp: "2026-01-01T00:00:01.000Z",
  payload: { type: "agent_message", message: "done" }
};

test("open thread reducer preserves local drafts when fresh server detail arrives", async () => {
  const openThreadReducer = await loadReducer();
  let state = openThreadReducer([], { type: "upsert-detail", thread: detail("thread-1") });
  state = openThreadReducer(state, { type: "set-composer-mode", threadId: "thread-1", mode: "goal" });
  state = openThreadReducer(state, {
    type: "set-draft",
    threadId: "thread-1",
    field: "modelDraft",
    value: "gpt-test"
  });
  state = openThreadReducer(state, {
    type: "upsert-detail",
    thread: { ...detail("thread-1"), status: "running", running: true, title: "server title" }
  });

  assert.equal(state[0].composerMode, "goal");
  assert.equal(state[0].modelDraft, "gpt-test");
  assert.equal(state[0].running, true);
  assert.equal(state[0].title, "server title");
});

test("open thread reducer retains transient Developer Instructions for the current tab only", async () => {
  const openThreadReducer = await loadReducer();
  const developerInstruction = {
    templateId: "reviewer",
    templateName: "Reviewer",
    instructions: "Review without editing.",
    injectedAt: new Date(0).toISOString()
  };
  let state = openThreadReducer([], {
    type: "upsert-detail",
    thread: { ...detail("thread-1"), developerInstruction }
  });
  state = openThreadReducer(state, {
    type: "upsert-detail",
    thread: { ...detail("thread-1"), title: "refreshed" }
  });

  assert.equal(state[0]?.developerInstruction?.instructions, "Review without editing.");
});

test("open thread reducer merges stream records and applies semantic ordering", async () => {
  const openThreadReducer = await loadReducer();
  let state = openThreadReducer([], { type: "upsert-detail", thread: detail("thread-1") });
  state = openThreadReducer(state, { type: "upsert-detail", thread: detail("thread-2") });
  state = openThreadReducer(state, {
    type: "merge-stream",
    threadId: "thread-1",
    thread: { ...detail("thread-1"), status: "running", running: true },
    record
  });
  state = openThreadReducer(state, { type: "reorder", threadIds: ["thread-2", "thread-1"] });

  assert.deepEqual(state.map((thread) => thread.threadId), ["thread-2", "thread-1"]);
  assert.equal(state[1].records[0].id, "record-1");
  assert.equal(state[1].running, true);
});

test("open thread reducer reconciles one queued message per new canonical user record", async () => {
  const openThreadReducer = await loadReducer();
  let state = openThreadReducer([], { type: "upsert-detail", thread: detail("thread-1") });
  for (const id of ["pending-1", "pending-2"]) {
    state = openThreadReducer(state, {
      type: "enqueue-user-message",
      threadId: "thread-1",
      message: {
        id,
        text: "same prompt",
        imageUrls: [],
        createdAt: "2026-08-28T00:00:00.000Z"
      }
    });
  }

  const canonicalUserRecord: CodexRecord = {
    id: "user-record-1",
    type: "event_msg",
    timestamp: "2026-08-28T00:00:01.000Z",
    payload: { type: "user_message", message: "same prompt" }
  };
  state = openThreadReducer(state, {
    type: "merge-stream",
    threadId: "thread-1",
    thread: { ...detail("thread-1"), status: "running", running: true },
    record: canonicalUserRecord
  });
  assert.deepEqual(state[0].pendingUserMessages.map((message) => message.id), ["pending-2"]);

  state = openThreadReducer(state, {
    type: "merge-stream",
    threadId: "thread-1",
    thread: { ...detail("thread-1"), status: "running", running: true },
    record: canonicalUserRecord
  });
  assert.deepEqual(state[0].pendingUserMessages.map((message) => message.id), ["pending-2"]);
});

test("open thread reducer lets the user dismiss one queued projection", async () => {
  const openThreadReducer = await loadReducer();
  let state = openThreadReducer([], { type: "upsert-detail", thread: detail("thread-1") });
  state = openThreadReducer(state, {
    type: "enqueue-user-message",
    threadId: "thread-1",
    message: {
      id: "pending-1",
      text: "queued prompt",
      imageUrls: [],
      createdAt: "2026-08-28T00:00:00.000Z"
    }
  });
  state = openThreadReducer(state, {
    type: "remove-pending-user-message",
    threadId: "thread-1",
    messageId: "pending-1"
  });

  assert.deepEqual(state[0].pendingUserMessages, []);
});

test("open thread reducer promotes provisional submissions to the authoritative queue", async () => {
  const openThreadReducer = await loadReducer();
  let state = openThreadReducer([], { type: "upsert-detail", thread: detail("thread-1") });
  state = openThreadReducer(state, {
    type: "enqueue-user-message",
    threadId: "thread-1",
    message: {
      id: "submission-1",
      text: "queued prompt",
      imageUrls: [],
      createdAt: "2026-08-28T00:00:00.000Z"
    }
  });
  state = openThreadReducer(state, {
    type: "merge-stream",
    threadId: "thread-1",
    thread: detail("thread-1"),
    queue: [{
      submissionId: "submission-1",
      text: "queued prompt",
      imageCount: 0,
      source: "web",
      createdAt: "2026-08-28T00:00:00.000Z",
      position: 1
    }]
  });
  assert.equal(state[0].pendingUserMessages[0]?.serverQueued, true);
  assert.equal(state[0].queuedTurns[0]?.submissionId, "submission-1");

  state = openThreadReducer(state, {
    type: "merge-stream",
    threadId: "thread-1",
    thread: detail("thread-1"),
    queue: []
  });
  assert.deepEqual(state[0].pendingUserMessages, []);
  assert.deepEqual(state[0].queuedTurns, []);
});

test("open thread reducer keeps background terminals independent from transcript records", async () => {
  const openThreadReducer = await loadReducer();
  let state = openThreadReducer([], { type: "upsert-detail", thread: detail("thread-1") });
  state = openThreadReducer(state, {
    type: "merge-stream",
    threadId: "thread-1",
    thread: { ...detail("thread-1") },
    backgroundTerminals: [{
      itemId: "background-item",
      processId: "background-process",
      command: "pnpm run tts:script",
      cwd: "/tmp/thread-1",
      osPid: 123,
      cpuPercent: 1.5,
      rssKb: 2048
    }]
  });

  assert.equal(state[0].records.length, 0);
  assert.equal(state[0].backgroundTerminals?.[0]?.command, "pnpm run tts:script");
});

test("open thread reducer merges historical record batches in one pass", async () => {
  const openThreadReducer = await loadReducer();
  const earlier: CodexRecord = {
    ...record,
    id: "record-earlier",
    timestamp: "2026-01-01T00:00:00.000Z"
  };
  let state = openThreadReducer([], { type: "upsert-detail", thread: detail("thread-1") });
  state = openThreadReducer(state, {
    type: "merge-stream",
    threadId: "thread-1",
    thread: { ...detail("thread-1"), messageCount: 2 },
    records: [record, earlier]
  });

  assert.deepEqual(state[0].records.map((item) => item.id), ["record-earlier", "record-1"]);
  assert.equal(state[0].messageCount, 2);
});

test("open thread reducer prepends older pages while retaining the latest window and history boundary", async () => {
  const openThreadReducer = await loadReducer();
  const older: CodexRecord = {
    ...record,
    id: "record-older",
    timestamp: "2026-01-01T00:00:00.000Z"
  };
  const latest: ThreadDetail = {
    ...detail("thread-1"),
    records: [record],
    history: {
      hasOlder: true,
      oldestRecordId: record.id,
      newestRecordId: record.id,
      loadedRecordCount: 1
    }
  };
  let state = openThreadReducer([], { type: "upsert-detail", thread: latest });
  state = openThreadReducer(state, {
    type: "merge-history",
    threadId: "thread-1",
    thread: {
      ...latest,
      records: [older],
      history: {
        hasOlder: false,
        oldestRecordId: older.id,
        newestRecordId: older.id,
        loadedRecordCount: 1
      }
    }
  });

  assert.deepEqual(state[0].records.map((item) => item.id), [older.id, record.id]);
  assert.equal(state[0].history?.hasOlder, false);
});

test("open thread reducer renders canonical server order despite skewed timestamps and delivery order", async () => {
  const openThreadReducer = await loadReducer();
  const user: CodexRecord = {
    id: "record-user",
    type: "event_msg",
    order: 1,
    timestamp: "2026-01-01T00:00:03.000Z",
    payload: { type: "user_message", message: "start generation" }
  };
  const commentary: CodexRecord = {
    id: "record-commentary",
    type: "event_msg",
    order: 2,
    timestamp: "2026-01-01T00:00:01.000Z",
    payload: { type: "agent_message", phase: "commentary", message: "confirmed" }
  };
  const tool: CodexRecord = {
    id: "record-tool",
    type: "response_item",
    order: 3,
    timestamp: "2026-01-01T00:00:02.000Z",
    payload: { type: "local_shell_call", call_id: "tool-1", status: "in_progress" }
  };
  let state = openThreadReducer([], { type: "upsert-detail", thread: detail("thread-1") });
  state = openThreadReducer(state, {
    type: "merge-stream",
    threadId: "thread-1",
    thread: { ...detail("thread-1"), messageCount: 3 },
    records: [tool, commentary, user]
  });

  assert.deepEqual(state[0].records.map((item) => item.id), [user.id, commentary.id, tool.id]);
});

test("open thread reducer preserves semantic transcript dedupe for historical batches", async () => {
  const openThreadReducer = await loadReducer();
  const liveRecord: CodexRecord = {
    id: "app:thread-1:turn-1:agent:live-id",
    type: "event_msg",
    timestamp: "2026-01-01T00:00:01.000Z",
    sourceThreadId: "thread-1",
    payload: { type: "agent_message", message: "same answer", phase: "final_answer" }
  };
  const snapshotRecord: CodexRecord = {
    ...liveRecord,
    id: "app:thread-1:turn-1:agent:snapshot-id"
  };
  let state = openThreadReducer([], {
    type: "upsert-detail",
    thread: { ...detail("thread-1"), records: [liveRecord], messageCount: 1 }
  });
  state = openThreadReducer(state, {
    type: "merge-stream",
    threadId: "thread-1",
    thread: { ...detail("thread-1"), messageCount: 1 },
    records: [snapshotRecord]
  });

  assert.deepEqual(state[0].records.map((item) => item.id), [snapshotRecord.id]);
});

test("open thread reducer replaces stale snapshots and applies command output deltas", async () => {
  const openThreadReducer = await loadReducer();
  const commandRecord: CodexRecord = {
    id: "command-record",
    type: "response_item",
    timestamp: "2026-01-01T00:00:01.000Z",
    payload: {
      type: "local_shell_call",
      call_id: "command-1",
      status: "in_progress",
      aggregated_output: "first"
    }
  };
  let state = openThreadReducer([], {
    type: "upsert-detail",
    thread: { ...detail("thread-1"), records: [record], messageCount: 1 }
  });
  state = openThreadReducer(state, {
    type: "merge-stream",
    threadId: "thread-1",
    thread: { ...detail("thread-1"), messageCount: 1 },
    records: [commandRecord],
    snapshot: {
      snapshotId: "snapshot-1",
      page: 0,
      reset: true,
      complete: true
    }
  });
  state = openThreadReducer(state, {
    type: "merge-stream",
    threadId: "thread-1",
    thread: { ...detail("thread-1"), messageCount: 1 },
    delta: {
      recordId: commandRecord.id,
      field: "aggregated_output",
      append: " second"
    }
  });

  assert.deepEqual(state[0].records.map((item) => item.id), [commandRecord.id]);
  assert.equal(
    (state[0].records[0].payload as { aggregated_output?: string }).aggregated_output,
    "first second"
  );
});

test("set-fields restores attachments without fabricating or replacing transcript records", async () => {
  const openThreadReducer = await loadReducer();
  const images = [{
    id: "image-1",
    file: { name: "image.png" } as File,
    name: "image.png",
    previewUrl: "blob:image"
  }];
  const texts = [{ id: "text-1", text: "notes" }];
  let state = openThreadReducer([], { type: "upsert-detail", thread: detail("thread-1") });
  state = openThreadReducer(state, { type: "append-record", threadId: "thread-1", record });
  state = openThreadReducer(state, {
    type: "set-fields",
    threadId: "thread-1",
    fields: {
      imageAttachments: images,
      textAttachments: texts
    }
  });

  assert.deepEqual(state[0].records, [record]);
  assert.deepEqual(state[0].imageAttachments, images);
  assert.deepEqual(state[0].textAttachments, texts);
});

test("conversation-only actions never create a workspace tab", async () => {
  const { openThreadReducer } = await import("../../src/web/openThreadReducer.js");
  const state = openThreadReducer([], {
    type: "append-record",
    threadId: "dialog-only-child",
    record
  });

  assert.deepEqual(state, []);
});

test("fresh non-CLI summaries clear a previous CLI source instead of retaining a stale badge", async () => {
  const reducer = await loadReducer();
  let state = reducer([], { type: "upsert-detail", thread: { ...detail("thread-1"), source: "cli" } });
  state = reducer(state, { type: "merge-stream", threadId: "thread-1", thread: { ...detail("thread-1"), source: "web" } });
  assert.equal(state[0].source, "web");
  state = reducer(state, { type: "merge-stream", threadId: "thread-1", thread: { ...detail("thread-1"), source: "cli" } });
  state = reducer(state, { type: "merge-stream", threadId: "thread-1", thread: detail("thread-1") });
  assert.equal(state[0].source, undefined);
});
