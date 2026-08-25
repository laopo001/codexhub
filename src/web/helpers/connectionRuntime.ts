import type { MachineSummary } from "../../shared/machineTypes.js";
import type { RuntimeSummary } from "../../shared/threadTypes.js";

export type ConnectionCodexRuntimeState = {
  kind: "connected" | "not-started" | "not-connected" | "disconnected" | "unavailable";
  label: string;
  detail: string;
};

export const connectionCodexVersionLabel = (cliVersion: string | undefined) => {
  const version = cliVersion?.trim();
  if (!version) return "Version unavailable";
  return `Codex ${version.startsWith("v") ? version : `v${version}`}`;
};

export const connectionCodexRuntimeState = (
  machine: MachineSummary | undefined,
  runtimeList: RuntimeSummary[]
): ConnectionCodexRuntimeState => {
  if (!machine) {
    return {
      kind: "not-connected",
      label: "Codex not connected",
      detail: "Connect this machine first"
    };
  }
  const runtime = runtimeList.find((item) => item.machineId === machine.machineId);
  if (!machine.online) {
    return {
      kind: "unavailable",
      label: "Codex unavailable",
      detail: runtime?.cliVersion
        ? `Machine offline · Last ${connectionCodexVersionLabel(runtime.cliVersion)}`
        : "Machine offline"
    };
  }
  if (!runtime) {
    return {
      kind: "not-started",
      label: "Codex not started",
      detail: "Start a thread to connect Codex"
    };
  }
  if (runtime.online) {
    return {
      kind: "connected",
      label: "Codex connected",
      detail: connectionCodexVersionLabel(runtime.cliVersion)
    };
  }
  return {
    kind: "disconnected",
    label: "Codex disconnected",
    detail: runtime.cliVersion
      ? `Last connected · ${connectionCodexVersionLabel(runtime.cliVersion)}`
      : "Runtime offline"
  };
};

export const connectionCodexRuntimeLine = (state: ConnectionCodexRuntimeState) => {
  if (state.kind === "connected") return `${state.label} · ${state.detail.replace(/^Codex\s+/, "")}`;
  if (state.kind === "disconnected") {
    const lastVersion = state.detail.match(/Codex\s+(v\S+)/)?.[1];
    return lastVersion ? `${state.label} · Last ${lastVersion}` : state.label;
  }
  if (state.kind === "unavailable") return `${state.label} · Machine offline`;
  return state.label;
};
