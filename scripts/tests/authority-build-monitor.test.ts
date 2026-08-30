import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthorityBuildMonitor } from "../../src/core/authorityBuildMonitor.js";
import { authorityBuildId } from "../../src/core/embeddedAuthority.js";

test("authority build monitor reports only a stable changed build", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-authority-build-monitor."));
  const service = path.join(root, "authority-service.cjs");
  const index = path.join(root, "index.html");
  await Promise.all([writeFile(service, "service-old"), writeFile(index, "index-old")]);
  const currentBuildId = await authorityBuildId([service, index], "npm");
  const updates: string[] = [];
  const monitor = new AuthorityBuildMonitor({
    currentBuildId,
    files: [service, index],
    pollMs: 60_000,
    onUpdateAvailable: (buildId) => updates.push(buildId)
  });
  try {
    await monitor.check();
    assert.deepEqual(updates, []);

    await writeFile(service, "service-new");
    await monitor.check();
    assert.deepEqual(updates, []);
    await monitor.check();
    assert.equal(updates.length, 1);
    assert.notEqual(updates[0], currentBuildId);

    await monitor.check();
    assert.equal(updates.length, 1);
    await rm(index);
    await monitor.check();
    assert.equal(updates.length, 1);
  } finally {
    monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});
