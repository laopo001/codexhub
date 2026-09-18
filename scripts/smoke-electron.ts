import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  authorityServicePort,
  embeddedSurfaceProtocolVersion
} from "../src/shared/surfaceTypes.js";

const execFileAsync = promisify(execFile);

const main = async () => {
  const authorityPort = await prepareAuthorityPortForSmoke();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-electron-state."));
  const pluginDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-electron-plugins."));
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-electron-user-data."));
  let output: string;
  try {
    output = await runElectronSmoke(dataDir, pluginDir, userDataDir, authorityPort);
  } finally {
    await cleanupIsolatedAuthority(dataDir);
    await Promise.all([
      rm(dataDir, { recursive: true, force: true }),
      rm(pluginDir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true })
    ]);
  }
  const payload = parseSmokePayload(output);
  if (payload.health.port !== authorityPort) {
    throw new Error(
      `Electron smoke did not use the shared authority port ${authorityPort}: ${JSON.stringify(payload.health)}`
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
  const candidate = authorityServicePort(process.env);
  if (!await isPortListening(candidate)) return candidate;
  const port = await findFreePort();
  console.log(`electron smoke: shared authority port ${candidate} is busy; using isolated test port ${port}`);
  return port;
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

const runElectronSmoke = async (dataDir: string, pluginDir: string, userDataDir: string, authorityPort: number) => await new Promise<string>((resolve, reject) => {
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
    CODEX_HUB_ELECTRON_SMOKE: "1",
    CODEX_HUB_PORT: String(authorityPort)
  };
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

const cleanupIsolatedAuthority = async (dataDir: string) => {
  if (process.platform === "win32") return;
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]);
  const servicePaths = [
    path.resolve("dist-node/authority-service.cjs"),
    path.resolve("dist-node/electron/authority-service.cjs")
  ];
  const pids = stdout.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) return [];
    const args = match[2].split(/\s+/);
    const hasDataDir = args.includes("--data-dir") && args.includes(dataDir);
    const hasHandoff = args.includes("--handoff") && args.some((arg) => arg.startsWith(dataDir + path.sep));
    const hasService = servicePaths.some((servicePath) => args.includes(servicePath));
    if (!hasService || (!hasDataDir && !hasHandoff)) return [];
    return [Number(match[1])];
  }).filter((pid) => pid > 0 && pid !== process.pid);
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { continue; }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
  }
};

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
