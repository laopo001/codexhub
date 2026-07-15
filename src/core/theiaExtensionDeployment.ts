import { randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import extractZip from "extract-zip";

type ExtensionManifest = {
  name?: string;
  publisher?: string;
  version?: string;
};

export type TheiaDeploymentResult = {
  deploymentPath: string;
  replacedExisting: boolean;
  retainedBackupPath: string | null;
};

export async function deployTheiaExtensionAtomically(options: {
  configDir: string;
  extensionId: string;
  sourceDir?: string;
  version: string;
  vsixPath?: string;
}): Promise<TheiaDeploymentResult> {
  const deploymentRoot = path.join(options.configDir, "deployedPlugins");
  const deploymentName = `${options.extensionId}@${options.version}`;
  const deploymentPath = path.join(deploymentRoot, deploymentName);
  const transactionId = `${process.pid}-${randomUUID()}`;
  const incomingPath = path.join(deploymentRoot, `.${deploymentName}.incoming-${transactionId}`);
  const backupPath = path.join(deploymentRoot, `.${deploymentName}.backup-${transactionId}`);

  if (!options.sourceDir && !options.vsixPath) {
    throw new Error("A Theia deployment source directory or VSIX path is required.");
  }
  if (options.sourceDir && options.vsixPath) {
    throw new Error("Provide either a Theia deployment source directory or VSIX path, not both.");
  }
  if (options.sourceDir) {
    await assertDeployedExtension(options.sourceDir, options.extensionId, options.version);
  } else {
    await assertFile(options.vsixPath!);
  }
  await mkdir(deploymentRoot, { recursive: true });

  let replacedExisting = false;
  let installedIncoming = false;
  try {
    if (options.sourceDir) {
      await cp(options.sourceDir, incomingPath, { recursive: true });
    } else {
      await extractZip(options.vsixPath!, { dir: incomingPath });
    }
    await assertDeployedExtension(incomingPath, options.extensionId, options.version);

    if (await pathExists(deploymentPath)) {
      await rename(deploymentPath, backupPath);
      replacedExisting = true;
    }
    await rename(incomingPath, deploymentPath);
    installedIncoming = true;
    await assertDeployedExtension(deploymentPath, options.extensionId, options.version);
  } catch (error) {
    await rm(incomingPath, { recursive: true, force: true }).catch(() => undefined);
    if (installedIncoming) {
      await rm(deploymentPath, { recursive: true, force: true }).catch(() => undefined);
    }
    if (replacedExisting) {
      await rename(backupPath, deploymentPath).catch((rollbackError) => {
        throw new AggregateError([error, rollbackError], `Theia deployment failed and rollback could not restore ${deploymentPath}`);
      });
    }
    throw error;
  }

  let retainedBackupPath: string | null = null;
  if (replacedExisting) {
    try {
      await rm(backupPath, { recursive: true, force: true });
    } catch {
      retainedBackupPath = backupPath;
    }
  }

  return { deploymentPath, replacedExisting, retainedBackupPath };
}

async function assertDeployedExtension(deploymentPath: string, expectedId: string, expectedVersion: string) {
  await assertFile(path.join(deploymentPath, "extension.vsixmanifest"));
  const extensionDir = path.join(deploymentPath, "extension");
  await assertExtensionPackage(extensionDir, expectedId, expectedVersion);
  await assertRuntimeFiles(extensionDir);
}

async function assertExtensionPackage(extensionDir: string, expectedId: string, expectedVersion: string) {
  const manifestPath = path.join(extensionDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ExtensionManifest;
  const actualId = manifest.publisher && manifest.name ? `${manifest.publisher}.${manifest.name}` : "";
  if (actualId !== expectedId || manifest.version !== expectedVersion) {
    throw new Error(`Unexpected extension manifest at ${manifestPath}: expected ${expectedId}@${expectedVersion}, received ${actualId}@${manifest.version ?? "unknown"}`);
  }
}

async function assertRuntimeFiles(extensionDir: string) {
  await Promise.all([
    assertFile(path.join(extensionDir, "extension.cjs")),
    assertFile(path.join(extensionDir, "dist", "index.html")),
    assertFile(path.join(extensionDir, "dist-node", "ssh", "remote-client.cjs")),
  ]);
}

async function assertFile(filePath: string) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`Theia extension staging is incomplete: ${filePath}`);
  }
}

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
