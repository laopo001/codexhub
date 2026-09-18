import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { findFreePort } from "../../src/server/embedded.js";
import { startServer, type ServerHandle } from "../../src/server/index.js";

const require = createRequire(import.meta.url);
const mockWebSocketModule = require.resolve("ws");

// Only the app-server methods exercised by these black-box tests are mocked.
const MOCK_CODEX = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const { WebSocketServer } = require(process.env.MOCK_CODEX_WS_MODULE);
const version = "0.144.4";
if (process.argv.includes("--version")) { process.stdout.write("codex " + version + "\n"); process.exit(0); }

const listenIndex = process.argv.indexOf("--listen");
const port = Number(new URL(process.argv[listenIndex + 1]).port);
const stateFile = process.env.MOCK_CODEX_STATE_FILE;
let starts;
try { starts = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { starts = { startCount: 0, pids: [] }; }
starts.startCount = Number(starts.startCount || 0) + 1;
starts.pids = Array.isArray(starts.pids) ? [...starts.pids, process.pid] : [process.pid];
fs.writeFileSync(stateFile, JSON.stringify(starts));

const sockets = new Set();
const threads = new Map();
let threadNumber = 0;
let turnNumber = 0;
const send = (socket, value) => { if (socket.readyState === 1) socket.send(JSON.stringify(value)); };
const broadcast = (value) => { for (const socket of sockets) send(socket, value); };
const summary = (thread, turns = false) => ({ id: thread.id, cwd: thread.cwd, name: thread.name, title: thread.title, createdAt: Math.floor(new Date(thread.createdAt).getTime() / 1000), updatedAt: Math.floor(new Date(thread.updatedAt).getTime() / 1000), ...(thread.model ? { model: thread.model, reasoningEffort: thread.effort } : {}), ...(turns ? { turns: thread.turns } : {}) });

const handle = (socket, message) => {
  if (message.id === undefined) return;
  const params = message.params && typeof message.params === "object" ? message.params : {};
  const method = message.method;
  let result = {};
  let error;
  let afterReply;
  if (method === "initialize") result = { userAgent: "codex_cli_rs/" + version, codexHome: "/tmp/mock-codex-home" };
  else if (method === "account/rateLimits/read") result = { rateLimits: null };
  else if (method === "model/list") result = { data: [{ id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "gpt-5.6-luna", description: "Fixture model", defaultReasoningEffort: "xhigh", supportedReasoningEfforts: [{ reasoningEffort: "xhigh", description: "Fixture effort" }], isDefault: true }], nextCursor: null };
  else if (method === "thread/list") result = { data: [...threads.values()].filter(thread => !params.cwd || thread.cwd === params.cwd).map(thread => summary(thread)), nextCursor: null };
  else if (method === "thread/name/set") {
    const thread = threads.get(params.threadId);
    if (thread) { thread.name = params.name; thread.title = params.name; }
  }
  else if (method === "thread/start") {
    const now = new Date().toISOString();
    const id = "mock-thread-" + process.pid + "-" + (++threadNumber);
    const thread = { id, cwd: typeof params.cwd === "string" ? params.cwd : process.cwd(), name: id, title: id, createdAt: now, updatedAt: now, turns: [] };
    threads.set(id, thread);
    result = { thread: summary(thread) };
  } else if (method === "thread/resume") {
    const thread = threads.get(params.threadId);
    if (thread) result = { thread: summary(thread) };
    else error = "thread not found: " + String(params.threadId);
  } else if (method === "thread/goal/get") result = { goal: null };
  else if (method === "thread/backgroundTerminals/list") result = { data: [], nextCursor: null };
  else if (method === "thread/unsubscribe") result = { status: "unsubscribed" };
  else if (method === "thread/turns/list") {
    const thread = threads.get(params.threadId);
    result = { data: thread ? [...thread.turns].reverse() : [], nextCursor: null };
  } else if (method === "turn/steer") {
    const thread = threads.get(params.threadId);
    const turn = thread && thread.turns.find(turn => turn.id === params.expectedTurnId && turn.status === "inProgress");
    if (!turn) error = "no active turn to steer";
    else {
      const userItem = { id: "guidance-" + turn.id + "-" + turn.items.length, type: "userMessage", content: params.input };
      turn.items.push(userItem);
      result = { turnId: turn.id };
      afterReply = () => broadcast({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item: userItem } });
    }
  } else if (method === "turn/start") {
    const thread = threads.get(params.threadId);
    if (!thread) error = "thread not found: " + String(params.threadId);
    else {
      starts.turnRequests = [...(starts.turnRequests || []), { model: params.model, effort: params.effort, threadId: params.threadId }];
      thread.model = params.model;
      thread.effort = params.effort;
      fs.writeFileSync(stateFile, JSON.stringify(starts));
      const startedAt = Date.now() / 1000;
      const turnId = "mock-turn-" + process.pid + "-" + (++turnNumber);
      const inputText = Array.isArray(params.input)
        ? params.input.filter((item) => item && typeof item === "object" && item.type === "text").map((item) => item.text).join("\n")
        : typeof params.input === "string" ? params.input : "";
      const userItem = { id: "mock-user-" + turnId, type: "userMessage", content: [{ type: "text", text: inputText }] };
      const item = { id: "mock-item-" + turnId, type: "agentMessage", text: "mock response" };
      const turn = { id: turnId, status: "completed", itemsView: "full", error: null, startedAt, completedAt: startedAt + 0.01, durationMs: 10, items: [userItem, item] };
      const delay = Number(process.env.MOCK_CODEX_TURN_DELAY_MS || "0");
      if (delay > 0) { turn.status = "inProgress"; turn.completedAt = null; turn.durationMs = null; turn.items = [userItem]; }
      thread.turns.push(turn);
      thread.updatedAt = new Date().toISOString();
      result = { turn: { id: turnId, status: "inProgress" } };
      afterReply = () => setTimeout(() => {
        broadcast({ method: "turn/started", params: { threadId: thread.id, turn: { id: turnId, status: "inProgress", startedAt } } });
        broadcast({ method: "item/completed", params: { threadId: thread.id, turnId, item: userItem } });
        if (process.env.MOCK_CODEX_RICH_TURNS === "1") {
          const commentary = { id: "commentary-" + turnId, type: "agentMessage", phase: "commentary", text: "正在检查委派任务的项目结构。" };
          const command = { id: "command-" + turnId, type: "commandExecution", command: "printf 'delegate web verification'", cwd: thread.cwd, status: "completed", aggregatedOutput: "delegate web verification\n", exitCode: 0, durationMs: 5 };
          turn.items.splice(1, 0, commentary, command);
          broadcast({ method: "item/completed", params: { threadId: thread.id, turnId, item: commentary } });
          broadcast({ method: "item/completed", params: { threadId: thread.id, turnId, item: command } });
        }
        const finish = () => {
          turn.status = "completed";
          turn.completedAt = Date.now() / 1000;
          turn.durationMs = Math.round((turn.completedAt - startedAt) * 1000);
          if (!turn.items.includes(item)) turn.items.push(item);
          broadcast({ method: "item/completed", params: { threadId: thread.id, turnId, item } });
          broadcast({ method: "turn/completed", params: { threadId: thread.id, turn } });
        };
        if (delay > 0) setTimeout(finish, delay); else finish();
      }, 10);
    }
  }
  send(socket, error ? { id: message.id, error: { code: -32000, message: error } } : { id: message.id, result });
  afterReply?.();
};

