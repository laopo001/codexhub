import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type {
  CodexAppServerLaunchOptions,
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  CodexSandboxMode
} from "../shared/appServerLaunch.js";
import { readPositiveIntEnv } from "../shared/env.js";
export type {
  CodexAppServerLaunchOptions,
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  CodexSandboxMode
} from "../shared/appServerLaunch.js";

export type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

export type CodexAppServerProcessHandle = {
  cwd: string;
  port: number;
  appServerUrl: string;
  cliVersion: string;
  stop: () => Promise<void>;
  wait: () => Promise<ChildExit>;
};

export type StartedCodexAppServerProcess = {
  child: ChildProcess;
  stopped: Promise<ChildExit>;
  cliVersion: string;
};

export const minimumCodexCliVersion = "0.144.4";
export class UnsupportedCodexCliVersionError extends Error {
  constructor(readonly version: string, readonly minimumVersion = minimumCodexCliVersion) {
    super(`Codex CLI ${minimumVersion} or newer is required for the current app-server protocol; found ${version}.`);
    this.name = "UnsupportedCodexCliVersionError";
  }
}
const codexAppServerReadyTimeoutMs = () => readPositiveIntEnv(process.env, "CODEX_HUB_APP_SERVER_READY_TIMEOUT_MS", 60_000);
const codexAppServerStderrTailLimit = 4000;
const execFileAsync = promisify(execFile);

// 启动官方 Codex app-server，并保留足够 stderr 方便解释 ready 失败。
export const startCodexAppServer = async (
  cwd: string,
  appServerUrl: string,
  port: number,
  options: CodexAppServerLaunchOptions = {}
): Promise<StartedCodexAppServerProcess> => {
  const launch = await codexAppServerLaunch(appServerUrl, resolveCodexAppServerLaunchOptions(options));
  const spawnOptions: SpawnOptions = {
    cwd,
    env: codexAppServerEnv(launch.codexCommand),
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32"
  };
  let child: ChildProcess;
  try {
    child = spawn(launch.command, launch.args, spawnOptions);
  } catch (error) {
    throw new Error(`codex app-server failed to spawn (${launch.command}): ${errorText(error)}`);
  }
  const stopped = waitForChild(child);
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    process.stderr.write(chunk);
    stderrTail = textTail(`${stderrTail}${chunk.toString()}`, codexAppServerStderrTailLimit);
  });
  try {
    await waitForReady(port, child, {
      timeoutMs: codexAppServerReadyTimeoutMs(),
      stderr: () => stderrTail
    });
    return { child, stopped, cliVersion: launch.cliVersion };
  } catch (error) {
    await terminateChild(child, stopped).catch((cleanupError: unknown) => {
      console.error(`codex app-server cleanup after failed startup failed: ${errorText(cleanupError)}`);
    });
    throw error;
  }
};

export const startCodexAppServerProcess = async (
  cwdInput: string,
  portInput?: number,
  options: CodexAppServerLaunchOptions = {}
): Promise<CodexAppServerProcessHandle> => {
  const cwd = path.resolve(cwdInput);
  const port = portInput ?? await findFreePort();
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid port: ${portInput}`);
  const appServerUrl = `ws://127.0.0.1:${port}`;
  const { child, stopped, cliVersion } = await startCodexAppServer(cwd, appServerUrl, port, options);
  const stop = cleanupOnce(async () => {
    await terminateChild(child, stopped);
  });
  return {
    cwd,
    port,
    appServerUrl,
    cliVersion,
    stop,
    wait: () => stopped
  };
};

export const terminateChild = async (
  child: ChildProcess,
  stopped: Promise<ChildExit>,
  gracefulTimeoutMs = 3000,
  killTimeoutMs = 3000
) => {
  if (child.exitCode !== null || child.signalCode !== null) return await stopped;
  signalChildProcess(child, "SIGTERM");
  const graceful = await Promise.race([
    stopped,
    delay(gracefulTimeoutMs).then(() => null)
  ]);
  if (graceful) return graceful;

  if (child.exitCode === null && child.signalCode === null) signalChildProcess(child, "SIGKILL");
  return await Promise.race([
    stopped,
    delay(killTimeoutMs).then(() => ({ code: child.exitCode, signal: child.signalCode }))
  ]);
};

export const findFreePort = async () => await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => resolve(port));
  });
});

export const signalExitCode = (signal: NodeJS.Signals) => {
  const signalNumbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
  const signalNumber = signalNumbers[signal] ?? 1;
  return 128 + signalNumber;
};

export const resolveCodexAppServerLaunchOptions = (
  overrides: CodexAppServerLaunchOptions = {}
): CodexAppServerLaunchOptions => {
  const envOptions = codexAppServerLaunchOptionsFromEnv();
  return {
    approvalPolicy: overrides.approvalPolicy ?? envOptions.approvalPolicy,
    approvalsReviewer: overrides.approvalsReviewer ?? envOptions.approvalsReviewer ?? "auto_review",
    sandbox: overrides.sandbox ?? envOptions.sandbox
  };
};

