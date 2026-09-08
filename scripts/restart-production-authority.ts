import path from "node:path";
import { loadDotEnv } from "../src/core/dotenv.js";
import { codexHubDataDirectory } from "../src/core/authorityPaths.js";
import { readAndApplyServerConfigEnv } from "../src/core/serverConfigEnv.js";
import { authorityBuildId, resolveAuthorityId } from "../src/core/embeddedAuthority.js";
import { loadConfig } from "../src/core/config.js";
import type { HealthPayload } from "../src/shared/apiContract.js";

class ProductionIdentityError extends Error {}

// Called only by the explicit publish/rollback workflow, never by normal bootstrap.
await loadDotEnv();
const dataDir = codexHubDataDirectory();
await readAndApplyServerConfigEnv(path.join(dataDir, "config.yaml"));
const config = loadConfig();
const baseUrl = process.env.CODEX_HUB_PROD_URL || `http://127.0.0.1:${config.port}`;
const authorityId = await resolveAuthorityId(dataDir);
const buildId = await authorityBuildId([
  path.resolve("dist-node/authority-service.cjs"),
  path.resolve(process.env.CODEX_HUB_STATIC_DIR || "dist", "index.html")
]);
const headers = process.env.CODEX_HUB_AUTH_TOKEN
  ? { authorization: `Bearer ${process.env.CODEX_HUB_AUTH_TOKEN}` }
  : undefined;
const health = async () => {
  const response = await fetch(`${baseUrl}/api/health`, { headers, signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`Production health returned HTTP ${response.status}.`);
  const value = await response.json() as HealthPayload;
  if (value.authority?.authorityId !== authorityId || value.configPath !== path.join(dataDir, "config.yaml")) {
    throw new ProductionIdentityError("Production authority identity/config does not match this deployment.");
  }
  if (value.authRequired && !value.authenticated) throw new ProductionIdentityError("Production authority authentication failed.");
  return value;
};
let current: HealthPayload | undefined;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try { current = await health(); break; } catch (error) {
    if (error instanceof ProductionIdentityError || attempt === 29) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
if (current?.build !== buildId) {
  const response = await fetch(`${baseUrl}/api/restart`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ buildId }), signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Production authority rejected restart (HTTP ${response.status}).`);
  const accepted = await response.json() as { ok?: boolean; restarting?: boolean };
  if (!accepted.ok || !accepted.restarting) throw new Error("Production authority did not accept restart.");
}
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const value = await health();
    if (value.build === buildId) {
      const page = await fetch(baseUrl, { signal: AbortSignal.timeout(5_000) });
      if (!page.ok) throw new Error(`Production Web returned HTTP ${page.status}.`);
      console.log(`Production authority verified: ${baseUrl} (${buildId})`);
      process.exit(0);
    }
  } catch { /* authority-owned restart releases its old listener first */ }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
throw new Error(`Production authority did not activate build ${buildId}.`);