const server = http.createServer((request, response) => {
  if (request.url === "/readyz") { response.writeHead(200); response.end("ready"); return; }
  response.writeHead(404); response.end();
});
const webSocketServer = new WebSocketServer({ server });
webSocketServer.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("message", (data) => { try { handle(socket, JSON.parse(String(data))); } catch (cause) { send(socket, { error: { code: -32700, message: String(cause) } }); } });
  socket.on("close", () => sockets.delete(socket));
});
const shutdown = () => {
  for (const socket of sockets) socket.close();
  webSocketServer.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
server.listen(port, "127.0.0.1");
`;

export type MockCodexStats = { startCount: number; pids: number[]; turnRequests?: Array<{ model?: string; effort?: string; threadId: string }> };
export type ApiResult<T> = { status: number; body: T };

export type BackendRegistrationFixture = {
  root: string;
  parentUrl: string;
  childUrl: string;
  childLocalMachineId: string;
  parentAuthToken: string;
  childAuthToken: string;
  get parent(): ServerHandle;
  child: ServerHandle;
  readMockCodexStats: () => Promise<MockCodexStats>;
  startParent: () => Promise<void>;
  stopParent: () => Promise<void>;
  restartParent: () => Promise<void>;
  stop: () => Promise<void>;
};

export const createBackendRegistrationFixture = async (
  options: { childLocalMachine?: boolean; childPort?: number; richTurns?: boolean; turnDelayMs?: number } = {}
): Promise<BackendRegistrationFixture> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-backend-registration."));
  const mockPath = path.join(root, "mock-codex.cjs");
  const statsPath = path.join(root, "mock-codex-state.json");
  const childLocalMachineId = `backend-registration-local-${process.pid}`;
  const parentAuthToken = "backend-registration-parent-auth";
  const childAuthToken = "backend-registration-child-auth";
  await writeFile(mockPath, MOCK_CODEX, { mode: 0o755 });
  await chmod(mockPath, 0o755);
  await writeFile(statsPath, JSON.stringify({ startCount: 0, pids: [] }));

  const envKeys = ["CODEX_HUB_CODEX_CLI", "MOCK_CODEX_STATE_FILE", "MOCK_CODEX_WS_MODULE", "MOCK_CODEX_RICH_TURNS", "MOCK_CODEX_TURN_DELAY_MS", "CODEX_HUB_APP_SERVER_READY_TIMEOUT_MS", "CODEX_HUB_PLUGIN_TELEGRAM", "CODEX_HUB_LOCAL_MACHINE_ID", "CODEX_HUB_LOCAL_MACHINE_NAME", "CODEX_HUB_NTFY_URL"] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    CODEX_HUB_CODEX_CLI: mockPath,
    MOCK_CODEX_STATE_FILE: statsPath,
    MOCK_CODEX_WS_MODULE: mockWebSocketModule,
    MOCK_CODEX_RICH_TURNS: options.richTurns ? "1" : "0",
    MOCK_CODEX_TURN_DELAY_MS: String(options.turnDelayMs ?? 0),
    CODEX_HUB_APP_SERVER_READY_TIMEOUT_MS: "5000",
    CODEX_HUB_PLUGIN_TELEGRAM: "0",
    CODEX_HUB_LOCAL_MACHINE_ID: childLocalMachineId,
    CODEX_HUB_LOCAL_MACHINE_NAME: "Backend registration child",
    CODEX_HUB_NTFY_URL: ""
  });

  const parentPort = await findFreePort("127.0.0.1");
  const childPort = options.childPort ?? await findFreePort("127.0.0.1");
  const parentOptions = { host: "127.0.0.1", port: parentPort, dataDir: path.join(root, "parent-data"), authToken: parentAuthToken, autoStartRuntime: true, features: { localMachine: false, ssh: false, tasks: false, integrations: false } } as const;
  const childOptions = { host: "127.0.0.1", port: childPort, dataDir: path.join(root, "child-data"), authToken: childAuthToken, autoStartRuntime: true, features: { localMachine: options.childLocalMachine ?? true, ssh: false, tasks: false, integrations: false } } as const;
  let parent: ServerHandle | undefined;
  let child: ServerHandle | undefined;
  let stopped = false;
  const restore = () => {
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await child?.stop().catch(() => undefined);
    await parent?.stop().catch(() => undefined);
    restore();
    await rm(root, { recursive: true, force: true });
  };
  try {
    parent = await startServer(parentOptions);
    child = await startServer(childOptions);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    root,
    parentUrl: `http://127.0.0.1:${parentPort}`,
    childUrl: `http://127.0.0.1:${childPort}`,
    childLocalMachineId,
    parentAuthToken,
    childAuthToken,
    get parent() {
      if (!parent) throw new Error("Parent server is not running");
      return parent;
    },
    get child() {
      if (!child) throw new Error("Child server is not running");
      return child;
    },
    readMockCodexStats: async () => JSON.parse(await readFile(statsPath, "utf8")) as MockCodexStats,
    startParent: async () => {
      if (parent) throw new Error("Parent server is already running");
      parent = await startServer(parentOptions);
    },
    stopParent: async () => {
      if (!parent) return;
      await parent.stop();
      parent = undefined;
    },
    restartParent: async () => {
      if (!parent) throw new Error("Parent server is not running");
      await parent.stop();
      parent = await startServer(parentOptions);
    },
    stop
  };
};

