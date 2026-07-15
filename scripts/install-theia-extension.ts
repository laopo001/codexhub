import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deployTheiaExtensionAtomically } from "../src/core/theiaExtensionDeployment.js";

type ExtensionManifest = {
  name?: string;
  publisher?: string;
  version?: string;
};

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}
if (args.length > 0) {
  throw new Error(`Unknown install:theia arguments: ${args.join(" ")}. Use environment variables to override config directories.`);
}

const stagingDir = path.resolve("dist-vscode");
const vsixPath = path.join(stagingDir, "codexhub.vsix");
const manifest = await readJson<ExtensionManifest>(path.join(stagingDir, "package.json"));
const extensionId = extensionIdentifier(manifest);
const version = manifest.version?.trim();
if (!version) throw new Error("dist-vscode/package.json must include a version.");
await assertFile(vsixPath, "Theia-compatible VSIX not found. Run `pnpm package:vscode` first.");

const wsl = await isWsl();
const configDirs = wsl
  ? [
      path.resolve(process.env.CODEX_HUB_THEIA_WSL_CONFIG_DIR?.trim() || path.join(os.homedir(), ".theia-ide")),
      resolveWindowsConfigDir(process.env.CODEX_HUB_THEIA_WINDOWS_CONFIG_DIR?.trim()),
    ]
  : [path.resolve(process.env.CODEX_HUB_THEIA_CONFIG_DIR?.trim() || path.join(os.homedir(), ".theia-ide"))];

const uniqueConfigDirs = [...new Set(configDirs)];
const deploymentPaths: string[] = [];
const retainedBackups: string[] = [];
const removedDropIns: string[] = [];

for (const configDir of uniqueConfigDirs) {
  const staleDropIn = path.join(configDir, "extensions", "codexhub.vsix");
  if (await pathExists(staleDropIn)) {
    await rm(staleDropIn, { force: true });
    removedDropIns.push(staleDropIn);
  }
  const result = await deployTheiaExtensionAtomically({
    configDir,
    extensionId,
    version,
    vsixPath,
  });
  deploymentPaths.push(result.deploymentPath);
  if (result.retainedBackupPath) retainedBackups.push(result.retainedBackupPath);
}

let manualVsixPath: string | null = null;
if (wsl) {
  manualVsixPath = "/mnt/d/Downloads/codexhub-theia.vsix";
  await mkdir(path.dirname(manualVsixPath), { recursive: true });
  await copyFile(vsixPath, manualVsixPath);
}

console.error(`installed Theia extension deployment: ${extensionId}@${version}`);
for (const deployedPath of deploymentPaths) console.error(`  ${deployedPath}`);
if (manualVsixPath) {
  console.error(`manual VSIX: ${manualVsixPath} (D:\\Downloads\\codexhub-theia.vsix)`);
}
for (const staleDropIn of removedDropIns) {
  console.error(`removed stale drop-in VSIX: ${staleDropIn}`);
}
for (const backupPath of retainedBackups) {
  console.error(`warning: installed successfully but could not remove old backup: ${backupPath}`);
}

if (wsl) {
  const runtimeDir = await resolveWslTheiaRuntimeDir();
  const expectedExtension = `${extensionId}@${version}`;
  const wslVerification = await verifyWslTheiaDeployment(runtimeDir, uniqueConfigDirs[0], expectedExtension);
  console.error(`verified by Theia WSL backend: ${wslVerification}`);
  const windowsIde = await resolveWindowsTheiaIde();
  const windowsVerification = await verifyWindowsTheiaDeployment(windowsIde, uniqueConfigDirs[1], expectedExtension);
  console.error(`verified by Theia Windows backend: ${windowsVerification}`);
}

console.error("Restart the Theia WSL connection to activate the installed extension.");
console.error("Official UI fallback: run `Extensions: Install from VSIX...` and choose D:\\Downloads\\codexhub-theia.vsix.");

