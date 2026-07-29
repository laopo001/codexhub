import assert from "node:assert/strict";
import test from "node:test";
import { recordToView } from "../../src/core/codexRecordView.js";
import { fileChanges } from "../../src/core/threadApprovalRecords.js";
import { ThreadHub } from "../../src/core/threadHub.js";
import {
  codexRecordFromAppServerItem,
  codexRecordFromAppServerUsage,
  codexRecordsFromAppServerTurnLifecycle,
  withAppServerItemRecordTiming
} from "../../src/core/threadAppServerRecords.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";

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

test("status usage is accumulated independently for each returned app-server Turn", () => {
  const hub = new ThreadHub();
  const sessionId = "turn-usage-session";
  const threadId = "turn-usage-thread";
  hub.registerSession({
    sessionId,
    machineId: "turn-usage-machine",
    workingDirectory: "/tmp/turn-usage"
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_settings_changed",
    threadId
  });
  const emitUsage = (
    turnId: string,
    last: { inputTokens: number; outputTokens: number; totalTokens: number },
    total: { inputTokens: number; outputTokens: number; totalTokens: number }
  ) => hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: {
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        tokenUsage: { last, total, modelContextWindow: 200_000 }
      }
    }
  });

  emitUsage(
    "turn-1",
    { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
    { inputTokens: 80, outputTokens: 20, totalTokens: 100 }
  );
  emitUsage(
    "turn-1",
    { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
    { inputTokens: 120, outputTokens: 30, totalTokens: 150 }
  );
  emitUsage(
    "turn-2",
    { inputTokens: 60, outputTokens: 20, totalTokens: 80 },
    { inputTokens: 180, outputTokens: 50, totalTokens: 230 }
  );

  const statusRecords = (hub.getThread(threadId)?.records ?? []).filter((record) =>
    (record.payload as Record<string, unknown>).type === "status_usage"
  );
  assert.equal(statusRecords.length, 2);
  assert.deepEqual(statusRecords.map((record) => {
    const payload = record.payload as Record<string, unknown>;
    return {
      turnId: payload.turn_id,
      usage: payload.usage
    };
  }), [{
    turnId: "turn-1",
    usage: {
      input_tokens: 120,
      cached_input_tokens: 0,
      output_tokens: 30,
      reasoning_output_tokens: 0,
      total_tokens: 150
    }
  }, {
    turnId: "turn-2",
    usage: {
      input_tokens: 60,
      cached_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 0,
      total_tokens: 80
    }
  }]);
});

test("terminal Turn status produces the authoritative lifecycle record even without timing", () => {
  const completed = codexRecordsFromAppServerTurnLifecycle("thread-1", "turn-completed", {
    status: "completed",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    error: null
  });
  assert.deepEqual(completed.map((record) => (record.payload as Record<string, unknown>).type), ["task_complete"]);

  const failed = codexRecordsFromAppServerTurnLifecycle("thread-1", "turn-failed", {
    status: "failed",
    startedAt: null,
    completedAt: null,
    durationMs: 250,
    error: { message: "quota exhausted" }
  });
  assert.deepEqual(failed[0]?.payload, {
    type: "turn_aborted",
    turn_id: "turn-failed",
    status: "failed",
    reason: "quota exhausted",
    error: { message: "quota exhausted" },
    duration_ms: 250
  });

  const interrupted = codexRecordsFromAppServerTurnLifecycle("thread-1", "turn-interrupted", {
    status: "interrupted",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    error: null
  });
  assert.deepEqual(interrupted[0]?.payload, {
    type: "turn_aborted",
    turn_id: "turn-interrupted",
    status: "interrupted",
    reason: "Turn interrupted"
  });
});

