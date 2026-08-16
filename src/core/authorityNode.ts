import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AuthorityNodeSource } from "../shared/surfaceTypes.js";

const execFileAsync = promisify(execFile);

/** The authority bundle is built for Node 20 and must not run on an older Node. */
export const minimumAuthorityNodeMajor = 20;

export type AuthorityNodeRuntime = {
  command: string;
  version: string;
  source: Exclude<AuthorityNodeSource, "unknown">;
};

type NodeVersion = {
  major: number;
  minor: number;
  patch: number;
  normalized: string;
};

/**
 * Resolve the Node executable for a detached authority.
 *
 * The explicit setting is intentionally an executable path/command rather than
 * an npm package name. npm installs packages; nvm/fnm/asdf or a system Node
 * installation supplies the runtime that appears on PATH.
 */
export const resolveAuthorityNode = async (
  env: NodeJS.ProcessEnv = process.env,
  fallbackCommand = process.execPath
): Promise<AuthorityNodeRuntime> => {
  const configured = env.CODEX_HUB_AUTHORITY_NODE?.trim();
  if (configured) {
    const command = await resolveNodeCommand(configured, env);
    if (!command) {
      throw new Error(
        `CODEX_HUB_AUTHORITY_NODE was not found: ${configured}. `
        + "Set it to a Node executable path or remove it to use PATH."
      );
    }
    return await inspectNode(command, "configured", env);
  }

  for (const candidate of pathNodeCandidates(env)) {
    const command = await existingFile(candidate);
    if (!command) continue;
    try {
      return await inspectNode(command, "path", env);
    } catch {
      // A stale shim or an older Node on PATH should not prevent the host
      // runtime from starting the authority. An explicit setting above is
      // strict and reports its error to the caller.
    }
  }

  const fallbackVersion = parseNodeVersion(process.version);
  assertSupportedNode(fallbackVersion, fallbackCommand);
  return {
    command: fallbackCommand,
    version: fallbackVersion.normalized,
    source: "host-fallback"
  };
};

export const isAuthorityNodePathEntryUsable = (
  entry: string,
  platform = process.platform
) => platform !== "linux" || !entry.startsWith("/mnt/");

const resolveNodeCommand = async (value: string, env: NodeJS.ProcessEnv) => {
  const pathLike = path.isAbsolute(value) || value.includes(path.sep) || value.includes("/") || value.includes("\\");
  if (pathLike) {
    for (const candidate of windowsExecutableCandidates(value)) {
      const command = await existingFile(candidate);
      if (command) return command;
    }
    return null;
  }
  for (const candidate of pathNodeCandidates(env, value)) {
    const command = await existingFile(candidate);
    if (command) return command;
  }
  return null;
};

const pathNodeCandidates = (env: NodeJS.ProcessEnv, executable?: string) => {
  const names = windowsExecutableCandidates(executable ?? "node");
  const pathEntries = (env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry && isAuthorityNodePathEntryUsable(entry));
  const candidates = pathEntries.flatMap((entry) => names.map((name) => path.join(entry, name)));
  if (process.platform === "win32") {
    const programFiles = env.ProgramW6432 ?? env.ProgramFiles;
    if (programFiles) {
      candidates.push(...names.map((name) => path.join(programFiles, "nodejs", name)));
    }
  }
  return [...new Set(candidates)];
};

const windowsExecutableCandidates = (value: string) => {
  if (process.platform !== "win32" || /\.(?:exe|cmd|bat)$/i.test(value)) return [value];
  return [value, `${value}.exe`];
};

const existingFile = async (candidate: string) => {
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
};

const inspectNode = async (
  command: string,
  source: Exclude<AuthorityNodeSource, "unknown">,
  env: NodeJS.ProcessEnv
): Promise<AuthorityNodeRuntime> => {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(command, ["--version"], {
      env,
      timeout: 5_000,
      windowsHide: true
    }));
  } catch (error) {
    throw new Error(`Could not execute authority Node ${command}: ${errorText(error)}`);
  }
  const version = parseNodeVersion(stdout);
  assertSupportedNode(version, command);
  return { command, version: version.normalized, source };
};

const parseNodeVersion = (value: string): NodeVersion => {
  const match = value.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Could not read a Node version from: ${value.trim() || "<empty>"}`);
  const [, major, minor, patch] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    normalized: `v${major}.${minor}.${patch}`
  };
};

const assertSupportedNode = (version: NodeVersion, command: string) => {
  if (version.major < minimumAuthorityNodeMajor) {
    throw new Error(
      `Authority Node ${command} is ${version.normalized}; `
      + `Node ${minimumAuthorityNodeMajor}+ is required.`
    );
  }
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
