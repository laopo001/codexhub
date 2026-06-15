import { isAppServerTunnelFrame, type AppServerTunnelFrame } from "./appServerTunnel.js";
import type { MachineCommand } from "./machineHub.js";
import type { SessionCommand } from "../shared/threadTypes.js";

export type MachineTransportMessage =
  | { type: "registered"; machineId: string; machine?: unknown }
  | { type: "commands"; cursor: number; commands: MachineCommand[] }
  | { type: "session_registered"; sessionId: string; session?: unknown }
  | { type: "session_commands"; sessionId: string; cursor: number; commands: SessionCommand[] }
  | { type: "session_error"; sessionId: string; message: string }
  | { type: "app_server_attached"; commandId: string; sessionId: string; threadId: string }
  | { type: "app_server_attach_error"; commandId: string; sessionId?: string; message: string }
  | AppServerTunnelFrame
  | { type: "error"; message: string };

export type MachineSessionTransportMessage = Extract<
  MachineTransportMessage,
  { type: "session_registered" | "session_commands" | "session_error" }
>;

export const machineTransportUrl = (apiBase: string, authToken?: string) => {
  const url = new URL("/api/machines/connect", apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (authToken?.trim()) url.searchParams.set("codexhub_token", authToken.trim());
  return url.toString();
};

export const parseMachineTransportMessage = (data: unknown): MachineTransportMessage | null => {
  const message = parseJsonRecord(data);
  if (!message) return null;
  // 这条 machine WebSocket 是长连接边界，坏消息要丢弃而不是打断 transport loop。
  if (isAppServerTunnelFrame(message)) return message;
  const type = typeof message.type === "string" ? message.type : "";
  if (type === "registered") {
    const machineId = typeof message.machineId === "string" ? message.machineId : "";
    return machineId ? { type: "registered", machineId, machine: message.machine } : null;
  }
  if (type === "commands") {
    const cursor = typeof message.cursor === "number" ? message.cursor : NaN;
    return Number.isFinite(cursor) && Array.isArray(message.commands)
      ? { type: "commands", cursor, commands: message.commands as MachineCommand[] }
      : null;
  }
  if (type === "session_registered") {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    return sessionId ? { type: "session_registered", sessionId, session: message.session } : null;
  }
  if (type === "session_commands") {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    const cursor = typeof message.cursor === "number" ? message.cursor : NaN;
    return sessionId && Number.isFinite(cursor) && Array.isArray(message.commands)
      ? { type: "session_commands", sessionId, cursor, commands: message.commands as SessionCommand[] }
      : null;
  }
  if (type === "session_error") {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    const messageText = typeof message.message === "string" ? message.message : "machine session server error";
    return sessionId ? { type: "session_error", sessionId, message: messageText } : null;
  }
  if (type === "app_server_attached") {
    const commandId = typeof message.commandId === "string" ? message.commandId : "";
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    const threadId = typeof message.threadId === "string" ? message.threadId : "";
    return commandId && sessionId && threadId ? { type: "app_server_attached", commandId, sessionId, threadId } : null;
  }
  if (type === "app_server_attach_error") {
    const commandId = typeof message.commandId === "string" ? message.commandId : "";
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    const messageText = typeof message.message === "string" ? message.message : "app-server attach failed";
    return commandId ? { type: "app_server_attach_error", commandId, sessionId, message: messageText } : null;
  }
  if (type === "error") {
    return { type: "error", message: typeof message.message === "string" ? message.message : "machine transport server error" };
  }
  return null;
};

type JsonRecord = Record<string, unknown>;

const parseJsonRecord = (data: unknown): JsonRecord | null => {
  try {
    if (typeof data === "string") return asRecord(JSON.parse(data));
    if (data instanceof ArrayBuffer) return asRecord(JSON.parse(Buffer.from(data).toString("utf8")));
    return asRecord(JSON.parse(String(data)));
  } catch {
    return null;
  }
};

const asRecord = (value: unknown): JsonRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
};
