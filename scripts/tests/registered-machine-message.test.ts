import assert from "node:assert/strict";
import test from "node:test";
import {
  createRegisteredMachineConnectionTracker,
  machineVsCodeChannels
} from "../../src/web/helpers/registeredMachines.js";
import type { MachineSummary } from "../../src/shared/machineTypes.js";
import type { ProjectSummary } from "../../src/shared/projectTypes.js";

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

test("machineVsCodeChannels summarizes channels per machine and preserves both stable and insiders", () => {
  const projects: Array<Pick<ProjectSummary, "machineId" | "source">> = [
    {
      machineId: "m1",
      source: { kind: "vscode", groupId: "g1", vscodeChannel: "insiders" }
    },
    {
      machineId: "m1",
      source: { kind: "vscode", groupId: "g2", vscodeChannel: "stable" }
    },
    {
      machineId: "m1",
      source: { kind: "electron", groupId: "el" }
    },
    {
      machineId: "m2",
      source: { kind: "vscode", groupId: "g3", vscodeChannel: "insiders" }
    }
  ];

  // m1 has both stable and insiders
  assert.deepEqual(machineVsCodeChannels("m1", projects), ["stable", "insiders"]);
  // m2 has insiders only
  assert.deepEqual(machineVsCodeChannels("m2", projects), ["insiders"]);
  // m3 has no projects
  assert.deepEqual(machineVsCodeChannels("m3", projects), []);
});
