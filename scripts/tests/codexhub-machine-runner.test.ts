import assert from "node:assert/strict";
import net, { type Socket } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startCodexhubMachine, type CodexhubMachineStatus } from "../../src/cli/codexhubMachine.js";
import { machineTransportUrl } from "../../src/core/machineTransportProtocol.js";

test("machine runner keeps empty auth tokens optional and redacts failed transport URLs", async () => {
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
  });
  const port = await listen(server);
  const apiBase = `http://127.0.0.1:${port}`;
  const secret = "runner-secret-token";
  const statuses: CodexhubMachineStatus[] = [];
  const runner = startCodexhubMachine({
    apiBase,
    authToken: secret,
    machineId: "machine-runner-redaction-test",
    onStatus: (status) => statuses.push(status)
  });
  try {
    const offline = await waitForStatus(statuses, "offline");
    assert.ok(offline.message?.includes("/api/machines/connect"));
    assert.ok(!offline.message?.includes(secret));
    assert.ok(!offline.message?.includes(encodeURIComponent(secret)));
    assert.equal(machineTransportUrl(apiBase, ""), `ws://127.0.0.1:${port}/api/machines/connect`);
  } finally {
    await runner.stop();
    await closeServer(server, sockets);
  }
});

test("machine runner aborts an in-flight websocket before stop resolves", async () => {
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.resume();
  });
  const port = await listen(server);
  const statuses: CodexhubMachineStatus[] = [];
  const runner = startCodexhubMachine({
    apiBase: `http://127.0.0.1:${port}`,
    machineId: "machine-runner-abort-test",
    onStatus: (status) => statuses.push(status)
  });
  try {
    await waitFor(() => sockets.size > 0, "websocket TCP connection");
    await Promise.race([
      runner.stop(),
      delay(2000).then(() => {
        throw new Error("machine runner stop timed out while websocket was connecting");
      })
    ]);
    await waitFor(() => sockets.size === 0, "aborted websocket close");
    assert.equal(statuses.at(-1)?.status, "stopped");
    assert.ok(!statuses.some((status) => status.status === "online"));
  } finally {
    await runner.stop();
    await closeServer(server, sockets);
  }
});

const listen = async (server: net.Server) => await new Promise<number>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("test server did not expose a TCP port"));
      return;
    }
    resolve(address.port);
  });
});

const closeServer = async (server: net.Server, sockets: Set<Socket>) => {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const waitForStatus = async (
  statuses: CodexhubMachineStatus[],
  expected: CodexhubMachineStatus["status"]
) => {
  await waitFor(() => statuses.some((status) => status.status === expected), `machine status ${expected}`);
  return statuses.find((status) => status.status === expected)!;
};

const waitFor = async (condition: () => boolean, label: string, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
};