test("context compaction preserves failed and interrupted protocol states", () => {
  const failed = codexRecordFromAppServerItem("thread-1", "turn-1", {
    type: "contextCompaction",
    id: "compact-failed",
    status: "failed"
  });
  const interrupted = codexRecordFromAppServerItem("thread-1", "turn-1", {
    type: "contextCompaction",
    id: "compact-interrupted",
    status: "interrupted"
  });
  assert.deepEqual(failed?.payload, {
    type: "context_compaction",
    status: "failed",
    message: "Compaction failed"
  });
  assert.deepEqual(interrupted?.payload, {
    type: "context_compaction",
    status: "interrupted",
    message: "Compaction interrupted"
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

test("ThreadHub coalesces current reasoning deltas into the completed reasoning item", () => {
  const hub = new ThreadHub();
  const sessionId = "reasoning-delta-session";
  const threadId = "reasoning-delta-thread";
  const turnId = "reasoning-delta-turn";
  const itemId = "reasoning-delta-item";
  const recordId = `app:${threadId}:${turnId}:item:reasoning:${itemId}`;
  hub.registerSession({ sessionId, workingDirectory: "/tmp/reasoning-delta" });
  const notify = (method: string, params: Record<string, unknown>) => hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: { method, params: { threadId, turnId, itemId, ...params } }
  });

  notify("item/started", {
    item: { type: "reasoning", id: itemId, summary: [], content: [] },
    startedAtMs: 1000
  });
  notify("item/reasoning/summaryPartAdded", { summaryIndex: 0 });
  notify("item/reasoning/summaryTextDelta", { summaryIndex: 0, delta: "Summary" });
  notify("item/reasoning/summaryTextDelta", { summaryIndex: 0, delta: " live" });
  notify("item/reasoning/textDelta", { contentIndex: 0, delta: "Detail one" });
  notify("item/reasoning/textDelta", { contentIndex: 1, delta: "Detail two" });

  let matches = hub.getThread(threadId)?.records.filter((record) => record.id === recordId) ?? [];
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.payload, {
    type: "reasoning",
    summary: ["Summary live"],
    content: "Detail one\nDetail two",
    status: "in_progress",
    started_at: "1970-01-01T00:00:01.000Z",
    content_parts: ["Detail one", "Detail two"]
  });

  notify("item/completed", {
    item: { type: "reasoning", id: itemId, summary: ["Authoritative summary"], content: ["Authoritative detail"] },
    completedAtMs: 2000
  });
  notify("item/reasoning/summaryTextDelta", { summaryIndex: 0, delta: " late" });
  matches = hub.getThread(threadId)?.records.filter((record) => record.id === recordId) ?? [];
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.payload, {
    type: "reasoning",
    summary: ["Authoritative summary"],
    content: "Authoritative detail",
    status: "completed",
    started_at: "1970-01-01T00:00:01.000Z",
    completed_at: "1970-01-01T00:00:02.000Z",
    duration_ms: 1000
  });
});

test("ThreadHub replaces experimental plan deltas with the authoritative completed plan", () => {
  const hub = new ThreadHub();
  const sessionId = "plan-delta-session";
  const threadId = "plan-delta-thread";
  const turnId = "plan-delta-turn";
  const itemId = "plan-delta-item";
  const recordId = `app:${threadId}:${turnId}:item:plan:${itemId}`;
  hub.registerSession({ sessionId, workingDirectory: "/tmp/plan-delta" });
  const notify = (method: string, params: Record<string, unknown>) => hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: { method, params: { threadId, turnId, itemId, ...params } }
  });

  notify("item/plan/delta", { delta: "Live " });
  notify("item/plan/delta", { delta: "plan" });
  let matches = hub.getThread(threadId)?.records.filter((record) => record.id === recordId) ?? [];
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.payload, { type: "plan", message: "Live plan", status: "in_progress" });

  notify("item/completed", {
    item: { type: "plan", id: itemId, text: "Authoritative plan" },
    completedAtMs: 2000
  });
  notify("item/plan/delta", { delta: " late" });
  matches = hub.getThread(threadId)?.records.filter((record) => record.id === recordId) ?? [];
  assert.equal(matches.length, 1);
  const completedPlan = matches[0]?.payload as Record<string, unknown>;
  assert.equal(completedPlan.type, "plan");
  assert.equal(completedPlan.message, "Authoritative plan");
  assert.equal(completedPlan.status, "completed");
});

