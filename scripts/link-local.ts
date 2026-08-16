import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { withUserPath } from "../src/core/userPath.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powershellPath = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const execFileAsync = promisify(execFile);

export const toWindowsWslPath = (posixPath: string, distroName: string) => {
  const normalizedPath = posixPath.replace(/^\/+/, "").replaceAll("/", "\\");
  return `\\\\wsl.localhost\\${distroName}\\${normalizedPath}`;
};

export const toPowerShellSingleQuoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

const readUserNpm = async (env: NodeJS.ProcessEnv) => {
  if (process.platform === "win32") return "npm.cmd";
  const shell = env.SHELL?.trim();
  if (!shell || !path.isAbsolute(shell)) return "npm";
  try {
    const { stdout } = await execFileAsync(shell, ["-ilc", "command -v npm"], {
      env,
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    const candidate = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/"))
      .at(-1);
    return candidate || "npm";
  } catch {
    return "npm";
  }
};

const prependExecutableDirectory = (env: NodeJS.ProcessEnv, executablePath: string) => {
  if (!path.isAbsolute(executablePath)) return env;
  const currentPath = env.PATH?.trim();
  const executableDirectory = path.dirname(executablePath);
  return {
    ...env,
    PATH: [executableDirectory, currentPath]
      .filter((entry): entry is string => Boolean(entry))
      .join(path.delimiter)
  };
};

const run = async (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
) => await new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
    windowsHide: true
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(
      `${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}.`
    ));
  });
});

export const linkLocalPackage = async () => {
  const distroName = process.env.WSL_DISTRO_NAME?.trim() || "Ubuntu";
  const windowsRepositoryRoot = toWindowsWslPath(repositoryRoot, distroName);
  const userEnv = await withUserPath(process.env);
  const wslNpm = await readUserNpm(userEnv);
  const wslNpmEnv = prependExecutableDirectory(userEnv, wslNpm);

  console.log(`codexhub link: WSL ${repositoryRoot} via ${wslNpm}`);
  await run(wslNpm, ["link"], { cwd: repositoryRoot, env: wslNpmEnv });

  console.log(`codexhub link: Windows npm link from ${windowsRepositoryRoot}`);
  await run(powershellPath, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      "$ErrorActionPreference = 'Stop'",
      `$source = ${toPowerShellSingleQuoted(windowsRepositoryRoot)}`,
      "$stage = Join-Path $env:LOCALAPPDATA 'CodexHub\\windows-link-package'",
      "$marker = Join-Path $stage '.codexhub-link-source'",
      "if (Test-Path -LiteralPath $stage) {",
      "  if (-not (Test-Path -LiteralPath $marker)) { throw \"Refusing to replace unmarked Windows staging directory: $stage\" }",
      "  if ((Get-Content -LiteralPath $marker -Raw).Trim() -ne $source) { throw \"Refusing to replace Windows staging directory with a different source: $stage\" }",
      "  foreach ($item in @('package.json', 'bin', 'dist', 'dist-node')) {",
      "    $target = Join-Path $stage $item",
      "    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }",
      "  }",
      "}",
      "New-Item -ItemType Directory -Path $stage -Force | Out-Null",
      "foreach ($item in @('package.json', 'bin', 'dist', 'dist-node')) {",
      "  $sourceItem = Join-Path $source $item",
      "  if (-not (Test-Path -LiteralPath $sourceItem)) { throw \"Missing built link artifact: $sourceItem\" }",
      "  Copy-Item -LiteralPath $sourceItem -Destination (Join-Path $stage $item) -Recurse -Force",
      "}",
      "[IO.File]::WriteAllText($marker, $source, [Text.UTF8Encoding]::new($false))",
      "Push-Location -LiteralPath $stage",
      "try {",
      "  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1).Source",
      "  if (-not $npm) { $npm = (Get-Command npm -ErrorAction Stop | Select-Object -First 1).Source }",
      "  if (-not $npm) { throw 'Windows npm was not found in PATH' }",
      "  & $npm install --omit=dev --ignore-scripts --no-audit --no-fund",
      "  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
      "  & $npm link",
      "  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
      "} finally { Pop-Location }",
      "Write-Output \"Windows npm link package: $stage\""
    ].join("; ")
  ], { env: process.env });

  console.log("codexhub link: WSL and Windows links are ready.");
};

const isMainModule = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (isMainModule) {
  linkLocalPackage().catch((error: unknown) => {
    console.error(`codexhub link failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
