import assert from "node:assert/strict";
import test from "node:test";
import { sessionEventSchema, threadRunOptionsSchema } from "../../src/shared/apiContract.js";

test("reasoning effort schemas follow app-server's open non-empty string contract", () => {
  for (const effort of ["max", "ultra", "future-effort"]) {
    assert.equal(threadRunOptionsSchema.safeParse({ modelReasoningEffort: effort }).success, true);
    assert.equal(sessionEventSchema.safeParse({
      type: "thread_settings_changed",
      threadId: "thread-1",
      modelReasoningEffort: effort
    }).success, true);
  }

  assert.equal(threadRunOptionsSchema.safeParse({ modelReasoningEffort: "" }).success, false);
  assert.equal(threadRunOptionsSchema.safeParse({ modelReasoningEffort: 1 }).success, false);
  assert.equal(threadRunOptionsSchema.safeParse({ modelReasoningEffort: null }).success, true);
  assert.equal(threadRunOptionsSchema.safeParse({ collaborationMode: "ultra" }).success, false);
});

test("record config extraction preserves Ultra without adopting child-agent settings", async () => {
  const previousWindow = "window" in globalThis
    ? (globalThis as { window?: unknown }).window
    : undefined;
  (globalThis as { window?: unknown }).window = { location: { search: "" } };
  const { normalizeReasoningEffort, threadConfigFromRecord } = await import("../../src/web/helpers/records.js").finally(() => {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  });

  assert.equal(normalizeReasoningEffort("max"), "max");
  assert.equal(normalizeReasoningEffort("ultra"), "ultra");
  assert.equal(normalizeReasoningEffort(""), undefined);
  assert.deepEqual(threadConfigFromRecord({
    id: "turn-context",
    type: "response_item",
    payload: { type: "turn_context", model: "gpt-5.6-sol", effort: "ultra" }
  }), {
    model: "gpt-5.6-sol",
    reasoning: "ultra",
    serviceTier: undefined
  });
  assert.deepEqual(threadConfigFromRecord({
    id: "child-agent",
    type: "response_item",
    payload: {
      type: "collab_agent_tool_call",
      model: "gpt-5.6-sol-mini",
      reasoning_effort: "ultra"
    }
  }), {});
});

test("reasoning catalog stays model-specific and preserves descriptions", async () => {
  const {
    modelSupportsReasoningEffort,
    reasoningOptionLabel,
    reasoningOptionsForSelection
  } = await import("../../src/web/helpers/core.js");
  const catalog = [
    {
      id: "sol",
      model: "gpt-5.6-sol",
      isDefault: true,
      supportedReasoningEfforts: [{
        value: "ultra",
        label: "ultra",
        description: "Maximum reasoning with automatic task delegation"
      }],
      serviceTiers: []
    },
    {
      id: "luna",
      model: "gpt-5.6-luna",
      supportedReasoningEfforts: [{ value: "max", label: "max" }],
      serviceTiers: []
    }
  ];

  const automaticOptions = reasoningOptionsForSelection("auto", catalog, "auto");
  const ultraOption = automaticOptions.find((option) => option.value === "ultra");
  assert.equal(reasoningOptionLabel(ultraOption!), "Ultra");
  assert.equal(ultraOption?.description, "Maximum reasoning with automatic task delegation");
  assert.equal(automaticOptions.some((option) => option.value === "max"), false);
  assert.equal(modelSupportsReasoningEffort(catalog, "gpt-5.6-luna", "ultra"), false);
});

test("failed or superseded effort overrides do not replace authoritative thread settings", async () => {
  const { ThreadHub } = await import("../../src/core/threadHub.js");
  const hub = new ThreadHub();
  const sessionId = "reasoning-rollback-session";
  const threadId = "reasoning-rollback-thread";
  hub.registerSession({
    sessionId,
    machineId: "machine-local",
    workingDirectory: "/tmp/reasoning-rollback"
  });
  hub.applySessionEvent(sessionId, {
    type: "thread_settings_changed",
    threadId,
    modelReasoningEffort: "max"
  });

  const turn = hub.runTurn(threadId, "unsupported effort", "web", {
    modelReasoningEffort: "unsupported-effort"
  });
  const batch = await hub.waitSessionCommands(sessionId, 0, 1);
  const command = batch.commands[0];
  assert.equal(command?.options?.modelReasoningEffort, "unsupported-effort");
  hub.failSessionCommand(sessionId, command!.commandId, "unsupported effort");
  await assert.rejects(turn, /unsupported effort/);
  assert.equal(hub.getThread(threadId)?.modelReasoningEffort, "max");

  const supersededTurn = hub.runTurn(threadId, "superseded effort", "web", {
    modelReasoningEffort: "ultra"
  });
  const supersededBatch = await hub.waitSessionCommands(sessionId, command!.seq, 1);
  const supersededCommand = supersededBatch.commands[0];
  hub.applySessionEvent(sessionId, {
    type: "thread_settings_changed",
    threadId,
    modelReasoningEffort: "max"
  });
  hub.resolveSessionCommand(sessionId, supersededCommand!.commandId, { ok: true });
  await supersededTurn;
  assert.equal(hub.getThread(threadId)?.modelReasoningEffort, "max");
});
