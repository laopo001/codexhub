import assert from "node:assert/strict";
import test from "node:test";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import type { ThreadDetail } from "../../src/shared/threadTypes.js";
import { sidebarOpenThreadItems } from "../../src/web/helpers/sidebarOpenThreads.js";
import { openThreadStateFromDetail } from "../../src/web/openThreadReducer.js";
import type { MachineSummary } from "../../src/web/types.js";

const machine = (machineId: string, type: MachineSummary["type"]): MachineSummary => ({
  machineId,
  type,
  name: `${type}-machine`,
  hostname: `${type}.example`,
  online: true,
  status: "online",
  lastSeenAt: "2026-09-02T00:00:00.000Z",
  capabilities: {
    projectLauncher: true,
    projectCatalog: "editable"
  }
});

const thread = (threadId: string, machineId: string) => openThreadStateFromDetail({
  threadId,
  workingDirectory: `/workspace/${threadId}`,
  runtime: { online: true, runnable: true, machineId },
  status: "idle",
  running: false,
  title: threadId,
  updatedAt: "2026-09-02T00:00:00.000Z",
  messageCount: 0,
  threadUsage: emptyThreadUsage(),
  records: [],
  backgroundTerminals: [],
  lastSeq: 0
} satisfies ThreadDetail);

test("sidebar open threads preserves opened tabs across local, SSH, and registered machines", () => {
  const machines = [
    machine("machine-local", "local"),
    machine("machine-ssh", "ssh"),
    machine("machine-registered", "registered")
  ];
  const openThreads = [
    thread("thread-local", "machine-local"),
    thread("thread-ssh", "machine-ssh"),
    thread("thread-registered", "machine-registered")
  ];

  const items = sidebarOpenThreadItems(openThreads, machines);

  assert.deepEqual(items.map((item) => item.thread.threadId), [
    "thread-local",
    "thread-ssh",
    "thread-registered"
  ]);
  assert.deepEqual(items.map((item) => item.machineType), ["local", "ssh", "registered"]);
  assert.deepEqual(items.map((item) => item.machineLabel), [
    "local-machine",
    "ssh-machine",
    "registered-machine"
  ]);
});
