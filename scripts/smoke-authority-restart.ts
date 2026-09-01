import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { authorityBuildId } from "../src/core/embeddedAuthority.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-authority-restart-smoke."));
const dataDir = path.join(root, "data");
const servicePath = path.resolve("dist-node/authority-service.cjs");
const staticDirectory = path.resolve("dist");
const port = await findFreePort();
const token = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const buildId = await authorityBuildId([servicePath, path.join(staticDirectory, "index.html")]);
const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HUB_AUTH_TOKEN: token, CODEX_HUB_LOCAL_MACHINE: "0" };
const args = [servicePath, "--port", String(port), "--authority-id", "authority-restart-smoke", "--authority-kind", "linux", "--data-dir", dataDir, "--static-directory", staticDirectory, "--build-id", buildId, "--auth-token-env", "CODEX_HUB_AUTH_TOKEN", "--project-catalog", "fixed"];
const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
let childClosed = false;
child.once("close", () => { childClosed = true; });
let stderr = "";
child.stderr?.on("data", (chunk) => { stderr += String(chunk).slice(-4_000); });
try {
  const url = `http://127.0.0.1:${port}`;
  const initial = await waitHealth(url);
  const response = await fetch(`${url}/api/restart`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const acknowledgement = await response.json() as { ok?: boolean; restarting?: boolean; error?: string };
  if (!response.ok || !acknowledgement.ok || !acknowledgement.restarting) {
    throw new Error(`restart acknowledgement failed: ${JSON.stringify(acknowledgement)}`);
  }
  const successor = await waitHealth(url, initial.serverInstanceId);
  if (successor.build !== buildId || successor.authority?.authorityId !== "authority-restart-smoke") {
    throw new Error(`successor health mismatch: ${JSON.stringify(successor)}`);
  }
  if (successor.authRequired !== true) throw new Error(`successor authRequired was not true: ${JSON.stringify(successor)}`);
  const authorized = await fetch(`${url}/api/projects`, { headers: { authorization: `Bearer ${token}` } });
  const unauthorized = await fetch(`${url}/api/projects`);
  if (authorized.status !== 200 || unauthorized.status !== 401) throw new Error(`auth contract failed: authorized=${authorized.status} unauthorized=${unauthorized.status}`);
  const index = await fetch(`${url}/`);
  const indexText = await index.text();
  if (!index.ok) throw new Error("successor did not serve index.html");
  const assets = [...indexText.matchAll(/(?:src|href)="(\/[^"']+\.(?:js|css)(?:\?[^"']*)?)"/g)].map((match) => match[1]);
  if (!assets.length) throw new Error("successor index did not contain script/css assets");
  for (const asset of assets) {
    const assetResponse = await fetch(`${url}${asset}`);
    if (assetResponse.status !== 200) throw new Error(`successor asset failed: ${asset} HTTP ${assetResponse.status}`);
  }
  const logContents = await Promise.all([
    readFile(path.join(dataDir, "authority.log"), "utf8").catch(() => ""),
    readFile(path.join(dataDir, "authority-restart.log"), "utf8").catch(() => "")
  ]);
  if (logContents.some((contents) => contents.includes(token))) throw new Error("auth token appeared in authority logs");
  if ((await readdir(dataDir)).some((name) => name.startsWith("authority-restart-") && name.endsWith(".json"))) {
    throw new Error("restart handoff file was not consumed");
  }
  const processes = await authorityProcesses(port, servicePath);
  if (processes.some((line) => line.includes(token))) throw new Error("auth token appeared in authority argv");
  console.log(JSON.stringify({ ok: true, url, oldServerInstanceId: initial.serverInstanceId, newServerInstanceId: successor.serverInstanceId, buildId: successor.build }));
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `; authority stderr: ${stderr}` : ""}`);
} finally {
  await killAuthorityProcesses(port);
  if (!childClosed) await new Promise<void>((resolve) => child.once("close", () => resolve()));
  await rm(root, { recursive: true, force: true });
}

async function waitHealth(url: string, previousInstance?: string) {
  const deadline = Date.now() + 30_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      const health = await response.json() as Record<string, any>;
      if (response.ok && health.ok && (!previousInstance || health.serverInstanceId !== previousInstance)) return health;
      last = health;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`health wait timed out: ${JSON.stringify(last)}`);
}

async function authorityProcesses(targetPort: number, targetServicePath: string) {
  if (process.platform === "win32") return [];
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]);
  return stdout.split("\n").filter((line) => {
    const args = line.trim().replace(/^\d+\s+/, "");
    return args.split(/\s+/).includes(targetServicePath)
      && args.split(/\s+/).includes("--port")
      && args.split(/\s+/).includes(String(targetPort));
  });
}

async function killAuthorityProcesses(targetPort: number) {
  const lines = await authorityProcesses(targetPort, servicePath);
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+/);
    const pid = Number(match?.[1]);
    if (pid > 0 && pid !== process.pid) process.kill(pid, "SIGTERM");
  }
}

async function findFreePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("could not allocate smoke port"));
      server.close(() => resolve(address.port));
    });
  });
}