test("ThreadHub applies file patch snapshots in place and lets completion win", () => {
  const hub = new ThreadHub();
  const sessionId = "file-delta-session";
  const threadId = "file-delta-thread";
  const turnId = "file-delta-turn";
  const itemId = "file-delta-item";
  const recordId = `app:${threadId}:${turnId}:item:fileChange:${itemId}`;
  hub.registerSession({ sessionId, workingDirectory: "/tmp/file-delta" });
  const notify = (method: string, params: Record<string, unknown>) => hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: { method, params: { threadId, turnId, itemId, ...params } }
  });

  notify("item/fileChange/patchUpdated", {
    changes: [{ path: "/tmp/first", kind: { type: "add" }, diff: "+first" }]
  });
  notify("item/fileChange/patchUpdated", {
    changes: [{ path: "/tmp/latest", kind: { type: "update" }, diff: "+latest" }]
  });
  let matches = hub.getThread(threadId)?.records.filter((record) => record.id === recordId) ?? [];
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.payload, {
    type: "file_change",
    changes: [{ path: "/tmp/latest", kind: "update", diff: "+latest" }],
    status: "in_progress"
  });

  notify("item/completed", {
    item: {
      type: "fileChange",
      id: itemId,
      changes: [{ path: "/tmp/final", kind: { type: "delete" }, diff: "-final" }],
      status: "completed"
    },
    completedAtMs: 2000
  });
  matches = hub.getThread(threadId)?.records.filter((record) => record.id === recordId) ?? [];
  assert.equal(matches.length, 1);
  const completedFileChange = matches[0]?.payload as Record<string, unknown>;
  assert.deepEqual({
    type: completedFileChange.type,
    changes: completedFileChange.changes,
    status: completedFileChange.status
  }, {
    type: "file_change",
    changes: [{ path: "/tmp/final", kind: "delete", diff: "-final" }],
    status: "completed"
  });
});

test("ThreadHub keeps MCP progress on one live item and drops it at authoritative completion", () => {
  const hub = new ThreadHub();
  const sessionId = "mcp-progress-session";
  const threadId = "mcp-progress-thread";
  const turnId = "mcp-progress-turn";
  const itemId = "mcp-progress-item";
  const recordId = `app:${threadId}:${turnId}:item:mcpToolCall:${itemId}`;
  hub.registerSession({ sessionId, workingDirectory: "/tmp/mcp-progress" });
  const notify = (method: string, params: Record<string, unknown>) => hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: { method, params: { threadId, turnId, itemId, ...params } }
  });
  const item = {
    type: "mcpToolCall",
    id: itemId,
    server: "apps",
    tool: "calendar.read",
    status: "inProgress",
    arguments: { range: "today" },
    appContext: null,
    pluginId: null,
    result: null,
    error: null
  };

  notify("item/started", { item, startedAtMs: 1000 });
  notify("item/mcpToolCall/progress", { message: "Connecting" });
  notify("item/mcpToolCall/progress", { message: "Connecting" });
  notify("item/mcpToolCall/progress", { message: "Reading events" });
  let matches = hub.getThread(threadId)?.records.filter((record) => record.id === recordId) ?? [];
  assert.equal(matches.length, 1);
  assert.deepEqual((matches[0]?.payload as Record<string, unknown>)?.progress_messages, ["Connecting", "Reading events"]);
  assert.match(recordToView(matches[0]!)?.text ?? "", /Reading events/);

  notify("item/completed", {
    item: { ...item, status: "completed", result: { content: [] } },
    completedAtMs: 2000
  });
  notify("item/mcpToolCall/progress", { message: "late" });
  matches = hub.getThread(threadId)?.records.filter((record) => record.id === recordId) ?? [];
  assert.equal(matches.length, 1);
  assert.equal("progress_messages" in (matches[0]?.payload as Record<string, unknown>), false);
  assert.equal((matches[0]?.payload as Record<string, unknown>)?.status, "completed");
});

