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

test("stream text arrives live, preserves stdin/options, and ignores history", { timeout: 20_000 }, async () => {
  const fixture = await createFixture();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-cli-stream-"));
  try {
    const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", "--connect", fixture.url,
      "start", "-", "--name", "Stream text", "--model", "gpt-stream", "--effort", "ultra",
      "--stream", "--cwd", cwd, "--machine", machineId, "--timeout", "10"], {
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
    const exitCode = await childExit(child);
    assert.equal(exitCode, 0, errors.value);

    assert.match(output.value, /Thread ID: stream-thread/);
    assert.match(output.value, /\[commentary\][\s\S]*live commentary/);
    assert.match(output.value, /\[final_answer\][\s\S]*live final/);
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

test("stream normal renders assistant/tools/files/errors/user response without replaying tool output", { timeout: 20_000 }, async () => {
  const fixture = await createFixture();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-cli-normal-"));
  try {
    const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", "--connect", fixture.url,
      "send", threadId, "normal input", "--stream", "--cwd", cwd, "--machine", machineId], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CODEX_HUB_DATA_DIR: dataDir,
        CODEX_HUB_AUTH_TOKEN: authToken,
        CODEX_HUB_PLUGIN_TELEGRAM: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = collectOutput(child.stdout);
    const errors = collectOutput(child.stderr);
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
    assert.doesNotMatch(output.value, /historical answer/);
    assert.doesNotMatch(output.value, /output-\d+/);
    assert.equal(fixture.turnBody.input, "normal input");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await fixture.close();
  }
});

test("conversation mode conflicts and output mode are rejected before reading stdin or contacting a backend", { timeout: 10_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-cli-args-"));
  try {
    const cases = [
      { args: ["--stream", "--json"], error: /--stream cannot be combined with --json/ },
      { args: ["--stream", "--no-wait"], error: /--stream cannot be combined with --no-wait/ },
      { args: ["--no-wait", "--stream"], error: /--stream cannot be combined with --no-wait/ },
      { args: ["--wait", "--no-wait"], error: /--wait cannot be combined with --no-wait/ },
      { args: ["--no-wait", "--wait"], error: /--wait cannot be combined with --no-wait/ },
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

test("send --wait waits for the final result without requiring stream output", { timeout: 20_000 }, async () => {
  const fixture = await createFixture();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-cli-send-wait-"));
  try {
    const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", "--connect", fixture.url,
      "send", threadId, "waited send", "--wait", "--cwd", cwd, "--machine", machineId], {
      cwd: projectRoot,
      env: { ...process.env, CODEX_HUB_DATA_DIR: dataDir, CODEX_HUB_AUTH_TOKEN: authToken, CODEX_HUB_PLUGIN_TELEGRAM: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = collectOutput(child.stdout);
    const errors = collectOutput(child.stderr);
    const exitCode = await childExit(child);
    assert.equal(exitCode, 0, errors.value);
    assert.match(output.value, /Thread ID: stream-thread/);
    assert.match(output.value, /live final/);
    assert.equal(fixture.subscriptions, 1);
    assert.equal(fixture.turnBody.input, "waited send");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await fixture.close();
  }
});

test("start remains waiting by default", { timeout: 20_000 }, async () => {
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
  subscriptions: number;
  close: () => Promise<void>;
};

const createFixture = async (): Promise<Fixture> => {
  const sockets = new Set<WebSocket>();
  const state: Fixture = {
    url: "",
    turnBody: {},
    turnResponseSent: false,
    subscriptions: 0,
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
      writeJson(response, 200, { threadId, workingDirectory: cwd, runtime: { machineId } });
      return;
    }
    if (request.method === "POST" && requestUrl.startsWith(`/api/threads/${threadId}/turn`)) {
      state.turnBody = JSON.parse(body) as { input?: string; options?: unknown };
      setTimeout(() => sendTurn(sockets), 25);
      setTimeout(() => {
        state.turnResponseSent = true;
        writeJson(response, 200, { ok: true, submissionId: "submission", delivery: "turn", lastSeq: 10 });
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
        records: [record("history", { type: "agent_message", message: "historical answer" })] }));
      socket.send(JSON.stringify({ type: "thread_subscribed", threadId }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  state.url = `http://127.0.0.1:${address.port}`;
  state.close = async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => websocket.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
};

const sendTurn = (sockets: Set<WebSocket>) => {
  let seq = 2;
  const send = (recordValue: unknown) => {
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "record", kind: "record", threadId, seq: seq++, record: recordValue }));
    }
  };
  send(record("commentary", { type: "agent_message", phase: "commentary", message: "live commentary" }));
  send(record("tool-call", { type: "function_call", name: "exec_command", call_id: "call", arguments: "{\"cmd\":\"printf\"}", status: "in_progress" }, "response_item"));
  send(record("shell", { type: "local_shell_call", call_id: "shell", action: { type: "exec", command: ["printf"] }, status: "in_progress", aggregated_output: "$ printf\nprefix" }, "response_item"));
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "record_delta", kind: "record_delta", threadId, seq: seq++, delta: { recordId: "shell", field: "aggregated_output", append: "\nnext" } }));
  }
  send(record("tool-result", {
    type: "function_call_output", call_id: "call", status: "completed",
    output: Array.from({ length: 12 }, (_, index) => `output-${index + 1}`).join("\n")
  }, "response_item"));
  send(record("file", { type: "file_change", status: "completed", changes: [{ path: "file.txt", kind: "update" }] }, "response_item"));
  send({ id: "error", type: "error", payload: { message: "visible stream error" } });
  send(record("user-input", { type: "user_input_request", status: "pending_user_input", questions: [{ id: "q", question: "Need input", header: "Input", isOther: false, isSecret: false, options: null }] }, "response_item"));
  send(record("final", { type: "agent_message", phase: "final_answer", message: "live final" }));
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "done", kind: "done", threadId, seq: 10 }));
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
