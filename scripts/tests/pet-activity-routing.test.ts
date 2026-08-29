import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSafeWindowsCmdInvocation,
  extractWslDistroFromLabel,
  findLongestMatchingProject,
  isPathSegmentAncestorOrEqual,
  normalizePath,
  parsePetActivityOpenTarget,
  parseProjectSource,
  resolveVsCodeCliExecutable,
  resolveVsCodeLaunchPlan,
  resolveWindowsVsCodeCliExecutable,
  validateSafeString,
} from "../../src/shared/petActivityRouting.js";
import type { ProjectSummary } from "../../src/shared/projectTypes.js";

const makeProject = (
  machineId: string,
  path: string,
  source?: ProjectSummary["source"]
): ProjectSummary => ({
  projectId: `${machineId}:${path}`,
  machineId,
  path,
  name: path.split("/").filter(Boolean).pop() || "root",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
  machineOnline: true,
  running: false,
  ...(source ? { source } : {})
});

test("validateSafeString enforces length and rejects control characters", () => {
  assert.equal(validateSafeString("valid-string", 32), "valid-string");
  assert.equal(validateSafeString("  trimmed  ", 32), "trimmed");
  assert.equal(validateSafeString("too-long-value", 5), null);
  assert.equal(validateSafeString("has\0null", 32), null);
  assert.equal(validateSafeString("has\rreturn", 32), null);
  assert.equal(validateSafeString("has\nnewline", 32), null);
  assert.equal(validateSafeString(123, 32), null);
  assert.equal(validateSafeString("", 32), null);
});

test("parseProjectSource validates source kinds, channels and rejects unknown fields", () => {
  assert.deepEqual(parseProjectSource({ kind: "vscode", groupId: "group-1", label: "VSCode: codexhub", vscodeChannel: "stable" }), {
    kind: "vscode",
    groupId: "group-1",
    label: "VSCode: codexhub",
    vscodeChannel: "stable"
  });
  assert.deepEqual(parseProjectSource({ kind: "vscode", groupId: "group-1", label: "VSCode: codexhub", vscodeChannel: "insiders" }), {
    kind: "vscode",
    groupId: "group-1",
    label: "VSCode: codexhub",
    vscodeChannel: "insiders"
  });
  assert.deepEqual(parseProjectSource({ kind: "electron", groupId: "electron-main" }), {
    kind: "electron",
    groupId: "electron-main"
  });
  // Electron cannot declare vscodeChannel
  assert.equal(parseProjectSource({ kind: "electron", groupId: "electron-main", vscodeChannel: "stable" }), null);
  // Invalid vscodeChannel
  assert.equal(parseProjectSource({ kind: "vscode", groupId: "group-1", vscodeChannel: "nightly" }), null);
  // Unknown fields rejected
  assert.equal(parseProjectSource({ kind: "vscode", groupId: "group-1", unknownField: "bad" }), null);
  assert.equal(parseProjectSource({ kind: "unknown", groupId: "group-1" }), null);
  assert.equal(parseProjectSource({ kind: "vscode" }), null);
  assert.equal(parseProjectSource({ kind: "vscode", groupId: "g", label: "bad\nlabel" }), null);
  assert.equal(parseProjectSource(null), null);
});

test("parsePetActivityOpenTarget strictly validates IPC payloads and rejects malformed source", () => {
  const validPayload = {
    threadId: "thread-123",
    workingDirectory: "/home/laop/projects/codexhub",
    machineId: "machine-1",
    machineHostname: "jx-workstation",
    projectPath: "/home/laop/projects/codexhub",
    source: { kind: "vscode" as const, groupId: "surface-1", label: "VSCode: codexhub [WSL: Ubuntu]", vscodeChannel: "insiders" as const }
  };
  assert.deepEqual(parsePetActivityOpenTarget(validPayload), validPayload);

  // Partial target without source is valid
  assert.deepEqual(parsePetActivityOpenTarget({ threadId: "thread-456" }), {
    threadId: "thread-456"
  });

  // Rejects invalid top-level types
  assert.equal(parsePetActivityOpenTarget(null), null);
  assert.equal(parsePetActivityOpenTarget("not-object"), null);
  assert.equal(parsePetActivityOpenTarget({}), null);
  assert.equal(parsePetActivityOpenTarget({ threadId: "   " }), null);
  assert.equal(parsePetActivityOpenTarget({ threadId: "t\x001" }), null);
  assert.equal(parsePetActivityOpenTarget({ threadId: "t", workingDirectory: "dir\nname" }), null);

  // Explicit malformed source causes the whole payload to be rejected (no silent drop)
  assert.equal(parsePetActivityOpenTarget({
    threadId: "thread-1",
    source: "invalid-source"
  }), null);
  assert.equal(parsePetActivityOpenTarget({
    threadId: "thread-1",
    source: {}
  }), null);
  assert.equal(parsePetActivityOpenTarget({
    threadId: "thread-1",
    source: { kind: "other", groupId: "group-1" }
  }), null);
  assert.equal(parsePetActivityOpenTarget({
    threadId: "thread-1",
    source: { kind: "electron", groupId: "group-1", vscodeChannel: "stable" }
  }), null);
});

