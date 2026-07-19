import type { MachineSummary } from "../../shared/machineTypes.js";

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
