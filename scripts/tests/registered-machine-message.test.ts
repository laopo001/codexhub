import assert from "node:assert/strict";
import test from "node:test";
import { createRegisteredMachineConnectionTracker } from "../../src/web/helpers/registeredMachines.js";
import type { MachineSummary } from "../../src/shared/machineTypes.js";

const machine = (
  machineId: string,
  type: MachineSummary["type"] = "registered",
  online = true
): MachineSummary => ({
  machineId,
  type,
  name: machineId,
  hostname: machineId,
  online,
  status: online ? "online" : "offline",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  capabilities: { projectLauncher: true }
});

test("registered machine messages report runtime transitions after the initial baseline", () => {
  const tracker = createRegisteredMachineConnectionTracker();
  tracker.seed([machine("existing"), machine("local", "local")]);

  const unchanged = tracker.update([machine("existing")]);
  assert.deepEqual(unchanged.connected, []);
  assert.deepEqual(unchanged.disconnected, []);

  const connected = tracker.update([machine("existing"), machine("new"), machine("offline", "registered", false)]);
  assert.deepEqual(connected.connected.map((item) => item.machineId), ["new"]);
  assert.deepEqual(connected.disconnected, []);

  const disconnected = tracker.update([machine("existing")]);
  assert.deepEqual(disconnected.connected, []);
  assert.deepEqual(disconnected.disconnected.map((item) => item.machineId), ["new"]);

  const reconnected = tracker.update([machine("existing"), machine("new")]);
  assert.deepEqual(reconnected.connected.map((item) => item.machineId), ["new"]);
  assert.deepEqual(reconnected.disconnected, []);
});