test("normalizePath handles POSIX, Windows slashes, and root boundaries", () => {
  assert.equal(normalizePath("/home/laop/projects/codexhub/"), "/home/laop/projects/codexhub");
  assert.equal(normalizePath("C:\\Users\\0laop\\projects\\codexhub\\"), "C:/Users/0laop/projects/codexhub");
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath("C:\\"), "C:/");
  assert.equal(normalizePath(""), "");
});

test("isPathSegmentAncestorOrEqual enforces strict path segment boundaries", () => {
  // Exact match
  assert.equal(isPathSegmentAncestorOrEqual("/home/laop/projects", "/home/laop/projects"), true);
  // Child directory match
  assert.equal(isPathSegmentAncestorOrEqual("/home/laop/projects", "/home/laop/projects/comfyui-sdk/videos"), true);
  // False prefix match (boundary check: projects vs projects-other)
  assert.equal(isPathSegmentAncestorOrEqual("/home/laop/projects", "/home/laop/projects-other"), false);
  assert.equal(isPathSegmentAncestorOrEqual("/home/laop/projects", "/home/laop/projects-other/videos"), false);
  // Windows path case-insensitive & boundary match
  assert.equal(isPathSegmentAncestorOrEqual("C:\\Users\\0laop\\projects", "c:/users/0laop/projects/sub"), true);
  assert.equal(isPathSegmentAncestorOrEqual("C:/Users", "c:/users-other/sub"), false);
});

test("findLongestMatchingProject isolates machines and selects most specific ancestor", () => {
  const wslMachine = "machine-authority-wsl";
  const sshMachine = "machine-authority-ssh";

  const rootProjects = [
    makeProject(wslMachine, "/home/laop/projects", { kind: "vscode", groupId: "parent-group", vscodeChannel: "stable" }),
    makeProject(wslMachine, "/home/laop/projects/comfyui-sdk", { kind: "vscode", groupId: "child-group", label: "VSCode: comfyui-sdk [WSL: Ubuntu]", vscodeChannel: "insiders" }),
    makeProject(sshMachine, "/home/laop/projects/comfyui-sdk", { kind: "vscode", groupId: "ssh-group", vscodeChannel: "stable" }),
  ];

  // 1. Longest match: nested workingDirectory matches the most specific child project
  const matchChild = findLongestMatchingProject(
    rootProjects,
    wslMachine,
    "/home/laop/projects/comfyui-sdk/videos/renders"
  );
  assert.equal(matchChild?.path, "/home/laop/projects/comfyui-sdk");
  assert.equal(matchChild?.source?.groupId, "child-group");
  assert.equal(matchChild?.source?.vscodeChannel, "insiders");

  // 2. Parent match when not under child project
  const matchParent = findLongestMatchingProject(
    rootProjects,
    wslMachine,
    "/home/laop/projects/other-tool/src"
  );
  assert.equal(matchParent?.path, "/home/laop/projects");
  assert.equal(matchParent?.source?.groupId, "parent-group");
  assert.equal(matchParent?.source?.vscodeChannel, "stable");

  // 3. Machine isolation: same path on different machine does not leak
  const matchSsh = findLongestMatchingProject(
    rootProjects,
    sshMachine,
    "/home/laop/projects/comfyui-sdk/videos"
  );
  assert.equal(matchSsh?.machineId, sshMachine);
  assert.equal(matchSsh?.source?.groupId, "ssh-group");

  // 4. Unknown machine returns undefined
  assert.equal(
    findLongestMatchingProject(rootProjects, "non-existent-machine", "/home/laop/projects/comfyui-sdk"),
    undefined
  );
});

