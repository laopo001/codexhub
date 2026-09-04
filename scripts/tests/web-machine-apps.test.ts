import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  machineAppsCommandPaletteCwds,
  machineAppsThreadBelongsToMachine,
  MachineAppCard,
  MachineAppsPanel
} from "../../src/web/MachineAppsPanel.js";

test("Apps card renders mocked runtime state without inferring accessibility from callable", () => {
  const markup = renderToStaticMarkup(createElement(MachineAppCard, {
    installed: { id: "calendar", runtimeName: "Codex Calendar", enabled: true, callable: true, accessible: null },
    metadata: {
      id: "calendar",
      name: "Calendar",
      description: "Calendar tools",
      iconUrl: null,
      iconUrlDark: null,
      distributionChannel: "account",
      installUrl: null,
      pluginDisplayNames: [],
      tools: [{ name: "list_events", title: "List events", description: "Read calendar events", enabled: true, disabledReason: null, readOnly: true }]
    }
  }));
  assert.match(markup, /Installed: Yes/);
  assert.match(markup, /Account access: Unknown/);
  assert.match(markup, /Callable: Yes/);
  assert.match(markup, /List events/);
});

test("Apps panel reports the unavailable machine state instead of using a static app fallback", () => {
  const markup = renderToStaticMarkup(createElement(MachineAppsPanel, {
    machines: [],
    openThreads: [],
    loadCommandPalette: () => undefined
  }));
  assert.match(markup, /No online Codex runtime is available/);
  assert.doesNotMatch(markup, /Calendar|Slack|GitHub/);
});

test("plugin sync snapshots every distinct open-thread cwd plus the machine default", () => {
  assert.deepEqual(machineAppsCommandPaletteCwds("/machine/default", [
    { workingDirectory: "/workspace/one" },
    { workingDirectory: "/workspace/one" },
    { workingDirectory: "/workspace/two" }
  ]), ["/machine/default", "/workspace/one", "/workspace/two"]);
});

test("an old thread id is invalid for a newly selected machine", () => {
  const threads = [{ threadId: "thread-a", runtime: { machineId: "machine-a" } }] as never[];
  assert.equal(machineAppsThreadBelongsToMachine("machine-b", "thread-a", threads), false);
  assert.equal(machineAppsThreadBelongsToMachine("machine-b", "", threads), true);
});
