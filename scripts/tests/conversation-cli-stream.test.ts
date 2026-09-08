import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { ConversationStreamRenderer } from "../../src/cli/conversationStreamRenderer.js";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const tsxCli = path.join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const authToken = "conversation-stream-test-token";
const threadId = "stream-thread";
const machineId = "stream-machine";
const cwd = "/remote/workspace";

test("start text arrives live, preserves stdin/options, and ignores history", { timeout: 20_000 }, async () => {
  const fixture = await createFixture();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-cli-stream-"));
  try {
    const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", "--connect", fixture.url,
      "start", "-", "--name", "Stream text", "--model", "gpt-stream", "--effort", "ultra",
      "--cwd", cwd, "--machine", machineId], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CODEX_HUB_DATA_DIR: dataDir,
        CODEX_HUB_AUTH_TOKEN: authToken,
        CODEX_HUB_PLUGIN_TELEGRAM: "0"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const output = collectOutput(child.stdout);
    const errors = collectOutput(child.stderr);
    child.stdin.end("first line\nsecond line\n");

    await waitFor(() => output.value.includes("[commentary]"), "first live text record");
    assert.equal(fixture.turnResponseSent, false, "a live WS record must precede the HTTP completion response");
    fixture.end();
    const exitCode = await childExit(child);
    assert.equal(exitCode, 0, errors.value);

    assert.match(output.value, /Thread ID: stream-thread/);
    assert.match(output.value, /\[commentary\][\s\S]*live commentary/);
    assert.match(output.value, /\[final_answer\][\s\S]*live final/);
    assert.match(output.value, /\[tool_call\]\nexec_command/);
    assert.match(output.value, /\[tool_result\]/);
    assert.match(output.value, /\[tool_call\]\napply_patch/);
    assert.match(output.value, /\[error\][\s\S]*visible stream error/);
    assert.match(output.value, /\[tool_call\]\nuser_input_request[\s\S]*Need input/);
    assert.doesNotMatch(output.value, /output-\d+/);
    assert.doesNotMatch(output.value, /historical answer/);
    assert.equal(fixture.turnBody.input, "first line\nsecond line\n");
    assert.deepEqual(fixture.turnBody.options, {
      model: "gpt-stream",
      modelReasoningEffort: "ultra"
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await fixture.close();
  }
});

test("conversation mode conflicts and output mode are rejected before reading stdin or contacting a backend", { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-cli-args-"));
  try {
    const cases = [
      { args: ["--stream"], error: /unknown option '--stream'/ },
      { args: ["--wait"], error: /unknown option '--wait'/ },
      { args: ["--no-wait"], error: /unknown option '--no-wait'/ },
      { args: ["--output", "normal"], error: /unknown option '--output'/ }
    ];
    for (const operation of ["start", "send"] as const) {
      for (const { args, error } of cases) {
        const commandArgs = operation === "start"
          ? ["start", "-", "--name", "invalid"]
          : ["send", threadId, "invalid"];
        const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", "--connect", "http://127.0.0.1:1",
          ...commandArgs, ...args], {
          cwd: projectRoot,
          env: { ...process.env, CODEX_HUB_DATA_DIR: dataDir, CODEX_HUB_PLUGIN_TELEGRAM: "0" },
          stdio: ["pipe", "pipe", "pipe"]
        });
        const output = collectOutput(child.stdout);
        const errors = collectOutput(child.stderr);
        child.stdin.end("must not be read\n");
        const exitCode = await childExit(child);
        assert.notEqual(exitCode, 0, `${operation} should reject conflicting options`);
        assert.equal(output.value, "");
        assert.match(errors.value, error);
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("send defaults to delivery confirmation without a realtime subscription", { timeout: 20_000 }, async () => {
  const fixture = await createFixture();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-cli-send-default-"));
  try {
    const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", "--connect", fixture.url,
      "send", threadId, "default send", "--cwd", cwd, "--machine", machineId], {
      cwd: projectRoot,
      env: { ...process.env, CODEX_HUB_DATA_DIR: dataDir, CODEX_HUB_AUTH_TOKEN: authToken, CODEX_HUB_PLUGIN_TELEGRAM: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = collectOutput(child.stdout);
    const errors = collectOutput(child.stderr);
    const exitCode = await childExit(child);
    assert.equal(exitCode, 0, errors.value);
    assert.match(output.value, /Thread ID: stream-thread/);
    assert.match(output.value, /Submission ID: submission/);
    assert.match(output.value, /Delivery: turn/);
    assert.doesNotMatch(output.value, /live commentary|live final/);
    assert.equal(fixture.subscriptions, 0);
    assert.equal(fixture.turnBody.input, "default send");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await fixture.close();
  }
});

test("start defaults to a persistent listener until end", { timeout: 20_000 }, async () => {
  const fixture = await createFixture();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-cli-start-default-"));
  try {
    const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", "--connect", fixture.url,
      "start", "start input", "--name", "Default start", "--cwd", cwd, "--machine", machineId], {
      cwd: projectRoot,
      env: { ...process.env, CODEX_HUB_DATA_DIR: dataDir, CODEX_HUB_AUTH_TOKEN: authToken, CODEX_HUB_PLUGIN_TELEGRAM: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = collectOutput(child.stdout);
    const errors = collectOutput(child.stderr);
    await waitFor(() => output.value.includes("live final"), "persistent first turn output");
    const exitedBeforeEnd = await Promise.race([
      childExit(child).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250))
    ]);
    assert.equal(exitedBeforeEnd, false, "default start must keep listening after the first turn");
    fixture.end();
    const exitCode = await childExit(child);
    assert.equal(exitCode, 0, errors.value);
    assert.match(output.value, /Thread ID: stream-thread/);
    assert.match(output.value, /live final/);
    assert.equal(fixture.subscriptions, 1);
    assert.equal(fixture.turnBody.input, "start input");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await fixture.close();
  }
});

test("persistent start carries send, stop, send, and end through one listener", { timeout: 30_000 }, async () => {
  const fixture = await createFixture();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-cli-lifecycle-"));
  const run = (args: string[]) => {
    const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", "--connect", fixture.url, ...args], {
      cwd: projectRoot,
      env: { ...process.env, CODEX_HUB_DATA_DIR: dataDir, CODEX_HUB_AUTH_TOKEN: authToken, CODEX_HUB_PLUGIN_TELEGRAM: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = collectOutput(child.stdout);
    const errors = collectOutput(child.stderr);
    return childExit(child).then((code) => ({ code, output: output.value, errors: errors.value }));
  };
  try {
    const start = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", "--connect", fixture.url,
      "start", "first", "--name", "Lifecycle", "--cwd", cwd, "--machine", machineId], {
      cwd: projectRoot,
      env: { ...process.env, CODEX_HUB_DATA_DIR: dataDir, CODEX_HUB_AUTH_TOKEN: authToken, CODEX_HUB_PLUGIN_TELEGRAM: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = collectOutput(start.stdout);
    const errors = collectOutput(start.stderr);
    await waitFor(() => output.value.includes("live final #1"), "first lifecycle turn");

    const firstSend = await run(["send", threadId, "second", "--cwd", cwd, "--machine", machineId]);
    assert.equal(firstSend.code, 0, firstSend.errors);
    await waitFor(() => (output.value.match(/live final/g) ?? []).length >= 2, "send output on original listener");

    fixture.setRunning(true);
    const stopped = await run(["stop", threadId, "--timeout", "5", "--json"]);
    assert.equal(stopped.code, 0, stopped.errors);
    assert.match(stopped.output, /"running":false/);
    const secondSend = await run(["send", threadId, "after stop", "--cwd", cwd, "--machine", machineId]);
    assert.equal(secondSend.code, 0, secondSend.errors);
    await waitFor(() => (output.value.match(/live final/g) ?? []).length >= 3, "post-stop send output");

    fixture.setRunning(true);
    const ended = await run(["end", threadId, "--timeout", "5", "--json"]);
    assert.equal(ended.code, 0, ended.errors);
    assert.match(ended.output, /"operation":"end"/);
    const startExit = await childExit(start);
    assert.equal(startExit, 0, errors.value);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await fixture.close();
  }
});

test("persistent timeout and realtime disconnect exit and release the listener", { timeout: 20_000 }, async () => {
  const runPersistent = async (fixture: Fixture, timeout?: string) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-cli-release-"));
    const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", "--connect", fixture.url,
      "start", "release", "--name", "Release", "--cwd", cwd, "--machine", machineId,
      ...(timeout ? ["--timeout", timeout] : [])], {
      cwd: projectRoot,
      env: { ...process.env, CODEX_HUB_DATA_DIR: dataDir, CODEX_HUB_AUTH_TOKEN: authToken, CODEX_HUB_PLUGIN_TELEGRAM: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = collectOutput(child.stdout);
    const errors = collectOutput(child.stderr);
    const exit = childExit(child);
    return { child, output, errors, exit, dataDir };
  };

  const timeoutFixture = await createFixture();
  const timeoutRun = await runPersistent(timeoutFixture, "1");
  try {
    await waitFor(() => timeoutFixture.turnResponseSent && timeoutRun.output.value.includes("live final #1"), "idle listener before timeout");
    const timeoutExit = await timeoutRun.exit;
    assert.notEqual(timeoutExit, 0);
    assert.match(timeoutRun.output.value + timeoutRun.errors.value, /timed out/);
    await waitFor(() => timeoutFixture.activeSockets() === 0, "timeout listener cleanup");
  } finally {
    await rm(timeoutRun.dataDir, { recursive: true, force: true });
    await timeoutFixture.close();
  }

  const disconnectFixture = await createFixture();
  const disconnectRun = await runPersistent(disconnectFixture);
  try {
    await waitFor(() => disconnectRun.output.value.includes("live final #1"), "disconnect listener output");
    disconnectFixture.disconnect();
    const disconnectExit = await disconnectRun.exit;
    assert.notEqual(disconnectExit, 0);
    await waitFor(() => disconnectFixture.activeSockets() === 0, "disconnect listener cleanup");
  } finally {
    await rm(disconnectRun.dataDir, { recursive: true, force: true });
    await disconnectFixture.close();
  }
});

test("normal renderer bounds an explicitly failed tool diagnostic", () => {
  const chunks: string[] = [];
  const renderer = new ConversationStreamRenderer((chunk) => chunks.push(chunk));
  const output = Array.from({ length: 12 }, (_, index) => `failed-${index + 1}`).join("\n");
  renderer.event({
    kind: "record",
    threadId,
    record: record("failed-tool", { type: "function_call_output", status: "failed", output }, "response_item")
  });
  const rendered = chunks.join("");
  assert.match(rendered, /failed-1/);
  assert.doesNotMatch(rendered, /failed-12/);
  assert.match(rendered, /已截断/);
  assert.doesNotMatch(rendered, /lines omitted/);
});

test("normal renderer coalesces Unicode assistant deltas and flushes status-only completion", () => {
  const chunks: string[] = [];
  const renderer = new ConversationStreamRenderer((chunk) => chunks.push(chunk));
  const emit = (message: string, status = "in_progress") => renderer.event({
    kind: "record",
    threadId,
    record: record("assistant", { type: "agent_message", phase: "commentary", message, status })
  });

  emit("");
  emit("你");
  emit("你好 ");
  emit("你好 世");
  emit("你好 世界\n下一行");
  emit("你好 世界\n下一行", "completed");
  renderer.completed();

  assert.equal(chunks.join(""), "[commentary]\n你好 世界\n下一行\n");
  assert.equal(chunks.join("").match(/\[commentary/g)?.length, 1);
  assert.doesNotMatch(chunks.join(""), /commentary update/);
});

test("normal renderer separates interleaved tools and keeps replacements explicit", () => {
  const chunks: string[] = [];
  const renderer = new ConversationStreamRenderer((chunk) => chunks.push(chunk));
  renderer.event({ kind: "record", threadId, record: record("assistant", { type: "agent_message", phase: "commentary", message: "先检查" }) });
  renderer.event({ kind: "record", threadId, record: record("assistant", { type: "agent_message", phase: "commentary", message: "先检查项目" }) });
  renderer.event({ kind: "record", threadId, record: record("tool", {
    type: "local_shell_call", status: "in_progress", action: { type: "exec", command: ["echo", "ok"] }, aggregated_output: "$ echo ok"
  }, "response_item") });
  renderer.event({ kind: "record", threadId, record: record("tool", {
    type: "local_shell_call", status: "in_progress", action: { type: "exec", command: ["echo", "ok"] }, aggregated_output: "$ echo ok\nleaked output"
  }, "response_item") });
  renderer.event({ kind: "record", threadId, record: record("tool", {
    type: "local_shell_call", status: "completed", action: { type: "exec", command: ["echo", "ok"] }, aggregated_output: "$ echo ok\nfinal output", exit_code: 0
  }, "response_item") });
  renderer.event({ kind: "record", threadId, record: record("final", { type: "agent_message", phase: "final_answer", message: "完成" }) });
  renderer.event({ kind: "record", threadId, record: record("replacement", { type: "agent_message", phase: "commentary", message: "hello world" }) });
  renderer.event({ kind: "record", threadId, record: record("replacement", { type: "agent_message", phase: "commentary", message: "hello there" }) });
  renderer.completed();

  const rendered = chunks.join("");
  assert.match(rendered, /\[commentary\]\n先检查项目\n\[tool_call\]/);
  assert.match(rendered, /\[tool_result\][\s\S]*✓ 完成 · exit 0\n\[final_answer\]/);
  assert.doesNotMatch(rendered, /leaked output/);
  assert.match(rendered, /\[commentary replaced\]\nhello there/);
  assert.doesNotMatch(rendered, /commentary update/);
});

test("normal renderer prints a shell command once and appends its completion result", () => {
  const chunks: string[] = [];
  const renderer = new ConversationStreamRenderer((chunk) => chunks.push(chunk));
  renderer.event({
    kind: "record", threadId, record: record("shell-start", {
      type: "local_shell_call", call_id: "shell-once", status: "in_progress",
      action: { type: "exec", command: ["echo", "ok"] }, aggregated_output: ""
    }, "response_item")
  });
  renderer.event({
    kind: "record", threadId, record: record("shell-complete", {
      type: "local_shell_call", call_id: "shell-once", status: "completed",
      action: { type: "exec", command: ["echo", "ok"] }, aggregated_output: "final output", exit_code: 0
    }, "response_item")
  });

  const rendered = chunks.join("");
  assert.equal((rendered.match(/command: echo ok/g) ?? []).length, 1);
  assert.doesNotMatch(rendered, /final output/);
});

test("normal renderer keeps separate executions of the same shell command", () => {
  const chunks: string[] = [];
  const renderer = new ConversationStreamRenderer((chunk) => chunks.push(chunk));
  for (const [callId, result] of [["shell-first", "first result"], ["shell-second", "second result"]]) {
    renderer.event({
      kind: "record", threadId, record: record(`${callId}-start`, {
        type: "local_shell_call", call_id: callId, status: "in_progress",
        action: { type: "exec", command: ["echo", "same"] }, aggregated_output: ""
      }, "response_item")
    });
    renderer.event({
      kind: "record", threadId, record: record(`${callId}-complete`, {
        type: "local_shell_call", call_id: callId, status: "completed",
        action: { type: "exec", command: ["echo", "same"] }, aggregated_output: result, exit_code: 0
      }, "response_item")
    });
  }

  const rendered = chunks.join("");
  assert.equal((rendered.match(/command: echo same/g) ?? []).length, 2);
  assert.doesNotMatch(rendered, /first result/);
  assert.doesNotMatch(rendered, /second result/);
});

test("normal renderer does not associate a completion-only shell with another call", () => {
  const chunks: string[] = [];
  const renderer = new ConversationStreamRenderer((chunk) => chunks.push(chunk));
  renderer.event({
    kind: "record", threadId, record: record("shell-a-start", {
      type: "local_shell_call", call_id: "shell-a", status: "in_progress",
      action: { type: "exec", command: ["echo", "same"] }, aggregated_output: ""
    }, "response_item")
  });
  renderer.event({
    kind: "record", threadId, record: record("shell-b-complete", {
      type: "local_shell_call", call_id: "shell-b", status: "completed",
      action: { type: "exec", command: ["echo", "same"] }, aggregated_output: "b result", exit_code: 0
    }, "response_item")
  });
  renderer.event({
    kind: "record", threadId, record: record("shell-a-complete", {
      type: "local_shell_call", call_id: "shell-a", status: "completed",
      action: { type: "exec", command: ["echo", "same"] }, aggregated_output: "a result", exit_code: 0
    }, "response_item")
  });

  const rendered = chunks.join("");
  assert.equal((rendered.match(/command: echo same/g) ?? []).length, 2);
  assert.doesNotMatch(rendered, /a result/);
  assert.doesNotMatch(rendered, /b result/);
});

test("normal renderer matches a no-call-id shell completion by the same record id", () => {
  const chunks: string[] = [];
  const renderer = new ConversationStreamRenderer((chunk) => chunks.push(chunk));
  renderer.event({
    kind: "record", threadId, record: record("shell-same-record", {
      type: "local_shell_call", status: "in_progress",
      action: { type: "exec", command: ["printf", "ok"] }, aggregated_output: ""
    }, "response_item")
  });
  renderer.event({
    kind: "record", threadId, record: record("shell-same-record", {
      type: "local_shell_call", status: "completed",
      action: { type: "exec", command: ["printf", "ok"] }, aggregated_output: "result", exit_code: 0
    }, "response_item")
  });

  const rendered = chunks.join("");
  assert.equal((rendered.match(/command: printf ok/g) ?? []).length, 1);
  assert.match(rendered, /✓ 完成 · exit 0/);
});

test("normal renderer keeps failed shell output while suppressing its repeated command", () => {
  const chunks: string[] = [];
  const renderer = new ConversationStreamRenderer((chunk) => chunks.push(chunk));
  renderer.event({
    kind: "record", threadId, record: record("failed-shell-start", {
      type: "local_shell_call", call_id: "failed-shell", status: "in_progress",
      action: { type: "exec", command: ["false"] }, aggregated_output: ""
    }, "response_item")
  });
  renderer.event({
    kind: "record", threadId, record: record("failed-shell-complete", {
      type: "local_shell_call", call_id: "failed-shell", status: "failed",
      action: { type: "exec", command: ["false"] }, aggregated_output: "failure details"
    }, "response_item")
  });

  const rendered = chunks.join("");
  assert.equal((rendered.match(/command: false/g) ?? []).length, 1);
  assert.match(rendered, /failure details/);
});

test("normal renderer hides success output and bounds long failure diagnostics", () => {
  const chunks: string[] = [];
  const renderer = new ConversationStreamRenderer((chunk) => chunks.push(chunk));
  const success = Array.from({ length: 300 }, (_, index) => `success-${index + 1}`).join("\n");
  renderer.event({ kind: "record", threadId, record: record("success", { type: "function_call_output", status: "completed", output: success }, "response_item") });
  const failure = Array.from({ length: 300 }, (_, index) => `failure-${index + 1}`).join("\n");
  renderer.event({ kind: "record", threadId, record: record("failure", { type: "function_call_output", status: "failed", output: failure }, "response_item") });
  renderer.completed();

  const rendered = chunks.join("");
  assert.doesNotMatch(rendered, /success-\d+/);
  assert.match(rendered, /failure-1/);
  assert.doesNotMatch(rendered, /failure-300/);
  assert.match(rendered, /已截断/);
  assert.equal((rendered.match(/\[tool_result\]/g) ?? []).length, 2);
});

type Fixture = {
  url: string;
  turnBody: { input?: string; options?: unknown };
  turnResponseSent: boolean;
  turns: number;
  lastSeq: number;
  subscriptions: number;
  end: () => void;
  running: boolean;
  setRunning: (running: boolean) => void;
  activeSockets: () => number;
  disconnect: () => void;
  close: () => Promise<void>;
};

const createFixture = async (): Promise<Fixture> => {
  const sockets = new Set<WebSocket>();
  const state: Fixture = {
    url: "",
    turnBody: {},
    turnResponseSent: false,
    turns: 0,
    lastSeq: 1,
    subscriptions: 0,
    end: () => undefined,
    running: false,
    setRunning: () => undefined,
    activeSockets: () => 0,
    disconnect: () => undefined,
    close: async () => undefined
  };
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${authToken}`) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const body = await readBody(request);
    const requestUrl = request.url ?? "/";
    if (requestUrl === "/api/machines") {
      writeJson(response, 200, { machines: [{ machineId, type: "local", online: true }] });
      return;
    }
    if (request.method === "POST" && requestUrl === `/api/machines/${machineId}/threads`) {
      writeJson(response, 200, { threadId, workingDirectory: cwd, runtime: { machineId } });
      return;
    }
    if (request.method === "PATCH" && requestUrl === `/api/threads/${threadId}/name`) {
      writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && requestUrl === `/api/threads/${threadId}`) {
      writeJson(response, 200, { threadId, workingDirectory: cwd, runtime: { machineId }, running: state.running, status: state.running ? "running" : "idle" });
      return;
    }
    if (request.method === "POST" && requestUrl === `/api/threads/${threadId}/stop`) {
      state.running = false;
      writeJson(response, 200, { stopped: true });
      return;
    }
    if (request.method === "POST" && requestUrl === `/api/threads/${threadId}/end`) {
      if (state.running) {
        writeJson(response, 409, { ended: false, error: "thread is still running" });
        return;
      }
      state.end();
      writeJson(response, 200, { ended: true, lastSeq: state.lastSeq });
      return;
    }
    if (request.method === "POST" && requestUrl.startsWith(`/api/threads/${threadId}/turn`)) {
      state.turnBody = JSON.parse(body) as { input?: string; options?: unknown };
      state.turns += 1;
      setTimeout(() => sendTurn(sockets, state.turns, state), 25);
      setTimeout(() => {
        state.turnResponseSent = true;
        writeJson(response, 200, { ok: true, submissionId: "submission", delivery: "turn", lastSeq: state.lastSeq });
      }, 175);
      return;
    }
    writeJson(response, 404, { error: "not found" });
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", (socket, request) => {
    const token = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("codexhub_token");
    if (token !== authToken) {
      socket.close(1008, "unauthorized");
      return;
    }
    state.subscriptions++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (message) => {
      const parsed = JSON.parse(String(message)) as { type?: string; threadId?: string };
      if (parsed.type !== "subscribe_thread" || parsed.threadId !== threadId) return;
      socket.send(JSON.stringify({ type: "thread", kind: "thread", threadId, historical: true, seq: 1,
        records: [record("history", { type: "agent_message", message: "historical answer" })], queue: [] }));
      socket.send(JSON.stringify({ type: "thread_subscribed", threadId }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  state.url = `http://127.0.0.1:${address.port}`;
  state.setRunning = (running) => { state.running = running; };
  state.activeSockets = () => sockets.size;
  state.disconnect = () => {
    for (const socket of sockets) socket.terminate();
  };
  state.end = () => {
    state.lastSeq += 1;
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({
        type: "thread", kind: "thread", threadId, seq: state.lastSeq, lifecycle: "end"
      }));
    }
  };
  state.close = async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => websocket.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
};

const sendTurn = (sockets: Set<WebSocket>, turnNumber = 1, state?: Fixture) => {
  let seq = (turnNumber - 1) * 20 + 2;
  const suffix = turnNumber === 1 ? "" : `-${turnNumber}`;
  const send = (recordValue: Record<string, unknown>) => {
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({
        type: "record", kind: "record", threadId, seq: seq++, record: { ...recordValue, id: `${String(recordValue.id)}${suffix}` }
      }));
    }
  };
  send(record("commentary", { type: "agent_message", phase: "commentary", message: "live commentary" }));
  send(record("tool-call", { type: "function_call", name: "exec_command", call_id: `call${suffix}`, arguments: "{\"cmd\":\"printf\"}", status: "in_progress" }, "response_item"));
  send(record("shell", { type: "local_shell_call", call_id: `shell${suffix}`, action: { type: "exec", command: ["printf"] }, status: "in_progress", aggregated_output: "$ printf\nprefix" }, "response_item"));
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "record_delta", kind: "record_delta", threadId, seq: seq++, delta: { recordId: `shell${suffix}`, field: "aggregated_output", append: "\nnext" } }));
  }
  send(record("tool-result", {
    type: "function_call_output", call_id: `call${suffix}`, status: "completed",
    output: Array.from({ length: 12 }, (_, index) => `output-${index + 1}`).join("\n")
  }, "response_item"));
  send(record("file", { type: "file_change", status: "completed", changes: [{ path: "file.txt", kind: "update" }] }, "response_item"));
  send({ id: "error", type: "error", payload: { message: "visible stream error" } });
  send(record("user-input", { type: "user_input_request", status: "pending_user_input", questions: [{ id: `q${suffix}`, question: "Need input", header: "Input", isOther: false, isSecret: false, options: null }] }, "response_item"));
  send(record("final", { type: "agent_message", phase: "final_answer", message: `live final #${turnNumber}` }));
  if (state) state.lastSeq = (turnNumber - 1) * 20 + 11;
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "done", kind: "done", threadId, seq: (turnNumber - 1) * 20 + 11 }));
  }
};

