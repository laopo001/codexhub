import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { codexHubExtensionId, resolveCodexHubVsixPath } from "./codexHubVsix.js";

type CommandResult = {
  code: number | null;
  errorCode?: string;
  output: string;
};

export type InstallVSCodeExtensionOptions = {
  codeCommand?: string;
  codeInsidersCommand?: string;
  installWindowsHost?: boolean;
  vsixPath?: string;
};

export type InstallVSCodeExtensionResult = {
  localExtension: string;
  localInsidersExtension: string | null;
  vsixPath: string;
  windowsExtension: string | null;
  windowsInsidersExtension: string | null;
};

export async function installVSCodeExtension(
  options: InstallVSCodeExtensionOptions = {},
): Promise<InstallVSCodeExtensionResult> {
  const vsixPath = await resolveCodexHubVsixPath(options.vsixPath);
  const codeCommand = options.codeCommand?.trim() || "code";
  const localExtension = await installWithLocalCode(vsixPath, codexHubExtensionId, codeCommand);
  const codeInsidersCommand = options.codeInsidersCommand?.trim() || "code-insiders";
  let localInsidersExtension: string | null = null;
  if (await commandExists(codeInsidersCommand)) {
    localInsidersExtension = await installWithLocalCode(vsixPath, codexHubExtensionId, codeInsidersCommand);
    if (!localInsidersExtension) {
      throw new Error("Could not install VS Code extension in VS Code Insiders.");
    }
  }
  const installWindowsHost = options.installWindowsHost ?? await isWsl();
  let windowsExtension: string | null = null;
  let windowsInsidersExtension: string | null = null;

  if (installWindowsHost) {
    ({ stable: windowsExtension, insiders: windowsInsidersExtension } = await installWithWindowsCode(
      vsixPath,
      codexHubExtensionId,
    ));
  }
  if (!localExtension) {
    throw new Error(installWindowsHost
      ? "Could not install VS Code extension in the current WSL environment. Ensure the `code` CLI is installed and on PATH."
      : "Could not install VS Code extension. Ensure the `code` CLI is installed and on PATH.");
  }
  return {
    localExtension,
    localInsidersExtension,
    vsixPath,
    windowsExtension,
    windowsInsidersExtension,
  };
}

async function installWithLocalCode(vsix: string, id: string, command: string) {
  const install = await runCommand(command, ["--install-extension", vsix, "--force"]);
  if (!installSucceeded(install)) return null;
  return await installedExtensionLine(command, id);
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
    "Write-Output ('CODEXHUB_STABLE::' + $match)",
    "$codeInsidersCmd = (Get-Command code-insiders.cmd -ErrorAction SilentlyContinue).Source",
    "if (-not $codeInsidersCmd) { $candidate = Join-Path $env:LOCALAPPDATA 'Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd'; if (Test-Path $candidate) { $codeInsidersCmd = $candidate } }",
    `if ($codeInsidersCmd) { & $codeInsidersCmd --install-extension '${psQuote(windowsVsix)}' --force; $insidersExtensions = & $codeInsidersCmd --list-extensions --show-versions; $insidersMatch = $insidersExtensions | Where-Object { $_ -like '${psQuote(id)}@*' } | Select-Object -First 1; if (-not $insidersMatch) { throw 'Installed extension not found in VS Code Insiders extension list: ${psQuote(id)}' }; Write-Output ('CODEXHUB_INSIDERS::' + $insidersMatch) }`,
  ].join("; ");

  const powershell = await powershellPath();
  const result = await runCommand(powershell, ["-NoProfile", "-Command", ps]);
  if (result.code !== 0) {
    throw new Error(`Windows VS Code extension install failed:\n${result.output.trim()}`);
  }
  const outputLines = result.output.trim().split(/\r?\n/).map((line) => line.trim());
  const stable = outputLines.find((line) => line.startsWith("CODEXHUB_STABLE::"))?.slice("CODEXHUB_STABLE::".length);
  const insiders = outputLines.find((line) => line.startsWith("CODEXHUB_INSIDERS::"))?.slice("CODEXHUB_INSIDERS::".length) ?? null;
  if (!stable) {
    throw new Error(`Windows VS Code extension install did not return a verification result:\n${result.output.trim()}`);
  }
  return { stable, insiders };
}

async function commandExists(command: string) {
  const result = await runCommand(command, ["--version"]);
  return result.errorCode !== "ENOENT";
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

function psQuote(value: string) {
  return value.replace(/'/g, "''");
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ code: null, errorCode: "code" in error ? String(error.code) : undefined, output: error.message });
    });
    child.on("close", (code) => {
      resolve({ code, output });
    });
  });
}
