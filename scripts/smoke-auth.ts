import { mkdir, mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const main = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-auth."));
  const dataDir = path.join(root, "state");
  await mkdir(dataDir, { recursive: true });

  process.env.CODEX_HUB_DATA_DIR = dataDir;
  process.env.CODEX_HUB_LOCAL_MACHINE = "0";
  process.env.CODEX_HUB_PLUGIN_TELEGRAM = "0";
  process.env.TELEGRAM_BOT_TOKEN = "";

  const port = await findFreePort();
  const token = `auth-smoke-${process.pid}`;
  const { startServer } = await import("../src/server/index.js");
  const server = await startServer({
    host: "127.0.0.1",
    port,
    authToken: token,
    features: {
      integrations: false,
      localMachine: false,
      ssh: false,
      tasks: false
    }
  });
  const apiBase = `http://127.0.0.1:${port}`;

  try {
    const health = await apiJson<{ authRequired?: boolean; authenticated?: boolean }>(apiBase, "/api/health");
    if (!health.authRequired || health.authenticated) {
      throw new Error(`health auth status mismatch: ${JSON.stringify(health)}`);
    }

    await expectStatus(apiBase, "/api/projects", 401);
    const projects = await apiJson<{ projects?: unknown[] }>(apiBase, "/api/projects", authInit(token));
    if (!Array.isArray(projects.projects)) throw new Error(`authorized projects response mismatch: ${JSON.stringify(projects)}`);

    const authStatus = await apiJson<{ authenticated?: boolean }>(apiBase, "/api/auth/status", authInit(token));
    if (!authStatus.authenticated) throw new Error(`auth status did not accept bearer token: ${JSON.stringify(authStatus)}`);

    await assertRealtimeWebSocket(apiBase, token);
    await assertMachineWebSocket(apiBase, token);
    console.log("auth smoke ok");
  } finally {
    await server.stop();
  }
};

const assertRealtimeWebSocket = async (apiBase: string, token: string) => {
  const ws = new WebSocket(webSocketUrl(apiBase, "/api/events/ws", token));
  const messages: unknown[] = [];
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  await waitForWebSocketOpen(ws, "authorized realtime websocket failed");
  ws.send(JSON.stringify({ type: "hello" }));
  await waitForMessage(messages, (message) => isRecord(message) && message.type === "ready", "realtime ready");
  ws.close();
};

const assertMachineWebSocket = async (apiBase: string, token: string) => {
  const machineId = `auth-smoke-machine-${process.pid}`;
  const ws = new WebSocket(webSocketUrl(apiBase, "/api/machines/connect", token));
  const messages: unknown[] = [];
  ws.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  await waitForWebSocketOpen(ws, "authorized machine websocket failed");
  ws.send(JSON.stringify({
    type: "register",
    commandCursor: 0,
    registration: {
      machineId,
      type: "registered",
      name: "Auth Smoke",
      hostname: "auth-smoke-host",
      capabilities: { projectLauncher: false }
    }
  }));
  await waitForMessage(messages, (message) => isRecord(message) && message.type === "registered" && message.machineId === machineId, "machine registered");
  ws.send(JSON.stringify({ type: "unregister" }));
  ws.close();
};

const apiJson = async <T = unknown>(apiBase: string, pathname: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(new URL(pathname, apiBase), {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${pathname}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
};

const expectStatus = async (apiBase: string, pathname: string, status: number) => {
  const response = await fetch(new URL(pathname, apiBase), { signal: AbortSignal.timeout(30_000) });
  if (response.status !== status) throw new Error(`expected HTTP ${status} for ${pathname}, got ${response.status}: ${await response.text()}`);
};

const authInit = (token: string): RequestInit => ({
  headers: { authorization: `Bearer ${token}` }
});

const webSocketUrl = (apiBase: string, pathname: string, token: string) => {
  const url = new URL(pathname, apiBase);
  url.protocol = "ws:";
  url.searchParams.set("codexhub_token", token);
  return url.toString();
};

const waitForWebSocketOpen = async (ws: WebSocket, label: string) => await new Promise<void>((resolve, reject) => {
  if (ws.readyState === WebSocket.OPEN) {
    resolve();
    return;
  }
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", () => reject(new Error(label)), { once: true });
});

const waitForMessage = async (
  messages: unknown[],
  predicate: (message: unknown) => boolean,
  label: string,
  timeoutMs = 5000
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const message = messages.find(predicate);
    if (message) return message;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const findFreePort = async () => await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close(() => reject(new Error("failed to allocate port")));
      return;
    }
    const port = address.port;
    server.close(() => resolve(port));
  });
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await main();
