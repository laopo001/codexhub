import assert from "node:assert/strict";
import test from "node:test";

test("approval actions follow the app-server decision order and hide unavailable actions", async () => {
  const runtimeGlobal = globalThis as { window?: unknown };
  const previousWindow = runtimeGlobal.window;
  runtimeGlobal.window = { location: { search: "" } };
  const { approvalDecisionActions } = await import("../../src/web/helpers/components.js");
  if (previousWindow === undefined) delete runtimeGlobal.window;
  else runtimeGlobal.window = previousWindow;

  assert.deepEqual(
    approvalDecisionActions("command_execution", ["deny", "approve", "deny", "cancel"])
      .map((action) => action.decision),
    ["deny", "approve", "cancel"]
  );
  assert.deepEqual(
    approvalDecisionActions("command_execution", []).map((action) => action.decision),
    []
  );
  const amendments = [
    { type: "accept_with_execpolicy_amendment" as const, execpolicyAmendment: ["git", "status"] },
    {
      type: "apply_network_policy_amendment" as const,
      networkPolicyAmendment: { host: "example.com", action: "allow" as const }
    }
  ];
  assert.deepEqual(
    approvalDecisionActions("command_execution", amendments).map((action) => ({
      decision: action.decision,
      label: action.label
    })),
    [
      { decision: amendments[0], label: "Allow pattern" },
      { decision: amendments[1], label: "Allow host" }
    ]
  );
  assert.deepEqual(
    approvalDecisionActions("permissions_request").map((action) => action.decision),
    ["approve", "approve_for_session", "deny"]
  );
});