const record = (id: string, payload: Record<string, unknown>, type = "event_msg") => ({
  id,
  type,
  payload
});

const writeJson = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
};

const collectOutput = (stream: NodeJS.ReadableStream) => {
  const result = { value: "" };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => { result.value += chunk; });
  return result;
};

const childExit = (child: ReturnType<typeof spawn>) => new Promise<number>((resolve, reject) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    resolve(child.exitCode ?? 1);
    return;
  }
  child.once("error", reject);
  child.once("close", (code) => resolve(code ?? 1));
});

const waitFor = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("function call/output correlate once without treating call completion as tool success", () => {
  let output = "";
  const renderer = new ConversationStreamRenderer(chunk => { output += chunk; });
  const emit = (id: string, payload: Record<string, unknown>) => renderer.event({ kind: "record", threadId, record: record(id, payload, "response_item") });
  const call = { type: "function_call", call_id: "f1", name: "exec_command", arguments: JSON.stringify({ cmd: "pnpm test", workdir: "/workspace" }) };
  emit("call", { ...call, status: "in_progress" });
  const waiting = output;
  emit("call", { ...call, status: "in_progress" });
  emit("call", { ...call, status: "completed" });
  assert.equal(output, waiting, "call updates must not print a heartbeat or premature result");
  for (const id of ["result1", "result2"]) emit(id, { type: "function_call_output", call_id: "f1", output: "private success body", status: "completed" });
  assert.equal((output.match(/\[tool_call\]/g) ?? []).length, 1);
  assert.equal((output.match(/\[tool_result\]/g) ?? []).length, 1);
  assert.match(output, /exec_command\ncommand: pnpm test\ncwd: \/workspace/);
  assert.match(output, /\[tool_result\]\nexec_command\n✓ 完成/);
  assert.doesNotMatch(output, /private success body/);
});

