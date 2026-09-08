import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { findFreePort } from "../../src/server/embedded.js";

const require = createRequire(import.meta.url);
const mockWebSocketModule = require.resolve("ws");

const FAKE_CODEX = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const { WebSocketServer } = require(process.env.MOCK_CODEX_WS_MODULE);
const version = "0.144.4";
if (process.argv.includes("--version")) { process.stdout.write("codex " + version + "\n"); process.exit(0); }
if (process.env.MOCK_CODEX_FAIL === "1") { process.stderr.write("fake startup " + (process.env.CODEX_HUB_AUTH_TOKEN || "secret-token") + "\n"); process.exit(1); }
const listenIndex = process.argv.indexOf("--listen");
const port = Number(new URL(process.argv[listenIndex + 1]).port);
const stateFile = process.env.MOCK_CODEX_STATE_FILE;
let stats;
try { stats = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { stats = { startCount: 0, pids: [] }; }
stats.startCount = Number(stats.startCount || 0) + 1;
stats.pids = Array.isArray(stats.pids) ? [...stats.pids, process.pid] : [process.pid];
fs.writeFileSync(stateFile, JSON.stringify(stats));
const sockets = new Set();
const threads = new Map();
let threadNumber = 0;
let turnNumber = 0;
const nowSeconds = () => Date.now() / 1000;
const summary = (thread, turns = false) => ({ id: thread.id, cwd: thread.cwd, name: thread.name, title: thread.title, createdAt: Math.floor(new Date(thread.createdAt).getTime() / 1000), updatedAt: Math.floor(new Date(thread.updatedAt).getTime() / 1000), ...(turns ? { turns: thread.turns } : {}) });
const send = (socket, value) => { if (socket.readyState === 1) socket.send(JSON.stringify(value)); };
const broadcast = (value) => { for (const socket of sockets) send(socket, value); };
const inputText = (input) => Array.isArray(input) ? input.filter((item) => item && item.type === "text").map((item) => item.text).join("\n") : typeof input === "string" ? input : "";
const handle = (socket, message) => {
  if (message.id === undefined) return;
  const params = message.params && typeof message.params === "object" ? message.params : {};
  const method = message.method;
  let result = {};
  let error;
  let afterReply;
  if (method === "initialize") result = { userAgent: "codex_cli_rs/" + version, codexHome: "/tmp/local-autostart-fake-codex" };
  else if (method === "account/rateLimits/read") result = { rateLimits: null };
  else if (method === "model/list") result = { data: [], nextCursor: null };
  else if (method === "thread/goal/get") result = { goal: null };
  else if (method === "thread/backgroundTerminals/list") result = { data: [], nextCursor: null };
  else if (method === "thread/unsubscribe") result = { status: "unsubscribed" };
  else if (method === "thread/list") result = { data: [...threads.values()].map((thread) => summary(thread)), nextCursor: null };
  else if (method === "thread/turns/list") {
    const thread = threads.get(params.threadId);
    result = { data: thread ? [...thread.turns].reverse() : [], nextCursor: null };
  } else if (method === "thread/start") {
    const createdAt = new Date().toISOString();
    const id = "local-thread-" + process.pid + "-" + (++threadNumber);
    const thread = { id, cwd: typeof params.cwd === "string" ? params.cwd : process.cwd(), name: id, title: id, createdAt, updatedAt: createdAt, turns: [] };
    threads.set(id, thread);
    result = { thread: summary(thread) };
  } else if (method === "thread/resume") {
    const thread = threads.get(params.threadId);
    if (thread) result = { thread: summary(thread) };
    else error = "thread not found: " + String(params.threadId);
  } else if (method === "thread/name/set") {
    const thread = threads.get(params.threadId);
    if (thread) { thread.name = params.name; thread.title = params.name; thread.updatedAt = new Date().toISOString(); }
  } else if (method === "turn/start") {
    const thread = threads.get(params.threadId);
    if (!thread) error = "thread not found: " + String(params.threadId);
    else {
      const turnId = "local-turn-" + process.pid + "-" + (++turnNumber);
      const startedAt = nowSeconds();
      const text = inputText(params.input);
      const userItem = { id: "local-user-" + turnId, type: "userMessage", content: [{ type: "text", text }] };
      const assistantItem = { id: "local-assistant-" + turnId, type: "agentMessage", text: "fake local response" };
      const turn = { id: turnId, status: "completed", itemsView: "full", error: null, startedAt, completedAt: startedAt + 0.01, durationMs: 10, items: [userItem, assistantItem] };
      thread.turns.push(turn);
      thread.updatedAt = new Date().toISOString();
      result = { turn: { id: turnId, status: "inProgress" } };
      afterReply = () => setTimeout(() => {
        broadcast({ method: "turn/started", params: { threadId: thread.id, turn: { id: turnId, status: "inProgress", startedAt } } });
        broadcast({ method: "item/completed", params: { threadId: thread.id, turnId, item: userItem } });
        broadcast({ method: "item/completed", params: { threadId: thread.id, turnId, item: assistantItem } });
        broadcast({ method: "turn/completed", params: { threadId: thread.id, turn } });
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
const shutdown = () => { for (const socket of sockets) socket.close(); webSocketServer.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
server.listen(port, "127.0.0.1");
`;

export type LocalServerAutostartFixture = {
  root: string;
  dataDir: string;
  mockCodexPath: string;
  statsPath: string;
  port: number;
  url: string;
  authToken: string;
  runCli: (args: string[], options?: { built?: boolean; env?: NodeJS.ProcessEnv }) => Promise<CliResult>;
  readStats: () => Promise<{ startCount: number; pids: number[] }>;
  serverPid: () => Promise<number | undefined>;
  stopServer: () => Promise<void>;
  close: () => Promise<void>;
};

type CliResult = { code: number | null; stdout: string; stderr: string };

const projectRoot = path.resolve(import.meta.dirname, "../..");
const tsxCli = path.join(projectRoot, "node_modules/tsx/dist/cli.mjs");

export const createLocalServerAutostartFixture = async (): Promise<LocalServerAutostartFixture> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-local-autostart."));
  const dataDir = path.join(root, "data");
  const mockCodexPath = path.join(root, "fake-codex.cjs");
  const statsPath = path.join(root, "stats.json");
  const port = await findFreePort("127.0.0.1");
  const authToken = "local-autostart-test-secret";
  await writeFile(mockCodexPath, FAKE_CODEX, { mode: 0o755 });
  await chmod(mockCodexPath, 0o755);
  await writeFile(statsPath, JSON.stringify({ startCount: 0, pids: [] }));
  let stopped = false;

  const baseEnv = () => {
    const env = { ...process.env };
    delete env.CODEX_HUB_SERVER_URL;
    return {
      ...env,
      CODEX_HUB_DATA_DIR: dataDir,
      CODEX_HUB_HOST: "127.0.0.1",
      CODEX_HUB_PORT: String(port),
      CODEX_HUB_AUTH_TOKEN: authToken,
      CODEX_HUB_CODEX_CLI: mockCodexPath,
      MOCK_CODEX_STATE_FILE: statsPath,
      MOCK_CODEX_WS_MODULE: mockWebSocketModule,
      CODEX_HUB_APP_SERVER_READY_TIMEOUT_MS: "5000",
      CODEX_HUB_LOCAL_SERVER_START_TIMEOUT_MS: "15000",
      CODEX_HUB_PLUGIN_TELEGRAM: "0"
    };
  };
  const runCli = async (args: string[], options: { built?: boolean; env?: NodeJS.ProcessEnv } = {}) => {
    const commandArgs = options.built
      ? [path.join(projectRoot, "bin/codexhub"), ...args]
      : [tsxCli, "src/cli/codexhub.ts", ...args];
    const child = spawn(process.execPath, commandArgs, {
      cwd: projectRoot,
      env: { ...baseEnv(), ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout: Buffer.concat(stdout).toString("utf8").trim(), stderr: Buffer.concat(stderr).toString("utf8").trim() };
  };
  const readStats = async () => JSON.parse(await readFile(statsPath, "utf8")) as { startCount: number; pids: number[] };
  const serverPid = async () => {
    try {
      const response = await fetch(`${"http://127.0.0.1:" + port}/api/machines`, { headers: { authorization: `Bearer ${authToken}` } });
      if (!response.ok) return undefined;
      const payload = await response.json() as { machines?: Array<{ pid?: number }> };
      return payload.machines?.find((machine) => typeof machine.pid === "number")?.pid;
    } catch {
      return undefined;
    }
  };
  const stopServer = async () => {
    const pid = await serverPid();
    if (pid && pid !== process.pid) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
      await waitForProcessExit(pid, 10_000);
    }
  };
  const close = async () => {
    if (stopped) return;
    stopped = true;
    await stopServer();
    await rm(root, { recursive: true, force: true });
  };
  return { root, dataDir, mockCodexPath, statsPath, port, url: `http://127.0.0.1:${port}`, authToken, runCli, readStats, serverPid, stopServer, close };
};

const waitForProcessExit = async (pid: number, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
};

export const waitForFixture = async <T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
};
