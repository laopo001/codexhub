// @ts-nocheck
import { apiJson } from "../appHelpers.js";

export const createSshActions = (ctx, _actions) => {
  const refreshSshHosts = async () => {
    const [hostData, configHostData] = await Promise.all([
      apiJson("/api/ssh/hosts"),
      apiJson("/api/ssh/config-hosts")
    ]);
    ctx.setSshHosts(Array.isArray(hostData.hosts) ? hostData.hosts : []);
    ctx.setSshConfigHosts(Array.isArray(configHostData.hosts) ? configHostData.hosts : []);
  };

  const refreshSshConnections = async () => {
    const payload = await apiJson("/api/ssh/connections");
    ctx.setSshConnections(Array.isArray(payload.connections) ? payload.connections : []);
  };

  const addSshHost = async (event) => {
    event.preventDefault();
    const alias = ctx.sshHostDraft.trim();
    if (!alias) return;
    ctx.setSshError("");
    ctx.setSshHostBusy(alias);
    try {
      const payload = await apiJson("/api/ssh/hosts", {
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

  const connectSshHost = async (host, name) => {
    const trimmedHost = host.trim();
    if (!trimmedHost) return;
    ctx.setSshError("");
    ctx.setSshConnectingHost(trimmedHost);
    try {
      const payload = await apiJson("/api/ssh/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: trimmedHost, name })
      });
      if (payload.connection) {
        ctx.setSshConnections((current) => [payload.connection, ...current.filter((item) => item.connectionId !== payload.connection.connectionId)]);
      }
      await refreshSshConnections().catch(() => undefined);
    } catch (error) {
      ctx.setSshError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setSshConnectingHost((current) => current === trimmedHost ? "" : current);
    }
  };

  const stopSshConnection = async (connectionId) => {
    try {
      const payload = await apiJson(`/api/ssh/connections/${encodeURIComponent(connectionId)}`, {
        method: "DELETE"
      });
      if (payload.connection) {
        ctx.setSshConnections((current) => [payload.connection, ...current.filter((item) => item.connectionId !== connectionId)]);
      }
      await refreshSshConnections().catch(() => undefined);
    } catch (error) {
      ctx.setSshError(error instanceof Error ? error.message : String(error));
    }
  };

  const removeSshHost = async (host, activeConnection) => {
    const suffix = activeConnection ? " and stop the current connection" : "";
    if (!window.confirm(`Remove ${host.alias} from CodexHub SSH hosts${suffix}?`)) return;
    ctx.setSshError("");
    ctx.setSshHostBusy(host.alias);
    try {
      const payload = await apiJson(`/api/ssh/hosts/${encodeURIComponent(host.alias)}`, {
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
