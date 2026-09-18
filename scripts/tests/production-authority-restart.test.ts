import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { authorityBuildId, resolveAuthorityId } from "../../src/core/embeddedAuthority.js";

for (const mismatch of [false, true]) {
  test(`production update ${mismatch ? "rejects another authority before restart" : "restarts and verifies the actual service build"}`, { timeout: 20_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cxh-production-update-test-"));
    const dataDir = path.join(root, "data");
    const authorityId = await resolveAuthorityId(dataDir);
    await mkdir(path.join(root, "dist-node"));
    await mkdir(path.join(root, "dist"));
    const files = [path.join(root, "dist-node/authority-service.cjs"), path.join(root, "dist/index.html")];
    await writeFile(files[0]!, "fixture service");
    await writeFile(files[1]!, "<html>fixture Web</html>");
    const buildId = await authorityBuildId(files);
    let restarted = false;
    let servedPage = false;
    let requestedBuild: unknown;
    let authenticated = false;
    const server = createServer(async (request, response) => {
      if (request.url === "/api/health") {
        authenticated = request.headers.authorization === "Bearer production-test-token";
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, authority: { authorityId: mismatch ? "authority-other-machine" : authorityId },
          configPath: path.join(dataDir, "config.yaml"), build: restarted ? buildId : "old-build",
          authRequired: true, authenticated }));
      } else if (request.url === "/api/restart") {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        requestedBuild = JSON.parse(body).buildId;
        restarted = true;
        response.end(JSON.stringify({ ok: true, restarting: true }));
      } else {
        servedPage = true;
        response.end("<html>fixture Web</html>");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const environment = { ...process.env };
      for (const key of Object.keys(environment)) if (key.startsWith("CODEX_HUB_")) delete environment[key];
      const projectRoot = path.resolve(import.meta.dirname, "../..");
      const child = spawn(process.execPath, [path.join(projectRoot, "node_modules/tsx/dist/cli.mjs"),
        path.join(projectRoot, "scripts/restart-production-authority.ts")], {
        cwd: root,
        env: { ...environment, CODEX_HUB_DATA_DIR: dataDir, CODEX_HUB_PROD_URL: `http://127.0.0.1:${address.port}`,
          CODEX_HUB_AUTH_TOKEN: "production-test-token" },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "";
      child.stdout.on("data", (data) => { output += String(data); });
      child.stderr.on("data", (data) => { output += String(data); });
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(authenticated, true);
      assert.equal(output.includes("production-test-token"), false);
      if (mismatch) {
        assert.notEqual(code, 0);
        assert.match(output, /identity\/config does not match/);
        assert.equal(restarted, false);
      } else {
        assert.equal(code, 0, output);
        assert.equal(requestedBuild, buildId);
        assert.equal(restarted, true);
        assert.equal(servedPage, true);
        assert.match(output, /Production authority verified/);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
