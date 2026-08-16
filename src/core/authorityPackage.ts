import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AuthorityServiceSource } from "../shared/surfaceTypes.js";

export type AuthorityPackageFallback = {
  authorityServicePath: string;
  staticDirectory: string;
  remoteClientPath?: string;
};

export type AuthorityPackageResolution = AuthorityPackageFallback & {
  source: AuthorityServiceSource;
  packageRoot?: string;
};

/**
 * Prefer a local npm/link package's built authority over the bundle carried by
 * the VSIX/Electron shell. The explicit package path is strict; automatic PATH
 * discovery is best effort so a stale global CLI cannot prevent startup.
 */
export const resolveAuthorityPackage = async (
  fallback: AuthorityPackageFallback,
  env: NodeJS.ProcessEnv = process.env
): Promise<AuthorityPackageResolution> => {
  const configuredRoot = env.CODEX_HUB_AUTHORITY_PACKAGE?.trim();
  if (configuredRoot) {
    const resolved = await packageResolution(path.resolve(configuredRoot), "configured-package");
    if (!resolved) {
      throw new Error(
        `CODEX_HUB_AUTHORITY_PACKAGE has no usable CodexHub build: ${configuredRoot}. `
        + "Run `pnpm build` in that package first."
      );
    }
    return resolved;
  }

  const linkedRoot = await discoverLinkedPackageRoot(env);
  if (linkedRoot) {
    const resolved = await packageResolution(linkedRoot, "linked-package");
    if (resolved) return resolved;
  }

  return { ...fallback, source: "bundled" };
};

const packageResolution = async (
  packageRoot: string,
  source: Exclude<AuthorityServiceSource, "bundled" | "unknown">
): Promise<AuthorityPackageResolution | null> => {
  const authorityServicePath = await firstFile([
    path.join(packageRoot, "dist-node", "authority-service.cjs"),
    path.join(packageRoot, "dist-vsix", "authority-service.cjs"),
    path.join(packageRoot, "dist-node", "electron", "authority-service.cjs")
  ]);
  const staticDirectory = path.join(packageRoot, "dist");
  if (!authorityServicePath || !await isDirectory(staticDirectory)) return null;
  const remoteClientPath = await firstFile([
    path.join(packageRoot, "dist-node", "ssh", "remote-client.cjs")
  ]);
  return {
    authorityServicePath,
    staticDirectory,
    ...(remoteClientPath ? { remoteClientPath } : {}),
    source,
    packageRoot
  };
};

const discoverLinkedPackageRoot = async (env: NodeJS.ProcessEnv) => {
  const executableNames = process.platform === "win32"
    ? ["codexhub.cmd", "codexhub.exe", "codexhub", "cxh.cmd", "cxh.exe", "cxh"]
    : ["codexhub", "cxh"];
  const pathValue = Object.entries(env)
    .find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const entries = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    for (const executableName of executableNames) {
      const executablePath = path.join(entry, executableName);
      if (!await isFile(executablePath)) continue;
      const packageRoot = await packageRootFromExecutable(executablePath);
      if (packageRoot && await isDirectory(packageRoot)) return packageRoot;
    }
  }
  return null;
};

export const packageRootFromExecutable = async (
  executablePath: string,
  platform: NodeJS.Platform = process.platform
) => {
  try {
    const resolvedPath = await realpath(executablePath);
    const binDirectory = path.dirname(resolvedPath);
    if (path.basename(binDirectory).toLowerCase() === "bin") {
      return path.dirname(binDirectory);
    }
    if (platform !== "win32") return null;
    return await firstDirectory([
      path.join(binDirectory, "node_modules", "@dadigua", "codexhub"),
      path.join(binDirectory, "node_modules", "codexhub")
    ]);
  } catch {
    return null;
  }
};

const firstFile = async (candidates: string[]) => {
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
};

const isFile = async (filePath: string) => {
  try {
    await access(filePath);
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const isDirectory = async (directoryPath: string) => {
  try {
    return (await stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
};

const firstDirectory = async (candidates: string[]) => {
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }
  return null;
};
