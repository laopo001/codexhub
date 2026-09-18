import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAuthorityPackage } from "../src/core/authorityPackage.js";

const makePackage = async (root: string) => {
  await Promise.all([
    mkdir(path.join(root, "dist"), { recursive: true }),
    mkdir(path.join(root, "dist-node", "ssh"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(root, "dist", "index.html"), "<html />"),
    writeFile(path.join(root, "dist-node", "authority-service.cjs"), "// authority"),
    writeFile(path.join(root, "dist-node", "ssh", "remote-client.cjs"), "// remote client")
  ]);
};

test("authority package resolver prefers an explicit local package", async () => {
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), "codexhub-authority-package."));
  try {
    await makePackage(packageRoot);
    const resolution = await resolveAuthorityPackage({
      authorityServicePath: "/bundled/authority-service.cjs",
      staticDirectory: "/bundled/dist"
    }, {
      CODEX_HUB_AUTHORITY_PACKAGE: packageRoot,
      PATH: ""
    });

    assert.equal(resolution.source, "configured-package");
    assert.equal(resolution.packageRoot, packageRoot);
    assert.equal(resolution.authorityServicePath, path.join(packageRoot, "dist-node", "authority-service.cjs"));
    assert.equal(resolution.staticDirectory, path.join(packageRoot, "dist"));
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("authority package resolver discovers a linked package through PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-linked-package."));
  const binDirectory = await mkdtemp(path.join(os.tmpdir(), "codexhub-linked-bin."));
  try {
    await makePackage(root);
    await mkdir(path.join(root, "bin"), { recursive: true });
    await writeFile(path.join(root, "bin", "codexhub"), "#!/usr/bin/env node\n");
    await symlink(path.join(root, "bin", "codexhub"), path.join(binDirectory, "codexhub"));
    const resolution = await resolveAuthorityPackage({
      authorityServicePath: "/bundled/authority-service.cjs",
      staticDirectory: "/bundled/dist"
    }, { PATH: binDirectory });

    assert.equal(resolution.source, "linked-package");
    assert.equal(resolution.packageRoot, root);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(binDirectory, { recursive: true, force: true });
  }
});

test("authority package resolver falls back to the embedded bundle", async () => {
  const fallback = {
    authorityServicePath: "/bundled/authority-service.cjs",
    staticDirectory: "/bundled/dist"
  };
  const resolution = await resolveAuthorityPackage(fallback, { PATH: "" });

  assert.deepEqual(resolution, { ...fallback, source: "bundled" });
});

test("authority package resolver rejects an explicit package without a build", async () => {
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), "codexhub-incomplete-package."));
  try {
    await assert.rejects(
      resolveAuthorityPackage({
        authorityServicePath: "/bundled/authority-service.cjs",
        staticDirectory: "/bundled/dist"
      }, { CODEX_HUB_AUTHORITY_PACKAGE: packageRoot, PATH: "" }),
      /has no usable CodexHub build/
    );
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});