test("ThreadHub coalesces current turn plan and diff projections until the completed snapshot", () => {
  const hub = new ThreadHub();
  const sessionId = "turn-projection-session";
  const threadId = "turn-projection-thread";
  const turnId = "turn-projection-turn";
  const planRecordId = `app:${threadId}:${turnId}:event:turn_plan_updated`;
  const diffRecordId = `app:${threadId}:${turnId}:event:turn_diff_updated`;
  hub.registerSession({ sessionId, workingDirectory: "/tmp/turn-projection" });
  const notify = (method: string, params: Record<string, unknown>) => hub.applySessionEvent(sessionId, {
    type: "thread_event",
    threadId,
    message: { method, params: { threadId, turnId, ...params } }
  });

  notify("turn/plan/updated", {
    explanation: "First",
    plan: [{ step: "Inspect", status: "pending" }]
  });
  notify("turn/plan/updated", {
    explanation: "Current",
    plan: [
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "inProgress" }
    ]
  });
  notify("turn/diff/updated", { diff: "--- old\n+++ first" });
  notify("turn/diff/updated", { diff: "--- old\n+++ current" });

  const liveRecords = hub.getThread(threadId)?.records ?? [];
  assert.equal(liveRecords.filter((record) => record.id === planRecordId).length, 1);
  assert.equal(liveRecords.filter((record) => record.id === diffRecordId).length, 1);
  assert.deepEqual(liveRecords.find((record) => record.id === planRecordId)?.payload, {
    type: "turn_plan_updated",
    explanation: "Current",
    plan: [
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "in_progress" }
    ],
    message: "Current\n[x] Inspect\n[~] Implement"
  });
  assert.deepEqual(liveRecords.find((record) => record.id === diffRecordId)?.payload, {
    type: "turn_diff_updated",
    diff: "--- old\n+++ current",
    message: "--- old\n+++ current"
  });

  notify("turn/completed", {
    turn: {
      id: turnId,
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1000,
      items: []
    }
  });
  notify("turn/plan/updated", {
    explanation: "late",
    plan: [{ step: "Late", status: "pending" }]
  });
  notify("turn/diff/updated", { diff: "late" });
  const completedRecords = hub.getThread(threadId)?.records ?? [];
  assert.equal(completedRecords.some((record) => record.id === planRecordId), false);
  assert.equal(completedRecords.some((record) => record.id === diffRecordId), false);
});

test("ThreadHub rejects stable approval decisions omitted by app-server", async () => {
  const hub = new ThreadHub();
  const sessionId = "approval-decisions-session";
  const threadId = "approval-decisions-thread";
  hub.registerSession({ sessionId, workingDirectory: "/tmp/approval-decisions" });
  hub.applySessionEvent(sessionId, {
    type: "approval_request",
    threadId,
    approval: {
      approvalId: "approval-current",
      method: "item/commandExecution/requestApproval",
      requestId: 1,
      kind: "command_execution",
      threadId,
      turnId: "approval-turn",
      itemId: "approval-item",
      createdAt: "2026-07-17T10:00:00.000Z",
      availableDecisions: ["approve", "deny"],
      params: { threadId, turnId: "approval-turn", itemId: "approval-item", command: "echo current" }
    }
  });

  const record = hub.getThread(threadId)?.records.find((candidate) => {
    const payload = candidate.payload as Record<string, unknown>;
    return (payload.approval as Record<string, unknown> | undefined)?.approvalId === "approval-current";
  });
  assert.deepEqual((record?.payload as { approval?: { availableDecisions?: unknown } })?.approval?.availableDecisions, [
    "approve",
    "deny"
  ]);
  await assert.rejects(
    hub.respondToApproval(threadId, "approval-current", "approve_for_session"),
    /decision is not available/
  );
});

