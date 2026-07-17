import type React from "react";
import { apiRoutes } from "../../shared/apiRoutes.js";
import { apiRouteJson, type SidebarDraftStore } from "../appHelpers.js";
import type { ParentRegistrationStatus, SshConnection, SshHost } from "../types.js";

type SshActionsContext = {
  registeredCommand: string;
  sidebarDraftStore: SidebarDraftStore;
  setParentRegistration: React.Dispatch<React.SetStateAction<ParentRegistrationStatus>>;
  setParentRegistrationBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setParentRegistrationError: React.Dispatch<React.SetStateAction<string>>;
  setRegisteredCommandCopied: React.Dispatch<React.SetStateAction<boolean>>;
  setSshConfigHosts: React.Dispatch<React.SetStateAction<SshHost[]>>;
  setSshConnectingHost: React.Dispatch<React.SetStateAction<string>>;
  setSshConnections: React.Dispatch<React.SetStateAction<SshConnection[]>>;
  setSshError: React.Dispatch<React.SetStateAction<string>>;
  setSshHostBusy: React.Dispatch<React.SetStateAction<string>>;
  setSshHosts: React.Dispatch<React.SetStateAction<SshHost[]>>;
};

export type SshActions = {
  refreshSshHosts: () => Promise<void>;
  refreshSshConnections: () => Promise<void>;
  addSshHost: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  connectSshHost: (host: string, name?: string) => Promise<void>;
  stopSshConnection: (connectionId: string) => Promise<void>;
  removeSshHost: (host: SshHost, activeConnection?: SshConnection) => Promise<void>;
  copyRegisteredCommand: () => Promise<void>;
  refreshParentRegistration: () => Promise<void>;
  connectParentRegistration: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  disconnectParentRegistration: () => Promise<void>;
};

export const createSshActions = (ctx: SshActionsContext): SshActions => {
  const refreshSshHosts = async () => {
    const [hostData, configHostData] = await Promise.all([
      apiRouteJson(apiRoutes.sshHosts),
      apiRouteJson(apiRoutes.sshConfigHosts)
    ]);
    ctx.setSshHosts(Array.isArray(hostData.hosts) ? hostData.hosts : []);
    ctx.setSshConfigHosts(Array.isArray(configHostData.hosts) ? configHostData.hosts : []);
  };

  const refreshSshConnections = async () => {
    const payload = await apiRouteJson(apiRoutes.sshConnections);
    ctx.setSshConnections(Array.isArray(payload.connections) ? payload.connections : []);
  };

  const refreshParentRegistration = async () => {
    const payload = await apiRouteJson(apiRoutes.parentRegistration);
    ctx.setParentRegistration(payload.registration ?? { status: "idle" });
  };

  const addSshHost = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const alias = ctx.sidebarDraftStore.getSnapshot().sshHostDraft.trim();
    if (!alias) return;
    ctx.setSshError("");
    ctx.setSshHostBusy(alias);
    try {
      const payload = await apiRouteJson(apiRoutes.addSshHost, { alias });
      ctx.setSshHosts(Array.isArray(payload.hosts) ? payload.hosts : []);
      await refreshSshHosts().catch(() => undefined);
      ctx.sidebarDraftStore.set("sshHostDraft", "");
    } catch (error) {
      ctx.setSshError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setSshHostBusy((current) => current === alias ? "" : current);
    }
  };

  const connectSshHost = async (host: string, name?: string) => {
    const trimmedHost = host.trim();
    if (!trimmedHost) return;
    ctx.setSshError("");
    ctx.setSshConnectingHost(trimmedHost);
    try {
      const payload = await apiRouteJson(apiRoutes.connectSsh, { host: trimmedHost, name });
      const connection = payload.connection;
      if (connection) {
        ctx.setSshConnections((current) => [connection, ...current.filter((item) => item.connectionId !== connection.connectionId)]);
      }
      await refreshSshConnections().catch(() => undefined);
    } catch (error) {
      ctx.setSshError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setSshConnectingHost((current) => current === trimmedHost ? "" : current);
    }
  };

  const stopSshConnection = async (connectionId: string) => {
    try {
      const payload = await apiRouteJson(apiRoutes.stopSshConnection, connectionId);
      const connection = payload.connection;
      if (connection) {
        ctx.setSshConnections((current) => [connection, ...current.filter((item) => item.connectionId !== connectionId)]);
      }
      await refreshSshConnections().catch(() => undefined);
    } catch (error) {
      ctx.setSshError(error instanceof Error ? error.message : String(error));
    }
  };

  const removeSshHost = async (host: SshHost, activeConnection?: SshConnection) => {
    const suffix = activeConnection ? " and stop the current connection" : "";
    if (!window.confirm(`Remove ${host.alias} from CodexHub SSH hosts${suffix}?`)) return;
    ctx.setSshError("");
    ctx.setSshHostBusy(host.alias);
    try {
      const payload = await apiRouteJson(apiRoutes.removeSshHost, host.alias);
      ctx.setSshHosts(Array.isArray(payload.hosts) ? payload.hosts : []);
      await refreshSshHosts().catch(() => undefined);
      if (activeConnection) await stopSshConnection(activeConnection.connectionId);
    } catch (error) {
      ctx.setSshError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setSshHostBusy((current) => current === host.alias ? "" : current);
    }
  };

  const copyRegisteredCommand = async () => {
    await navigator.clipboard?.writeText(ctx.registeredCommand).catch(() => undefined);
    ctx.setRegisteredCommandCopied(true);
    window.setTimeout(() => ctx.setRegisteredCommandCopied(false), 1200);
  };

  const connectParentRegistration = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parentRegistrationDraft = ctx.sidebarDraftStore.getSnapshot().parentRegistrationDraft;
    let parsed: ReturnType<typeof parseParentRegistrationInput>;
    try {
      parsed = parseParentRegistrationInput(parentRegistrationDraft.url);
    } catch (error) {
      ctx.setParentRegistrationError(error instanceof Error ? error.message : String(error));
      return;
    }
    ctx.setParentRegistrationBusy(true);
    ctx.setParentRegistrationError("");
    try {
      const payload = await apiRouteJson(apiRoutes.connectParentRegistration, {
        url: parsed.url,
        authToken: parsed.authToken,
        machineId: parentRegistrationDraft.machineId.trim() || undefined,
        name: parentRegistrationDraft.name.trim() || undefined
      });
      ctx.setParentRegistration(payload.registration ?? { status: "idle" });
    } catch (error) {
      ctx.setParentRegistrationError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setParentRegistrationBusy(false);
    }
  };

  const disconnectParentRegistration = async () => {
    ctx.setParentRegistrationBusy(true);
    ctx.setParentRegistrationError("");
    try {
      const payload = await apiRouteJson(apiRoutes.disconnectParentRegistration);
      ctx.setParentRegistration(payload.registration ?? { status: "idle" });
    } catch (error) {
      ctx.setParentRegistrationError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setParentRegistrationBusy(false);
    }
  };

  return {
    refreshSshHosts,
    refreshSshConnections,
    addSshHost,
    connectSshHost,
    stopSshConnection,
    removeSshHost,
    copyRegisteredCommand,
    refreshParentRegistration,
    connectParentRegistration,
    disconnectParentRegistration
  };
};

const parseParentRegistrationInput = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Parent register URL is required.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Parent register URL must be a valid URL.");
  }
  const authToken = url.searchParams.get("codexhub_token")?.trim() || undefined;
  return {
    url: url.origin,
    authToken
  };
};