export const codexAppServerLaunchOptionsFromEnv = (): CodexAppServerLaunchOptions => ({
  approvalPolicy: parseCodexApprovalPolicy(process.env.CODEX_HUB_APP_SERVER_APPROVAL_POLICY, "CODEX_HUB_APP_SERVER_APPROVAL_POLICY"),
  approvalsReviewer: parseCodexApprovalsReviewer(
    process.env.CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER,
    "CODEX_HUB_APP_SERVER_APPROVALS_REVIEWER"
  ),
  sandbox: parseCodexSandboxMode(process.env.CODEX_HUB_APP_SERVER_SANDBOX, "CODEX_HUB_APP_SERVER_SANDBOX")
});

export const parseCodexApprovalPolicy = (
  value: string | undefined,
  label = "approval policy"
): CodexApprovalPolicy | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "untrusted" || trimmed === "on-request" || trimmed === "never") return trimmed;
  throw new Error(`Invalid ${label}: ${value}`);
};

export const parseCodexSandboxMode = (
  value: string | undefined,
  label = "sandbox mode"
): CodexSandboxMode | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "read-only" || trimmed === "workspace-write" || trimmed === "danger-full-access") return trimmed;
  throw new Error(`Invalid ${label}: ${value}`);
};

export const parseCodexApprovalsReviewer = (
  value: string | undefined,
  label = "approvals reviewer"
): CodexApprovalsReviewer | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "user" || trimmed === "auto_review" || trimmed === "guardian_subagent") return trimmed;
  throw new Error(`Invalid ${label}: ${value}`);
};

const codexAppServerLaunch = async (appServerUrl: string, options: CodexAppServerLaunchOptions) => {
  const codexCommand = await resolveCodexCommand();
  const cliVersion = await readCodexCliVersion(codexCommand);
  assertSupportedCodexCliVersion(cliVersion);
  const appServerArgs = codexAppServerArgs(appServerUrl, options);
  if (process.platform === "linux" && await fileExists("/usr/bin/setpriv")) {
    // 在 Linux 下把子进程绑定到当前进程，避免崩溃后留下孤儿 app-server。
    return {
      command: "/usr/bin/setpriv",
      args: ["--pdeathsig", "TERM", codexCommand, ...appServerArgs],
      codexCommand,
      cliVersion
    };
  }
  if (needsWindowsCommandShell(codexCommand)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "call", codexCommand, ...appServerArgs],
      codexCommand,
      cliVersion
    };
  }
  return {
    command: codexCommand,
    args: appServerArgs,
    codexCommand,
    cliVersion
  };
};

const codexAppServerArgs = (appServerUrl: string, options: CodexAppServerLaunchOptions) => [
  "app-server",
  ...codexConfigArgs(options),
  "--listen",
  appServerUrl
];

const codexConfigArgs = (options: CodexAppServerLaunchOptions) => [
  ...(options.approvalPolicy ? ["-c", `approval_policy="${options.approvalPolicy}"`] : []),
  ...(options.approvalsReviewer ? ["-c", `approvals_reviewer="${options.approvalsReviewer}"`] : []),
  ...(options.sandbox ? ["-c", `sandbox_mode="${options.sandbox}"`] : [])
];

const codexAppServerEnv = (codexCommand: string) => ({
  ...process.env,
  PATH: uniquePathEntries([
    path.dirname(process.execPath),
    path.dirname(codexCommand),
    ...(process.env.PATH ?? "").split(path.delimiter)
  ]).join(path.delimiter)
});

export const resolveCodexCommand = async () => {
  for (const candidate of codexCommandCandidates()) {
    if (candidate && await fileExists(candidate)) return candidate;
  }
  throw new Error("codex CLI not found. Install @openai/codex or set CODEX_HUB_CODEX_CLI to the codex executable path.");
};

export const readCodexCliVersion = async (codexCommand: string) => {
  const command = needsWindowsCommandShell(codexCommand)
    ? process.env.ComSpec || "cmd.exe"
    : codexCommand;
  const args = needsWindowsCommandShell(codexCommand)
    ? ["/d", "/s", "/c", "call", codexCommand, "--version"]
    : ["--version"];
  let output: string;
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      env: codexAppServerEnv(codexCommand),
      timeout: 10_000,
      windowsHide: true
    });
    output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  } catch (error) {
    throw new Error(`Unable to read Codex CLI version from ${codexCommand}: ${errorText(error)}`);
  }
  const version = parseCodexCliVersion(output);
  if (!version) {
    throw new Error(`Unable to parse Codex CLI version from ${codexCommand}: ${output.trim() || "empty output"}`);
  }
  return version;
};

export const parseCodexCliVersion = (value: string) =>
  value.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1];

export const assertSupportedCodexCliVersion = (
  version: string,
  minimumVersion = minimumCodexCliVersion
) => {
  if (compareSemver(version, minimumVersion) >= 0) return;
  throw new UnsupportedCodexCliVersionError(version, minimumVersion);
};

