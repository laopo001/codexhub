import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  authorityServicePort,
  embeddedSurfaceProtocolVersion
} from "../src/shared/surfaceTypes.js";

const main = async () => {
  await prepareAuthorityPortForSmoke();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-electron-state."));
  const pluginDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-electron-plugins."));
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-electron-user-data."));
  const output = await runElectronSmoke(dataDir, pluginDir, userDataDir);
  const payload = parseSmokePayload(output);
  if (payload.health.port !== authorityServicePort()) {
    throw new Error(
      `Electron smoke did not use the shared authority port ${authorityServicePort()}: ${JSON.stringify(payload.health)}`
    );
  }
  if (!payload.health.authority || payload.health.authority.surfaceProtocolVersion !== embeddedSurfaceProtocolVersion) {
    throw new Error(`Electron smoke did not expose the shared authority descriptor: ${JSON.stringify(payload.health)}`);
  }
  if (!payload.url.includes("surface=electron") || !payload.url.includes("surfaceId=electron-")) {
    throw new Error(`Electron smoke did not register an Electron surface: ${payload.url}`);
  }
  const expectedConfigPath = path.join(dataDir, "config.yaml");
  if (payload.health.configPath !== expectedConfigPath) {
    throw new Error(`Electron smoke used unexpected config path: ${JSON.stringify(payload.health)}`);
  }
  if ("statePath" in payload.health) {
    throw new Error(`Electron health exposed removed statePath alias: ${JSON.stringify(payload.health)}`);
  }
  if (!payload.health.authorityRuntime?.nodePath || !payload.health.authorityRuntime.nodeVersion) {
    throw new Error(`Electron smoke did not expose authority Node runtime metadata: ${JSON.stringify(payload.health)}`);
  }
  if (process.env.CODEX_HUB_AUTHORITY_PACKAGE?.trim()
    && payload.health.authorityServiceSource !== "configured-package") {
    throw new Error(
      `Electron smoke did not use CODEX_HUB_AUTHORITY_PACKAGE: ${JSON.stringify(payload.health)}`
    );
  }
  if (!payload.restartHealth?.authority
    || payload.restartHealth.authority.surfaceProtocolVersion !== embeddedSurfaceProtocolVersion) {
    throw new Error(
      `Electron smoke authority restart did not recover the shared authority: ${JSON.stringify(payload.restartHealth)}`
    );
  }
  console.log(
    `electron ok: ${payload.url} node=${payload.health.authorityRuntime.nodeVersion}`
    + ` service=${payload.health.authorityServiceSource ?? "unknown"} restart=ok`
  );
};

const prepareAuthorityPortForSmoke = async () => {
  if (process.env.CODEX_HUB_AUTHORITY_PORT?.trim()) return;
  const defaultPort = authorityServicePort({ ...process.env, CODEX_HUB_AUTHORITY_PORT: undefined });
  if (!await isPortListening(defaultPort)) return;
  const port = await findFreePort();
  process.env.CODEX_HUB_AUTHORITY_PORT = String(port);
  console.log(`electron smoke: shared authority default port ${defaultPort} is busy; using isolated test port ${port}`);
};

const findFreePort = async () => await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close(() => reject(new Error("Could not allocate Electron smoke port.")));
      return;
    }
    const port = address.port;
    server.close(() => resolve(port));
  });
});

const isPortListening = async (port: number) => await new Promise<boolean>((resolve) => {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  const finish = (listening: boolean) => {
    socket.removeAllListeners();
    socket.destroy();
    resolve(listening);
  };
  socket.setTimeout(500);
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
  socket.once("timeout", () => finish(false));
});

const runElectronSmoke = async (dataDir: string, pluginDir: string, userDataDir: string) => await new Promise<string>((resolve, reject) => {
  const electronBin = path.join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron.cmd" : "electron"
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HUB_DATA_DIR: dataDir,
    CODEX_HUB_PLUGIN_DIR: pluginDir,
    CODEX_HUB_LOCAL_MACHINE: "1",
    CODEX_HUB_ELECTRON_SMOKE: "1"
  };
  delete env.CODEX_HUB_PORT;
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronBin, [
    `--user-data-dir=${userDataDir}`,
    "--no-sandbox",
    "--headless",
    "--disable-gpu",
    "--ozone-platform=headless",
    "dist-node/electron/main.cjs"
  ], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  const append = (chunk: Buffer) => {
    output += chunk.toString("utf8");
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("error", reject);
  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
    reject(new Error(`Electron smoke timed out:\n${output}`));
  }, 45_000);
  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    if (code === 0) {
      resolve(output);
      return;
    }
    reject(new Error(`Electron smoke failed: code=${code ?? ""} signal=${signal ?? ""}\n${output}`));
  });
});

const parseSmokePayload = (output: string): {
  ok: true;
  url: string;
  health: {
    port: number;
    configPath: string;
    authority?: { surfaceProtocolVersion?: number };
    authorityRuntime?: { nodePath?: string; nodeVersion?: string };
    authorityServiceSource?: string;
  };
  restartHealth?: {
    authority?: { surfaceProtocolVersion?: number };
  };
} => {
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as {
        ok?: unknown;
        url?: unknown;
        health?: {
          port?: unknown;
          configPath?: unknown;
          authority?: { surfaceProtocolVersion?: unknown };
          authorityRuntime?: { nodePath?: unknown; nodeVersion?: unknown };
          authorityServiceSource?: unknown;
        };
        restartHealth?: {
          authority?: { surfaceProtocolVersion?: unknown };
        };
      };
      if (parsed.ok === true
        && typeof parsed.url === "string"
        && typeof parsed.health?.port === "number"
        && typeof parsed.health?.configPath === "string") {
        return parsed as {
          ok: true;
          url: string;
          health: {
            port: number;
            configPath: string;
            authority?: { surfaceProtocolVersion?: number };
            authorityRuntime?: { nodePath?: string; nodeVersion?: string };
            authorityServiceSource?: string;
          };
          restartHealth?: {
            authority?: { surfaceProtocolVersion?: number };
          };
        };
      }
    } catch {
      // Keep looking for the smoke JSON line; Fastify logs are also JSON.
    }
  }
  throw new Error(`Electron smoke payload missing:\n${output}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
