import os from "node:os";
import path from "node:path";
import {
  authorityServiceAuthToken,
  removeLegacyAuthorityTokenFiles
} from "../core/authorityAuth.js";
import {
  resolveEmbeddedAuthorityHost,
  runAuthorityRestartSupervisor
} from "../core/embeddedAuthority.js";
import { applyServerConfigEnv, readServerConfigEnv } from "../core/serverConfigEnv.js";
import { resolveAuthorityNode } from "../core/authorityNode.js";
import { resolveCodexAppServerLaunchOptions, parseCodexApprovalPolicy, parseCodexApprovalsReviewer, parseCodexSandboxMode } from "../cli/codexAppServerProcess.js";
import { startEmbeddedServer } from "./embedded.js";
import type { CodexHubAuthorityKind } from "../shared/surfaceTypes.js";
import { embeddedSurfaceProtocolVersion } from "../shared/surfaceTypes.js";

/** Run the single authority service entrypoint used by every host. */
export const runAuthorityService = async (
  values: string[] = process.argv.slice(2),
  servicePath = process.argv[1] ? path.resolve(process.argv[1]) : undefined,
  serviceCommand?: string[]
) => {
  if (values[0] === "--restart-supervisor") {
    if (values[1] !== "--handoff" || !values[2]) {
      throw new Error("Missing --handoff for authority restart supervisor.");
    }
    await runAuthorityRestartSupervisor(values[2]);
    return;
  }
  const args = parseAuthorityArgs(values);
  const port = positiveInteger(required(args, "port"), "port");
  const authorityId = required(args, "authority-id");
  const kind = parseAuthorityKind(required(args, "authority-kind"));
  const dataDir = required(args, "data-dir");
  const staticDirectory = required(args, "static-directory");
  const buildId = args.get("build-id") || null;
  const configEnv = await readServerConfigEnv(path.join(dataDir, "config.yaml"));
  applyServerConfigEnv(configEnv);
  const host = args.get("host") || await resolveEmbeddedAuthorityHost(dataDir);
  const authToken = authorityServiceAuthToken(args.get("auth-token-env"), process.env);
  const projectCatalog = parseProjectCatalog(args.get("project-catalog") || "editable");
  const appServerLaunch = resolveCodexAppServerLaunchOptions({
    approvalPolicy: parseCodexApprovalPolicy(args.get("approval-policy"), "--approval-policy"),
    approvalsReviewer: parseCodexApprovalsReviewer(args.get("approvals-reviewer"), "--approvals-reviewer"),
    sandbox: parseCodexSandboxMode(args.get("sandbox"), "--sandbox")
  });
  const authorityEntry = servicePath ?? path.resolve(process.argv[1] ?? "authority-service.cjs");

  delete process.env.CODEX_HUB_AUTH_TOKEN;
  await removeLegacyAuthorityTokenFiles(dataDir).catch((error: unknown) => {
    console.warn(`codexhub authority could not remove obsolete token file: ${errorText(error)}`);
  });
  const remoteClientPath = args.get("remote-client");
  if (remoteClientPath) process.env.CODEX_HUB_SSH_REMOTE_CLIENT_PATH = remoteClientPath;
  const nodeRuntime = await resolveAuthorityNode(process.env);
  const server = await startEmbeddedServer({
    host,
    portMode: "preferred",
    preferredPort: port,
    dataDir,
    staticDirectory,
    surface: "default",
    localProjectCatalog: projectCatalog,
    buildId,
    authorityBuildFiles: [authorityEntry, path.join(staticDirectory, "index.html")],
    authorityRestart: {
      servicePath: authorityEntry,
      serviceCommand,
      remoteClientPath,
      nodeCommand: nodeRuntime.command,
      nodeSource: nodeRuntime.source,
      authToken,
      authTokenFromConfig: configEnv !== undefined && Object.prototype.hasOwnProperty.call(configEnv, "CODEX_HUB_AUTH_TOKEN")
    },
    authToken,
    authority: {
      authorityId,
      kind,
      surfaceProtocolVersion: embeddedSurfaceProtocolVersion
    },
    parentRegistrationIdentity: {
      machineId: `machine-authority-${authorityId.replace(/^authority-/, "")}`,
      name: `CodexHub Authority · ${authorityLabel(kind)} · ${os.hostname()}`
    },
    parentRegistration: parentRegistrationFromEnvironment(),
    appServerLaunch,
    features: { localMachine: process.env.CODEX_HUB_LOCAL_MACHINE !== "0" },
    logPrefix: "codexhub authority"
  });

  console.error(
    `codexhub authority ready: ${kind} ${authorityId} listen=${host}:${server.port} auth=${authToken ? "required" : "off"}`
  );
  const stop = () => {
    void server.stop().catch((error: unknown) => {
      console.error(`codexhub authority stop failed: ${errorText(error)}`);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<void>((resolve) => server.app.server.once("close", resolve));
};

const parseAuthorityArgs = (values: string[]) => {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (!arg?.startsWith("--")) throw new Error(`Unexpected authority service argument: ${arg ?? ""}`);
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (parsed.has(arg.slice(2))) throw new Error(`Duplicate authority service argument: ${arg}`);
    parsed.set(arg.slice(2), value);
    index += 1;
  }
  return parsed;
};

const required = (values: Map<string, string>, key: string) => {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`Missing --${key}`);
  return value;
};

const positiveInteger = (value: string, label: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
};

const parseAuthorityKind = (value: string): CodexHubAuthorityKind => {
  if (value === "windows" || value === "macos" || value === "linux" || value === "wsl") return value;
  throw new Error(`Invalid authority kind: ${value}`);
};

const parseProjectCatalog = (value: string): "editable" | "fixed" => {
  if (value === "editable" || value === "fixed") return value;
  throw new Error(`Invalid project catalog: ${value}`);
};

const parentRegistrationFromEnvironment = () => {
  const url = process.env.CODEX_HUB_REGISTER_TO?.trim();
  if (!url) return undefined;
  return {
    url,
    ...(process.env.CODEX_HUB_REGISTER_AUTH_TOKEN !== undefined
      ? { authToken: process.env.CODEX_HUB_REGISTER_AUTH_TOKEN }
      : {})
  };
};

const authorityLabel = (kind: CodexHubAuthorityKind) => {
  if (kind === "windows") return "Windows";
  if (kind === "macos") return "macOS";
  if (kind === "wsl") return `WSL${process.env.WSL_DISTRO_NAME?.trim() ? ` ${process.env.WSL_DISTRO_NAME.trim()}` : ""}`;
  return "Linux";
};

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