const compareSemver = (left: string, right: string) => {
  const [leftCore, leftPrerelease] = left.split("-", 2);
  const [rightCore, rightPrerelease] = right.split("-", 2);
  const leftParts = leftCore.split(".").map(Number);
  const rightParts = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  if (leftPrerelease === undefined) return rightPrerelease === undefined ? 0 : 1;
  if (rightPrerelease === undefined) return -1;
  const leftIdentifiers = leftPrerelease.split(".");
  const rightIdentifiers = rightPrerelease.split(".");
  for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index += 1) {
    const leftIdentifier = leftIdentifiers[index];
    const rightIdentifier = rightIdentifiers[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumber = /^\d+$/.test(leftIdentifier) ? Number(leftIdentifier) : null;
    const rightNumber = /^\d+$/.test(rightIdentifier) ? Number(rightIdentifier) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftIdentifier.localeCompare(rightIdentifier);
  }
  return 0;
};

const codexCommandCandidates = () => {
  const executableNames = process.platform === "win32"
    ? ["codex.cmd", "codex.bat", "codex.exe", "codex"]
    : ["codex"];
  const windowsGlobalDirs = process.platform === "win32"
    ? [
      path.join(os.homedir(), "AppData", "Roaming", "npm"),
      path.join(os.homedir(), "AppData", "Local", "pnpm"),
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : undefined
    ]
    : [];
  const pathCandidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => isCodexPathEntryUsableOnPlatform(entry))
    .flatMap((entry) => executableNames.map((name) => path.join(entry, name)));
  return [
    process.env.CODEX_HUB_CODEX_CLI,
    ...pathCandidates,
    ...executableNames.map((name) => path.join(os.homedir(), ".local", "share", "pnpm", "bin", name)),
    ...executableNames.map((name) => path.join(os.homedir(), ".npm-global", "bin", name)),
    ...windowsGlobalDirs.flatMap((entry) => entry ? executableNames.map((name) => path.join(entry, name)) : [])
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
};

// WSL 会把 Windows PATH 注入 Linux 进程。那些目录里的 npm/pnpm shim 会由
// Linux node 执行 Windows node_modules，进而加载错误平台的 Codex 可选依赖。
// 显式 CODEX_HUB_CODEX_CLI 仍保留覆盖能力；这里只过滤 PATH 自动发现。
export const isCodexPathEntryUsableOnPlatform = (
  entry: string,
  platform: NodeJS.Platform = process.platform
) => platform !== "linux" || !/^\/mnt\/[a-z](?:\/|$)/i.test(entry);

const needsWindowsCommandShell = (command: string) =>
  process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);

const uniquePathEntries = (entries: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
};

const fileExists = async (filePath: string) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

type WaitForReadyOptions = {
  timeoutMs: number;
  stderr: () => string;
};

const waitForReady = async (port: number, child: ChildProcess, options: WaitForReadyOptions) => {
  let childExited = false;
  let childExitCode: number | null = null;
  let childExitSignal: NodeJS.Signals | null = null;
  let childError: Error | null = null;
  child.once("error", (error) => {
    childError = error;
  });
  child.once("exit", (code, signal) => {
    childExited = true;
    childExitCode = code;
    childExitSignal = signal;
  });
  const url = `http://127.0.0.1:${port}/readyz`;
  const startedAt = Date.now();
  // 轮询 /readyz 而不是固定 sleep，让 CLI 解析和登录问题尽快暴露。
  while (Date.now() - startedAt < options.timeoutMs) {
    if (childError) throw appServerReadyError(`codex app-server failed to start: ${errorText(childError)}`, options.stderr());
    if (childExited) {
      const code = childExitCode ?? "";
      const signal = childExitSignal ?? "";
      throw appServerReadyError(`codex app-server exited before becoming ready: code=${code} signal=${signal}`, options.stderr());
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // 继续轮询直到超时
    }
    await delay(150);
  }
  throw appServerReadyError(`codex app-server did not become ready after ${options.timeoutMs}ms: ${url}`, options.stderr());
};

const appServerReadyError = (message: string, stderr: string) => {
  const tail = stderr.trim();
  return new Error(tail ? `${message}\nRecent codex app-server stderr:\n${tail}` : message);
};

const waitForChild = async (child: ChildProcess) => await new Promise<ChildExit>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

const signalChildProcess = (child: ChildProcess, signal: NodeJS.Signals) => {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // 回退到下面的直接子进程 signal。
    }
  }
  try {
    child.kill(signal);
  } catch {
    // 状态检查和 signal 之间进程可能已经退出。
  }
};

const cleanupOnce = <T>(cleanup: () => T | Promise<T>) => {
  let called = false;
  return async () => {
    if (called) return undefined;
    called = true;
    return await cleanup();
  };
};

const textTail = (value: string, limit: number) => value.length <= limit ? value : value.slice(-limit);

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
