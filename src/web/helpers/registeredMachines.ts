import type { MachineSummary } from "../../shared/machineTypes.js";
import type { ProjectSummary } from "../../shared/projectTypes.js";
import type { VscodeChannel } from "../../shared/surfaceTypes.js";

const onlineRegisteredMachines = (machines: MachineSummary[]) => new Map(
  machines
    .filter((machine) => machine.type === "registered" && machine.online)
    .map((machine) => [machine.machineId, machine])
);

export const createRegisteredMachineConnectionTracker = () => {
  let connectedMachines = new Map<string, MachineSummary>();
  return {
    seed(machines: MachineSummary[]) {
      connectedMachines = onlineRegisteredMachines(machines);
    },
    update(machines: MachineSummary[]) {
      const nextConnectedMachines = onlineRegisteredMachines(machines);
      const connected = [...nextConnectedMachines.values()]
        .filter((machine) => !connectedMachines.has(machine.machineId));
      const disconnected = [...connectedMachines.values()]
        .filter((machine) => !nextConnectedMachines.has(machine.machineId));
      connectedMachines = nextConnectedMachines;
      return { connected, disconnected };
    }
  };
};

/** 从项目列表中按 machineId 汇总实际存在的 VSCode 渠道（同时存在时返回 stable 与 insiders） */
export const machineVsCodeChannels = (
  machineId: string,
  projects: readonly Pick<ProjectSummary, "machineId" | "source">[] = []
): VscodeChannel[] => {
  const channels = new Set<VscodeChannel>();
  for (const project of projects) {
    if (project.machineId === machineId && project.source?.kind === "vscode") {
      if (project.source.vscodeChannel === "stable" || project.source.vscodeChannel === "insiders") {
        channels.add(project.source.vscodeChannel);
      }
    }
  }
  return [...channels].sort((a, b) => (a === "stable" ? -1 : b === "stable" ? 1 : 0));
};