function printUsage() {
  console.error([
    "Build and install the CodexHub VSIX into Theia user deployment directories.",
    "",
    "Usage:",
    "  pnpm run install:theia",
    "",
    "Theia supports `--install-plugin` / `--install-extension`, but unlike VS Code",
    "it has no `--force` replacement for an already installed identical version.",
    "This helper extracts the complete VSIX layout and atomically replaces the old",
    "deployment, then asks the Theia WSL backend to list the installed extension.",
    "",
    "Overrides:",
    "  CODEX_HUB_THEIA_WSL_CONFIG_DIR=/path/to/.theia-ide",
    "  CODEX_HUB_THEIA_WINDOWS_CONFIG_DIR=C:\\path\\to\\.theia-ide",
    "  CODEX_HUB_THEIA_CONFIG_DIR=/path/to/.theia-ide",
  ].join("\n"));
}

function resolveWindowsConfigDir(input: string | undefined) {
  if (!input) return "/mnt/c/Users/0laop/.theia-ide";
  const windowsMatch = /^([a-z]):[\\/](.*)$/i.exec(input);
  if (windowsMatch) {
    return path.resolve(`/mnt/${windowsMatch[1].toLowerCase()}/${windowsMatch[2].replace(/\\/g, "/")}`);
  }
  const resolved = path.resolve(input);
  if (!/^\/mnt\/[a-z](?:\/|$)/i.test(resolved)) {
    throw new Error(`Expected a Windows path or WSL mounted path, received: ${input}`);
  }
  return resolved;
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

async function resolveWslTheiaRuntimeDir() {
  const override = process.env.CODEX_HUB_THEIA_WSL_RUNTIME_DIR?.trim();
  if (override) {
    await assertTheiaRuntime(override);
    return path.resolve(override);
  }

  const entries = await readdir(os.homedir(), { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && /^\.theia-ide-electron-app-.+-remote$/.test(entry.name))
    .map((entry) => path.join(os.homedir(), entry.name))
    .sort()
    .reverse();
  for (const candidate of candidates) {
    try {
      await assertTheiaRuntime(candidate);
      return candidate;
    } catch {
      // Continue looking for a complete Theia remote runtime.
    }
  }
  throw new Error("The Theia WSL remote runtime was not found. Connect Theia to WSL once, then rerun install:theia.");
}

async function resolveWindowsTheiaIde() {
  const input = process.env.CODEX_HUB_THEIA_IDE_DIR?.trim()
    || "/mnt/c/Users/0laop/AppData/Local/Programs/TheiaIDE";
  const fileSystemPath = resolveWindowsConfigDir(input);
  const executablePath = fileSystemPath.toLowerCase().endsWith(".exe")
    ? fileSystemPath
    : path.join(fileSystemPath, "TheiaIDE.exe");
  await assertFile(executablePath, `Theia IDE executable not found: ${executablePath}`);
  const windowsExecutablePath = mountedPathToWindowsPath(executablePath);
  const windowsIdeDir = windowsExecutablePath.replace(/\\TheiaIDE\.exe$/i, "");
  return {
    executablePath,
    windowsBackendPath: `${windowsIdeDir}\\resources\\app.asar\\lib\\backend\\main.js`,
    windowsExecutablePath,
  };
}

async function assertTheiaRuntime(runtimeDir: string) {
  const entries = await readdir(runtimeDir, { withFileTypes: true });
  const nodeDir = entries.find((entry) => entry.isDirectory() && /^node-v.+-linux-x64$/.test(entry.name));
  if (!nodeDir) throw new Error(`Theia remote Node.js runtime not found under ${runtimeDir}`);
  await Promise.all([
    assertFile(path.join(runtimeDir, nodeDir.name, "bin", "node"), `Theia remote Node.js runtime not found under ${runtimeDir}`),
    assertFile(path.join(runtimeDir, "lib", "backend", "main.js"), `Theia remote backend not found under ${runtimeDir}`),
  ]);
}

async function verifyWslTheiaDeployment(runtimeDir: string, configDir: string, expectedExtension: string) {
  const nodeDirEntries = await readdir(runtimeDir, { withFileTypes: true });
  const nodeDir = nodeDirEntries.find((entry) => entry.isDirectory() && /^node-v.+-linux-x64$/.test(entry.name));
  if (!nodeDir) throw new Error(`Theia remote Node.js runtime not found under ${runtimeDir}`);
  const executable = path.join(runtimeDir, nodeDir.name, "bin", "node");
  const backend = path.join(runtimeDir, "lib", "backend", "main.js");
  const output = await runUntilOutput(executable, [backend, "list-plugins", "--show-versions", "--port=0"], {
    ...process.env,
    THEIA_CONFIG_DIR: configDir,
  }, expectedExtension, 20_000);
  const installedLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line === expectedExtension);
  if (!installedLine) throw new Error(`Theia did not list the installed extension ${expectedExtension}.\n${output.trim()}`);
  return installedLine;
}

async function verifyWindowsTheiaDeployment(
  ide: { executablePath: string; windowsBackendPath: string; windowsExecutablePath: string },
  configDir: string,
  expectedExtension: string,
) {
  const windowsConfigDir = mountedPathToWindowsPath(configDir);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$env:ELECTRON_RUN_AS_NODE = '1'",
    `$env:THEIA_CONFIG_DIR = '${psQuote(windowsConfigDir)}'`,
    `$exe = '${psQuote(ide.windowsExecutablePath)}'`,
    `$backend = '${psQuote(ide.windowsBackendPath)}'`,
    `$expected = '${psQuote(expectedExtension)}'`,
    "$stdout = Join-Path $env:TEMP ('codexhub-theia-' + [guid]::NewGuid().ToString() + '.out.log')",
    "$stderr = Join-Path $env:TEMP ('codexhub-theia-' + [guid]::NewGuid().ToString() + '.err.log')",
    "$arguments = @(('\"' + $backend + '\"'), 'list-plugins', '--show-versions', '--port=0')",
    "$process = Start-Process -FilePath $exe -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru",
    "$deadline = (Get-Date).AddSeconds(20)",
    "$combined = ''",
    "try { do { Start-Sleep -Milliseconds 200; $combined = ((Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue) + \"`n\" + (Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue)); if (($combined -split '\\r?\\n') -contains $expected) { break } } while ((Get-Date) -lt $deadline -and -not $process.HasExited) } finally { if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }; Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue }",
    "if (($combined -split '\\r?\\n') -notcontains $expected) { Write-Output $combined; throw \"Theia Windows backend did not list $expected\" }",
    "Write-Output $expected",
  ].join("; ");
  const result = await runCommand(await powershellPath(), ["-NoProfile", "-Command", script]);
  if (result.code !== 0) {
    throw new Error(`Theia Windows deployment verification failed:\n${result.output.trim()}`);
  }
  const installedLine = result.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line === expectedExtension);
  if (!installedLine) throw new Error(`Theia Windows backend did not list ${expectedExtension}.\n${result.output.trim()}`);
  return installedLine;
}

