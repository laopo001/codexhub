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

test("stream raw is live JSONL, preserves stdin/options, and ignores history", { timeout: 20_000 }, async () => {
  const fixture = await createFixture();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-cli-stream-"));
  try {
    const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", "--connect", fixture.url,
      "start", "-", "--name", "Stream raw", "--model", "gpt-stream", "--effort", "ultra",
      "--stream", "--output", "raw", "--cwd", cwd, "--machine", machineId, "--timeout", "10"], {
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

    await waitFor(() => output.value.includes('"type":"codexhub.record"'), "first live raw record");
    assert.equal(fixture.turnResponseSent, false, "a live WS record must precede the HTTP completion response");
    const exitCode = await childExit(child);
    assert.equal(exitCode, 0, errors.value);

    const envelopes = output.value.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    assert.equal(envelopes[0]?.version, 1);
    assert.deepEqual(envelopes[0], {
      version: 1,
      type: "codexhub.thread.started",
      threadId,
      machineId,
      cwd
    });
    assert.equal(envelopes.some((entry) => entry.type === "codexhub.error"), false);
    assert.equal(envelopes.some((entry) => entry.type === "codexhub.turn.completed"), true);
    assert.equal(envelopes.at(-1)?.type, "codexhub.turn.completed");
    assert.equal(envelopes.some((entry) => entry.record?.id === "history"), false);
    assert.equal(envelopes.some((entry) => entry.type === "codexhub.record_delta"), true);
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
      "send", threadId, "normal input", "--stream", "--output", "normal", "--cwd", cwd, "--machine", machineId], {
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
    assert.match(output.value, /\[tool call: exec_command\]/);
    assert.match(output.value, /\[tool result\]/);
    assert.match(output.value, /\[file change: completed\]/);
    assert.match(output.value, /\[error\][\s\S]*visible stream error/);
    assert.match(output.value, /\[user input\]/);
    assert.doesNotMatch(output.value, /historical answer/);
    for (const line of ["output-1", "output-2", "output-3", "output-4", "output-5", "output-8", "output-9", "output-10", "output-11", "output-12"]) {
      assert.match(output.value, new RegExp(line));
    }
    assert.doesNotMatch(output.value, /output-6|output-7/);
    assert.equal(fixture.turnBody.input, "normal input");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await fixture.close();
  }
});

test("stream conflicts and output mode are rejected before reading stdin or contacting a backend", { timeout: 10_000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-cli-args-"));
  try {
    for (const extra of [["--json"], ["--no-wait"], []]) {
      const args = extra.length
        ? ["--stream", ...extra]
        : ["--output", "normal"];
      const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", "--connect", "http://127.0.0.1:1",
        "start", "-", "--name", "invalid", ...args], {
        cwd: projectRoot,
        env: { ...process.env, CODEX_HUB_DATA_DIR: dataDir, CODEX_HUB_PLUGIN_TELEGRAM: "0" },
        stdio: ["pipe", "pipe", "pipe"]
      });
      const output = collectOutput(child.stdout);
      const errors = collectOutput(child.stderr);
      child.stdin.end("must not be read\n");
      const exitCode = await childExit(child);
      assert.notEqual(exitCode, 0);
      assert.equal(output.value, "");
      assert.match(errors.value, extra[0] === "--json"
        ? /--stream cannot be combined with --json/
        : extra[0] === "--no-wait"
          ? /--stream cannot be combined with --no-wait/
          : /--output is only valid with --stream/);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("normal renderer keeps an explicitly failed tool output complete", () => {
  const chunks: string[] = [];
  const renderer = new ConversationStreamRenderer("normal", (chunk) => chunks.push(chunk));
  const output = Array.from({ length: 12 }, (_, index) => `failed-${index + 1}`).join("\n");
  renderer.event({
    kind: "record",
    threadId,
    record: record("failed-tool", { type: "function_call_output", status: "failed", output }, "response_item")
  });
  const rendered = chunks.join("");
  assert.match(rendered, /failed-1/);
  assert.match(rendered, /failed-12/);
  assert.doesNotMatch(rendered, /lines omitted/);
});

test("normal renderer coalesces Unicode assistant deltas and flushes status-only completion", () => {
  const chunks: string[] = [];
  const renderer = new ConversationStreamRenderer("normal", (chunk) => chunks.push(chunk));
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
  renderer.completed({ threadId, lastSeq: 1 });

  assert.equal(chunks.join(""), "[commentary]\n你好 世界\n下一行\n");
  assert.equal(chunks.join("").match(/\[commentary/g)?.length, 1);
  assert.doesNotMatch(chunks.join(""), /commentary update/);
});

test("normal renderer separates interleaved tools and keeps replacements explicit", () => {
  const chunks: string[] = [];
  const renderer = new ConversationStreamRenderer("normal", (chunk) => chunks.push(chunk));
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
  renderer.completed({ threadId, lastSeq: 2 });

  const rendered = chunks.join("");
  assert.match(rendered, /\[commentary\]\n先检查项目\n\[shell\]/);
  assert.match(rendered, /\[shell\][\s\S]*final output\n\[final_answer\]/);
  assert.doesNotMatch(rendered, /leaked output/);
  assert.match(rendered, /\[commentary replaced\]\nhello there/);
  assert.doesNotMatch(rendered, /commentary update/);
});

test("normal renderer trims a 300-line success once and keeps failure output complete", () => {
  const chunks: string[] = [];
  const renderer = new ConversationStreamRenderer("normal", (chunk) => chunks.push(chunk));
  const success = Array.from({ length: 300 }, (_, index) => `success-${index + 1}`).join("\n");
  renderer.event({ kind: "record", threadId, record: record("success", { type: "function_call_output", status: "completed", output: success }, "response_item") });
  const failure = Array.from({ length: 300 }, (_, index) => `failure-${index + 1}`).join("\n");
  renderer.event({ kind: "record", threadId, record: record("failure", { type: "function_call_output", status: "failed", output: failure }, "response_item") });
  renderer.completed({ threadId, lastSeq: 3 });

  const rendered = chunks.join("");
  assert.equal((rendered.match(/290 lines omitted/g) ?? []).length, 1);
  assert.match(rendered, /success-1/);
  assert.match(rendered, /success-5/);
  assert.doesNotMatch(rendered, /success-6/);
  assert.match(rendered, /success-296/);
  assert.match(rendered, /success-300/);
  assert.match(rendered, /failure-1/);
  assert.match(rendered, /failure-300/);
  assert.doesNotMatch(rendered, /failure-6[\s\S]*lines omitted/);
});

type Fixture = {
  url: string;
  turnBody: { input?: string; options?: unknown };
  turnResponseSent: boolean;
  close: () => Promise<void>;
};

const createFixture = async (): Promise<Fixture> => {
  const sockets = new Set<WebSocket>();
  const state: Fixture = {
    url: "",
    turnBody: {},
    turnResponseSent: false,
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
