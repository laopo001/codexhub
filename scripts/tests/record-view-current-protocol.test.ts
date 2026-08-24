import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  recordsToViews,
  recordToView,
  subagentAssignmentForChild
} from "../../src/core/codexRecordView.js";
import { compactToolViews } from "../../src/shared/compactRecordViews.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import { SubagentActivityMessage } from "../../src/web/SubagentActivityMessage.js";
import { resolveSubagentThreadTarget } from "../../src/web/helpers/subagentThreads.js";

const compactionRecord = (id: string, type: string): CodexRecord => ({
  id,
  type: "event_msg",
  payload: { type, status: "completed" }
});

test("record views only special-case the normalized context_compaction event", () => {
  const current = compactionRecord("current", "context_compaction");
  const oldAliases = [
    compactionRecord("old-context-compacted", "context_compacted"),
    compactionRecord("old-compacted", "compacted")
  ];

  assert.equal(recordToView(current)?.label, "context_compaction");

  for (const record of oldAliases) {
    const type = (record.payload as { type: string }).type;
    assert.equal(recordToView(record)?.label, type);
  }
});

test("compact views only coalesce normalized context_compaction events", () => {
  const currentViews = [
    recordToView(compactionRecord("current-1", "context_compaction")),
    recordToView(compactionRecord("current-2", "context_compaction"))
  ].filter((view) => view !== null);
  assert.equal(compactToolViews(currentViews).length, 1);

  const mixedViews = [
    recordToView(compactionRecord("current", "context_compaction")),
    recordToView(compactionRecord("old", "compacted"))
  ].filter((view) => view !== null);
  assert.equal(compactToolViews(mixedViews).length, 2);
});