function runUntilOutput(
  command: string,
  commandArgs: string[],
  env: NodeJS.ProcessEnv,
  expectedOutput: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      detached: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const stop = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const forceTimer = setTimeout(() => {
        if (child.exitCode !== null) return;
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 1_000);
      forceTimer.unref();
    };
    const finish = () => {
      if (settled || !output.split(/\r?\n/).some((line) => line.trim() === expectedOutput)) return;
      settled = true;
      clearTimeout(timeout);
      stop();
      resolve(output);
    };
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      finish();
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Theia verification exited with code ${code ?? "unknown"}.\n${output.trim()}`));
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      reject(new Error(`Timed out waiting for Theia to list ${expectedOutput}.\n${output.trim()}`));
    }, timeoutMs);
  });
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function mountedPathToWindowsPath(value: string) {
  const match = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(path.resolve(value));
  if (!match) throw new Error(`Cannot convert WSL mounted path to Windows path: ${value}`);
  return `${match[1].toUpperCase()}:\\${(match[2] ?? "").replace(/\//g, "\\")}`.replace(/\\$/, "");
}

async function powershellPath() {
  const candidate = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  return await pathExists(candidate) ? candidate : "powershell.exe";
}

function psQuote(value: string) {
  return value.replace(/'/g, "''");
}

function runCommand(command: string, commandArgs: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ code: null, output: error.message });
    });
    child.on("close", (code) => {
      resolve({ code, output });
    });
  });
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
