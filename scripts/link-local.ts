import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const powershellPath = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

export const toWindowsWslPath = (posixPath: string, distroName: string) => {
  const normalizedPath = posixPath.replace(/^\/+/, "").replaceAll("/", "\\");
  return `\\\\wsl.localhost\\${distroName}\\${normalizedPath}`;
};

export const toPowerShellSingleQuoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

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

  console.log(`codexhub link: WSL ${repositoryRoot}`);
  await run("npm", ["link"], { cwd: repositoryRoot, env: process.env });

  console.log(`codexhub link: Windows ${windowsRepositoryRoot}`);
  await run(powershellPath, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      "$ErrorActionPreference = 'Stop'",
      `Set-Location -LiteralPath ${toPowerShellSingleQuoted("C:\\")}`,
      `$source = ${toPowerShellSingleQuoted(windowsRepositoryRoot)}`,
      "$command = 'pushd \"' + $source + '\" && cd && npm link'",
      "cmd.exe /d /s /c $command",
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
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