test("Goal snapshots mark lifecycle transitions without treating every update as start or end", async () => {
  const makeGoalRecord = (
    id: string,
    objective: string,
    options: {
      status?: string;
      timeUsedSeconds?: number;
      updatedAt?: number;
      tokenBudget?: number | null;
      createdAt?: number;
    } = {}
  ): CodexRecord => ({
    id,
    timestamp: new Date((options.updatedAt ?? 1_754_131_200) * 1000).toISOString(),
    type: "event_msg",
    sourceThreadId: "goal-thread",
    payload: {
      type: "thread_goal_updated",
      threadId: "goal-thread",
      goal: {
        threadId: "goal-thread",
        objective,
        status: options.status ?? "active",
        tokenBudget: options.tokenBudget ?? null,
        tokensUsed: options.timeUsedSeconds ?? 10,
        timeUsedSeconds: options.timeUsedSeconds ?? 10,
        createdAt: options.createdAt ?? 1_754_131_200,
        updatedAt: options.updatedAt ?? 1_754_131_200
      }
    }
  });
  const records = [
    makeGoalRecord("goal-start", "finish the implementation"),
    makeGoalRecord("goal-progress", "finish the implementation", { timeUsedSeconds: 30, updatedAt: 1_754_131_260 }),
    makeGoalRecord("goal-paused", "finish the implementation", { status: "paused", updatedAt: 1_754_131_320 }),
    makeGoalRecord("goal-paused-progress", "finish the implementation", { status: "paused", timeUsedSeconds: 40, updatedAt: 1_754_131_380 }),
    makeGoalRecord("goal-resumed", "finish the implementation", { updatedAt: 1_754_131_440 }),
    makeGoalRecord("goal-edited", "finish the implementation and tests", { tokenBudget: 2_000, updatedAt: 1_754_131_500 }),
    makeGoalRecord("goal-complete", "finish the implementation and tests", { status: "complete", tokenBudget: 2_000, updatedAt: 1_754_131_560 }),
    makeGoalRecord("goal-complete-progress", "finish the implementation and tests", { status: "complete", tokenBudget: 2_000, timeUsedSeconds: 90, updatedAt: 1_754_131_620 }),
    makeGoalRecord("next-goal-start", "ship the next change", { createdAt: 1_754_131_680, updatedAt: 1_754_131_680 })
  ];

  assert.deepEqual(recordsToViews(records).map((view) => ({ role: view.role, label: view.label, text: view.text })), [
    { role: "user", label: "goal start", text: "finish the implementation" },
    { role: "user", label: "goal paused", text: "finish the implementation" },
    { role: "user", label: "goal resumed", text: "finish the implementation" },
    { role: "user", label: "goal update", text: "finish the implementation and tests" },
    { role: "user", label: "goal end", text: "finish the implementation and tests" },
    { role: "user", label: "goal start", text: "ship the next change" }
  ]);

  const reopenedRecords = [
    makeGoalRecord("goal-complete-snapshot", "finish the implementation and tests", {
      status: "complete",
      tokenBudget: 2_000,
      timeUsedSeconds: 90,
      updatedAt: 1_754_131_560
    })
  ];
  assert.deepEqual(
    recordsToViews(reopenedRecords).map((view) => ({ label: view.label, text: view.text, at: view.at })),
    [
      {
        label: "goal start",
        text: "finish the implementation and tests",
        at: "2025-08-02T10:40:00.000Z"
      },
      {
        label: "goal end",
        text: "finish the implementation and tests",
        at: "2025-08-02T10:46:00.000Z"
      }
    ]
  );
  assert.equal(compactToolViews(recordsToViews(records)).every((view) => view.role === "user"), true);

  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  try {
    const { isSimpleMainView, isSimpleRecord } = await import("../../src/web/helpers/records.js");
    assert.equal(isSimpleRecord(records[0]), true);
    assert.equal(isSimpleMainView(recordsToViews([records[0]])[0]), true);
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test("subagent activities keep one semantic view in Simple mode", () => {
  const kinds = [
    ["started", "Started"],
    ["interacted", "Interacted"],
    ["interrupted", "Interrupted"]
  ] as const;

  for (const [kind, statusText] of kinds) {
    const record: CodexRecord = {
      id: `subagent-${kind}`,
      timestamp: "2026-08-02T13:09:16.123Z",
      type: "response_item",
      payload: {
        type: "subAgentActivity",
        kind,
        agentPath: "/root/readme_accuracy",
        agentThreadId: "019fc297-cc2c-7cc3-bccc-4dea01abcd42"
      }
    };
    const compact = recordToView(record);

    assert.ok(compact);
    assert.equal(compact.label, "subagent");
    assert.equal(compact.text, `${statusText} · readme_accuracy`);
    assert.equal(compact.statusText, statusText);
    assert.deepEqual(compact.subagentActivity, {
      kind,
      agentPath: "/root/readme_accuracy",
      agentThreadId: "019fc297-cc2c-7cc3-bccc-4dea01abcd42"
    });
    assert.deepEqual(compactToolViews([compact]), [compact]);
  }
});

test("subagent activity UI hides protocol fields and exposes the child thread action", () => {
  const threadId = "019fc297-cc2c-7cc3-bccc-4dea01abcd42";
  const html = renderToStaticMarkup(createElement(SubagentActivityMessage, {
    activity: {
      kind: "started",
      agentPath: "/root/readme_accuracy",
      agentThreadId: threadId,
      assignment: {
        initialMessage: "Review the README against the current product behavior",
        model: "gpt-5.6-terra",
        reasoningEffort: "max"
      }
    },
    statusLabel: "Started",
    timestampText: "21:09",
    timestampTitle: "2026-08-02 21:09",
    onOpenThread: () => undefined
  }));
  const visibleText = html.replace(/<[^>]+>/g, "");

  assert.match(visibleText, /Subagentreadme_accuracyStartedView21:09Requestedgpt-5\.6-terraMaxTaskReview the README/);
  assert.doesNotMatch(visibleText, /019fc297|activity:|agent:|thread:/);
  assert.match(html, /aria-label="View readme_accuracy subagent thread"/);
  assert.match(html, new RegExp(`title="View subagent thread ${threadId}"`));
  assert.match(html, /title="Requested model: gpt-5\.6-terra"/);
  assert.match(html, /title="Review the README against the current product behavior"/);
});

test("subagent activities join their spawn assignment in Simple mode", () => {
  const parentThreadId = "parent-thread";
  const turnId = "turn-1";
  const childThreadId = "child-thread";
  const activity: CodexRecord = {
    id: `app:${parentThreadId}:${turnId}:item:subAgentActivity:activity-1`,
    timestamp: "2026-08-02T13:09:16.123Z",
    type: "response_item",
    sourceThreadId: parentThreadId,
    payload: {
      type: "subAgentActivity",
      kind: "started",
      agentPath: "/root/readme_accuracy",
      agentThreadId: childThreadId
    }
  };
  const spawn: CodexRecord = {
    id: `app:${parentThreadId}:${turnId}:item:collabAgentToolCall:spawn-1`,
    timestamp: "2026-08-02T13:09:17.123Z",
    type: "response_item",
    sourceThreadId: parentThreadId,
    payload: {
      type: "collab_agent_tool_call",
      call_id: "spawn-1",
      tool: "spawnAgent",
      status: "completed",
      receiver_thread_ids: [childThreadId, "second-child"],
      prompt: "Review the README against the current product behavior",
      model: "gpt-5.6-terra",
      reasoning_effort: "max"
    }
  };
  const unrelated: CodexRecord = {
    ...activity,
    id: `app:${parentThreadId}:${turnId}:item:subAgentActivity:activity-2`,
    payload: {
      type: "subAgentActivity",
      kind: "started",
      agentPath: "/root/unrelated",
      agentThreadId: "unrelated-child"
    }
  };
  const otherTurn: CodexRecord = {
    ...activity,
    id: `app:${parentThreadId}:turn-2:item:subAgentActivity:activity-3`
  };
  const otherParent: CodexRecord = {
    ...activity,
    id: `app:other-parent:${turnId}:item:subAgentActivity:activity-4`,
    sourceThreadId: "other-parent"
  };
  // The activity intentionally arrives before the spawn item to cover live/history ordering.
  const records = [activity, unrelated, otherTurn, otherParent, spawn];
  const simple = recordsToViews(records).find((view) => view.id === activity.id);
  const compact = compactToolViews(recordsToViews(records)).find((view) => view.id === activity.id);
  const expectedAssignment = {
    initialMessage: "Review the README against the current product behavior",
    model: "gpt-5.6-terra",
    reasoningEffort: "max"
  };

  assert.deepEqual(simple?.subagentActivity?.assignment, expectedAssignment);
  assert.deepEqual(compact?.subagentActivity?.assignment, expectedAssignment);
  assert.deepEqual(subagentAssignmentForChild(records, childThreadId), expectedAssignment);
  assert.equal(recordsToViews(records).find((view) => view.id === unrelated.id)?.subagentActivity?.assignment, undefined);
  assert.equal(recordsToViews(records).find((view) => view.id === otherTurn.id)?.subagentActivity?.assignment, undefined);
  assert.equal(recordsToViews(records).find((view) => view.id === otherParent.id)?.subagentActivity?.assignment, undefined);
});

test("subagent thread actions follow the visible parent thread machine", () => {
  const childThreadId = "child-thread";
  const target = resolveSubagentThreadTarget("parent-a", childThreadId, [{
    threadId: "parent-a",
    workingDirectory: "/projects/a",
    runtime: { machineId: "machine-a" }
  }, {
    threadId: childThreadId,
    workingDirectory: "/projects/b",
    runtime: { machineId: "machine-b" }
  }], [{
    machineId: "machine-b",
    online: true,
    threads: [{ threadId: childThreadId }]
  }, {
    machineId: "machine-a",
    online: true,
    threads: []
  }]);

  assert.deepEqual(target, {
    machineId: "machine-a",
    workingDirectory: "/projects/a",
    online: true,
    attached: false
  });
});

test("Plan mode output renders as the final Codex answer in Simple mode", async () => {
  const plan: CodexRecord = {
    id: "app:thread-1:turn-1:item:plan:plan-1",
    timestamp: "2026-07-24T07:23:18.397Z",
    type: "event_msg",
    payload: {
      type: "plan",
      message: "# Implementation plan\n\n- Fix the projection.",
      status: "completed"
    },
    sourceThreadId: "thread-1"
  };
  const expected = {
    role: "codex",
    label: "final_answer",
    text: "# Implementation plan\n\n- Fix the projection.",
    status: "completed",
    canFork: true
  };

  assert.deepEqual(recordToView(plan), {
    id: plan.id,
    at: plan.timestamp,
    statusText: "completed",
    record: plan,
    ...expected
  });

  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { isSimpleRecord } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });
  assert.equal(isSimpleRecord(plan), true);
});

test("interrupted turns render as a neutral terminal state rather than a failure", () => {
  const records: CodexRecord[] = [{
    id: "turn-start",
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-1" }
  }, {
    id: "turn-interrupted",
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: "turn-1", status: "interrupted" }
  }];
  const views = records.map(recordToView).filter((view) => view !== null);
  const [turn] = compactToolViews(views);

  assert.equal(turn?.text, "Turn interrupted");
  assert.equal(turn?.status, undefined);
});

