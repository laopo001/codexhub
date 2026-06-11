import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SshRemoteClientBundle = {
  path: string;
  hash: string;
  size: number;
  endpointPath: string;
};

let cachedBundle: SshRemoteClientBundle | null | undefined;

export const resolveSshRemoteClientBundle = async (options: { refresh?: boolean } = {}) => {
  if (!options.refresh && cachedBundle !== undefined) return cachedBundle;
  for (const candidate of candidateRemoteClientPaths()) {
    const bundle = await readBundle(candidate);
    if (bundle) {
      cachedBundle = bundle;
      return bundle;
    }
  }
  cachedBundle = null;
  return null;
};

export const readSshRemoteClientBundle = async (expectedHash: string) => {
  const bundle = await resolveSshRemoteClientBundle();
  if (!bundle || bundle.hash !== expectedHash) return null;
  return {
    ...bundle,
    content: await readFile(bundle.path)
  };
};

const candidateRemoteClientPaths = () => {
  const configured = process.env.CODEX_HUB_SSH_REMOTE_CLIENT_PATH?.trim();
  const moduleDir = moduleDirectory();
  const packageRoot = findPackageRoot(moduleDir);
  return [
    ...(configured ? [path.resolve(configured)] : []),
    path.resolve(moduleDir, "ssh/remote-client.cjs"),
    path.resolve(moduleDir, "../ssh/remote-client.cjs"),
    path.resolve(packageRoot, "dist-node/ssh/remote-client.cjs"),
    path.resolve(process.cwd(), "dist-node/ssh/remote-client.cjs"),
    path.resolve(moduleDir, "ssh/remote-client.mjs"),
    path.resolve(moduleDir, "../ssh/remote-client.mjs"),
    path.resolve(packageRoot, "dist-node/ssh/remote-client.mjs"),
    path.resolve(process.cwd(), "dist-node/ssh/remote-client.mjs")
  ];
};

const moduleDirectory = () => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    if (typeof __dirname === "string") return __dirname;
    return process.cwd();
  }
};

const findPackageRoot = (start: string) => {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
};

const readBundle = async (filePath: string): Promise<SshRemoteClientBundle | null> => {
  try {
    const [info, content] = await Promise.all([stat(filePath), readFile(filePath)]);
    if (!info.isFile()) return null;
    const hash = createHash("sha256").update(content).digest("hex");
    return {
      path: filePath,
      hash,
      size: content.byteLength,
      endpointPath: `/api/ssh/remote-client/${hash}`
    };
  } catch {
    return null;
  }
};
