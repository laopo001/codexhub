import assert from "node:assert/strict";
import test from "node:test";
import {
  captureRendererDiagnosticReport,
  recordRendererRealtimeEvent,
  rendererRealtimeEventMetadata,
  resetRendererDiagnosticsForTest,
  updateRendererDiagnosticContext
} from "../../src/web/helpers/rendererDiagnostics.js";

test("renderer diagnostics retain only whitelisted realtime metadata", () => {
  resetRendererDiagnosticsForTest();
  const event = {
    type: "record",
    seq: 42,
    thread: { threadId: "thread-a", workingDirectory: "/secret/project" },
    record: {
      id: "record-a",
      type: "response_item",
      payload: {
        type: "local_shell_call",
        aggregated_output: "secret output",
        path: "/secret/file"
      }
    }
  };
  assert.deepEqual(rendererRealtimeEventMetadata(event, "2026-01-01T00:00:00.000Z"), {
    receivedAt: "2026-01-01T00:00:00.000Z",
    type: "record",
    seq: 42,
    threadId: "thread-a",
    recordId: "record-a",
    recordType: "response_item",
    payloadType: "local_shell_call"
  });
  recordRendererRealtimeEvent(event);
  updateRendererDiagnosticContext({
    activeThreadId: "thread-a",
    openThreadIds: ["thread-a", "thread-b"],
    serverInstanceId: "instance-a",
    authorityId: "authority-a",
    surface: "default"
  });
  const report = captureRendererDiagnosticReport(
    new Error("failed at ?codexhub_token=secret-token"),
    "\n    at Conversation (/assets/index.js)"
  );
  const serialized = JSON.stringify(report);
  assert.deepEqual(report.context.openThreadIds, ["thread-a", "thread-b"]);
  assert.equal(report.recentRealtimeEvents.at(-1)?.recordId, "record-a");
  assert.doesNotMatch(serialized, /secret output|\/secret\/project|\/secret\/file|secret-token/);
  assert.match(serialized, /codexhub_token=\[redacted\]/);
  assert.match(serialized, /Conversation/);
});

test("renderer diagnostics bound the realtime event ring", () => {
  resetRendererDiagnosticsForTest();
  for (let seq = 1; seq <= 30; seq += 1) {
    recordRendererRealtimeEvent({ type: "projects", seq });
  }
  const report = captureRendererDiagnosticReport(new Error("boom"));
  assert.equal(report.recentRealtimeEvents.length, 24);
  assert.equal(report.recentRealtimeEvents[0]?.seq, 7);
  assert.equal(report.recentRealtimeEvents.at(-1)?.seq, 30);
});
