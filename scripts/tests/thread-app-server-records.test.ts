import assert from "node:assert/strict";
import test from "node:test";
import { recordToView } from "../../src/core/codexRecordView.js";
import { fileChanges } from "../../src/core/threadApprovalRecords.js";
import { ThreadHub } from "../../src/core/threadHub.js";
import {
  codexRecordFromAppServerItem,
  codexRecordFromAppServerUsage,
  withAppServerItemRecordTiming
} from "../../src/core/threadAppServerRecords.js";

test("file changes only consume current structured kind values", () => {
  assert.deepEqual(fileChanges([
    { path: "/tmp/current", kind: { type: "add" }, diff: "+current" },
    { path: "/tmp/legacy", kind: "delete", diff: "-legacy" }
  ]), [
    { path: "/tmp/current", kind: "add", diff: "+current" },
    { path: "/tmp/legacy", kind: "update", diff: "-legacy" }
  ]);
});

test("subAgentActivity remains lossless and gets a readable record view", () => {
  const item = {
    type: "subAgentActivity",
    id: "activity-1",
    kind: "started",
    agentThreadId: "child-thread-1",
    agentPath: "research_protocol"
  };

  const record = codexRecordFromAppServerItem(
    "root-thread",
    "turn-1",
    item,
    "2026-07-17T10:00:00.000Z"
  );

  assert.ok(record);
  assert.equal(record.type, "response_item");
  assert.deepEqual(record.payload, item);
  assert.equal(record.sourceThreadId, "root-thread");
  assert.equal(record.id, "app:root-thread:turn-1:item:subAgentActivity:activity-1");
  assert.deepEqual(recordToView(record), {
    id: record.id,
    role: "event",
    label: "subagent activity",
    text: "activity: started\nagent: research_protocol\nthread: child-thread-1",
    at: "2026-07-17T10:00:00.000Z",
    record
  });
});

test("collabAgentToolCall preserves Ultra child-agent settings", () => {
  const record = codexRecordFromAppServerItem("root-thread", "turn-2", {
    type: "collabAgentToolCall",
    id: "call-1",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: "root-thread",
    receiverThreadIds: ["child-thread-1"],
    prompt: "Research the new protocol",
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
    agentsStates: { "child-thread-1": { status: "completed", message: null } }
  });

  assert.ok(record);
  assert.deepEqual(record.payload, {
    type: "collab_agent_tool_call",
    call_id: "call-1",
    tool: "spawnAgent",
    status: "completed",
    sender_thread_id: "root-thread",
    receiver_thread_ids: ["child-thread-1"],
    prompt: "Research the new protocol",
    model: "gpt-5.6-sol",
    reasoning_effort: "ultra",
    agents_states: { "child-thread-1": { status: "completed", message: null } }
  });
});

test("mcpToolCall preserves the current app context fields", () => {
  const appContext = {
    connectorId: "calendar",
    linkId: "link-1",
    resourceUri: "calendar://events/1",
    appName: "Calendar",
    templateId: null,
    actionName: "create_event"
  };
  const record = codexRecordFromAppServerItem("root-thread", "turn-3", {
    type: "mcpToolCall",
    id: "mcp-1",
    server: "apps",
    tool: "create_event",
    status: "completed",
    arguments: { title: "Protocol review" },
    appContext,
    pluginId: "calendar-plugin",
    result: { content: [] },
    error: null
  });

  assert.ok(record);
  assert.deepEqual(record.payload, {
    type: "mcp_tool_call",
    server: "apps",
    tool: "create_event",
    arguments: { title: "Protocol review" },
    appContext,
    pluginId: "calendar-plugin",
    result: { content: [] },
    error: null,
    status: "completed"
  });
});

test("token usage reads current camelCase protocol fields into stable snake_case records", () => {
  const record = codexRecordFromAppServerUsage("thread-usage", "turn-usage", {
    last: {
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 150
    },
    total: {
      inputTokens: 240,
      cachedInputTokens: 40,
      outputTokens: 60,
      reasoningOutputTokens: 20,
      totalTokens: 300
    },
    modelContextWindow: 200_000
  });

  assert.ok(record);
  assert.deepEqual(record.payload, {
    type: "token_count",
    info: {
      last_token_usage: {
        input_tokens: 120,
        cached_input_tokens: 20,
        output_tokens: 30,
        reasoning_output_tokens: 10,
        total_tokens: 150
      },
      total_token_usage: {
        input_tokens: 240,
        cached_input_tokens: 40,
        output_tokens: 60,
        reasoning_output_tokens: 20,
        total_tokens: 300
      },
      model_context_window: 200_000
    }
  });
});

