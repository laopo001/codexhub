import os from "node:os";
import type { CodexHubAuthorityKind } from "../../../src/shared/surfaceTypes.js";
import { vscodeSurfaceProtocolVersion } from "../../../src/shared/surfaceTypes.js";
import { startEmbeddedServer } from "../../../src/server/embedded.js";
import {
  authorityServiceAuthToken,
  removeLegacyVscodeAuthorityTokenFile
} from "./authorityAuth.js";

void main().catch((error: unknown) => {
  console.error(`codexhub vscode authority failed: ${errorText(error)}`);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = positiveInteger(required(args, "port"), "port");
  const authorityId = required(args, "authority-id");
  const authorityKind = parseAuthorityKind(required(args, "authority-kind"));
  const dataDir = required(args, "data-dir");
  const staticDirectory = required(args, "static-directory");
  const buildId = args.get("build-id") || null;
  const authToken = authorityServiceAuthToken(args.get("auth-token-env"), process.env);
  delete process.env.CODEX_HUB_AUTH_TOKEN;
  await removeLegacyVscodeAuthorityTokenFile(dataDir).catch((error: unknown) => {
    console.warn(`codexhub vscode authority could not remove obsolete token file: ${errorText(error)}`);
  });
  const remoteClientPath = args.get("remote-client");
  if (remoteClientPath) process.env.CODEX_HUB_SSH_REMOTE_CLIENT_PATH = remoteClientPath;

  const server = await startEmbeddedServer({
    host: "127.0.0.1",
    portMode: "preferred",
    preferredPort: port,
    dataDir,
    staticDirectory,
    surface: "vscode",
    buildId,
    authToken,
    authority: {
      authorityId,
      kind: authorityKind,
      surfaceProtocolVersion: vscodeSurfaceProtocolVersion
    },
    parentRegistrationIdentity: {
      machineId: `machine-vscode-${authorityId.replace(/^authority-/, "")}`,
      name: `CodexHub VSCode · ${authorityLabel(authorityKind)} · ${os.hostname()}`
    },
    features: { localMachine: true },
    logPrefix: "codexhub vscode authority"
  });

  console.error(
    `codexhub vscode authority ready: ${authorityKind} ${authorityId} http://127.0.0.1:${server.port} auth=${authToken ? "required" : "off"}`
  );

  const stop = () => {
    void server.stop().catch((error: unknown) => {
      console.error(`codexhub vscode authority stop failed: ${errorText(error)}`);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<void>((resolve) => server.app.server.once("close", resolve));
}

function parseArgs(values: string[]) {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg?.startsWith("--")) throw new Error(`Unexpected authority service argument: ${arg ?? ""}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    parsed.set(arg.slice(2), value);
    index += 1;
  }
  return parsed;
}

function required(values: Map<string, string>, key: string) {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function positiveInteger(value: string, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

function parseAuthorityKind(value: string): CodexHubAuthorityKind {
  if (value === "windows" || value === "macos" || value === "linux" || value === "wsl") return value;
  throw new Error(`Invalid authority kind: ${value}`);
}

function authorityLabel(kind: CodexHubAuthorityKind) {
  if (kind === "windows") return "Windows";
  if (kind === "macos") return "macOS";
  if (kind === "wsl") return `WSL${process.env.WSL_DISTRO_NAME?.trim() ? ` ${process.env.WSL_DISTRO_NAME.trim()}` : ""}`;
  return "Linux";
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
