import assert from "node:assert/strict";
import net from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findFreePort,
  stableEmbeddedPortForName,
  startEmbeddedServer
} from "../../src/server/embedded.js";
import {
  authorityKind,
  authorityServicePort,
  authorityHostServicePort
} from "../../src/shared/surfaceTypes.js";
import { migrateLegacyEmbeddedAuthorityData } from "../../src/core/authorityPaths.js";

test("VSCode authority ports match across desktop hosts and reserve WSL plus one", () => {
  assert.equal(authorityHostServicePort, 28_788);
  assert.equal(authorityServicePort({}, "win32"), 28_788);
  assert.equal(authorityServicePort({}, "darwin"), 28_788);
  assert.equal(authorityServicePort({}, "linux"), 28_788);
  assert.equal(authorityServicePort({ WSL_DISTRO_NAME: "Ubuntu" }, "linux"), 28_789);
  assert.equal(authorityServicePort({ WSL_INTEROP: "/run/WSL/1_interop" }, "linux"), 28_789);
  assert.equal(authorityKind({}, "win32"), "windows");
  assert.equal(authorityKind({}, "darwin"), "macos");
  assert.equal(authorityKind({}, "linux"), "linux");
  assert.equal(authorityKind({ WSL_DISTRO_NAME: "Ubuntu" }, "linux"), "wsl");
});

test("embedded clients can use an explicit authority port for isolated development", () => {
  assert.equal(authorityServicePort({ CODEX_HUB_AUTHORITY_PORT: "30123" }, "linux"), 30_123);
  assert.equal(authorityServicePort({ CODEX_HUB_PORT: "30124" }, "linux"), 30_124);
  assert.equal(authorityServicePort({ CODEX_HUB_PORT: "30125", CODEX_HUB_AUTHORITY_PORT: "30125" }, "linux"), 30_125);
  assert.throws(
    () => authorityServicePort({ CODEX_HUB_PORT: "30125", CODEX_HUB_AUTHORITY_PORT: "30126" }, "linux"),
    /must match/
  );
  assert.throws(
    () => authorityServicePort({ CODEX_HUB_AUTHORITY_PORT: "not-a-port" }, "linux"),
    /Invalid CODEX_HUB_AUTHORITY_PORT/
  );
});

test("legacy VSCode authority data migrates without overwriting shared state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-authority-migration."));
  const legacyDir = path.join(root, "legacy");
  const sharedDir = path.join(root, "shared");
  try {
    await mkdir(legacyDir, { recursive: true });
    await writeFile(path.join(legacyDir, "config.yaml"), "version: 1\n");
    await writeFile(path.join(legacyDir, "vscode-authority-id"), "authority-legacy\n");
    assert.equal(await migrateLegacyEmbeddedAuthorityData(legacyDir, sharedDir), true);
    assert.equal(await readFile(path.join(sharedDir, "config.yaml"), "utf8"), "version: 1\n");
    assert.equal(await readFile(path.join(sharedDir, "vscode-authority-id"), "utf8"), "authority-legacy\n");

    await writeFile(path.join(sharedDir, "config.yaml"), "version: 2\n");
    assert.equal(await migrateLegacyEmbeddedAuthorityData(legacyDir, sharedDir), false);
    assert.equal(await readFile(path.join(sharedDir, "config.yaml"), "utf8"), "version: 2\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