test("extractWslDistroFromLabel parses standard VSCode and Authority WSL patterns", () => {
  assert.equal(extractWslDistroFromLabel("VSCode: codexhub [WSL: Ubuntu]"), "Ubuntu");
  assert.equal(extractWslDistroFromLabel("VSCode: app [WSL: Ubuntu-22.04]"), "Ubuntu-22.04");
  assert.equal(extractWslDistroFromLabel("VSCode: workspace [WSL: Debian]"), "Debian");
  assert.equal(extractWslDistroFromLabel("CodexHub Authority · WSL Ubuntu · jx"), "Ubuntu");
  assert.equal(extractWslDistroFromLabel("VSCode: codexhub [SSH: remote-host]"), null);
  assert.equal(extractWslDistroFromLabel("VSCode: codexhub [Dev Container: Python]"), null);
  assert.equal(extractWslDistroFromLabel("VSCode: local-windows"), null);
  assert.equal(extractWslDistroFromLabel(undefined), null);
});

test("resolveVsCodeCliExecutable returns correct executable names per channel and platform", () => {
  assert.equal(resolveVsCodeCliExecutable("stable", {}, "win32"), "code.cmd");
  assert.equal(resolveVsCodeCliExecutable("stable", {}, "linux"), "code");
  assert.equal(resolveVsCodeCliExecutable("insiders", {}, "win32"), "code-insiders.cmd");
  assert.equal(resolveVsCodeCliExecutable("insiders", {}, "linux"), "code-insiders");
  assert.equal(resolveVsCodeCliExecutable("stable", { CODEX_HUB_VSCODE_CLI: "custom-code" }, "win32"), "custom-code");
  assert.equal(resolveVsCodeCliExecutable("insiders", { CODEX_HUB_VSCODE_INSIDERS_CLI: "custom-insiders" }, "win32"), "custom-insiders");
});