test("MCP and dynamic tools report real failures and supplied duration", () => {
  let output = "";
  const renderer = new ConversationStreamRenderer(chunk => { output += chunk; });
  const emit = (id: string, payload: Record<string, unknown>) => renderer.event({ kind: "record", threadId, record: record(id, payload, "response_item") });
  emit("mcp", { type: "mcp_tool_call", server: "docs", tool: "search", arguments: { query: "status" }, status: "in_progress" });
  emit("mcp", { type: "mcp_tool_call", server: "docs", tool: "search", status: "completed", duration_ms: 1200, result: { isError: true, content: [{ type: "text", text: "search unavailable" }] } });
  emit("dynamic", { type: "function_call", call_id: "d", name: "clock", namespace: "functions", arguments: "{}", status: "completed", success: false, content_items: [{ type: "text", text: "clock unavailable" }] });
  assert.equal((output.match(/✗ 失败/g) ?? []).length, 2);
  assert.match(output, /docs.search/);
  assert.match(output, /1200ms/);
  assert.match(output, /search unavailable/);
  assert.match(output, /functions.clock/);
  assert.match(output, /clock unavailable/);
  assert.doesNotMatch(output, /✓ 完成/);
});

test("orphan results do not fabricate calls and late calls do not duplicate results", () => {
  let output = "";
  const renderer = new ConversationStreamRenderer(chunk => { output += chunk; });
  const emit = (id: string, payload: Record<string, unknown>) => renderer.event({ kind: "record", threadId, record: record(id, payload, "response_item") });
  emit("out", { type: "function_call_output", call_id: "late", output: "hidden", status: "completed" });
  assert.doesNotMatch(output, /\[tool_call\]/);
  emit("in", { type: "function_call", call_id: "late", name: "search", arguments: '{"query":"target"}', status: "completed" });
  emit("out2", { type: "function_call_output", call_id: "late", output: "hidden" });
  assert.equal((output.match(/\[tool_call\]/g) ?? []).length, 1);
  assert.equal((output.match(/\[tool_result\]/g) ?? []).length, 1);
  assert.doesNotMatch(output, /hidden/);
});

