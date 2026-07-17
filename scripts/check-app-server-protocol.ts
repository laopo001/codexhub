import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertSupportedCodexCliVersion,
  minimumCodexCliVersion,
  parseCodexCliVersion
} from "../src/cli/codexAppServerProcess.js";
import { codexhubVersion } from "../src/shared/version.js";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const minimumVersion = minimumCodexCliVersion;
const packageManifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
  version?: string;
  devDependencies?: Record<string, string>;
};

if (packageManifest.version !== codexhubVersion) {
  throw new Error(`src/shared/version.ts must match package.json (${packageManifest.version ?? "missing"}).`);
}

if (packageManifest.devDependencies?.["@openai/codex"] !== minimumVersion) {
  throw new Error(`@openai/codex must be pinned to ${minimumVersion} for deterministic protocol checks.`);
}

const codex = await resolveProtocolCodex();
const versionOutput = await runCodex(codex, ["--version"]);
const actualVersion = parseCodexCliVersion(versionOutput);
if (!actualVersion) throw new Error(`Could not parse Codex CLI version from: ${versionOutput.trim()}`);
assertSupportedCodexCliVersion(actualVersion, minimumVersion);

const schemaDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-app-server-schema-"));
try {
  await runCodex(codex, ["app-server", "generate-ts", "--experimental", "--out", schemaDir]);
  await assertSchema("v2/Model.ts", [
    [/export type Model = \{ id: string, model: string,/, "Model.id and Model.model must both be required"],
    [/serviceTiers: Array<ModelServiceTier>/, "Model.serviceTiers must be available"],
    [/defaultServiceTier: string \| null/, "Model.defaultServiceTier must be available"]
  ]);
  await assertSchema("v2/ThreadGoal.ts", [
    [/threadId: string/, "ThreadGoal.threadId must be required"],
    [/objective: string/, "ThreadGoal.objective must be required"],
    [/status: ThreadGoalStatus/, "ThreadGoal.status must be required"],
    [/tokenBudget: number \| null/, "ThreadGoal.tokenBudget must be required"],
    [/tokensUsed: number/, "ThreadGoal.tokensUsed must be required"],
    [/timeUsedSeconds: number/, "ThreadGoal.timeUsedSeconds must be required"],
    [/createdAt: number/, "ThreadGoal.createdAt must be required"],
    [/updatedAt: number/, "ThreadGoal.updatedAt must be required"]
  ]);
  await assertSchema("v2/ReviewStartResponse.ts", [
    [/turn: Turn/, "ReviewStartResponse.turn must be required"],
    [/reviewThreadId: string/, "ReviewStartResponse.reviewThreadId must be required"]
  ]);
  await assertSchema("v2/FileUpdateChange.ts", [
    [/kind: PatchChangeKind/, "FileUpdateChange.kind must use PatchChangeKind"]
  ]);
  await assertSchema("v2/Turn.ts", [
    [/status: TurnStatus/, "Turn.status must be required"]
  ]);
  await assertSchema("v2/ThreadResumeResponse.ts", [
    [/thread: Thread/, "ThreadResumeResponse.thread must be required"]
  ]);
  await assertSchema("v2/ThreadResumeParams.ts", [
    [/excludeTurns\?: boolean/, "ThreadResumeParams.excludeTurns must be available"]
  ]);
  await assertSchema("v2/ThreadUnsubscribeParams.ts", [
    [/threadId: string/, "ThreadUnsubscribeParams.threadId must be required"]
  ]);
  await assertSchema("v2/ThreadUnsubscribeStatus.ts", [
    [/"notLoaded"/, "ThreadUnsubscribeStatus must include notLoaded"],
    [/"notSubscribed"/, "ThreadUnsubscribeStatus must include notSubscribed"],
    [/"unsubscribed"/, "ThreadUnsubscribeStatus must include unsubscribed"]
  ]);
  await assertSchema("v2/CommandExecutionRequestApprovalParams.ts", [
    [/availableDecisions\?: Array<CommandExecutionApprovalDecision> \| null/, "command approvals must expose availableDecisions"]
  ]);
  await assertSchema("v2/CommandExecutionApprovalDecision.ts", [
    [/"accept"/, "command approvals must include accept"],
    [/"acceptForSession"/, "command approvals must include acceptForSession"],
    [/"decline"/, "command approvals must include decline"],
    [/"cancel"/, "command approvals must include cancel"],
    [/acceptWithExecpolicyAmendment/, "command approvals must expose execpolicy amendments"],
    [/applyNetworkPolicyAmendment/, "command approvals must expose network policy amendments"]
  ]);
  await assertSchema("v2/AskForApproval.ts", [
    [/"untrusted"/, "AskForApproval must include untrusted"],
    [/"on-request"/, "AskForApproval must include on-request"],
    [/"never"/, "AskForApproval must include never"],
    [/^(?![\s\S]*"on-failure")[\s\S]*$/, "AskForApproval must not include removed on-failure"]
  ]);
  await assertSchema("ClientRequest.ts", [
    [/"method": "thread\/fork"/, "thread/fork must be available"],
    [/"method": "thread\/compact\/start"/, "thread/compact/start must be available"],
    [/"method": "thread\/goal\/set"/, "thread/goal/set must be available"],
    [/"method": "thread\/unsubscribe"/, "thread/unsubscribe must be available"],
    [/"method": "review\/start"/, "review/start must be available"]
  ]);
  await assertSchema("ServerNotification.ts", [
    [/"method": "item\/plan\/delta"/, "plan deltas must be available"],
    [/"method": "item\/reasoning\/summaryTextDelta"/, "reasoning summary deltas must be available"],
    [/"method": "item\/reasoning\/summaryPartAdded"/, "reasoning summary parts must be available"],
    [/"method": "item\/reasoning\/textDelta"/, "reasoning text deltas must be available"],
    [/"method": "item\/fileChange\/patchUpdated"/, "file change patch updates must be available"],
    [/"method": "item\/mcpToolCall\/progress"/, "MCP progress notifications must be available"],
    [/"method": "turn\/plan\/updated"/, "turn plan updates must be available"],
    [/"method": "turn\/diff\/updated"/, "turn diff updates must be available"],
    [/"method": "rawResponseItem\/completed"/, "rawResponseItem/completed must be available"],
    [/"method": "thread\/goal\/updated"/, "thread/goal/updated must be available"],
    [/"method": "thread\/tokenUsage\/updated"/, "thread/tokenUsage/updated must be available"]
  ]);
  await assertSchema("InitializeResponse.ts", [
    [/userAgent: string/, "initialize must identify the app-server user agent"]
  ]);
} finally {
  await rm(schemaDir, { recursive: true, force: true });
}

console.log(`app-server protocol ok: codex-cli ${actualVersion} (minimum ${minimumVersion})`);

type CodexCommand = { command: string; argsPrefix: string[] };

async function resolveProtocolCodex(): Promise<CodexCommand> {
  const override = process.env.CODEX_HUB_PROTOCOL_CODEX?.trim();
  if (override) return { command: override, argsPrefix: [] };
  const entrypoint = path.join(repoRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
  try {
    await access(entrypoint);
    return { command: process.execPath, argsPrefix: [entrypoint] };
  } catch {
    throw new Error(`Pinned Codex CLI not installed at ${entrypoint}. Run pnpm install first.`);
  }
}

async function runCodex(codex: CodexCommand, args: string[]) {
  const { stdout, stderr } = await execFileAsync(codex.command, [...codex.argsPrefix, ...args], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024
  });
  return `${stdout}${stderr}`;
}

async function assertSchema(relativePath: string, assertions: Array<[RegExp, string]>) {
  const source = await readFile(path.join(schemaDir, relativePath), "utf8");
  for (const [pattern, message] of assertions) {
    if (!pattern.test(source)) throw new Error(`${relativePath}: ${message}`);
  }
}