test("interrupted turns use a neutral Web activity status", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { activityStatusFromRecord } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  assert.deepEqual(activityStatusFromRecord({
    id: "turn-interrupted",
    type: "event_msg",
    payload: { type: "turn_aborted", turn_id: "turn-1", status: "interrupted" }
  }), {
    key: "turn",
    label: "Interrupted",
    status: undefined,
    at: undefined,
    text: "Turn interrupted"
  });
});

test("structured app-server plans become one expandable Status item with the current step summary", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { activityStatusesFromRecords } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  const records: CodexRecord[] = [{
    id: "plan-update-1",
    timestamp: "2026-07-19T02:00:01.000Z",
    type: "event_msg",
    payload: {
      type: "turn_plan_updated",
      plan: [
        { step: "Inspect the app-server plan", status: "completed" },
        { step: "Connect Plan to Status", status: "inProgress" },
        { step: "Verify in the browser", status: "pending" }
      ]
    }
  }, {
    id: "plan-update-2",
    timestamp: "2026-07-19T02:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "turn_plan_updated",
      plan: [
        { step: "Inspect the app-server plan", status: "completed" },
        { step: "Connect Plan to Status", status: "inProgress" },
        { step: "Verify in the browser", status: "pending" },
        { step: "Review the final diff", status: "pending" }
      ]
    }
  }];

  const planStatuses = activityStatusesFromRecords(records).filter((status) => status.key === "plan");
  assert.equal(planStatuses.length, 1);
  assert.deepEqual(planStatuses[0], {
    key: "plan",
    label: "Plan",
    status: "in_progress",
    at: "2026-07-19T02:00:02.000Z",
    text: "Connect Plan to Status",
    summaryText: "Connect Plan to Status · 2/4",
    steps: [
      { step: "Inspect the app-server plan", status: "completed" },
      { step: "Connect Plan to Status", status: "in_progress" },
      { step: "Verify in the browser", status: "pending" },
      { step: "Review the final diff", status: "pending" }
    ]
  });
});

