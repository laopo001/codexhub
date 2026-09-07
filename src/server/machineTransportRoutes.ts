import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { AppServerTunnelPeer, isAppServerTunnelFrame } from "../core/appServerTunnel.js";
import type { RemoteBackendRegistry } from "./remoteBackendRegistry.js";
import type { MachineHub } from "../core/machineHub.js";
import type { CodexhubServerState } from "../core/serverState.js";
import type { ThreadHub } from "../core/threadHub.js";
import {
  machineTransportMessageSchema,
  type MachineTransportIncomingMessage
} from "../shared/apiContract.js";
import type { MachineRegistration, MachineRegistrationProject, MachineSummary } from "../shared/machineTypes.js";
import type { SessionEventInput } from "../shared/threadTypes.js";

type AttachTunneledAppServerInput = {
  machineId: string;
  transportId: string;
  commandId: string;
  sessionId: string;
  appServerId: string;
  cwd: string;
  appServerUrl: string;
  tunnel: AppServerTunnelPeer;
};

export type MachineTransportRoutesContext = {
  attachTunneledAppServer: (input: AttachTunneledAppServerInput) => Promise<string | undefined>;
  clearMachineRegistrationProjects: (machineId: string) => void;
  machines: MachineHub;
  onMachineRegistered?: (machine: MachineSummary, registration: MachineRegistration) => void;
  publishProjects: () => void;
  refreshRetainedThreadRecordSubscriptions: () => void;
  replaceMachineRegistrationProjects: (machineId: string, projects: MachineRegistrationProject[] | undefined) => void;
  shouldPersistMachine: (machine: MachineSummary) => boolean;
  startTunneledAppServerThread: (input: {
    transportId: string;
    sessionId: string;
    cwd: string;
    threadId?: string;
  }) => Promise<string>;
  state: CodexhubServerState;
  stopTunneledAppServerSession: (sessionId: string, transportId?: string) => Promise<void>;
  stopTunneledAppServerSessionsForTransport: (transportId: string) => Promise<void>;
  threads: ThreadHub;
  remoteBackend: RemoteBackendRegistry;
};

