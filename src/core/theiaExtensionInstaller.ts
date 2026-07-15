import { access, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deployTheiaExtensionAtomically, type TheiaDeploymentResult } from "./theiaExtensionDeployment.js";

type CodexHubPackageManifest = {
  name?: string;
  version?: string;
};

export type InstallTheiaExtensionOptions = {
  configDir?: string;
  vsixPath?: string;
};

export type InstallTheiaExtensionResult = TheiaDeploymentResult & {
  extensionId: string;
  removedStaleDropIn: string | null;
  version: string;
  vsixPath: string;
};

const extensionId = "dadigua.codexhub";

export async function installTheiaExtension(
  options: InstallTheiaExtensionOptions = {},
): Promise<InstallTheiaExtensionResult> {
  const [manifest, vsixPath] = await Promise.all([
    readCodexHubPackageManifest(),
    resolveTheiaVsixPath(options.vsixPath),
  ]);
  if (manifest.name !== "@dadigua/codexhub" || !manifest.version?.trim()) {
    throw new Error("Could not resolve the @dadigua/codexhub package version for Theia installation.");
  }
  const version = manifest.version.trim();
  const configDir = resolveConfigDir(options.configDir);
  const staleDropIn = path.join(configDir, "extensions", "codexhub.vsix");
  const removedStaleDropIn = await isFile(staleDropIn) ? staleDropIn : null;
  if (removedStaleDropIn) await rm(removedStaleDropIn, { force: true });

  const deployment = await deployTheiaExtensionAtomically({
    configDir,
    extensionId,
    version,
    vsixPath,
  });
  return {
    ...deployment,
    extensionId,
    removedStaleDropIn,
    version,
    vsixPath,
  };
}

async function resolveTheiaVsixPath(input: string | undefined) {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = input?.trim()
    ? [path.resolve(expandHome(input.trim()))]
    : [
        process.env.CODEX_HUB_THEIA_VSIX?.trim(),
        path.resolve(moduleDir, "../../dist-vscode/codexhub.vsix"),
        path.resolve(moduleDir, "../../../dist-vscode/codexhub.vsix"),
        path.resolve(process.cwd(), "dist-vscode/codexhub.vsix"),
      ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of [...new Set(candidates)]) {
    const resolved = path.resolve(expandHome(candidate));
    if (await isFile(resolved)) return resolved;
  }
  throw new Error([
    "The Theia-compatible CodexHub VSIX was not found.",
    "Reinstall a published @dadigua/codexhub package that includes it, or pass --vsix <path>.",
    "From a source checkout, run `pnpm run package:vscode` first.",
  ].join(" "));
}

async function readCodexHubPackageManifest() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../package.json"),
    path.resolve(moduleDir, "../../../package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(await readFile(candidate, "utf8")) as CodexHubPackageManifest;
      if (manifest.name === "@dadigua/codexhub") return manifest;
    } catch {
      // Try the next source or compiled package location.
    }
  }
  throw new Error("Could not find the @dadigua/codexhub package manifest.");
}

function resolveConfigDir(input: string | undefined) {
  const value = input?.trim()
    || process.env.CODEX_HUB_THEIA_CONFIG_DIR?.trim()
    || process.env.THEIA_CONFIG_DIR?.trim()
    || path.join(os.homedir(), ".theia-ide");
  return path.resolve(expandHome(value));
}

function expandHome(value: string) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

async function isFile(filePath: string) {
  try {
    await access(filePath);
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