test("Plan Status rows stay compact until expanded and then render every step", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { ActivityStatusRows } = await import("../../src/web/helpers/components.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });
  const status = {
    key: "plan",
    label: "Plan",
    status: "in_progress" as const,
    text: "Connect Plan to Status",
    summaryText: "Connect Plan to Status · 2/4",
    steps: [
      { step: "Inspect the app-server plan", status: "completed" as const },
      { step: "Connect Plan to Status", status: "in_progress" as const },
      { step: "Verify in the browser", status: "pending" as const },
      { step: "Review the final diff", status: "pending" as const }
    ]
  };

  const collapsed = renderToStaticMarkup(createElement(ActivityStatusRows, {
    statuses: [status],
    expandedKeys: new Set<string>(),
    onToggle: () => undefined
  }));
  assert.match(collapsed, /Connect Plan to Status/);
  assert.doesNotMatch(collapsed, /Inspect the app-server plan/);
  assert.match(collapsed, /aria-expanded="false"/);

  const expanded = renderToStaticMarkup(createElement(ActivityStatusRows, {
    statuses: [status],
    expandedKeys: new Set<string>(),
    onToggle: () => undefined,
    showPlanSteps: true
  }));
  assert.match(expanded, /activityStatusPlanSteps/);
  assert.match(expanded, /Inspect the app-server plan/);
  assert.match(expanded, /Connect Plan to Status/);
  assert.match(expanded, /Verify in the browser/);
  assert.match(expanded, /Review the final diff/);
});

test("approval interactions stay on their message and out of Turn Status", async () => {
  const { activityStatusesFromRecords } = await import("../../src/web/helpers/records.js");
  assert.deepEqual(activityStatusesFromRecords([{
    id: "approval-request",
    type: "response_item",
    payload: {
      type: "file_change",
      approval: {
        approvalId: "approval-1",
        kind: "command_execution",
        status: "pending"
      }
    }
  }]), []);
});

test("Thread background processes use an expandable BACKGROUNDS section", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { ThreadStatusCard } = await import("../../src/web/helpers/components.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  const markup = renderToStaticMarkup(createElement(ThreadStatusCard, {
    backgroundTerminals: [{
      itemId: "background-item",
      processId: "background-process",
      command: "sleep 45",
      cwd: "/tmp/codexhub",
      osPid: 1234,
      cpuPercent: 1.2,
      rssKb: 4096
    }],
    onTerminate: () => undefined
  }));

  assert.match(markup, /BACKGROUNDS/);
  assert.match(markup, /1 process/);
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /sleep 45/);
  assert.match(markup, /statusRegistryAction/);
  assert.match(markup, /Terminate background process sleep 45/);
});

test("Thread Status card stays mounted when the current Turn is idle", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { StatusCardOverview } = await import("../../src/web/helpers/components.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  const markup = renderToStaticMarkup(createElement(StatusCardOverview, {
    executionMeta: {
      status: "idle",
      label: "Idle",
      duration: "",
      text: "Idle"
    },
    turnActive: false,
    statuses: [],
    backgroundTerminals: [],
    expanded: false,
    onToggleExpanded: () => undefined
  }));

  assert.match(markup, /Thread status: Idle/);
  assert.match(markup, />Idle</);
  assert.match(markup, /activityStatusCardOverview/);
  assert.doesNotMatch(markup, />Thread</);
});

test("Turn Status card keeps Turn semantics while it is mounted", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { ActivityStatusBar } = await import("../../src/web/helpers/components.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  const markup = renderToStaticMarkup(createElement(ActivityStatusBar, {
    statuses: [],
    expanded: true,
    expandedKeys: new Set<string>(),
    onToggle: () => undefined
  }));

  assert.match(markup, /Turn details/);
  assert.match(markup, /turnStatusCard/);
});