export const apiJson = async <T>(apiBase: string, pathname: string, token: string, init: RequestInit = {}): Promise<ApiResult<T>> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(new URL(pathname, apiBase), { ...init, headers, signal: init.signal ?? AbortSignal.timeout(5_000) });
  const text = await response.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  return { status: response.status, body: body as T };
};

export const waitFor = async <T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, label: string, timeoutMs = 10_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (predicate(value)) return value;
    } catch { /* transient during startup/restart */ }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

export const subscribeRealtimeThread = async (apiBase: string, token: string, threadId: string) => {
  const url = new URL("/api/events/ws", apiBase);
  url.protocol = "ws:";
  url.searchParams.set("codexhub_token", token);
  const socket = new WebSocket(url.toString());
  const messages: unknown[] = [];
  socket.on("message", (data) => { try { messages.push(JSON.parse(String(data))); } catch { /* ignore */ } });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "subscribe_thread", threadId, after: 0 }));
  await waitFor(() => messages, (items) => items.some((item) => isMessage(item, "thread_subscribed", threadId)), `thread subscription ${threadId}`);
  return { messages, close: async () => { if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); } };
};

const isMessage = (value: unknown, type: string, threadId: string) => {
  if (!value || typeof value !== "object") return false;
  const message = value as { type?: unknown; threadId?: unknown };
  return message.type === type && message.threadId === threadId;
};
