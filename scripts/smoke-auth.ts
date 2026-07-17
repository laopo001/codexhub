import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { apiJson } from "./smoke/support/http.js";
import { findFreePort } from "./smoke/support/network.js";
import { delay } from "./smoke/support/time.js";

const main = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-auth."));
  const dataDir = path.join(root, "state");
  const previewPath = path.join(root, "preview.png");
  const remoteClientPath = path.join(root, "remote-client.cjs");
  await mkdir(dataDir, { recursive: true });
  await writeFile(previewPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeFile(remoteClientPath, "console.log('auth smoke remote client');\n");

  process.env.CODEX_HUB_DATA_DIR = dataDir;
  process.env.CODEX_HUB_LOCAL_MACHINE = "0";
  process.env.CODEX_HUB_PLUGIN_TELEGRAM = "0";
  process.env.CODEX_HUB_SSH_REMOTE_CLIENT_PATH = remoteClientPath;
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
    await expectStatus(apiBase, `/api/projects?token=${encodeURIComponent(token)}`, 401);
    await expectStatus(apiBase, `/api/projects?codexhub_token=${encodeURIComponent(token)}`, 401);
    await expectStatus(apiBase, "/api/projects", 401, {
      headers: { "x-codexhub-token": token }
    });
    const projects = await apiJson<{ projects?: unknown[] }>(apiBase, "/api/projects", authInit(token));
    if (!Array.isArray(projects.projects)) throw new Error(`authorized projects response mismatch: ${JSON.stringify(projects)}`);

    const authStatus = await apiJson<{ authenticated?: boolean }>(apiBase, "/api/auth/status", authInit(token));
    if (!authStatus.authenticated) throw new Error(`auth status did not accept bearer token: ${JSON.stringify(authStatus)}`);

    await assertFileQueryAuth(apiBase, token, previewPath);
    await assertRegisteredBootstrapBearer(apiBase, token);
    await assertRealtimeWebSocket(apiBase, token);
    await assertMachineWebSocket(apiBase, token);
    console.log("auth smoke ok");
  } finally {
    await server.stop();
  }
};

const assertFileQueryAuth = async (apiBase: string, token: string, previewPath: string) => {
  const url = new URL("/api/file", apiBase);
  url.searchParams.set("path", previewPath);
  await expectStatus(apiBase, `${url.pathname}${url.search}`, 401);
  url.searchParams.set("codexhub_token", token);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200 || response.headers.get("content-type") !== "image/png") {
    throw new Error(`file query auth failed: HTTP ${response.status} ${await response.text()}`);
  }
};

const assertRegisteredBootstrapBearer = async (apiBase: string, token: string) => {
  const response = await fetch(new URL("/api/registered/bootstrap", apiBase), {
    ...authInit(token),
    signal: AbortSignal.timeout(30_000)
  });
  const script = await response.text();
  if (!response.ok || !script.includes(`CODEX_HUB_AUTH_TOKEN='${token}'`)) {
    throw new Error(`registered bootstrap did not preserve bearer auth: HTTP ${response.status} ${script}`);
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

const expectStatus = async (apiBase: string, pathname: string, status: number, init: RequestInit = {}) => {
  const response = await fetch(new URL(pathname, apiBase), {
    ...init,
    signal: AbortSignal.timeout(30_000)
  });
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

await main();