test("collapsed Turn Status card hides the whole Turn detail section", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { ActivityStatusBar } = await import("../../src/web/helpers/components.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  const markup = renderToStaticMarkup(createElement(ActivityStatusBar, {
    statuses: [{
      key: "usage",
      label: "Usage",
      status: "completed" as const,
      text: "total 154.4k",
      summaryText: "154.4k"
    }],
    expanded: false,
    expandedKeys: new Set<string>(),
    onToggle: () => undefined
  }));

  assert.equal(markup, "");
});

test("Turn status items own their nested expansion", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { ActivityStatusBar } = await import("../../src/web/helpers/components.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  const status = {
    key: "files",
    label: "Files",
    status: "completed" as const,
    text: "2 files changed",
    files: [{ path: "src/app.tsx", added: 3, removed: 1 }]
  };
  const collapsed = renderToStaticMarkup(createElement(ActivityStatusBar, {
    statuses: [status],
    expanded: true,
    expandedKeys: new Set<string>(),
    onToggle: () => undefined
  }));
  const nestedExpanded = renderToStaticMarkup(createElement(ActivityStatusBar, {
    statuses: [status],
    expanded: true,
    expandedKeys: new Set(["files"]),
    onToggle: () => undefined
  }));

  assert.match(collapsed, /aria-expanded="false"/);
  assert.doesNotMatch(collapsed, /fileChangeRow/);
  assert.match(nestedExpanded, /aria-expanded="true"/);
  assert.match(nestedExpanded, /fileChangeRow/);
});

test("Turn Status keeps Usage at the end and colors file deltas", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { ActivityStatusBar, StatusCardOverview } = await import("../../src/web/helpers/components.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  const markup = renderToStaticMarkup(createElement(ActivityStatusBar, {
    statuses: [
      {
        key: "usage",
        label: "Usage",
        status: "completed" as const,
        text: "total 31.1k · +3 -1",
        summaryText: "31.1k · +3 -1"
      },
      {
        key: "files",
        label: "Files",
        status: "completed" as const,
        text: "2 files changed · +3 -1",
        summaryText: "+3 · -1 · 2 files changed",
        files: [{ path: "src/app.tsx", added: 3, removed: 1 }]
      }
    ],
    expanded: true,
    expandedKeys: new Set<string>(),
    onToggle: () => undefined
  }));

  assert.ok(markup.indexOf('statusRegistryLabel">Files') < markup.indexOf('statusRegistryLabel">Usage'));
  assert.match(markup, /class="activityStatusDelta added">\+3<\/span>/);
  assert.match(markup, /class="activityStatusDelta removed">-1<\/span>/);

  const overview = renderToStaticMarkup(createElement(StatusCardOverview, {
    executionMeta: {
      status: "running",
      label: "Running",
      duration: "",
      text: "Running"
    },
    turnActive: true,
    statuses: [
      {
        key: "usage",
        label: "Usage",
        status: "completed" as const,
        text: "total 31.1k",
        summaryText: "31.1k"
      },
      {
        key: "files",
        label: "Files",
        status: "completed" as const,
        text: "2 files changed",
        summaryText: "+3 · -1 · 2 files changed"
      }
    ],
    backgroundTerminals: [{
      itemId: "background-item",
      processId: "background-process",
      command: "sleep 45",
      cwd: "/tmp/codexhub",
      osPid: 1234,
      cpuPercent: 1.2,
      rssKb: 4096
    }],
    expanded: false,
    onToggleExpanded: () => undefined
  }));
  assert.ok(overview.indexOf(">Files<") < overview.indexOf(">Usage<"));
  assert.ok(overview.indexOf(">Usage<") < overview.indexOf(">BG<"));
});

test("completed Plan status uses an explicit completion label", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { activityStatusFromRecord } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  assert.deepEqual(activityStatusFromRecord({
    id: "plan-completed",
    timestamp: "2026-07-19T02:00:03.000Z",
    type: "event_msg",
    payload: {
      type: "turn_plan_updated",
      plan: [
        { step: "Inspect the app-server plan", status: "completed" },
        { step: "Connect Plan to Status", status: "completed" },
        { step: "Verify in the browser", status: "completed" },
        { step: "Review the final diff", status: "completed" }
      ]
    }
  }), {
    key: "plan",
    label: "Plan",
    status: "completed",
    at: "2026-07-19T02:00:03.000Z",
    text: "All steps complete",
    summaryText: "All steps complete · 4/4",
    steps: [
      { step: "Inspect the app-server plan", status: "completed" },
      { step: "Connect Plan to Status", status: "completed" },
      { step: "Verify in the browser", status: "completed" },
      { step: "Review the final diff", status: "completed" }
    ]
  });
});