test("resolveWindowsVsCodeCliExecutable requires an existing absolute Windows shim for stable and insiders", () => {
  const stableProgramFiles = "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd";
  const stableLocalAppData = "C:\\Users\\tester\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd";
  const insidersLocalAppData = "C:\\Users\\tester\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd";
  const insidersProgramFiles = "C:\\Program Files\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd";

  // Stable resolution
  assert.equal(resolveWindowsVsCodeCliExecutable("stable", { ProgramFiles: "C:\\Program Files" },
    (candidate) => candidate === stableProgramFiles), stableProgramFiles);
  assert.equal(resolveWindowsVsCodeCliExecutable("stable", { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    (candidate) => candidate === stableLocalAppData), stableLocalAppData);
  assert.equal(resolveWindowsVsCodeCliExecutable("stable", {
    CODEX_HUB_VSCODE_CLI: "D:\\VSCode\\bin\\code.cmd",
    ProgramFiles: "C:\\Program Files"
  }, (candidate) => candidate === "D:\\VSCode\\bin\\code.cmd"), "D:\\VSCode\\bin\\code.cmd");
  assert.equal(resolveWindowsVsCodeCliExecutable("stable", {
    CODEX_HUB_VSCODE_CLI: "D:\\missing\\code.cmd",
    ProgramFiles: "C:\\Program Files"
  }, (candidate) => candidate === stableProgramFiles), null, "an explicit missing override must not silently fall back");

  // Insiders resolution
  assert.equal(resolveWindowsVsCodeCliExecutable("insiders", { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    (candidate) => candidate === insidersLocalAppData), insidersLocalAppData);
  assert.equal(resolveWindowsVsCodeCliExecutable("insiders", { ProgramFiles: "C:\\Program Files" },
    (candidate) => candidate === insidersProgramFiles), insidersProgramFiles);
  assert.equal(resolveWindowsVsCodeCliExecutable("insiders", {
    CODEX_HUB_VSCODE_INSIDERS_CLI: "D:\\VSCodeInsiders\\bin\\code-insiders.cmd",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local"
  }, (candidate) => candidate === "D:\\VSCodeInsiders\\bin\\code-insiders.cmd"), "D:\\VSCodeInsiders\\bin\\code-insiders.cmd");
  assert.equal(resolveWindowsVsCodeCliExecutable("insiders", {
    CODEX_HUB_VSCODE_INSIDERS_CLI: "D:\\missing\\code-insiders.cmd",
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local"
  }, (candidate) => candidate === insidersLocalAppData), null, "an explicit missing insiders override must not fall back");

  assert.equal(resolveWindowsVsCodeCliExecutable("stable", {}, () => false), null);
  assert.equal(resolveWindowsVsCodeCliExecutable("insiders", {}, () => false), null);
});

test("buildSafeWindowsCmdInvocation quotes safe arguments and supports code.cmd and code-insiders.cmd", () => {
  // 1. Safe command and arguments without reuse-window
  const validInvocation = buildSafeWindowsCmdInvocation("code.cmd", [
    "--remote",
    "wsl+Ubuntu",
    "/home/laop/projects/codexhub"
  ], { comSpec: "cmd.exe", cwd: "C:\\Windows" });
  assert.deepEqual(validInvocation, {
    cmdExe: "cmd.exe",
    cmdArgs: [
      "/d",
      "/v:off",
      "/s",
      "/c",
      'call "code.cmd" "--remote" "wsl+Ubuntu" "/home/laop/projects/codexhub"'
    ],
    rawCommandLine: '"code.cmd" "--remote" "wsl+Ubuntu" "/home/laop/projects/codexhub"',
    windowsVerbatimArguments: true,
    cwd: "C:\\Windows"
  });

  // 2. Insiders cmd path with space and Unicode and default environment resolution
  const insidersInvocation = buildSafeWindowsCmdInvocation("C:\\Users\\0laop\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd", [
    "--remote",
    "wsl+Ubuntu",
    "C:\\Users\\0laop\\项目 & 资料\\sub"
  ], { comSpec: "cmd.exe", env: { SystemRoot: "C:\\Windows" } });
  assert.deepEqual(insidersInvocation, {
    cmdExe: "cmd.exe",
    cmdArgs: [
      "/d",
      "/v:off",
      "/s",
      "/c",
      'call "C:\\Users\\0laop\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd" "--remote" "wsl+Ubuntu" "C:\\Users\\0laop\\项目 & 资料\\sub"'
    ],
    rawCommandLine: '"C:\\Users\\0laop\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd" "--remote" "wsl+Ubuntu" "C:\\Users\\0laop\\项目 & 资料\\sub"',
    windowsVerbatimArguments: true,
    cwd: "C:\\Windows"
  });

  // 3. Rejects quotes, control characters, cmd expansion, and non-code commands.
  assert.equal(buildSafeWindowsCmdInvocation("code.cmd", ['arg"with"quote']), null);
  assert.equal(buildSafeWindowsCmdInvocation("code.cmd", ["arg\nwith\nnewline"]), null);
  assert.equal(buildSafeWindowsCmdInvocation("code.cmd", ["arg\rwith\rreturn"]), null);
  assert.equal(buildSafeWindowsCmdInvocation("code.cmd", ["arg\0null"]), null);
  assert.equal(buildSafeWindowsCmdInvocation("code.cmd", ["%PATH%"]), null);
  assert.equal(buildSafeWindowsCmdInvocation("code.cmd", ["danger!name"]), null);
  assert.equal(buildSafeWindowsCmdInvocation("code.cmd", ["caret^name"]), null);
  assert.equal(buildSafeWindowsCmdInvocation("calc.exe", ["arg"]), null);
  assert.equal(buildSafeWindowsCmdInvocation("code.cmd & notepad.exe", ["arg"]), null);
  assert.equal(buildSafeWindowsCmdInvocation("C:\\%TEMP%\\code.cmd", ["arg"]), null);
});

test("resolveVsCodeLaunchPlan requires channel, matching hostname and excludes reuse-window", () => {
  const localHostname = "jx-pc";
  const wslInsidersTarget = {
    threadId: "t-1",
    workingDirectory: "/home/laop/projects/codexhub/src",
    machineHostname: "JX-PC",
    projectPath: "/home/laop/projects/codexhub",
    source: {
      kind: "vscode" as const,
      groupId: "registered:wsl:vscode-1",
      label: "VSCode: codexhub [WSL: Ubuntu]",
      vscodeChannel: "insiders" as const
    }
  };

  // 1. Matches local hostname and insiders channel -> generates safe WSL remote plan with code-insiders.cmd without --reuse-window
  const planWin = resolveVsCodeLaunchPlan(wslInsidersTarget, { platform: "win32", localHostname });
  assert.deepEqual(planWin, {
    command: "code-insiders.cmd",
    args: ["--remote", "wsl+Ubuntu", "/home/laop/projects/codexhub"],
    remote: "wsl+Ubuntu",
    targetPath: "/home/laop/projects/codexhub"
  });

  // 2. Stable channel generates code.cmd
  const wslStableTarget = {
    ...wslInsidersTarget,
    source: {
      ...wslInsidersTarget.source,
      vscodeChannel: "stable" as const
    }
  };
  assert.deepEqual(resolveVsCodeLaunchPlan(wslStableTarget, { platform: "win32", localHostname }), {
    command: "code.cmd",
    args: ["--remote", "wsl+Ubuntu", "/home/laop/projects/codexhub"],
    remote: "wsl+Ubuntu",
    targetPath: "/home/laop/projects/codexhub"
  });

  // 3. Missing vscodeChannel -> returns null (no-op, never defaults to stable!)
  const missingChannelTarget = {
    ...wslInsidersTarget,
    source: {
      kind: "vscode" as const,
      groupId: "registered:wsl:vscode-1",
      label: "VSCode: codexhub [WSL: Ubuntu]"
    }
  };
  assert.equal(resolveVsCodeLaunchPlan(missingChannelTarget, { platform: "win32", localHostname }), null);

  // 4. Remote physical machine hostname mismatch -> returns null (no-op)
  const mismatchTarget = {
    ...wslInsidersTarget,
    machineHostname: "other-physical-host"
  };
  assert.equal(resolveVsCodeLaunchPlan(mismatchTarget, { platform: "win32", localHostname }), null);

  // 5. Missing machineHostname or localHostname -> returns null
  assert.equal(resolveVsCodeLaunchPlan({ ...wslInsidersTarget, machineHostname: undefined }, { platform: "win32", localHostname }), null);
  assert.equal(resolveVsCodeLaunchPlan(wslInsidersTarget, { platform: "win32", localHostname: "" }), null);
});

test("resolveVsCodeLaunchPlan generates clean args without --reuse-window for local Windows VSCode", () => {
  const localHostname = "my-windows-desktop";
  const winTarget = {
    threadId: "t-win",
    workingDirectory: "C:\\Users\\0laop\\projects\\codexhub",
    machineHostname: "MY-WINDOWS-DESKTOP",
    source: {
      kind: "vscode" as const,
      groupId: "vscode-local",
      label: "VSCode: codexhub",
      vscodeChannel: "stable" as const
    }
  };

  // Hostname matches
  const plan = resolveVsCodeLaunchPlan(winTarget, { platform: "win32", localHostname });
  assert.deepEqual(plan, {
    command: "code.cmd",
    args: ["C:\\Users\\0laop\\projects\\codexhub"],
    targetPath: "C:\\Users\\0laop\\projects\\codexhub"
  });

  // Hostname mismatch -> no-op
  assert.equal(resolveVsCodeLaunchPlan({ ...winTarget, machineHostname: "remote-windows" }, { platform: "win32", localHostname }), null);
});

test("resolveVsCodeLaunchPlan returns null for SSH/Remote, non-vscode, or missing sources", () => {
  const localHostname = "my-host";
  // SSH VSCode -> no-op
  assert.equal(resolveVsCodeLaunchPlan({
    threadId: "t-ssh",
    workingDirectory: "/root/projects/app",
    machineHostname: localHostname,
    source: {
      kind: "vscode",
      groupId: "registered:machine:vscode-ssh",
      label: "VSCode: app [SSH: production-server]",
      vscodeChannel: "stable"
    }
  }, { localHostname }), null);

  // GroupId indicates SSH -> no-op
  assert.equal(resolveVsCodeLaunchPlan({
    threadId: "t-ssh-2",
    workingDirectory: "/root/projects/app",
    machineHostname: localHostname,
    source: {
      kind: "vscode",
      groupId: "machine:ssh:vscode-1",
      vscodeChannel: "insiders"
    }
  }, { localHostname }), null);

  // Electron source -> no-op for VSCode launcher
  assert.equal(resolveVsCodeLaunchPlan({
    threadId: "t-electron",
    machineHostname: localHostname,
    source: { kind: "electron", groupId: "electron-main" }
  }, { localHostname }), null);

  // Missing source -> no-op
  assert.equal(resolveVsCodeLaunchPlan({
    threadId: "t-none",
    machineHostname: localHostname,
    workingDirectory: "/home/laop/test"
  }, { localHostname }), null);
});
