import type { MachineSummary, OpenThreadState } from "../types.js";

export type SidebarOpenThreadItem = {
  thread: OpenThreadState;
  machineLabel: string;
  machineType?: MachineSummary["type"];
};

export const sidebarOpenThreadItems = (
  openThreads: readonly OpenThreadState[],
  machines: readonly MachineSummary[]
): SidebarOpenThreadItem[] => {
  const machinesById = new Map(machines.map((machine) => [machine.machineId, machine]));
  return openThreads.map((thread) => {
    const machineId = thread.runtime.machineId;
    const machine = machineId ? machinesById.get(machineId) : undefined;
    return {
      thread,
      machineLabel: machine?.name ?? machine?.hostname ?? machineId ?? "Unknown machine",
      machineType: machine?.type
    };
  });
};
