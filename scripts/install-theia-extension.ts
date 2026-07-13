import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type ExtensionManifest = {
  name?: string;
  publisher?: string;
  version?: string;
};

type CommandResult = {
  code: number | null;
  output: string;
};

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}

const vsixPath = path.resolve("dist-vscode/codexhub.vsix");
const manifest = await readJson<ExtensionManifest>("dist-vscode/package.json");
const extensionId = extensionIdentifier(manifest);
const version = manifest.version?.trim();
if (!version) throw new Error("dist-vscode/package.json must include a version.");
await assertFile(vsixPath, "Theia-compatible VSIX not found. Run `pnpm package:vscode` first.");

const wsl = await isWsl();
const ideInput = args.find((value) => !value.startsWith("-"))
  ?? process.env.CODEX_HUB_THEIA_IDE_DIR?.trim();
const ide = await resolveTheiaIde(ideInput, wsl);
const deployedName = `${extensionId}@${version}`;

const stagedPaths: string[] = [];
if (wsl) {
  const wslConfigDir = path.resolve(process.env.CODEX_HUB_THEIA_WSL_CONFIG_DIR?.trim() || path.join(os.homedir(), ".theia-ide"));
  stagedPaths.push(await stageVsix(vsixPath, wslConfigDir));

  const windowsConfigDir = process.env.CODEX_HUB_THEIA_WINDOWS_CONFIG_DIR?.trim()
    ? resolveWindowsInput(process.env.CODEX_HUB_THEIA_WINDOWS_CONFIG_DIR.trim()).fileSystemPath
    : "/mnt/c/Users/0laop/.theia-ide";
  stagedPaths.push(await stageVsix(vsixPath, windowsConfigDir));
} else {
  stagedPaths.push(await stageVsix(vsixPath, path.join(os.homedir(), ".theia-ide")));
}

const removedDeployments = await removeExistingDeployments(stagedPaths, deployedName);
const launch = await launchTheiaInstaller(ide.executablePath, ide.windowsExecutablePath, wsl);
if (launch.code !== 0) {
  throw new Error(`Theia IDE extension install command failed:\n${launch.output.trim()}`);
}

const deployed = await waitForDeployment(stagedPaths, deployedName, 20_000);
console.error(`staged Theia extension: ${extensionId}@${version}`);
for (const stagedPath of stagedPaths) console.error(`  ${stagedPath}`);
for (const removed of removedDeployments) console.error(`replaced existing Theia extension: ${removed}`);
console.error(`Theia IDE: ${ide.displayPath}`);
if (deployed) {
  console.error(`deployed Theia extension: ${deployed}`);
} else {
  console.error("Theia accepted the install command. Reconnect the WSL remote window (or fully restart Theia) so its backend deploys the staged VSIX.");
}

function printUsage() {
  console.error([
    "Build and install the CodexHub VSIX into the Windows Theia IDE.",
    "",
    "Usage:",
    "  pnpm run install:theia",
    "  pnpm run install:theia -- 'C:\\path\\to\\TheiaIDE'",
    "  CODEX_HUB_THEIA_IDE_DIR=/mnt/c/path/to/TheiaIDE pnpm run install:theia",
    "",
    "The default Windows install is C:\\Users\\0laop\\AppData\\Local\\Programs\\TheiaIDE.",
    "When run from WSL, the VSIX is staged for both the Windows frontend and the",
    "current WSL remote backend before TheiaIDE.exe receives --install-plugin.",
    "An existing deployment of the same extension version is replaced.",
  ].join("\n"));
}