test("ThreadHub preserves pending command approval across active turn snapshots", () => {
  const hub = new ThreadHub();
  const sessionId = "approval-snapshot-session";
  const threadId = "approval-snapshot-thread";
  const turnId = "approval-snapshot-turn";
  const itemId = "approval-snapshot-item";
  const recordId = `app:${threadId}:${turnId}:item:commandExecution:${itemId}`;
  hub.registerSession({ sessionId, workingDirectory: "/tmp/approval-snapshot" });
  hub.applySessionEvent(sessionId, {
    type: "approval_request",
    threadId,
    approval: {
      approvalId: "approval-snapshot-current",
      method: "item/commandExecution/requestApproval",
      requestId: 2,
      kind: "command_execution",
      threadId,
      turnId,
      itemId,
      createdAt: "2026-07-24T02:42:39.654Z",
      params: {
        threadId,
        turnId,
        itemId,
        command: "rm -rf /tmp/approval-snapshot"
      }
    }
  });

  const assertPendingApproval = () => {
    const matchingRecords = hub.getThread(threadId)?.records.filter((record) => record.id === recordId) ?? [];
    assert.equal(matchingRecords.length, 1);
    const payload = matchingRecords[0].payload as Record<string, unknown>;
    const approval = payload.approval as Record<string, unknown>;
    assert.equal(payload.status, "pending_approval");
    assert.equal(approval.approvalId, "approval-snapshot-current");
    assert.equal(approval.status, "pending");
    assert.equal(recordToView(matchingRecords[0])?.status, "pending");
  };

  assertPendingApproval();
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: [{
      id: turnId,
      status: "inProgress",
      items: [{
        id: itemId,
        type: "commandExecution",
        status: "inProgress",
        command: "/usr/bin/zsh -lc 'rm -rf /tmp/approval-snapshot'",
        aggregatedOutput: "",
        exitCode: null
      }]
    }]
  });
  assertPendingApproval();

  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: [{
      id: turnId,
      status: "inProgress",
      items: []
    }]
  });
  assertPendingApproval();

  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: [{
      id: turnId,
      status: "completed",
      items: [{
        id: itemId,
        type: "commandExecution",
        status: "completed",
        command: "/usr/bin/zsh -lc 'rm -rf /tmp/approval-snapshot'",
        aggregatedOutput: "",
        exitCode: 0
      }]
    }]
  });
  const completedRecord = hub.getThread(threadId)?.records.find((record) => record.id === recordId);
  assert.equal((completedRecord?.payload as Record<string, unknown>)?.status, "completed");
  assert.equal((completedRecord?.payload as Record<string, unknown>)?.approval, undefined);
});

