import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const main = async () => {
  const blocker = await listenOnDefaultElectronPort();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-electron-state."));
  const pluginDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-electron-plugins."));
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-electron-user-data."));
  try {
    const output = await runElectronSmoke(dataDir, pluginDir, userDataDir);
    if (output.includes("codexhub electron port 18788 is busy; using ")) {
      throw new Error(`Electron smoke used preferred-port fallback instead of random port:\n${output}`);
    }
    const payload = parseSmokePayload(output);
    if (payload.health.port === 18788) throw new Error("Electron smoke reused occupied legacy default port.");
    const expectedConfigPath = path.join(dataDir, "config.yaml");
    if (payload.health.configPath !== expectedConfigPath || payload.health.statePath !== expectedConfigPath) {
      throw new Error(`Electron smoke used unexpected config path: ${JSON.stringify(payload.health)}`);
    }
    console.log(`electron ok: ${payload.url}`);
  } finally {
    await closeServer(blocker);
  }
};

const listenOnDefaultElectronPort = async () => await new Promise<net.Server>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(18788, "127.0.0.1", () => resolve(server));
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
    CODEX_HUB_LOCAL_MACHINE: "0",
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
    "dist-node/electron/main.js"
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
  }, 30_000);
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
  health: { port: number; configPath: string; statePath: string };
} => {
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as {
        ok?: unknown;
        url?: unknown;
        health?: { port?: unknown; configPath?: unknown; statePath?: unknown };
      };
      if (parsed.ok === true
        && typeof parsed.url === "string"
        && typeof parsed.health?.port === "number"
        && typeof parsed.health?.configPath === "string"
        && typeof parsed.health?.statePath === "string") {
        return parsed as { ok: true; url: string; health: { port: number; configPath: string; statePath: string } };
      }
    } catch {
      // Keep looking for the smoke JSON line; Fastify logs are also JSON.
    }
  }
  throw new Error(`Electron smoke payload missing:\n${output}`);
};

const closeServer = async (server: net.Server) => await new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
