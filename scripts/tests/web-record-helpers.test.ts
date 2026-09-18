import assert from "node:assert/strict";
import test from "node:test";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import {
  applyThreadRecordDelta,
  combineRecordSources,
  mergeRecord
} from "../../src/web/helpers/records.js";
import { conversationViewsFromRecords } from "../../src/web/helpers/conversationViews.js";

const messageRecord = (
  id: string,
  message: string,
  timestamp: string,
  options: Pick<CodexRecord, "order" | "sourceThreadId"> = {}
): CodexRecord => ({
  id,
  type: "event_msg",
  timestamp,
  ...options,
  payload: { type: "agent_message", phase: "final_answer", message }
});

test("record source merge preserves canonical order and app-server semantic dedupe", () => {
  const live = messageRecord(
    "app:thread-1:turn-1:agent:live",
    "same answer",
    "2026-09-18T00:00:02.000Z",
    { sourceThreadId: "thread-1" }
  );
  const earlier = messageRecord(
    "record-earlier",
    "earlier",
    "2026-09-18T00:00:01.000Z"
  );
  const snapshot = { ...live, id: "app:thread-1:turn-1:agent:snapshot" };

  const merged = combineRecordSources([live], [snapshot, earlier]);
  assert.deepEqual(merged.map((record) => record.id), [earlier.id, snapshot.id]);
  assert.equal(merged.some((record) => record.id === live.id), false);
  assert.equal(merged[1], snapshot);
});

test("record source merge reuses identical or empty inputs without rebuilding them", () => {
  const records = [messageRecord("record-1", "answer", "2026-09-18T00:00:00.000Z")];
  assert.equal(combineRecordSources(records, records), records);
  assert.equal(combineRecordSources([], records), records);
  assert.equal(combineRecordSources(records, []), records);
});

test("mergeRecord replaces an id, keeps canonical order, and preserves delta append semantics", () => {
  const first = messageRecord("first", "first", "2026-09-18T00:00:01.000Z");
  const second = messageRecord("second", "second", "2026-09-18T00:00:02.000Z");
  const movedSecond = { ...second, timestamp: "2026-09-18T00:00:00.000Z" };
  const ordered = mergeRecord([first, second], movedSecond);
  assert.deepEqual(ordered.map((record) => record.id), [second.id, first.id]);

  const deltaRecord: CodexRecord = {
    id: "command",
    type: "response_item",
    payload: { type: "local_shell_call", aggregated_output: "first" }
  };
  const updated = applyThreadRecordDelta([deltaRecord], {
    recordId: deltaRecord.id,
    field: "aggregated_output",
    append: " second"
  });
  assert.equal((updated[0].payload as { aggregated_output: string }).aggregated_output, "first second");
  assert.equal((deltaRecord.payload as { aggregated_output: string }).aggregated_output, "first");
});

test("conversation projection cache is isolated by records identity and does not share mutable views", () => {
  const recordsA = [messageRecord("same-id", "message A", "2026-09-18T00:00:00.000Z")];
  const recordsB = [messageRecord("same-id", "message B", "2026-09-18T00:00:00.000Z")];

  const viewsA = conversationViewsFromRecords(recordsA);
  viewsA[0].text = "mutated outside the cache";

  assert.equal(conversationViewsFromRecords(recordsA)[0].text, "message A");
  assert.equal(conversationViewsFromRecords(recordsB)[0].text, "message B");
});

test("conversation projection cache keeps expansion keys independent", () => {
  const records: CodexRecord[] = [
    {
      id: "tool-1",
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", call_id: "call-1", arguments: '{"cmd":"pwd"}' }
    },
    messageRecord("boundary", "next message", "2026-09-18T00:00:01.000Z"),
    {
      id: "tool-2",
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", call_id: "call-2", arguments: '{"cmd":"ls"}' }
    }
  ];

  const collapsed = conversationViewsFromRecords(records);
  const batch = collapsed.find((view) => view.toolBatch)?.toolBatch;
  assert.ok(batch);
  assert.equal(batch.expanded, false);

  const expanded = conversationViewsFromRecords(records, new Set([batch.key]));
  assert.equal(expanded.some((view) => view.record.id === "tool-1"), true);
  assert.equal(expanded.find((view) => view.toolBatch)?.toolBatch?.expanded, true);
  assert.equal(conversationViewsFromRecords(records).find((view) => view.toolBatch)?.toolBatch?.expanded, false);
});
