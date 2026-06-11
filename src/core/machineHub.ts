import { randomUUID } from "node:crypto";

export type MachineType = "local" | "ssh" | "registered" | "server";

export type MachineCapabilities = {
  projectLauncher: boolean;
};

export type MachineRegistration = {
  machineId?: string;
  type?: MachineType;
  name?: string;
  hostname: string;
  pid?: number;
  platform?: string;
  cwd?: string;
  capabilities?: Partial<MachineCapabilities>;
  transportId?: string;
};

export type MachineSummary = {
  machineId: string;
  type: MachineType;
  name?: string;
  hostname: string;
  online: boolean;
  status: "online" | "offline";
  lastSeenAt: string;
  offlineSinceAt?: string;
  offlineReason?: "transport_disconnected" | "unregistered";
  pid?: number;
  platform?: string;
  cwd?: string;
  capabilities: MachineCapabilities;
};

export type MachineStartSessionResult = {
  sessionId: string;
  threadId: string;
  appServerUrl: string;
  cwd: string;
  reused?: boolean;
};

export type MachineDirectoryEntry = {
  name: string;
  path: string;
};

export type MachineDirectoryListing = {
  cwd: string;
  parent?: string;
  home: string;
  entries: MachineDirectoryEntry[];
};

export type MachineStopSessionResult = {
  sessionId: string;
  stopped: boolean;
  cwd?: string;
};

export type MachineCommandResult = MachineStartSessionResult | MachineDirectoryListing | MachineStopSessionResult;

type MachineCommandBase = {
  seq: number;
  commandId: string;
  createdAt: string;
};

type MachineCommandDetail = {
  type: "start_session";
  cwd: string;
  reuse?: boolean;
} | {
  type: "list_directory";
  cwd?: string;
} | {
  type: "stop_session";
  sessionId: string;
};

type MachineCommandInput = Omit<MachineCommandBase, "seq"> & MachineCommandDetail;

export type MachineCommand = MachineCommandBase & MachineCommandDetail;

type MachineState = MachineSummary & {
  transportId?: string;
  commands: MachineCommand[];
  waiters: Set<MachineWaiter>;
};