test("guidance messages stay inside the existing Turn activity scope", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { latestTurnActivityScope } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });
  const records: CodexRecord[] = [{
    id: "turn-started",
    timestamp: "2026-07-19T02:00:00.000Z",
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-1" }
  }, {
    id: "initial-input",
    timestamp: "2026-07-19T02:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", turn_id: "turn-1", content: [] }
  }, {
    id: "activity-before-guidance",
    timestamp: "2026-07-19T02:00:02.000Z",
    type: "event_msg",
    payload: { type: "agent_message", turn_id: "turn-1", message: "working" }
  }, {
    id: "guidance-input",
    timestamp: "2026-07-19T02:00:03.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", turn_id: "turn-1", content: [] }
  }];

  const scope = latestTurnActivityScope(records);
  assert.equal(scope.key, "turn:turn-1");
  assert.equal(scope.startedAt, "2026-07-19T02:00:00.000Z");
  assert.equal(scope.userRecordId, "initial-input");
  assert.equal(scope.records.some((record) => record.id === "activity-before-guidance"), true);
});

test("Goal auto continuation status scope follows the current turnId without requiring a new user message", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { activityStatusesFromRecords, latestTurnActivityScope } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });
  const records: CodexRecord[] = [{
    id: "app:goal-thread:turn-1:event:task_started",
    timestamp: "2026-07-19T02:00:00.000Z",
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-1" },
    sourceThreadId: "goal-thread"
  }, {
    id: "app:goal-thread:turn-1:user:user-1",
    type: "event_msg",
    payload: { type: "user_message", message: "start the Goal" },
    sourceThreadId: "goal-thread"
  }, {
    id: "app:goal-thread:turn-1:item:fileChange:file-1",
    type: "response_item",
    payload: {
      type: "file_change",
      status: "completed",
      changes: [{ path: "first.ts", diff: "+first" }]
    },
    sourceThreadId: "goal-thread"
  }, {
    id: "app:goal-thread:turn-2:event:task_started",
    timestamp: "2026-07-19T02:10:00.000Z",
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-2" },
    sourceThreadId: "goal-thread"
  }, {
    id: "app:goal-thread:turn-2:item:fileChange:file-2",
    type: "response_item",
    payload: {
      type: "file_change",
      status: "completed",
      changes: [{ path: "second.ts", diff: "+second" }]
    },
    sourceThreadId: "goal-thread"
  }];

  const scope = latestTurnActivityScope(records, "turn-2");
  assert.equal(scope.key, "turn:turn-2");
  assert.equal(scope.startedAt, "2026-07-19T02:10:00.000Z");
  assert.deepEqual(scope.records.map((record) => record.id), [
    "app:goal-thread:turn-2:event:task_started",
    "app:goal-thread:turn-2:item:fileChange:file-2"
  ]);
  assert.deepEqual(
    activityStatusesFromRecords(scope.records)
      .find((status) => status.key === "files")
      ?.files
      ?.map((file) => file.path),
    ["second.ts"]
  );
});

test("active Goal status accumulates multiple app-server Turns", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const {
    activeGoalActivityScopeFromRecords,
    activityStatusesFromRecords,
    activityStatusSnapshotsFromRecords
  } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });
  const goalCreatedAt = Date.parse("2026-07-19T02:00:00.000Z") / 1000;
  const records: CodexRecord[] = [{
    id: "goal-active",
    timestamp: "2026-07-19T02:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "thread_goal_updated",
      threadId: "goal-thread",
      goal: {
        threadId: "goal-thread",
        objective: "finish across Turns",
        status: "active",
        createdAt: goalCreatedAt,
        updatedAt: goalCreatedAt
      }
    }
  }, ...goalTurnRecords("turn-1", "2026-07-19T02:00:01.000Z", {
    file: "first.ts",
    input: 100,
    output: 20,
    finalId: "goal-final-1",
    completedAt: "2026-07-19T02:05:00.000Z"
  }), ...goalTurnRecords("turn-2", "2026-07-19T02:10:00.000Z", {
    file: "second.ts",
    input: 60,
    output: 10
  })];

  const scope = activeGoalActivityScopeFromRecords(records, "goal-thread");
  assert.deepEqual(scope?.turnIds, ["turn-1", "turn-2"]);
  const statuses = activityStatusesFromRecords(scope?.records ?? []);
  assert.deepEqual(
    statuses.find((status) => status.key === "files")?.files?.map((file) => file.path),
    ["first.ts", "second.ts"]
  );
  assert.equal(statuses.find((status) => status.key === "usage")?.summaryText, "190 · in 160 · out 30");
  assert.deepEqual(
    activityStatusSnapshotsFromRecords(records, "turn-2", "goal-thread"),
    []
  );
});