test("new and future ThreadItem variants fall back without losing wire fields", () => {
  const fixtures = [
    {
      type: "hookPrompt",
      id: "hook-1",
      fragments: [{ text: "Review this prompt", hookRunId: "hook-run-1" }]
    },
    {
      type: "sleep",
      id: "sleep-1",
      durationMs: 2500
    },
    {
      type: "enteredReviewMode",
      id: "review-enter-1",
      review: "uncommittedChanges"
    },
    {
      type: "exitedReviewMode",
      id: "review-exit-1",
      review: "uncommittedChanges"
    },
    {
      type: "futureThreadItem",
      id: "future-1",
      nested: { enabled: true, values: ["one", 2] }
    }
  ];

  for (const item of fixtures) {
    const record = codexRecordFromAppServerItem("thread-1", "turn-1", item);
    assert.ok(record, `${item.type} should produce a record`);
    assert.equal(record.type, "response_item");
    assert.deepEqual(record.payload, item);
    const view = recordToView(record);
    assert.ok(view, `${item.type} should remain visible`);
    assert.equal(view.label, item.type);
  }
});

test("items without a protocol type are still rejected", () => {
  assert.equal(codexRecordFromAppServerItem("thread-1", "turn-1", { id: "missing-type" }), null);
});

test("status-less ThreadItems retain lifecycle state across snapshot replacement", () => {
  const item = { type: "sleep", id: "sleep-live", durationMs: 1000 };
  const started = codexRecordFromAppServerItem(
    "thread-1",
    "turn-1",
    item,
    "2026-07-17T10:00:00.000Z",
    "inProgress"
  );
  assert.ok(started);
  assert.equal((started.payload as Record<string, unknown>).status, "in_progress");

  const completed = codexRecordFromAppServerItem(
    "thread-1",
    "turn-1",
    item,
    "2026-07-17T10:00:01.000Z",
    "completed"
  );
  assert.ok(completed);
  assert.equal((completed.payload as Record<string, unknown>).status, "completed");

  const snapshot = codexRecordFromAppServerItem("thread-1", "turn-1", item);
  const preserved = withAppServerItemRecordTiming(snapshot, { item, existing: completed });
  assert.ok(preserved);
  assert.equal((preserved.payload as Record<string, unknown>).status, "completed");
});

test("ThreadHub terminal snapshots finish live status-less items", () => {
  const hub = new ThreadHub();
  const sessionId = "snapshot-status-session";
  const threadId = "snapshot-status-thread";
  const turnId = "snapshot-status-turn";
  const item = { type: "sleep", id: "sleep-live", durationMs: 1000 };
  hub.registerSession({ sessionId, workingDirectory: "/tmp/snapshot-status" });
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: {
      method: "item/started",
      params: { threadId, turnId, item, startedAtMs: 1000 }
    }
  });
  const started = hub.getThread(threadId)?.records.find((candidate) =>
    candidate.id === `app:${threadId}:${turnId}:item:sleep:sleep-live`
  );
  assert.equal((started?.payload as Record<string, unknown>)?.status, "in_progress");
  assert.equal(started?.timestamp, "1970-01-01T00:00:01.000Z");
  assert.equal((started?.payload as Record<string, unknown>)?.started_at, "1970-01-01T00:00:01.000Z");

  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: [{
      id: turnId,
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000,
      items: [item]
    }]
  });

  const record = hub.getThread(threadId)?.records.find((candidate) =>
    candidate.id === `app:${threadId}:${turnId}:item:sleep:sleep-live`
  );
  assert.equal((record?.payload as Record<string, unknown>)?.status, "completed");
});

test("ThreadHub stale active snapshots do not regress completed status-less items", () => {
  const hub = new ThreadHub();
  const sessionId = "snapshot-race-session";
  const threadId = "snapshot-race-thread";
  const turnId = "snapshot-race-turn";
  const item = { type: "sleep", id: "sleep-race", durationMs: 1000 };
  hub.registerSession({ sessionId, workingDirectory: "/tmp/snapshot-race" });
  hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: {
      method: "item/completed",
      params: { threadId, turnId, item, completedAtMs: 2000 }
    }
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: [{
      id: turnId,
      status: "inProgress",
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null,
      items: [item]
    }]
  });

  const record = hub.getThread(threadId)?.records.find((candidate) =>
    candidate.id === `app:${threadId}:${turnId}:item:sleep:sleep-race`
  );
  assert.equal((record?.payload as Record<string, unknown>)?.status, "completed");
});
