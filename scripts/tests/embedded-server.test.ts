import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findFreePort,
  stableEmbeddedPortForName,
  startEmbeddedServer
} from "../../src/server/embedded.js";
import {
  vscodeAuthorityKind,
  vscodeAuthorityServicePort,
  vscodeHostServicePort
} from "../../src/shared/surfaceTypes.js";

test("VSCode authority ports match across desktop hosts and reserve WSL plus one", () => {
  assert.equal(vscodeHostServicePort, 28_788);
  assert.equal(vscodeAuthorityServicePort({}, "win32"), 28_788);
  assert.equal(vscodeAuthorityServicePort({}, "darwin"), 28_788);
  assert.equal(vscodeAuthorityServicePort({}, "linux"), 28_788);
  assert.equal(vscodeAuthorityServicePort({ WSL_DISTRO_NAME: "Ubuntu" }, "linux"), 28_789);
  assert.equal(vscodeAuthorityServicePort({ WSL_INTEROP: "/run/WSL/1_interop" }, "linux"), 28_789);
  assert.equal(vscodeAuthorityKind({}, "win32"), "windows");
  assert.equal(vscodeAuthorityKind({}, "darwin"), "macos");
  assert.equal(vscodeAuthorityKind({}, "linux"), "linux");
  assert.equal(vscodeAuthorityKind({ WSL_DISTRO_NAME: "Ubuntu" }, "linux"), "wsl");
});

test("stable embedded ports are deterministic and stay inside the named range", () => {
  const first = stableEmbeddedPortForName("codexhub");
  assert.equal(first, stableEmbeddedPortForName("codexhub"));
  assert.ok(first >= 20_000 && first <= 29_999);
  assert.notEqual(first, stableEmbeddedPortForName("another-workspace"));
});

test("increment embedded port mode tries the next port when the preferred port is busy", async () => {
  const host = "127.0.0.1";
  const preferredPort = await findConsecutiveFreePorts(host);
  const blocker = net.createServer();
  await listen(blocker, preferredPort, host);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-embedded-port."));
  let server: Awaited<ReturnType<typeof startEmbeddedServer>> | undefined;
  try {
    server = await startEmbeddedServer({
      host,
      portMode: "increment",
      preferredPort,
      dataDir,
      features: {
        localMachine: false,
        ssh: false,
        tasks: false,
        integrations: false
      }
    });
    assert.equal(server.port, preferredPort + 1);
  } finally {
    await server?.stop();
    await close(blocker);
    await rm(dataDir, { recursive: true, force: true });
  }
});

const findConsecutiveFreePorts = async (host: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = await findFreePort(host);
    if (port >= 65_535) continue;
    const probe = net.createServer();
    try {
      await listen(probe, port + 1, host);
      return port;
    } catch {
      // Try another pair.
    } finally {
      await close(probe);
    }
  }
  throw new Error("Could not find two consecutive free ports for embedded server test.");
};

const listen = async (server: net.Server, port: number, host: string) =>
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

const close = async (server: net.Server) => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
};