test("Goal status excludes Turns while paused and resumes the same cumulative scope", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const {
    activeGoalActivityScopeFromRecords,
    activityStatusesFromRecords,
    activityStatusSnapshotsFromRecords
  } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });
  const goalCreatedAt = Date.parse("2026-07-19T02:00:00.000Z") / 1000;
  const goalUpdate = (
    id: string,
    timestamp: string,
    status: "active" | "paused" | "complete"
  ): CodexRecord => ({
    id,
    timestamp,
    type: "event_msg",
    payload: {
      type: "thread_goal_updated",
      threadId: "goal-thread",
      goal: {
        threadId: "goal-thread",
        objective: "finish across active intervals",
        status,
        createdAt: goalCreatedAt,
        updatedAt: Date.parse(timestamp) / 1000
      }
    }
  });
  const firstTurn = goalTurnRecords("turn-1", "2026-07-19T02:00:01.000Z", {
    file: "first.ts",
    input: 100,
    output: 20,
    finalId: "goal-final-1",
    completedAt: "2026-07-19T02:05:00.000Z"
  });
  const pausedTurn = goalTurnRecords("paused-turn", "2026-07-19T02:07:00.000Z", {
    file: "paused.ts",
    input: 900,
    output: 90,
    finalId: "paused-final",
    completedAt: "2026-07-19T02:08:00.000Z"
  });
  const pausedRecords = [
    goalUpdate("goal-active", "2026-07-19T02:00:00.000Z", "active"),
    ...firstTurn,
    goalUpdate("goal-paused", "2026-07-19T02:06:00.000Z", "paused"),
    ...pausedTurn
  ];
  assert.equal(activeGoalActivityScopeFromRecords(pausedRecords, "goal-thread"), null);

  const resumedRecords = [
    ...pausedRecords,
    goalUpdate("goal-resumed", "2026-07-19T02:09:00.000Z", "active"),
    ...goalTurnRecords("turn-2", "2026-07-19T02:10:00.000Z", {
      file: "second.ts",
      input: 60,
      output: 10,
      finalId: "goal-final-2",
      completedAt: "2026-07-19T02:15:00.000Z"
    })
  ];
  const resumedScope = activeGoalActivityScopeFromRecords(resumedRecords, "goal-thread");
  assert.deepEqual(resumedScope?.turnIds, ["turn-1", "turn-2"]);
  assert.equal(
    activityStatusesFromRecords(resumedScope?.records ?? [])
      .find((status) => status.key === "usage")
      ?.summaryText,
    "190 · in 160 · out 30"
  );

  const completedRecords = [
    ...resumedRecords,
    goalUpdate("goal-complete", "2026-07-19T02:16:00.000Z", "complete")
  ];
  const snapshots = activityStatusSnapshotsFromRecords(completedRecords, undefined, "goal-thread");
  const goalStatuses = snapshots.find((snapshot) => snapshot.targetRecordId === "goal-final-2")?.statuses ?? [];
  assert.equal(goalStatuses.find((status) => status.key === "usage")?.summaryText, "190 · in 160 · out 30");
  assert.deepEqual(
    goalStatuses.find((status) => status.key === "files")?.files?.map((file) => file.path),
    ["first.ts", "second.ts"]
  );
  assert.equal(
    snapshots.find((snapshot) => snapshot.targetRecordId === "paused-final")
      ?.statuses
      .find((status) => status.key === "usage")
      ?.summaryText,
    "990 · in 900 · out 90"
  );
});

