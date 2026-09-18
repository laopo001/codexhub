import assert from "node:assert/strict";
import test from "node:test";
import type { MachineSummary } from "../src/shared/machineTypes.js";
import type { RuntimeSummary } from "../src/shared/threadTypes.js";
import {
  connectionCodexRuntimeLine,
  connectionCodexRuntimeState,
  connectionCodexVersionLabel
} from "../src/web/helpers/connectionRuntime.js";

const machine = (online = true): MachineSummary => ({
  machineId: "machine-test",
  type: "local",
  name: "local",
  hostname: "test-host",
  online,
  status: online ? "online" : "offline",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  capabilities: { projectLauncher: true }
});

const runtime = (online = true, cliVersion: string | undefined = "0.149.0"): RuntimeSummary => ({
  machineId: "machine-test",
  workingDirectory: "/workspace",
  online,
  status: online ? "online" : "offline",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  cliVersion,
  threads: []
});

test("connection Codex runtime status distinguishes transport, startup, and runtime state", () => {
  assert.deepEqual(connectionCodexRuntimeState(undefined, []), {
    kind: "not-connected",
    label: "Codex not connected",
    detail: "Connect this machine first"
  });
  assert.deepEqual(connectionCodexRuntimeState(machine(), []), {
    kind: "not-started",
    label: "Codex not started",
    detail: "Start a thread to connect Codex"
  });
  assert.deepEqual(connectionCodexRuntimeState(machine(), [runtime()]), {
    kind: "connected",
    label: "Codex connected",
    detail: "Codex v0.149.0"
  });
  assert.deepEqual(connectionCodexRuntimeState(machine(), [runtime(false)]), {
    kind: "disconnected",
    label: "Codex disconnected",
    detail: "Last connected · Codex v0.149.0"
  });
  assert.deepEqual(connectionCodexRuntimeState(machine(false), [runtime(false)]), {
    kind: "unavailable",
    label: "Codex unavailable",
    detail: "Machine offline · Last Codex v0.149.0"
  });
});

test("connection Codex version and compact line preserve one version prefix", () => {
  assert.equal(connectionCodexVersionLabel("v0.149.0"), "Codex v0.149.0");
  assert.equal(connectionCodexVersionLabel(undefined), "Version unavailable");
  assert.equal(
    connectionCodexRuntimeLine(connectionCodexRuntimeState(machine(), [runtime()])),
    "Codex connected · v0.149.0"
  );
  assert.equal(
    connectionCodexRuntimeLine(connectionCodexRuntimeState(machine(), [runtime(false)])),
    "Codex disconnected · Last v0.149.0"
  );
  assert.equal(connectionCodexRuntimeLine(connectionCodexRuntimeState(machine(), [])), "Codex not started");
});
