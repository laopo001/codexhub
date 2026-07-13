import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deployTheiaExtensionAtomically } from "./theia-extension-deployment.js";

const extensionId = "dadigua.codexhub";
const version = "0.4.16";
const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-theia-installer-"));

try {
  const configDir = path.join(root, "config");
  const stagingDir = path.join(root, "staging");
  const deploymentPath = path.join(configDir, "deployedPlugins", `${extensionId}@${version}`);
  await createStaging(stagingDir);
  await mkdir(path.join(deploymentPath, "extension"), { recursive: true });
  await writeFile(path.join(deploymentPath, "extension", "old-marker.txt"), "old");

  const result = await deployTheiaExtensionAtomically({ configDir, extensionId, sourceDir: stagingDir, version });
  assert.equal(result.deploymentPath, deploymentPath);
  assert.equal(result.replacedExisting, true);
  assert.equal(result.retainedBackupPath, null);
  assert.equal(await readFile(path.join(deploymentPath, "extension", "extension.cjs"), "utf8"), "new bundle");
  assert.equal(await readFile(path.join(deploymentPath, "extension.vsixmanifest"), "utf8"), "vsix manifest");
  await assert.rejects(access(path.join(deploymentPath, "extension", "old-marker.txt")));
  assert.deepEqual(
    (await readdir(path.dirname(deploymentPath))).filter((entry) => entry.includes(".backup-") || entry.includes(".incoming-")),
    [],
  );

  const invalidStaging = path.join(root, "invalid-staging");
  await mkdir(path.join(invalidStaging, "extension"), { recursive: true });
  await writeFile(path.join(invalidStaging, "extension.vsixmanifest"), "vsix manifest");
  await writeFile(path.join(invalidStaging, "extension", "package.json"), JSON.stringify({
    name: "codexhub",
    publisher: "dadigua",
    version,
  }));
  await assert.rejects(
    deployTheiaExtensionAtomically({ configDir, extensionId, sourceDir: invalidStaging, version }),
    /staging is incomplete/,
  );
  assert.equal(await readFile(path.join(deploymentPath, "extension", "extension.cjs"), "utf8"), "new bundle");

  console.error("theia installer atomic replacement smoke passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function createStaging(stagingDir: string) {
  const extensionDir = path.join(stagingDir, "extension");
  await mkdir(path.join(extensionDir, "dist"), { recursive: true });
  await mkdir(path.join(extensionDir, "dist-node", "ssh"), { recursive: true });
  await writeFile(path.join(stagingDir, "extension.vsixmanifest"), "vsix manifest");
  await writeFile(path.join(extensionDir, "package.json"), JSON.stringify({
    name: "codexhub",
    publisher: "dadigua",
    version,
  }));
  await writeFile(path.join(extensionDir, "extension.cjs"), "new bundle");
  await writeFile(path.join(extensionDir, "dist", "index.html"), "<html></html>");
  await writeFile(path.join(extensionDir, "dist-node", "ssh", "remote-client.cjs"), "remote client");
}