test("completed Goal moves one cumulative status snapshot to its last FINAL_ANSWER", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const {
    activeGoalActivityScopeFromRecords,
    activityStatusSnapshotsFromRecords
  } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });
  const goalCreatedAt = Date.parse("2026-07-19T02:00:00.000Z") / 1000;
  const goalCompletedAt = Date.parse("2026-07-19T02:20:00.000Z") / 1000;
  const records: CodexRecord[] = [
    ...goalTurnRecords("ordinary-turn", "2026-07-19T01:50:00.000Z", {
      file: "ordinary.ts",
      input: 10,
      output: 2,
      finalId: "ordinary-final",
      completedAt: "2026-07-19T01:55:00.000Z"
    }),
    {
      id: "goal-active",
      timestamp: "2026-07-19T02:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "thread_goal_updated",
        threadId: "goal-thread",
        goal: {
          threadId: "goal-thread",
          objective: "finish across Turns",
          status: "active",
          createdAt: goalCreatedAt,
          updatedAt: goalCreatedAt
        }
      }
    },
    ...goalTurnRecords("turn-1", "2026-07-19T02:00:01.000Z", {
      file: "first.ts",
      input: 100,
      output: 20,
      finalId: "goal-final-1",
      completedAt: "2026-07-19T02:05:00.000Z"
    }),
    ...goalTurnRecords("turn-2", "2026-07-19T02:10:00.000Z", {
      file: "second.ts",
      input: 60,
      output: 10
    }),
    {
      id: "goal-complete",
      timestamp: "2026-07-19T02:20:00.000Z",
      type: "event_msg",
      payload: {
        type: "thread_goal_updated",
        threadId: "goal-thread",
        goal: {
          threadId: "goal-thread",
          objective: "finish across Turns",
          status: "complete",
          createdAt: goalCreatedAt,
          updatedAt: goalCompletedAt
        }
      }
    },
    {
      id: "goal-final-2",
      timestamp: "2026-07-19T02:20:01.000Z",
      type: "event_msg",
      payload: { type: "agent_message", turn_id: "turn-2", message: "Goal complete", phase: "final_answer" },
      sourceThreadId: "goal-thread"
    },
    {
      id: "app:goal-thread:turn-2:event:task_complete",
      timestamp: "2026-07-19T02:20:02.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-2" },
      sourceThreadId: "goal-thread"
    }
  ];

  assert.equal(activeGoalActivityScopeFromRecords(records, "goal-thread"), null);
  const snapshots = activityStatusSnapshotsFromRecords(records, undefined, "goal-thread");
  assert.deepEqual(snapshots.map((snapshot) => snapshot.targetRecordId), [
    "ordinary-final",
    "goal-final-2"
  ]);
  const goalStatuses = snapshots.find((snapshot) => snapshot.targetRecordId === "goal-final-2")?.statuses ?? [];
  assert.deepEqual(
    goalStatuses.find((status) => status.key === "files")?.files?.map((file) => file.path),
    ["first.ts", "second.ts"]
  );
  assert.equal(goalStatuses.find((status) => status.key === "usage")?.summaryText, "190 · in 160 · out 30");
});

test("web goal extraction only consumes current camelCase ThreadGoal fields", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { latestThreadGoalFromRecords } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  assert.deepEqual(latestThreadGoalFromRecords([{
    id: "current-goal",
    type: "event_msg",
    payload: {
      type: "thread_goal_updated",
      threadId: "thread-1",
      goal: {
        threadId: "thread-1",
        objective: "finish",
        status: "active",
        tokenBudget: 1000,
        timeUsedSeconds: 30,
        updatedAt: 3
      }
    }
  }], "thread-1"), {
    objective: "finish",
    status: "active",
    tokenBudget: 1000,
    timeUsedSeconds: 30,
    updatedAt: "1970-01-01T00:00:03.000Z"
  });

  assert.deepEqual(latestThreadGoalFromRecords([{
    id: "old-goal-fields",
    type: "event_msg",
    payload: {
      type: "thread_goal_updated",
      goal: {
        objective: "finish",
        status: "active",
        token_budget: 1000,
        updated_at: 3
      }
    }
  }]), {
    objective: "finish",
    status: "active",
    tokenBudget: undefined,
    timeUsedSeconds: undefined,
    updatedAt: undefined
  });
});

const goalTurnRecords = (
  turnId: string,
  startedAt: string,
  options: {
    file: string;
    input: number;
    output: number;
    finalId?: string;
    completedAt?: string;
  }
): CodexRecord[] => [{
  id: `app:goal-thread:${turnId}:event:task_started`,
  timestamp: startedAt,
  type: "event_msg",
  payload: { type: "task_started", turn_id: turnId },
  sourceThreadId: "goal-thread"
}, {
  id: `app:goal-thread:${turnId}:item:fileChange:${options.file}`,
  timestamp: startedAt,
  type: "response_item",
  payload: {
    type: "file_change",
    status: "completed",
    changes: [{ path: options.file, diff: `+${options.file}` }]
  },
  sourceThreadId: "goal-thread"
}, {
  id: `app:goal-thread:${turnId}:statusUsage`,
  timestamp: startedAt,
  type: "event_msg",
  payload: {
    type: "status_usage",
    turn_id: turnId,
    usage: {
      input_tokens: options.input,
      output_tokens: options.output,
      total_tokens: options.input + options.output
    }
  },
  sourceThreadId: "goal-thread"
}, ...(options.finalId ? [{
  id: options.finalId,
  timestamp: options.completedAt,
  type: "event_msg" as const,
  payload: { type: "agent_message", turn_id: turnId, message: "done", phase: "final_answer" },
  sourceThreadId: "goal-thread"
}] : []), ...(options.completedAt ? [{
  id: `app:goal-thread:${turnId}:event:task_complete`,
  timestamp: options.completedAt,
  type: "event_msg" as const,
  payload: { type: "task_complete", turn_id: turnId },
  sourceThreadId: "goal-thread"
}] : [])];