test("ThreadHub ingests real paginated turn history in bounded historical batches", () => {
  const hub = new ThreadHub();
  const sessionId = "large-snapshot-session";
  const threadId = "large-snapshot-thread";
  hub.registerSession({ sessionId, workingDirectory: "/tmp/large-snapshot" });
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: []
  });
  const events: Array<{
    kind: string;
    historical?: boolean;
    record?: unknown;
    records?: unknown[];
  }> = [];
  const unsubscribe = hub.subscribe(
    threadId,
    hub.getThread(threadId)?.lastSeq ?? 0,
    (event) => events.push(event)
  );
  const turns = Array.from({ length: 5_000 }, (_, index) => ({
    id: `turn-${index}`,
    status: "completed",
    startedAt: index * 2 + 1,
    completedAt: index * 2 + 2,
    items: [
      {
        type: "userMessage",
        id: `user-${index}`,
        content: [{ type: "text", text: `question ${index}` }]
      },
      {
        type: "agentMessage",
        id: `agent-${index}`,
        text: `answer ${index}`,
        phase: "final_answer"
      }
    ]
  }));

  const startedAt = performance.now();
  for (let page = 0; page < 100; page += 1) {
    const end = turns.length - page * 50;
    hub.applySessionEvent(sessionId, {
      type: "thread_turns_snapshot",
      threadId,
      turns: turns.slice(end - 50, end),
      snapshotId: "large-snapshot-1",
      page,
      head: page === 0,
      complete: page === 99
    });
  }
  const elapsedMs = performance.now() - startedAt;
  const detail = hub.getThread(threadId);

  assert.equal(detail?.records.length, 20_000);
  assert.equal(detail?.messageCount, 20_000);
  assert.ok(elapsedMs < 15_000, `large snapshot took ${Math.round(elapsedMs)}ms`);
  assert.equal(events.length, 100);
  assert.ok(events.every((event) =>
    event.kind === "thread"
    && event.historical === true
    && event.record === undefined
    && (event.records?.length ?? 0) <= 500
  ));

  for (let page = 0; page < 100; page += 1) {
    const end = turns.length - page * 50;
    hub.applySessionEvent(sessionId, {
      type: "thread_turns_snapshot",
      threadId,
      turns: turns.slice(end - 50, end),
      snapshotId: "large-snapshot-2",
      page,
      head: page === 0,
      complete: page === 99
    });
  }
  assert.equal(hub.getThread(threadId)?.records.length, 20_000);
  const maxHistoricalOrder = Math.max(...(hub.getThread(threadId)?.records.map((record) => record.order ?? 0) ?? []));
  const deltaStartedAt = performance.now();
  for (let index = 0; index < 1_000; index += 1) {
    hub.applySessionEvent(sessionId, {
      type: "thread_event",
      threadId,
      message: {
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId: "live-turn",
          itemId: "live-agent",
          delta: "x"
        }
      }
    });
  }
  const deltaElapsedMs = performance.now() - deltaStartedAt;
  const liveRecord = hub.getThread(threadId)?.records.find((candidate) =>
    candidate.id === `app:${threadId}:live-turn:agent:live-agent`
  );
  assert.equal((liveRecord?.payload as { message?: string })?.message?.length, 1_000);
  assert.ok((liveRecord?.order ?? 0) > maxHistoricalOrder);
  assert.ok(deltaElapsedMs < 5_000, `large-thread deltas took ${Math.round(deltaElapsedMs)}ms`);
  unsubscribe();
});

test("ThreadHub streams command output as deltas without retaining cumulative record versions", () => {
  const hub = new ThreadHub();
  const sessionId = "command-delta-session";
  const threadId = "command-delta-thread";
  const turnId = "command-delta-turn";
  const itemId = "command-delta-item";
  hub.registerSession({ sessionId, workingDirectory: "/tmp/command-delta" });
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: []
  });

  let recordEvents = 0;
  let deltaEvents = 0;
  let streamedBytes = 0;
  const unsubscribe = hub.subscribe(
    threadId,
    hub.getThread(threadId)?.lastSeq ?? 0,
    (event) => {
      if (event.kind === "record") recordEvents += 1;
      if (event.kind === "record_delta") {
        deltaEvents += 1;
        streamedBytes += Buffer.byteLength(JSON.stringify(event));
        assert.equal(event.record, undefined);
        assert.equal(event.delta?.recordId, `app:${threadId}:${turnId}:item:commandExecution:${itemId}`);
      }
    }
  );
  const notify = (method: string, params: Record<string, unknown>) => {
    hub.applySessionEvent(sessionId, {
      type: "thread_event",
      threadId,
      heartbeat: false,
      message: {
        method,
        params: { threadId, turnId, ...params }
      }
    });
  };
  notify("item/started", {
    item: {
      id: itemId,
      type: "commandExecution",
      status: "inProgress",
      command: "build",
      aggregatedOutput: "",
      exitCode: null
    }
  });

  const chunk = "x".repeat(8 * 1024);
  for (let index = 0; index < 1_000; index += 1) {
    notify("item/commandExecution/outputDelta", { itemId, delta: chunk });
  }

  const detail = hub.getThread(threadId);
  const commandRecord = detail?.records.find((record) =>
    record.id === `app:${threadId}:${turnId}:item:commandExecution:${itemId}`
  );
  assert.equal((commandRecord?.payload as { aggregated_output?: string })?.aggregated_output?.length, 8 * 1024 * 1_000);
  assert.equal(recordEvents, 1);
  assert.equal(deltaEvents, 1_000);
  assert.ok(streamedBytes < 12 * 1024 * 1024, `delta stream serialized ${streamedBytes} bytes`);
  assert.equal("events" in ((hub as unknown as { threads: Map<string, object> }).threads.get(threadId) ?? {}), false);

  notify("item/completed", {
    completedAtMs: Date.now(),
    item: {
      id: itemId,
      type: "commandExecution",
      status: "completed",
      command: "build",
      aggregatedOutput: chunk.repeat(1_000),
      exitCode: 0
    }
  });
  const completedRecord = hub.getThread(threadId)?.records.find((candidate) =>
    candidate.id === `app:${threadId}:${turnId}:item:commandExecution:${itemId}`
  );
  assert.equal(recordEvents, 2);
  assert.equal((completedRecord?.payload as { status?: string })?.status, "completed");
  assert.equal((completedRecord?.payload as { aggregated_output?: string })?.aggregated_output?.length, 8 * 1024 * 1_000);
  unsubscribe();
});

