import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
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

const vsixPath = path.resolve("dist-vscode/codexhub.vsix");
const manifest = await readJson<ExtensionManifest>("dist-vscode/package.json");
const extensionId = extensionIdentifier(manifest);

await assertFile(vsixPath, "VSCode package not found. Run `pnpm package:vscode` first.");

const localInstalled = await installWithLocalCode(vsixPath, extensionId);

if (await isWsl()) {
  await installWithWindowsCode(vsixPath, extensionId);
  if (!localInstalled) {
    throw new Error("Could not install VSCode extension in the current WSL environment. Ensure the `code` CLI is installed and on PATH.");
  }
  process.exit(0);
}

if (localInstalled) {
  process.exit(0);
}

throw new Error("Could not install VSCode extension. Ensure the `code` CLI is installed and on PATH.");

async function installWithLocalCode(vsix: string, id: string) {
  const install = await runCommand("code", ["--install-extension", vsix, "--force"]);
  if (!installSucceeded(install)) return false;

  const listed = await installedExtensionLine("code", id);
  if (!listed) return false;
  console.error(`installed VSCode extension: ${listed}`);
  return true;
}

async function installWithWindowsCode(vsix: string, id: string) {
  const windowsVsix = await copyVsixToWindowsDownloads(vsix);
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "Set-Location C:\\",
    "$codeCmd = (Get-Command code.cmd -ErrorAction SilentlyContinue).Source",
    "if (-not $codeCmd) { $candidate = Join-Path $env:LOCALAPPDATA 'Programs\\Microsoft VS Code\\bin\\code.cmd'; if (Test-Path $candidate) { $codeCmd = $candidate } }",
    "if (-not $codeCmd) { throw 'VS Code code.cmd not found' }",
    `& $codeCmd --install-extension '${psQuote(windowsVsix)}' --force`,
    "$extensions = & $codeCmd --list-extensions --show-versions",
    `$match = $extensions | Where-Object { $_ -like '${psQuote(id)}@*' } | Select-Object -First 1`,
    `if (-not $match) { throw 'Installed extension not found in VS Code extension list: ${psQuote(id)}' }`,
    "Write-Output $match"
  ].join("; ");

  const powershell = await powershellPath();
  const result = await runCommand(powershell, ["-NoProfile", "-Command", ps]);
  if (result.code !== 0) {
    throw new Error(`Windows VSCode extension install failed:\n${result.output.trim()}`);
  }
  console.error(`installed VSCode extension: ${result.output.trim().split(/\r?\n/).at(-1) ?? id}`);
}

async function installedExtensionLine(command: string, id: string) {
  const list = await runCommand(command, ["--list-extensions", "--show-versions"]);
  if (list.code !== 0 || isRemoteCliOnlyOutput(list.output)) return null;
  return list.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().startsWith(`${id.toLowerCase()}@`)) ?? null;
}

function installSucceeded(result: CommandResult) {
  if (result.code !== 0) return false;
  return !isRemoteCliOnlyOutput(result.output);
}

function isRemoteCliOnlyOutput(output: string) {
  return output.includes("Command is only available in WSL or inside a Visual Studio Code terminal");
}

async function copyVsixToWindowsDownloads(vsix: string) {
  const downloads = "/mnt/d/Downloads";
  await mkdir(downloads, { recursive: true });
  const target = path.join(downloads, "codexhub.vsix");
  await copyFile(vsix, target);
  return mountedPathToWindowsPath(target);
}

function mountedPathToWindowsPath(value: string) {
  const match = value.match(/^\/mnt\/([a-z])\/(.+)$/i);
  if (!match) throw new Error(`Cannot convert WSL path to Windows path: ${value}`);
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
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

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
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
    child.on("close", (code) => {
      resolve({ code, output });
    });
  });
}
