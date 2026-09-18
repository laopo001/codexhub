import assert from "node:assert/strict";
import test from "node:test";
import { recordsToViews } from "../src/core/codexRecordView.js";
import { compactToolViews, collapseHistoricalToolBatches } from "../src/shared/compactRecordViews.js";
import { formatInspectDetail } from "../src/web/helpers/toolPreview.js";
import { resolveInspectMessage } from "../src/web/helpers/inspectMessage.js";

test("function call inspection follows the call record through completed output compaction", () => {
  const records = [
    {
      id: "record-call",
      type: "response_item",
      payload: { type: "function_call", name: "shell", call_id: "call-1", arguments: "{}", status: "in_progress" }
    },
    {
      id: "record-output",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: "completed output" }
    }
  ];
  const pending = compactToolViews(recordsToViews([records[0]]))[0];
  const selection = { threadId: "thread-1", recordId: pending.record.id };
  const completed = compactToolViews(recordsToViews(records));

  assert.equal(pending.id, "compact-tool:call-1");
  assert.equal(completed[0].record.id, selection.recordId);
  assert.equal(completed[0].inspectText, "completed output");
  assert.equal(resolveInspectMessage(selection, "thread-1", completed), completed[0]);
});

test("local shell inspection follows a replaced record to its final output", () => {
  const runningRecord = {
    id: "shell-record",
    type: "response_item",
    payload: {
      type: "local_shell_call",
      call_id: "shell-call-1",
      action: { command: ["printf", "partial"] },
      status: "in_progress",
      aggregated_output: "partial"
    }
  };
  const completedRecord = {
    ...runningRecord,
    payload: {
      ...runningRecord.payload,
      status: "completed",
      exit_code: 0,
      aggregated_output: "final"
    }
  };
  const pending = compactToolViews(recordsToViews([runningRecord]))[0];
  const selection = { threadId: "thread-1", recordId: pending.record.id };
  const completed = compactToolViews(recordsToViews([completedRecord]));
  const resolved = resolveInspectMessage(selection, "thread-1", completed);

  assert.ok(resolved);
  assert.equal(resolved.record.id, "shell-record");
  assert.equal(resolved.status, "completed");
  assert.equal(formatInspectDetail(resolved).outputBlock, "final");
});

test("inspect selection remains scoped to its thread after tool batch projection", () => {
  const records = [{
    id: "record-call",
    type: "response_item",
    payload: { type: "function_call", name: "shell", call_id: "call-1", arguments: "{}", status: "in_progress" }
  }];
  const views = compactToolViews(recordsToViews(records));
  const selection = { threadId: "thread-1", recordId: views[0].record.id };
  const projected = collapseHistoricalToolBatches(views, new Set());

  assert.equal(resolveInspectMessage(selection, "thread-2", projected), null);
  assert.equal(resolveInspectMessage(selection, "thread-1", projected), projected[0]);
});