export const registerMachineTransportRoutes = (app: FastifyInstance, ctx: MachineTransportRoutesContext) => {
  app.get("/api/machines/connect", { websocket: true }, (socket) => {
    const transportId = randomUUID();
    let machineId: string | null = null;
    let transportRole: "machine" | "backend" | null = null;
    let backendGeneration: string | undefined;
    let commandCursor = 0;
    let closed = false;
    let commandPumpStarted = false;
    let cleanedUp = false;
    const sessionIds = new Set<string>();
    const sessionCursors = new Map<string, number>();
    const sessionCommandPumps = new Set<string>();

    const send = (message: unknown) => {
      if (socket.readyState !== 1) return;
      socket.send(JSON.stringify(message));
    };
    const tunnel = new AppServerTunnelPeer({
      send: (frame) => send(frame),
      label: `codexhub server machine transport ${transportId}`
    });
    const sessionTransportId = (sessionId: string) => `${transportId}:${sessionId}`;

    const commandPump = async () => {
      while (!closed && machineId) {
        const response = await ctx.machines.waitMachineCommands(machineId, commandCursor, 60_000);
        if (closed || !machineId) return;
        commandCursor = Math.max(commandCursor, response.cursor);
        if (response.commands.length) send({ type: "commands", cursor: commandCursor, commands: response.commands });
      }
    };

    const startCommandPump = () => {
      if (commandPumpStarted) return;
      commandPumpStarted = true;
      void commandPump().catch((error: unknown) => {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        socket.close();
      });
    };

    const sessionCommandPump = async (sessionId: string) => {
      while (!closed && sessionIds.has(sessionId)) {
        const response = await ctx.threads.waitSessionCommands(sessionId, sessionCursors.get(sessionId) ?? 0, 60_000);
        if (closed || !sessionIds.has(sessionId)) return;
        sessionCursors.set(sessionId, Math.max(sessionCursors.get(sessionId) ?? 0, response.cursor));
        if (response.commands.length) {
          send({
            type: "session_commands",
            sessionId,
            cursor: sessionCursors.get(sessionId) ?? response.cursor,
            commands: response.commands
          });
        }
      }
    };

    const startSessionCommandPump = (sessionId: string) => {
      if (sessionCommandPumps.has(sessionId)) return;
      sessionCommandPumps.add(sessionId);
      void sessionCommandPump(sessionId)
        .catch((error: unknown) => {
          send({
            type: "session_error",
            sessionId,
            message: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => sessionCommandPumps.delete(sessionId));
    };

    const disconnectSessions = () => {
      for (const sessionId of [...sessionIds]) {
        ctx.threads.disconnectSession(sessionId, sessionTransportId(sessionId));
      }
      sessionIds.clear();
      sessionCursors.clear();
    };

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      closed = true;
      tunnel.closeAll();
      const connectedSessionIds = [...sessionIds];
      disconnectSessions();
      if (transportRole === "machine") void ctx.stopTunneledAppServerSessionsForTransport(transportId);
      for (const sessionId of connectedSessionIds) ctx.remoteBackend.detach(sessionId, transportId);
      if (!machineId) return;
      ctx.machines.disconnectMachine(machineId, transportId);
      ctx.clearMachineRegistrationProjects(machineId);
      ctx.publishProjects();
    };

    const registerMachine = (
      parsed: Extract<MachineTransportIncomingMessage, { type: "register" | "backend_register" }>,
      role: "machine" | "backend"
    ) => {
      if (transportRole && transportRole !== role) {
        throw new Error(`Machine transport role is already fixed as ${transportRole}.`);
      }
      if (transportRole === role) {
        throw new Error("Machine transport registration can only occur once per connection.");
      }
      if (role === "backend" && parsed.registration.type !== "registered") {
        throw new Error("backend registration must use machine type registered");
      }
      transportRole = role;
      if (role === "backend") {
        backendGeneration = (parsed as Extract<MachineTransportIncomingMessage, { type: "backend_register" }>).generation;
      }
      const registration = role === "backend"
        ? { ...parsed.registration, transportId, capabilities: { ...parsed.registration.capabilities, projectLauncher: false } }
        : { ...parsed.registration, transportId };
      const result = ctx.machines.registerMachine(registration, role);
      ctx.onMachineRegistered?.(result.machine, parsed.registration);
      if (ctx.shouldPersistMachine(result.machine)) {
        ctx.state.upsertMachine({
          machineId: result.machineId,
          type: result.machine.type,
          hostname: result.machine.hostname,
          name: result.machine.name,
          lastSeenAt: result.machine.lastSeenAt,
          capabilities: result.machine.capabilities
        });
      }
      ctx.replaceMachineRegistrationProjects(result.machineId, parsed.registration.projects);
      machineId = result.machineId;
      commandCursor = ctx.machines.clampMachineCommandCursor(machineId, parsed.type === "register" ? parsed.commandCursor ?? 0 : parsed.commandCursor ?? 0);
      send({ type: "registered", machineId, machine: result.machine });
      ctx.publishProjects();
      startCommandPump();
    };

    const registerSession = (parsed: Extract<MachineTransportIncomingMessage, { type: "session_register" }>) => {
      const registered = ctx.threads.registerSession({
        ...parsed.registration,
        sessionId: parsed.sessionId,
        machineId: machineId!,
        transportId: sessionTransportId(parsed.sessionId),
        transportRole: transportRole ?? "machine",
        ...(transportRole === "backend" && backendGeneration ? { remoteGeneration: backendGeneration } : {})
      });
      const sessionId = registered.sessionId;
      sessionIds.add(sessionId);
      sessionCursors.set(sessionId, ctx.threads.clampSessionCommandCursor(sessionId, parsed.commandCursor ?? 0));
      send({ type: "session_registered", sessionId, session: registered.session });
      if (transportRole === "backend") {
        if (!backendGeneration) throw new Error("Backend transport generation handshake is missing.");
        ctx.remoteBackend.attach({
          sessionId,
          transportId,
          generation: backendGeneration,
          send
        });
        ctx.machines.heartbeatMachine(machineId!, { capabilities: { projectLauncher: true } });
      }
      ctx.refreshRetainedThreadRecordSubscriptions();
      ctx.publishProjects();
      startSessionCommandPump(sessionId);
    };

    const unregisterMachine = async () => {
      ctx.machines.unregisterMachine(machineId!, transportId);
      ctx.clearMachineRegistrationProjects(machineId!);
      if (transportRole === "machine") await ctx.stopTunneledAppServerSessionsForTransport(transportId);
      for (const sessionId of [...sessionIds]) {
        ctx.threads.unregisterSession(sessionId, sessionTransportId(sessionId));
      }
      sessionIds.clear();
      sessionCursors.clear();
      ctx.publishProjects();
      machineId = null;
      socket.close();
    };

    const handleMessage = async (data: unknown) => {
      let parsed: MachineTransportIncomingMessage;
      try {
        parsed = machineTransportMessageSchema.parse(JSON.parse(String(data)));
      } catch (error) {
        send({ type: "error", message: `invalid machine transport message: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      if (parsed.type !== "register" && parsed.type !== "backend_register" && !machineId) {
        send({ type: "error", message: "machine transport must register before sending messages" });
        return;
      }

      try {
        if (isAppServerTunnelFrame(parsed)) {
          if (transportRole === "backend") throw new Error("backend transport does not accept app-server tunnel frames");
          return tunnel.handleFrame(parsed);
        }
        if (parsed.type === "register") return registerMachine(parsed, "machine");
        if (parsed.type === "backend_register") return registerMachine(parsed, "backend");
        if (transportRole === "backend" && (
          parsed.type === "app_server_ready"
          || parsed.type === "app_server_start_thread"
          || parsed.type === "app_server_stopped"
        )) {
          throw new Error("backend transport does not accept app-server tunnel lifecycle messages");
        }
        if (parsed.type === "app_server_ready") {
          const threadId = await ctx.attachTunneledAppServer({
            machineId: machineId!,
            transportId,
            commandId: parsed.commandId,
            sessionId: parsed.sessionId,
            appServerId: parsed.appServerId,
            cwd: parsed.cwd,
            appServerUrl: parsed.appServerUrl,
            tunnel
          });
          send({
            type: "app_server_attached",
            commandId: parsed.commandId,
            sessionId: parsed.sessionId,
            ...(threadId ? { threadId } : {})
          });
          return;
        }
        if (parsed.type === "app_server_start_thread") {
          const threadId = await ctx.startTunneledAppServerThread({
            transportId,
            sessionId: parsed.sessionId,
            cwd: parsed.cwd,
            threadId: parsed.threadId
          });
          send({ type: "app_server_attached", commandId: parsed.commandId, sessionId: parsed.sessionId, threadId });
          return;
        }
        if (parsed.type === "app_server_stopped") {
          await ctx.stopTunneledAppServerSession(parsed.sessionId, transportId);
          return;
        }
        if (parsed.type === "unregister") return await unregisterMachine();
        if (parsed.type === "heartbeat") {
          const registration = parsed.registration ?? {};
          const heartbeatRegistration = transportRole === "backend"
            ? { ...registration, capabilities: { ...registration.capabilities, projectLauncher: sessionIds.size > 0 } }
            : registration;
          ctx.machines.heartbeatMachine(machineId!, heartbeatRegistration);
          if (Object.hasOwn(registration, "projects")) {
            ctx.replaceMachineRegistrationProjects(machineId!, registration.projects);
          }
          ctx.publishProjects();
          return;
        }
        if (parsed.type === "session_register") return registerSession(parsed);
        if (parsed.type === "session_unregister") {
          ctx.threads.unregisterSession(parsed.sessionId, sessionTransportId(parsed.sessionId));
          if (transportRole === "backend") ctx.remoteBackend.dispose(parsed.sessionId);
          sessionIds.delete(parsed.sessionId);
          sessionCursors.delete(parsed.sessionId);
          if (transportRole === "backend") ctx.machines.heartbeatMachine(machineId!, { capabilities: { projectLauncher: sessionIds.size > 0 } });
          ctx.publishProjects();
          return;
        }
        if (parsed.type === "session_heartbeat") {
          ctx.threads.heartbeatSession(parsed.sessionId, parsed.registration ?? {}, sessionTransportId(parsed.sessionId));
          return;
        }
        if (parsed.type === "session_event") {
          if (transportRole === "backend" && parsed.event.type !== "runtime_projection" && parsed.event.type !== "thread_projection") {
            throw new Error("backend transport only accepts CodexHub projection events");
          }
          if (transportRole === "machine" && (parsed.event.type === "runtime_projection" || parsed.event.type === "thread_projection")) {
            throw new Error("standalone machine transport cannot send backend projection events");
          }
          return ctx.threads.applySessionEvent(parsed.sessionId, parsed.event as SessionEventInput, sessionTransportId(parsed.sessionId));
        }
        if (parsed.type === "backend_command_result") {
          ctx.remoteBackend.resolve(parsed.sessionId, transportId, parsed.generation, parsed.commandId, parsed.result);
          return;
        }
        if (parsed.type === "backend_command_error") {
          ctx.remoteBackend.reject(parsed.sessionId, transportId, parsed.generation, parsed.commandId, parsed.message);
          return;
        }
        if (parsed.type === "backend_command_done") {
          ctx.remoteBackend.complete(parsed.sessionId, transportId, parsed.generation, parsed.commandId, parsed.message);
          return;
        }
        if (parsed.type === "session_command_result") {
          ctx.threads.resolveSessionCommand(parsed.sessionId, parsed.commandId, parsed.result, sessionTransportId(parsed.sessionId));
          return;
        }
        if (parsed.type === "session_command_error") {
          ctx.threads.failSessionCommand(parsed.sessionId, parsed.commandId, parsed.message, sessionTransportId(parsed.sessionId));
          return;
        }
        if (parsed.type === "command_result") {
          ctx.machines.resolveCommand(machineId!, parsed.commandId, parsed.result);
          ctx.publishProjects();
          return;
        }
        ctx.machines.failCommand(machineId!, parsed.commandId, parsed.message);
        ctx.publishProjects();
      } catch (error) {
        if (parsed.type === "app_server_ready" || parsed.type === "app_server_start_thread") {
          send({
            type: "app_server_attach_error",
            commandId: parsed.commandId,
            sessionId: parsed.sessionId,
            message: error instanceof Error ? error.message : String(error)
          });
          return;
        }
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    };

    socket.on("message", (data: unknown) => void handleMessage(data));
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
};