type PendingMachineCommand = {
  machineId: string;
  type: MachineCommand["type"];
  resolve: (value: MachineCommandResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type MachineWaiter = () => void;

export class MachineHub {
  private readonly machines = new Map<string, MachineState>();
  private readonly pendingCommands = new Map<string, PendingMachineCommand>();

  constructor(private readonly options: { onChange?: () => void } = {}) {}

  registerMachine(registration: MachineRegistration): { machineId: string; machine: MachineSummary } {
    const now = new Date().toISOString();
    const machineId = registration.machineId?.trim() || createMachineId(registration.hostname);
    const existing = this.machines.get(machineId);
    if (existing) {
      for (const waiter of [...existing.waiters]) waiter();
    }
    const machine: MachineState = {
      machineId,
      type: normalizeMachineType(registration.type, existing?.type),
      name: registration.name,
      hostname: registration.hostname,
      online: true,
      status: "online",
      lastSeenAt: now,
      pid: registration.pid,
      platform: registration.platform,
      cwd: registration.cwd,
      capabilities: normalizeMachineCapabilities(registration.capabilities, existing?.capabilities),
      transportId: registration.transportId,
      commands: existing?.commands ?? [],
      waiters: existing?.waiters ?? new Set()
    };
    this.machines.set(machineId, machine);
    this.options.onChange?.();
    return { machineId, machine: machineSummary(machine) };
  }

  heartbeatMachine(machineId: string, registration: Partial<MachineRegistration> = {}) {
    const machine = this.machines.get(machineId);
    if (!machine) return { ok: false };
    const previousState = machineVisibleState(machine);
    machine.name = registration.name ?? machine.name;
    machine.type = normalizeMachineType(registration.type, machine.type);
    machine.hostname = registration.hostname ?? machine.hostname;
    machine.pid = registration.pid ?? machine.pid;
    machine.platform = registration.platform ?? machine.platform;
    machine.cwd = registration.cwd ?? machine.cwd;
    machine.capabilities = normalizeMachineCapabilities(registration.capabilities, machine.capabilities);
    machine.lastSeenAt = new Date().toISOString();
    if (!machine.online) {
      machine.online = true;
      machine.status = "online";
      delete machine.offlineSinceAt;
      delete machine.offlineReason;
    }
    if (previousState !== machineVisibleState(machine)) this.options.onChange?.();
    return { ok: true, machineId };
  }

  unregisterMachine(machineId: string, transportId?: string) {
    const machine = this.machines.get(machineId);
    if (!machine) return { ok: false };
    if (transportId && machine.transportId && machine.transportId !== transportId) return { ok: true, machineId };
    this.markMachineOffline(machine, "unregistered", "Machine unregistered");
    return { ok: true, machineId };
  }

  disconnectMachine(machineId: string, transportId?: string) {
    const machine = this.machines.get(machineId);
    if (!machine) return { ok: false };
    if (transportId && machine.transportId && machine.transportId !== transportId) return { ok: true, machineId };
    this.markMachineOffline(machine, "transport_disconnected", "Machine transport disconnected");
    return { ok: true, machineId };
  }

  listMachines() {
    return [...this.machines.values()]
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .map(machineSummary);
  }

  startSession(machineId: string, input: { cwd: string; reuse?: boolean }, timeoutMs = 90_000) {
    const machine = this.requireMachine(machineId);
    if (!machine.online) throw new Error(`Machine is offline: ${machineId}`);
    if (!machine.capabilities.projectLauncher) throw new Error(`Machine cannot launch projects: ${machineId}`);
    const commandId = randomUUID();
    const command = this.enqueueMachineCommand(machine.machineId, {
      commandId,
      type: "start_session",
      createdAt: new Date().toISOString(),
      cwd: input.cwd,
      reuse: input.reuse
    });
    return {
      command,
      promise: this.waitForCommand<MachineStartSessionResult>(commandId, machine.machineId, "start_session", timeoutMs)
    };
  }

  listDirectory(machineId: string, input: { cwd?: string }, timeoutMs = 30_000) {
    const machine = this.requireMachine(machineId);
    if (!machine.online) throw new Error(`Machine is offline: ${machineId}`);
    if (!machine.capabilities.projectLauncher) throw new Error(`Machine cannot browse projects: ${machineId}`);
    const commandId = randomUUID();
    const command = this.enqueueMachineCommand(machine.machineId, {
      commandId,
      type: "list_directory",
      createdAt: new Date().toISOString(),
      cwd: input.cwd
    });
    return {
      command,
      promise: this.waitForCommand<MachineDirectoryListing>(commandId, machine.machineId, "list_directory", timeoutMs)
    };
  }

  stopSession(machineId: string, input: { sessionId: string }, timeoutMs = 30_000) {
    const machine = this.requireMachine(machineId);
    if (!machine.online) throw new Error(`Machine is offline: ${machineId}`);
    const commandId = randomUUID();
    const command = this.enqueueMachineCommand(machine.machineId, {
      commandId,
      type: "stop_session",
      createdAt: new Date().toISOString(),
      sessionId: input.sessionId
    });
    return {
      command,
      promise: this.waitForCommand<MachineStopSessionResult>(commandId, machine.machineId, "stop_session", timeoutMs)
    };
  }

  async waitMachineCommands(machineId: string, after: number, timeoutMs = 25_000) {
    const machine = this.machines.get(machineId);
    if (!machine) return { machineId, cursor: after, commands: [] };
    if (machineCommandsAfter(machine, after).length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
        const waiter = () => {
          clearTimeout(timer);
          machine.waiters.delete(waiter);
          resolve();
        };
        machine.waiters.add(waiter);
      });
    }
    const commands = machineCommandsAfter(machine, after);
    return {
      machineId,
      cursor: commands.at(-1)?.seq ?? after,
      commands
    };
  }

  clampMachineCommandCursor(machineId: string, requestedCursor: number) {
    const maxCursor = this.machines.get(machineId)?.commands.at(-1)?.seq ?? 0;
    return Math.max(0, Math.min(requestedCursor, maxCursor));
  }

  resolveCommand(machineId: string, commandId: string, result: MachineCommandResult) {
    const pending = this.pendingCommands.get(commandId);
    if (!pending || pending.machineId !== machineId) return { ok: false };
    clearTimeout(pending.timer);
    this.pendingCommands.delete(commandId);
    pending.resolve(result);
    return { ok: true, machineId, commandId };
  }

  failCommand(machineId: string, commandId: string, message: string) {
    const pending = this.pendingCommands.get(commandId);
    if (!pending || pending.machineId !== machineId) return { ok: false };
    clearTimeout(pending.timer);
    this.pendingCommands.delete(commandId);
    pending.reject(new Error(message));
    return { ok: true, machineId, commandId };
  }

  private requireMachine(machineId: string) {
    const machine = this.machines.get(machineId);
    if (!machine) throw new Error(`Machine not found: ${machineId}`);
    return machine;
  }

  private enqueueMachineCommand(machineId: string, command: MachineCommandInput) {
    const machine = this.requireMachine(machineId);
    const seq = (machine.commands.at(-1)?.seq ?? 0) + 1;
    const next: MachineCommand = { ...command, seq };
    machine.commands.push(next);
    if (machine.commands.length > 500) machine.commands.splice(0, machine.commands.length - 500);
    for (const waiter of [...machine.waiters]) waiter();
    return next;
  }

  private waitForCommand<T extends MachineCommandResult>(
    commandId: string,
    machineId: string,
    type: MachineCommand["type"],
    timeoutMs: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(commandId);
        reject(new Error(`Machine command timed out: ${type}`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingCommands.set(commandId, {
        machineId,
        type,
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
    });
  }

  private markMachineOffline(
    machine: MachineState,
    reason: NonNullable<MachineSummary["offlineReason"]>,
    message: string
  ) {
    const previousState = machineVisibleState(machine);
    machine.online = false;
    machine.status = "offline";
    machine.offlineSinceAt = machine.offlineSinceAt ?? new Date().toISOString();
    machine.offlineReason = reason;
    for (const command of machine.commands) this.failCommand(machine.machineId, command.commandId, message);
    for (const waiter of [...machine.waiters]) waiter();
    if (previousState !== machineVisibleState(machine)) this.options.onChange?.();
  }
}

export const createMachineId = (hostname: string) => `machine-${safeMachinePart(hostname)}`;

const safeMachinePart = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "local";

const machineSummary = (machine: MachineState): MachineSummary => ({
  machineId: machine.machineId,
  type: machine.type,
  name: machine.name,
  hostname: machine.hostname,
  online: machine.online,
  status: machine.status,
  lastSeenAt: machine.lastSeenAt,
  offlineSinceAt: machine.offlineSinceAt,
  offlineReason: machine.offlineReason,
  pid: machine.pid,
  platform: machine.platform,
  cwd: machine.cwd,
  capabilities: machine.capabilities
});

const machineCommandsAfter = (machine: MachineState, after: number) =>
  machine.commands.filter((command) => command.seq > after);

const machineVisibleState = (machine: MachineState) => JSON.stringify({
  machineId: machine.machineId,
  type: machine.type,
  name: machine.name,
  hostname: machine.hostname,
  online: machine.online,
  status: machine.status,
  offlineSinceAt: machine.offlineSinceAt,
  offlineReason: machine.offlineReason,
  pid: machine.pid,
  platform: machine.platform,
  cwd: machine.cwd,
  capabilities: machine.capabilities
});

export const normalizeMachineType = (
  value: MachineType | undefined,
  fallback: MachineType = "registered"
): MachineType => {
  return value === "local" || value === "ssh" || value === "registered" || value === "server" ? value : fallback;
};

export const normalizeMachineCapabilities = (
  value: Partial<MachineCapabilities> | undefined,
  fallback: MachineCapabilities = { projectLauncher: true }
): MachineCapabilities => ({
  projectLauncher: typeof value?.projectLauncher === "boolean"
    ? value.projectLauncher
    : fallback.projectLauncher
});
