import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSummary, ThreadPickerState } from "../../src/web/types.js";

test("generic runtime thread picker keeps project origin unresolved", async () => {
  const { createProjectActions } = await import("../../src/web/appActions/projectActions.js");
  const runtime: RuntimeSummary = {
    machineId: "machine-a",
    workingDirectory: "/workspace-root",
    online: true,
    status: "online",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    threads: []
  };
  let picker: ThreadPickerState | null = null;
  const context = {
    activeRuntime: runtime,
    runtimeList: [runtime],
    threadPicker: null,
    setActiveMachineId: () => undefined,
    setActiveWorkspacePath: () => undefined,
    setThreadPicker: (value: ThreadPickerState | null | ((current: ThreadPickerState | null) => ThreadPickerState | null)) => {
      picker = typeof value === "function" ? value(picker) : value;
    }
  } as unknown as Parameters<typeof createProjectActions>[0];

  const actions = createProjectActions(context, {} as Parameters<typeof createProjectActions>[1]);
  actions.openThreadPicker(runtime);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const currentPicker = picker as ThreadPickerState | null;
  assert.equal(currentPicker?.workingDirectory, "/workspace-root");
  assert.equal(currentPicker?.projectTarget, undefined);
});