async function resolveTheiaIde(input: string | undefined, wsl: boolean) {
  const defaultInput = wsl
    ? "/mnt/c/Users/0laop/AppData/Local/Programs/TheiaIDE"
    : process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "TheiaIDE")
      : "";
  const value = (input || defaultInput).trim().replace(/^(\"|')(.*)\1$/, "$2");
  if (!value) throw new Error("The Theia IDE directory is required on this platform.");

  const resolved = wsl ? resolveWindowsInput(value) : {
    fileSystemPath: path.resolve(value),
    windowsPath: process.platform === "win32" ? path.resolve(value) : null
  };
  const executablePath = resolved.fileSystemPath.toLowerCase().endsWith(".exe")
    ? resolved.fileSystemPath
    : path.join(resolved.fileSystemPath, process.platform === "win32" || wsl ? "TheiaIDE.exe" : "theia-ide");
  await assertFile(executablePath, `Theia IDE executable not found: ${executablePath}`);
  const windowsExecutablePath = resolved.windowsPath
    ? resolved.windowsPath.toLowerCase().endsWith(".exe")
      ? resolved.windowsPath
      : `${resolved.windowsPath.replace(/[\\/]$/, "")}\\TheiaIDE.exe`
    : null;
  return {
    executablePath,
    windowsExecutablePath,
    displayPath: windowsExecutablePath ?? executablePath
  };
}

function resolveWindowsInput(input: string) {
  const windowsMatch = /^([a-z]):[\\/](.*)$/i.exec(input);
  if (windowsMatch) {
    return {
      fileSystemPath: path.resolve(`/mnt/${windowsMatch[1].toLowerCase()}/${windowsMatch[2].replace(/\\/g, "/")}`),
      windowsPath: `${windowsMatch[1].toUpperCase()}:\\${windowsMatch[2].replace(/\//g, "\\")}`
    };
  }
  const fileSystemPath = path.resolve(input);
  const mounted = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(fileSystemPath);
  if (!mounted) {
    throw new Error(`Expected a Windows path or WSL mounted path, received: ${input}`);
  }
  return {
    fileSystemPath,
    windowsPath: `${mounted[1].toUpperCase()}:\\${(mounted[2] ?? "").replace(/\//g, "\\")}`.replace(/\\$/, "")
  };
}

async function stageVsix(source: string, configDir: string) {
  const extensionsDir = path.join(configDir, "extensions");
  await mkdir(extensionsDir, { recursive: true });
  const target = path.join(extensionsDir, "codexhub.vsix");
  await copyFile(source, target);
  return target;
}

async function launchTheiaInstaller(executablePath: string, windowsExecutablePath: string | null, wsl: boolean) {
  if (!wsl) return runCommand(executablePath, [`--install-plugin=${vsixPath}`], { detached: true });
  if (!windowsExecutablePath) throw new Error("Could not resolve the Windows Theia IDE executable path.");
  const windowsVsixPath = "D:\\Downloads\\codexhub-theia.vsix";
  const windowsVsixFile = "/mnt/d/Downloads/codexhub-theia.vsix";
  await mkdir(path.dirname(windowsVsixFile), { recursive: true });
  await copyFile(vsixPath, windowsVsixFile);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$exe = '${psQuote(windowsExecutablePath)}'`,
    `$vsix = '${psQuote(windowsVsixPath)}'`,
    "if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw \"Theia IDE executable not found: $exe\" }",
    "if (-not (Test-Path -LiteralPath $vsix -PathType Leaf)) { throw \"VSIX not found: $vsix\" }",
    "Start-Process -FilePath $exe -ArgumentList @(\"--install-plugin=$vsix\")",
    "Write-Output \"started $exe --install-plugin=$vsix\""
  ].join("; ");
  return runCommand(await powershellPath(), ["-NoProfile", "-Command", script]);
}

async function waitForDeployment(stagedPaths: string[], deployedName: string, timeoutMs: number) {
  const roots = deploymentRoots(stagedPaths);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const root of roots) {
      const entries = await readdir(root).catch(() => []);
      const match = entries.find((entry) => entry.toLowerCase() === deployedName.toLowerCase());
      if (match) return path.join(root, match);
    }
    await delay(500);
  }
  return null;
}

async function removeExistingDeployments(stagedPaths: string[], deployedName: string) {
  const removed: string[] = [];
  for (const root of deploymentRoots(stagedPaths)) {
    const entries = await readdir(root).catch(() => []);
    const match = entries.find((entry) => entry.toLowerCase() === deployedName.toLowerCase());
    if (!match) continue;
    const target = path.join(root, match);
    await rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}

function deploymentRoots(stagedPaths: string[]) {
  return [
    ...new Set(stagedPaths.map((stagedPath) => path.join(path.dirname(path.dirname(stagedPath)), "deployedPlugins")))
  ];
}

async function powershellPath() {
  const candidate = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  try {
    await access(candidate);
    return candidate;
  } catch {
    return "powershell.exe";
  }
}

async function isWsl() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return (await readFile("/proc/version", "utf8")).toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function assertFile(filePath: string, message: string) {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}

function extensionIdentifier(manifest: ExtensionManifest) {
  if (!manifest.publisher || !manifest.name) {
    throw new Error("dist-vscode/package.json must include publisher and name.");
  }
  return `${manifest.publisher}.${manifest.name}`;
}

function psQuote(value: string) {
  return value.replace(/'/g, "''");
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function runCommand(command: string, commandArgs: string[], options: { detached?: boolean } = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      stdio: options.detached ? "ignore" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: options.detached
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ code: null, output: error.message });
    });
    if (options.detached) {
      child.unref();
      resolve({ code: 0, output: "" });
      return;
    }
    child.on("close", (code) => {
      resolve({ code, output });
    });
  });
}
