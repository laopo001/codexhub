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
