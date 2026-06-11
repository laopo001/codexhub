import type React from "react";
import { apiJson } from "../appHelpers.js";
import type { SshConnection, SshHost } from "../types.js";

type SshHostsPayload = {
  hosts?: SshHost[];
};

type SshConnectionsPayload = {
  connections?: SshConnection[];
};

type SshConnectionPayload = {
  connection?: SshConnection;
};

type SshActionsContext = {
  registeredCommand: string;
  sshHostDraft: string;
  setRegisteredCommandCopied: React.Dispatch<React.SetStateAction<boolean>>;
  setSshConfigHosts: React.Dispatch<React.SetStateAction<SshHost[]>>;
  setSshConnectingHost: React.Dispatch<React.SetStateAction<string>>;
  setSshConnections: React.Dispatch<React.SetStateAction<SshConnection[]>>;
  setSshError: React.Dispatch<React.SetStateAction<string>>;
  setSshHostBusy: React.Dispatch<React.SetStateAction<string>>;
  setSshHostDraft: React.Dispatch<React.SetStateAction<string>>;
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
};

export const createSshActions = (ctx: SshActionsContext, _actions: unknown): SshActions => {
  const refreshSshHosts = async () => {
    const [hostData, configHostData] = await Promise.all([
      apiJson<SshHostsPayload>("/api/ssh/hosts"),
      apiJson<SshHostsPayload>("/api/ssh/config-hosts")
    ]);
    ctx.setSshHosts(Array.isArray(hostData.hosts) ? hostData.hosts : []);
    ctx.setSshConfigHosts(Array.isArray(configHostData.hosts) ? configHostData.hosts : []);
  };

  const refreshSshConnections = async () => {
    const payload = await apiJson<SshConnectionsPayload>("/api/ssh/connections");
    ctx.setSshConnections(Array.isArray(payload.connections) ? payload.connections : []);
  };

  const addSshHost = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const alias = ctx.sshHostDraft.trim();
    if (!alias) return;
    ctx.setSshError("");
    ctx.setSshHostBusy(alias);
    try {
      const payload = await apiJson<SshHostsPayload>("/api/ssh/hosts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alias })
      });
      ctx.setSshHosts(Array.isArray(payload.hosts) ? payload.hosts : []);
      await refreshSshHosts().catch(() => undefined);
      ctx.setSshHostDraft("");
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
      const payload = await apiJson<SshConnectionPayload>("/api/ssh/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: trimmedHost, name })
      });
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
      const payload = await apiJson<SshConnectionPayload>(`/api/ssh/connections/${encodeURIComponent(connectionId)}`, {
        method: "DELETE"
      });
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
      const payload = await apiJson<SshHostsPayload>(`/api/ssh/hosts/${encodeURIComponent(host.alias)}`, {
        method: "DELETE"
      });
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

  return {
    refreshSshHosts,
    refreshSshConnections,
    addSshHost,
    connectSshHost,
    stopSshConnection,
    removeSshHost,
    copyRegisteredCommand
  };
};