test("ThreadHub replaces a stale cursor with a canonical records snapshot", () => {
  const hub = new ThreadHub();
  const sessionId = "snapshot-resume-session";
  const threadId = "snapshot-resume-thread";
  hub.registerSession({ sessionId, workingDirectory: "/tmp/snapshot-resume" });
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: [{
      id: "turn-1",
      status: "completed",
      items: [{
        id: "agent-1",
        type: "agentMessage",
        text: "current",
        phase: "final_answer"
      }]
    }]
  });
  const current = hub.getThread(threadId);
  assert.ok(current);

  const exactEvents: unknown[] = [];
  const unsubscribeExact = hub.subscribe(threadId, current.lastSeq, (event) => exactEvents.push(event));
  assert.equal(exactEvents.length, 0);
  unsubscribeExact();

  const staleEvents: Array<{
    seq: number;
    records?: CodexRecord[];
    snapshot?: { snapshotId: string; page: number; reset: boolean; complete: boolean };
  }> = [];
  const unsubscribeStale = hub.subscribe(threadId, current.lastSeq + 100, (event) => staleEvents.push(event));
  assert.equal(staleEvents.length, 1);
  assert.equal(staleEvents[0].seq, current.lastSeq);
  assert.deepEqual(staleEvents[0].snapshot, {
    snapshotId: staleEvents[0].snapshot?.snapshotId,
    page: 0,
    reset: true,
    complete: true
  });
  assert.deepEqual(staleEvents[0].records, current.records);
  unsubscribeStale();
});

test("ThreadHub orders untimed history across pages and ignores stale retry pages", () => {
  const hub = new ThreadHub();
  const sessionId = "untimed-history-session";
  const threadId = "untimed-history-thread";
  hub.registerSession({ sessionId, workingDirectory: "/tmp/untimed-history" });
  const turn = (index: number) => ({
    id: `turn-${index}`,
    status: "completed",
    startedAt: null,
    completedAt: null,
    items: [{
      type: "userMessage",
      id: `user-${index}`,
      content: [{ type: "text", text: `question ${index}` }]
    }]
  });

  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: [turn(3), turn(4)],
    snapshotId: "untimed-snapshot-1",
    page: 0,
    head: true,
    complete: false
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: [turn(99)],
    snapshotId: "stale-snapshot",
    page: 1,
    head: false,
    complete: true
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_turns_snapshot",
    threadId,
    turns: [turn(1), turn(2)],
    snapshotId: "untimed-snapshot-1",
    page: 1,
    head: false,
    complete: true
  });

  const userTurnIds = hub.getThread(threadId)?.records
    .filter((record) => record.id.includes(":user:"))
    .map((record) => record.id.split(":")[2]);
  assert.deepEqual(userTurnIds, ["turn-1", "turn-2", "turn-3", "turn-4"]);
  assert.equal(userTurnIds?.includes("turn-99"), false);
});
