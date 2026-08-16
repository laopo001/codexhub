import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const userPathMarker = "__CODEXHUB_USER_PATH__";

/**
 * Return the environment used by an embedded authority.
 *
 * GUI-launched VS Code/Electron processes frequently inherit a shorter PATH
 * than an interactive terminal. Read the user's login shell PATH when
 * possible, put it before the inherited PATH, and keep every other variable
 * unchanged. This is best effort: a broken shell startup file must not stop
 * the authority from starting with the host environment.
 */
export const withUserPath = async (
  env: NodeJS.ProcessEnv = process.env
): Promise<NodeJS.ProcessEnv> => {
  const userPath = await readUserLoginPath(env);
  return userPath ? mergePathEntries(env, userPath) : { ...env };
};

export const mergePathEntries = (
  env: NodeJS.ProcessEnv,
  preferredPath: string,
  platform = process.platform,
  delimiter = path.delimiter
): NodeJS.ProcessEnv => {
  const inheritedPath = readPath(env, platform);
  const entries = [...splitPath(preferredPath, delimiter), ...splitPath(inheritedPath, delimiter)];
  const mergedPath = [...new Set(entries)].join(delimiter);
  const pathKey = findPathKey(env, platform);
  return { ...env, [pathKey]: mergedPath };
};

export const parseUserPathOutput = (stdout: string) => {
  const line = stdout
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(userPathMarker));
  const value = line?.slice(userPathMarker.length).trim();
  return value || null;
};

const readUserLoginPath = async (env: NodeJS.ProcessEnv) => {
  if (process.platform === "win32") return null;
  const shell = env.SHELL?.trim();
  if (!shell || !path.isAbsolute(shell)) return null;
  try {
    await access(shell);
    const { stdout } = await execFileAsync(
      shell,
      ["-ilc", `printf '\\n${userPathMarker}%s\\n' "$PATH"`],
      {
        env,
        timeout: 3_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }
    );
    return parseUserPathOutput(stdout);
  } catch {
    return null;
  }
};

const readPath = (env: NodeJS.ProcessEnv, platform = process.platform) => {
  const key = findPathKey(env, platform);
  return env[key] ?? "";
};

const findPathKey = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => {
  if (platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
};

const splitPath = (value: string, delimiter: string) => value
  .split(delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean);
