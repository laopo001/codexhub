import type { FastifyInstance, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { z } from "zod";
import type { MachineHub } from "../core/machineHub.js";
import type { PluginHub } from "../core/pluginHub.js";
import type { CodexhubServerState } from "../core/serverState.js";
import { listSshHosts } from "../core/sshConfig.js";
import type { SshMachineManager } from "../core/sshMachine.js";
import {
  readSshRemoteClientBundle,
  resolveSshRemoteClientBundle,
  type SshRemoteClientBundle
} from "../core/sshRemoteClient.js";
import {
  parentRegistrationConnectSchema,
  sshConnectSchema,
  sshHostAliasSchema,
  type MachineDirectoryListing,
  type MachinesPayload,
  type ParentRegistrationConnectInput,
  type ParentRegistrationPayload,
  type ParentRegistrationStatus,
  type PluginsPayload,
  type SshConnectionPayload,
  type SshConnectionsPayload,
  type SshHostsPayload,
  type SshHostSummary
} from "../shared/apiContract.js";
import { contentType } from "./serverFiles.js";

export type ConnectionRoutesContext = {
  sshEnabled: boolean;
  machines: MachineHub;
  plugins: PluginHub;
  sshMachines: SshMachineManager;
  state: CodexhubServerState;
  listCodexhubSshHosts: () => Promise<SshHostSummary[]>;
  hasSshConfigHost: (alias: string) => Promise<boolean>;
  autoConnectSavedSshHost: (alias: string, reason: string) => Promise<void>;
  stopSshConnectionsForHost: (alias: string) => Promise<void>;
  parentRegistrationView: () => ParentRegistrationStatus;
  startParentRegistration: (input: ParentRegistrationConnectInput) => Promise<ParentRegistrationStatus>;
  stopParentRegistration: () => Promise<ParentRegistrationStatus>;
  buildRegisteredBootstrap: (request: FastifyRequest, bundle: SshRemoteClientBundle, input: { server?: string; name?: string }) => string;
};

export const registerConnectionRoutes = (app: FastifyInstance, ctx: ConnectionRoutesContext) => {
  app.get("/api/machines", async () => ({ machines: ctx.machines.listMachines() } satisfies MachinesPayload));

  app.get("/api/ssh/config-hosts", async () => ({
    hosts: ctx.sshEnabled ? await listSshHosts() : []
  } satisfies SshHostsPayload));

  app.get("/api/ssh/hosts", async () => ({ hosts: await ctx.listCodexhubSshHosts() } satisfies SshHostsPayload));

  app.post("/api/ssh/hosts", async (request, reply) => {
    if (!ctx.sshEnabled) return reply.code(404).send({ error: "ssh_disabled" });
    const { alias: rawAlias } = sshHostAliasSchema.parse(request.body);
    const alias = rawAlias.trim();
    if (!await ctx.hasSshConfigHost(alias)) return reply.code(404).send({ error: `SSH config host not found: ${alias}` });
    const alreadySaved = ctx.state.listSshHosts().some((host) => host.alias === alias);
    ctx.state.upsertSshHost({ alias });
    if (!alreadySaved) void ctx.autoConnectSavedSshHost(alias, "host_added");
    return { ok: true, hosts: await ctx.listCodexhubSshHosts() } satisfies SshHostsPayload;
  });

  app.delete("/api/ssh/hosts/:alias", async (request, reply) => {
    if (!ctx.sshEnabled) return reply.code(404).send({ error: "ssh_disabled" });
    const { alias } = sshHostAliasSchema.parse(request.params);
    await ctx.stopSshConnectionsForHost(alias);
    return {
      ok: true,
      deleted: ctx.state.deleteSshHost(alias),
      hosts: await ctx.listCodexhubSshHosts()
    } satisfies SshHostsPayload;
  });

  app.get("/api/ssh/connections", async () => ({
    connections: ctx.sshEnabled ? ctx.sshMachines.listConnections() : []
  } satisfies SshConnectionsPayload));

  app.get("/api/registered/parent", async () => ({
    registration: ctx.parentRegistrationView()
  } satisfies ParentRegistrationPayload));
  app.post("/api/registered/parent", async (request) => ({
    registration: await ctx.startParentRegistration(parentRegistrationConnectSchema.parse(request.body))
  } satisfies ParentRegistrationPayload));
  app.delete("/api/registered/parent", async () => ({
    registration: await ctx.stopParentRegistration()
  } satisfies ParentRegistrationPayload));

  app.get("/api/registered/bootstrap", async (request, reply) => {
    const query = z.object({ server: z.string().url().optional(), name: z.string().min(1).optional() }).parse(request.query);
    const bundle = await resolveSshRemoteClientBundle();
    if (!bundle) return reply.code(404).send({ error: "remote_client_not_found" });
    const script = ctx.buildRegisteredBootstrap(request, bundle, query);
    reply.type("text/x-shellscript; charset=utf-8");
    reply.header("cache-control", "no-cache");
    return reply.send(script);
  });

  app.get("/api/remote-client/:hash", async (request, reply) => {
    const params = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.params);
    const bundle = await readSshRemoteClientBundle(params.hash);
    if (!bundle) return reply.code(404).send({ error: "remote_client_not_found" });
    reply.type("text/javascript; charset=utf-8");
    reply.header("cache-control", "public, max-age=31536000, immutable");
    reply.header("x-codexhub-remote-client-sha256", bundle.hash);
    return reply.send(bundle.content);
  });

  app.get("/api/ssh/remote-client/:hash", async (request, reply) => {
    if (!ctx.sshEnabled) return reply.code(404).send({ error: "ssh_disabled" });
    const params = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.params);
    const bundle = await readSshRemoteClientBundle(params.hash);
    if (!bundle) return reply.code(404).send({ error: "ssh_remote_client_not_found" });
    reply.type("text/javascript; charset=utf-8");
    reply.header("cache-control", "public, max-age=31536000, immutable");
    reply.header("x-codexhub-remote-client-sha256", bundle.hash);
    return reply.send(bundle.content);
  });

  app.get("/api/plugins", async () => ({ plugins: await ctx.plugins.listPlugins() } satisfies PluginsPayload));
  app.get("/api/plugins/:pluginId/assets/*", async (request, reply) => {
    const params = z.object({ pluginId: z.string().min(1), "*": z.string().min(1) }).parse(request.params);
    try {
      const filePath = await ctx.plugins.resolveAsset(params.pluginId, params["*"]);
      reply.type(contentType(filePath));
      return reply.send(createReadStream(filePath));
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/ssh/connect", async (request, reply) => {
    if (!ctx.sshEnabled) return reply.code(404).send({ error: "ssh_disabled" });
    const input = sshConnectSchema.parse(request.body);
    try {
      return { ok: true, connection: ctx.sshMachines.connect(input) } satisfies SshConnectionPayload;
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/ssh/connections/:connectionId", async (request, reply) => {
    if (!ctx.sshEnabled) return reply.code(404).send({ error: "ssh_disabled" });
    const params = z.object({ connectionId: z.string().min(1) }).parse(request.params);
    try {
      return { ok: true, connection: await ctx.sshMachines.stop(params.connectionId) } satisfies SshConnectionPayload;
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/machines/:machineId/directories", async (request, reply) => {
    const params = z.object({ machineId: z.string().min(1) }).parse(request.params);
    const query = z.object({ path: z.string().optional() }).parse(request.query);
    try {
      return await ctx.machines.listDirectory(params.machineId, { cwd: query.path }).promise satisfies MachineDirectoryListing;
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
};
