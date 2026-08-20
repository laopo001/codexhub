import assert from "node:assert/strict";
import test from "node:test";
import { MachineHub } from "../../src/core/machineHub.js";

const register = (hub: MachineHub, capabilities = { projectLauncher: true as boolean }) =>
  hub.registerMachine({
    machineId: "machine-test",
    type: "local",
    hostname: "test-host",
    capabilities
  });

test("machine command entry points share the project launcher capability guard", () => {
  const hub = new MachineHub();
  register(hub, { projectLauncher: false });

  assert.throws(
    () => hub.ensureRuntime("machine-test", { cwd: "/workspace" }),
    /Machine cannot launch projects: machine-test/
  );
  assert.throws(
    () => hub.listDirectory("machine-test", { cwd: "/workspace" }),
    /Machine cannot browse projects: machine-test/
  );
  assert.throws(
    () => hub.previewFile("machine-test", { path: "/workspace/file.txt" }),
    /Machine cannot preview files: machine-test/
  );
});

test("shared machine guard preserves offline errors before capability errors", () => {
  const hub = new MachineHub();
  register(hub, { projectLauncher: false });
  hub.disconnectMachine("machine-test");

  assert.throws(
    () => hub.startSession("machine-test", { cwd: "/workspace" }),
    /Machine is offline: machine-test/
  );
});
