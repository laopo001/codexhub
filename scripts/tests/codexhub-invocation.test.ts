import assert from "node:assert/strict";
import test from "node:test";
import {
  codexhubThreadIdFromOutput,
  parseCodexhubInvocation,
  type CodexhubInvocation
} from "../../src/web/helpers/codexhubInvocation.js";

const threadId = "123e4567-e89b-12d3-a456-426614174000";

const invocation = (value: CodexhubInvocation | null) => value;

test("parses a start command and its supported options", () => {
  assert.deepEqual(invocation(parseCodexhubInvocation([
    "codexhub",
    "start",
    "first message",
    "--name",
    "Panel thread",
    "--cwd",
    "/tmp/project",
    "--machine=machine-a",
    "--model",
    "gpt-5",
    "--effort=high",
    "--connect",
    "http://127.0.0.1:8788",
    "--stream",
    "--wait",
    "--timeout=30",
    "--json"
  ])), {
    operation: "start",
    name: "Panel thread",
    cwd: "/tmp/project",
    machineId: "machine-a",
    model: "gpt-5",
    effort: "high",
    connectUrl: "http://127.0.0.1:8788",
    input: "first message"
  });
});

test("parses quoted arguments, env prefixes, shell wrappers, and line continuations", () => {
  const command = String.raw`env CODEXHUB_TEST=1 bash -lc 'codexhub send ${threadId} "two words" --cwd "/tmp/my project" --server=http://localhost:8788'`;
  assert.deepEqual(invocation(parseCodexhubInvocation(command)), {
    operation: "send",
    threadId,
    cwd: "/tmp/my project",
    connectUrl: "http://localhost:8788",
    input: "two words"
  });

  assert.deepEqual(invocation(parseCodexhubInvocation([
    "sh",
    "-c",
    "CODEXHUB_MODE=1 cxh start --name 'A quoted name' " + "\\" + "\n" +
      "'input with spaces'"
  ])), {
    operation: "start",
    name: "A quoted name",
    input: "input with spaces"
  });
});

test("parses an app-server serialized single-element shell command with heredoc input", () => {
  const command = [
    `/usr/bin/zsh -lc "codexhub start - --name 'Breeze dialogue repair' --cwd /workspace/videos --model gpt-5.6-luna --effort xhigh <<'TASK'`,
    "Review the dialogue instructions and keep the existing voice bindings.",
    "TASK\""
  ].join("\n");

  assert.deepEqual(invocation(parseCodexhubInvocation([command])), {
    operation: "start",
    name: "Breeze dialogue repair",
    cwd: "/workspace/videos",
    model: "gpt-5.6-luna",
    effort: "xhigh",
    input: "Review the dialogue instructions and keep the existing voice bindings."
  });
});

test("parses send, stop, and end IDs only from their position arguments", () => {
  assert.deepEqual(invocation(parseCodexhubInvocation(`cxh send --model=gpt-5 ${threadId} "continue this" --no-wait`)), {
    operation: "send",
    threadId,
    model: "gpt-5",
    input: "continue this"
  });
  assert.deepEqual(invocation(parseCodexhubInvocation(["codexhub", "stop", threadId, "--json"])), {
    operation: "stop",
    threadId
  });
  assert.deepEqual(invocation(parseCodexhubInvocation(`codexhub end ${threadId} --timeout 10`)), {
    operation: "end",
    threadId
  });
});

test("takes a start input from heredoc stdin and leaves its body uninterpreted", () => {
  const command = [
    "codexhub start - --name \"heredoc thread\" <<'INPUT'",
    "first line",
    "codexhub send 123e4567-e89b-12d3-a456-426614174000 should stay text",
    "echo 'also text'",
    "INPUT",
    ""
  ].join("\n");

  assert.deepEqual(invocation(parseCodexhubInvocation(command)), {
    operation: "start",
    name: "heredoc thread",
    input: [
      "first line",
      "codexhub send 123e4567-e89b-12d3-a456-426614174000 should stay text",
      "echo 'also text'"
    ].join("\n")
  });
});

test("only accepts a standalone UUID Thread ID output line", () => {
  assert.equal(codexhubThreadIdFromOutput(`task text: Thread ID: ${threadId}`), undefined);
  assert.equal(codexhubThreadIdFromOutput(`$ codexhub start --name x\nThread ID: not-a-uuid`), undefined);
  assert.equal(codexhubThreadIdFromOutput(`output\n Thread ID: ${threadId} \nmore`), threadId);
});

test("rejects echoes, ordinary task text, dynamic IDs, and ambiguous commands", () => {
  assert.equal(parseCodexhubInvocation("echo 'codexhub start --name fake input'"), null);
  assert.equal(parseCodexhubInvocation("Please run codexhub send in this task"), null);
  assert.equal(parseCodexhubInvocation("codexhub send $THREAD_ID 'input'"), null);
  assert.equal(parseCodexhubInvocation("codexhub send \"$(printf '%s' '${threadId}')\" input"), null);
  assert.equal(parseCodexhubInvocation(`codexhub start --name x input && codexhub send ${threadId} next`), null);
  assert.equal(parseCodexhubInvocation(`codexhub start --name x input; echo done`), null);
  assert.equal(parseCodexhubInvocation("python -c 'codexhub start --name x input'"), null);
  assert.equal(parseCodexhubInvocation("codexhub start --name x input --unknown"), null);
});

test("rejects unsafe commands in a serialized single-element shell array", () => {
  assert.equal(parseCodexhubInvocation(["/usr/bin/zsh -lc \"echo 'codexhub start --name fake input'\""]), null);
  assert.equal(parseCodexhubInvocation(["/usr/bin/zsh -lc \"codexhub send $THREAD_ID 'input'\""]), null);
  assert.equal(parseCodexhubInvocation(["/usr/bin/zsh -lc \"codexhub start --name x input && echo done\""]), null);
});

test("very large or deeply nested shell wrappers remain ordinary shell previews", () => {
  assert.equal(parseCodexhubInvocation(`codexhub start '${"x".repeat(65000)}' --name long`), null);
  let command = "codexhub start task --name nested";
  for (let i = 0; i < 10; i++) command = `sh -c ${JSON.stringify(command)}`;
  assert.equal(parseCodexhubInvocation(command), null);
});