test("tool parameters are bounded, preserve cwd and redact common credentials", () => {
  let output = "";
  const renderer = new ConversationStreamRenderer(chunk => { output += chunk; });
  const emit = (id: string, name: string, args: Record<string, unknown>) => renderer.event({ kind: "record", threadId, record: record(id, { type: "function_call", name, arguments: JSON.stringify(args), status: "in_progress" }, "response_item") });
  emit("cmd", "exec_command", { cmd: `curl --token secret-one https://user:secret-two@example.com/?api_key=secret-three ${"x".repeat(5000)}`, workdir: "/workspace" });
  emit("http", "request", { url: "https://example.com", headers: { Authorization: "Bearer secret-four" }, password: "secret-five" });
  assert.match(output, /cwd: \/workspace/);
  assert.match(output, /已截断/);
  assert.match(output, /REDACTED/);
  assert.doesNotMatch(output, /secret-(one|two|three|four|five)/);
  assert.ok(output.length < 1800);
});

test("patch previews show paths instead of edit bodies", () => {
  let output = "";
  const renderer = new ConversationStreamRenderer(chunk => { output += chunk; });
  renderer.event({ kind: "record", threadId, record: record("patch", {
    type: "function_call", name: "apply_patch", status: "in_progress",
    arguments: JSON.stringify({ patch: "*** Begin Patch\n*** Update File: src/app.ts\n@@\n+private edit body\n*** End Patch" })
  }, "response_item") });
  assert.match(output, /src\/app.ts/);
  assert.doesNotMatch(output, /private edit body/);
});

test("nonzero structured and standard shell outputs cannot be labelled successful", () => {
  let output = "";
  const renderer = new ConversationStreamRenderer(chunk => { output += chunk; });
  for (const [id, result] of [["json", JSON.stringify({ exit_code: 7, output: "failure" })], ["shell", "Process exited with code 2\nerror details"]]) {
    renderer.event({ kind: "record", threadId, record: record(id, { type: "function_call_output", output: result }, "response_item") });
  }
  assert.equal((output.match(/✗ 失败/g) ?? []).length, 2);
  assert.doesNotMatch(output, /✓ 完成/);
});
