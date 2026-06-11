import type React from "react";
import { apiJson } from "../appHelpers.js";
import type { ServerConnection, ServerConnectionDraft } from "../types.js";

type ServerConnectionsPayload = {
  connections?: ServerConnection[];
};

type ServerConnectionPayload = {
  connection?: ServerConnection;
};

type ServerConnectionActionsContext = {
  serverConnectionDraft: ServerConnectionDraft;
  setServerConnectionBusyId: React.Dispatch<React.SetStateAction<string>>;
  setServerConnectionDraft: React.Dispatch<React.SetStateAction<ServerConnectionDraft>>;
  setServerConnectionError: React.Dispatch<React.SetStateAction<string>>;
  setServerConnections: React.Dispatch<React.SetStateAction<ServerConnection[]>>;
};

export type ServerConnectionActions = {
  refreshServerConnections: () => Promise<void>;
  addServerConnection: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  connectServerConnection: (connectionId: string) => Promise<void>;
  disconnectServerConnection: (connectionId: string) => Promise<void>;
  removeServerConnection: (connection: ServerConnection) => Promise<void>;
  toggleServerConnectionEnabled: (connection: ServerConnection) => Promise<void>;
};

export const createServerConnectionActions = (
  ctx: ServerConnectionActionsContext,
  _actions: unknown
): ServerConnectionActions => {
  const refreshServerConnections = async () => {
    const payload = await apiJson<ServerConnectionsPayload>("/api/server-connections");
    ctx.setServerConnections(Array.isArray(payload.connections) ? payload.connections : []);
  };

  const addServerConnection = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const rawUrl = ctx.serverConnectionDraft.url.trim();
    if (!rawUrl) return;
    ctx.setServerConnectionError("");
    ctx.setServerConnectionBusyId("new");
    try {
      const parsed = parseServerConnectionUrlInput(rawUrl);
      const payload = await apiJson<ServerConnectionPayload>("/api/server-connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: parsed.url,
          name: ctx.serverConnectionDraft.name.trim() || undefined,
          authToken: parsed.authToken,
          enabled: true
        })
      });
      if (payload.connection) {
        ctx.setServerConnections((current) => upsertServerConnection(current, payload.connection!));
      }
      ctx.setServerConnectionDraft({ name: "", url: "" });
      await refreshServerConnections().catch(() => undefined);
    } catch (error) {
      ctx.setServerConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setServerConnectionBusyId((current) => current === "new" ? "" : current);
    }
  };

  const connectServerConnection = async (connectionId: string) => {
    await runConnectionAction(connectionId, "connect");
  };

  const disconnectServerConnection = async (connectionId: string) => {
    await runConnectionAction(connectionId, "disconnect");
  };

  const toggleServerConnectionEnabled = async (connection: ServerConnection) => {
    ctx.setServerConnectionError("");
    ctx.setServerConnectionBusyId(connection.connectionId);
    try {
      const payload = await apiJson<ServerConnectionPayload>(`/api/server-connections/${encodeURIComponent(connection.connectionId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !connection.enabled })
      });
      if (payload.connection) {
        ctx.setServerConnections((current) => upsertServerConnection(current, payload.connection!));
      }
      await refreshServerConnections().catch(() => undefined);
    } catch (error) {
      ctx.setServerConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setServerConnectionBusyId((current) => current === connection.connectionId ? "" : current);
    }
  };

  const removeServerConnection = async (connection: ServerConnection) => {
    if (!window.confirm(`Remove server connection ${connection.name}?`)) return;
    ctx.setServerConnectionError("");
    ctx.setServerConnectionBusyId(connection.connectionId);
    try {
      await apiJson<ServerConnectionsPayload>(`/api/server-connections/${encodeURIComponent(connection.connectionId)}`, {
        method: "DELETE"
      });
      ctx.setServerConnections((current) => current.filter((item) => item.connectionId !== connection.connectionId));
      await refreshServerConnections().catch(() => undefined);
    } catch (error) {
      ctx.setServerConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setServerConnectionBusyId((current) => current === connection.connectionId ? "" : current);
    }
  };

  const runConnectionAction = async (connectionId: string, action: "connect" | "disconnect") => {
    ctx.setServerConnectionError("");
    ctx.setServerConnectionBusyId(connectionId);
    try {
      const payload = await apiJson<ServerConnectionPayload>(
        `/api/server-connections/${encodeURIComponent(connectionId)}/${action}`,
        { method: "POST" }
      );
      if (payload.connection) {
        ctx.setServerConnections((current) => upsertServerConnection(current, payload.connection!));
      }
      await refreshServerConnections().catch(() => undefined);
    } catch (error) {
      ctx.setServerConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      ctx.setServerConnectionBusyId((current) => current === connectionId ? "" : current);
    }
  };

  return {
    refreshServerConnections,
    addServerConnection,
    connectServerConnection,
    disconnectServerConnection,
    removeServerConnection,
    toggleServerConnectionEnabled
  };
};

const upsertServerConnection = (connections: ServerConnection[], connection: ServerConnection) =>
  [connection, ...connections.filter((item) => item.connectionId !== connection.connectionId)];

const parseServerConnectionUrlInput = (value: string) => {
  const raw = value.trim();
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported server URL protocol: ${url.protocol}`);
  }
  if (!url.hostname) throw new Error("Server host is required.");
  const authToken = url.searchParams.get("token")?.trim()
    || url.searchParams.get("codexhub_token")?.trim()
    || undefined;
  url.searchParams.delete("token");
  url.searchParams.delete("codexhub_token");
  url.hash = "";
  return { url: url.toString(), authToken };
};
