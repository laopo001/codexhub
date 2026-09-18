import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { registerParent, resolveRegisterParentTarget } from "../src/cli/registerParent.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(projectRoot, "node_modules/tsx/dist/cli.mjs");

type CapturedRequest = {
  method?: string;
  path?: string;
  authorization?: string;
  body?: unknown;
};

const readRequestBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const listen = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}` };
};

const close = async (server: Server) => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
};

const runCli = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexhub-register-cli."));
  const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_HUB_DATA_DIR: dataDir,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  try {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      }));
    });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
};

const outputOf = (result: { stdout: string; stderr: string }) => `${result.stdout}\n${result.stderr}`;

test("register posts to the local backend, separates tokens, and exits without contacting the parent", async () => {
  let captured: CapturedRequest | undefined;
  let parentRequests = 0;
  const parent = await listen((_request, response) => {
    parentRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ registration: { status: "online" } }));
  });
  const local = await listen(async (request, response) => {
    captured = {
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization
    };
    captured.body = JSON.parse(await readRequestBody(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ registration: { status: "starting", url: "http://secret-response-url" } }));
  });

  try {
    const parentUrl = parent.url;
    const result = await runCli([
      "--server", local.url,
      "register",
      "--to", parentUrl,
      "--machine-id", "machine-cli",
      "--name", "CLI registration"
    ], {
      CODEX_HUB_AUTH_TOKEN: "local-secret",
      CODEX_HUB_REGISTER_AUTH_TOKEN: "parent-env-secret"
    });

    assert.equal(result.code, 0, outputOf(result));
    assert.deepEqual(captured, {
      method: "POST",
      path: "/api/registered/parent",
      authorization: "Bearer local-secret",
      body: {
        url: parentUrl,
        authToken: "parent-env-secret",
        machineId: "machine-cli",
        name: "CLI registration"
      }
    });
    assert.equal(parentRequests, 0);
    assert.match(outputOf(result), /Registration request accepted by local CodexHub server\./);
    assert.equal(outputOf(result).includes("registered with parent"), false);
    assert.equal(outputOf(result).includes("local-secret"), false);
    assert.equal(outputOf(result).includes("parent-env-secret"), false);
    assert.equal(outputOf(result).includes("parent-url-secret"), false);
  } finally {
    await close(local.server);
    await close(parent.server);
  }
});

test("register preserves Register URL token semantics and explicit empty parent tokens", async () => {
  const requests: CapturedRequest[] = [];
  const local = await listen(async (request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(await readRequestBody(request))
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ registration: { status: "starting" } }));
  });

  try {
    const urlToken = `${local.url}/parent?codexhub_token=url-secret`;
    const withoutExplicitToken = await runCli(["--server", local.url, "register", "--to", urlToken], {
      CODEX_HUB_AUTH_TOKEN: "local-only-secret",
      CODEX_HUB_REGISTER_AUTH_TOKEN: "environment-secret"
    });
    assert.equal(withoutExplicitToken.code, 0, outputOf(withoutExplicitToken));
    assert.deepEqual(requests[0]?.body, { url: local.url, authToken: "url-secret" });
    assert.equal(requests[0]?.authorization, "Bearer local-only-secret");

    const withEmptyToken = await runCli([
      "--server", local.url,
      "register",
      "--to", urlToken,
      "--auth-token", ""
    ], { CODEX_HUB_AUTH_TOKEN: "local-only-secret" });
    assert.equal(withEmptyToken.code, 0, outputOf(withEmptyToken));
    assert.deepEqual(requests[1]?.body, { url: local.url, authToken: "" });
    assert.equal(requests[1]?.authorization, "Bearer local-only-secret");
  } finally {
    await close(local.server);
  }
});

test("register does not echo tokens from backend errors", async () => {
  let failedBody: unknown;
  const local = await listen(async (_request, response) => {
    failedBody = JSON.parse(await readRequestBody(_request));
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("failed parent-url-secret body-secret local-secret");
  });

  try {
    const result = await runCli([
      "--server", local.url,
      "register",
      "--to", `${local.url}/parent?codexhub_token=parent-url-secret`,
      "--auth-token", "body-secret"
    ], { CODEX_HUB_AUTH_TOKEN: "local-secret" });
    assert.equal(result.code, 1);
    assert.deepEqual(failedBody, {
      url: local.url,
      authToken: "body-secret"
    });
    assert.match(outputOf(result), /HTTP 500/);
    assert.equal(outputOf(result).includes("parent-url-secret"), false);
    assert.equal(outputOf(result).includes("body-secret"), false);
    assert.equal(outputOf(result).includes("local-secret"), false);
  } finally {
    await close(local.server);
  }
});

test("register rejects malformed or inactive successful responses", async () => {
  const responses = [
    "<html>not json</html>",
    "",
    "{}",
    JSON.stringify({ registration: { status: "offline", url: "response-secret" } }),
    JSON.stringify({ registration: { status: "stopped", url: "response-secret" } }),
    JSON.stringify({ registration: { status: "error", url: "response-secret" } })
  ];
  let responseIndex = 0;
  const local = await listen(async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(responses[responseIndex++]);
  });

  try {
    for (const responseBody of responses) {
      const result = await runCli([
        "--server", local.url,
        "register",
        "--to", `${local.url}/parent?codexhub_token=request-secret`
      ]);
      assert.equal(result.code, 1, `${responseBody}: ${outputOf(result)}`);
      assert.match(outputOf(result), /invalid parent registration response|did not accept parent registration/);
      assert.equal(outputOf(result).includes("response-secret"), false);
      assert.equal(outputOf(result).includes("request-secret"), false);
      assert.equal(outputOf(result).includes("Registration request accepted"), false);
    }
  } finally {
    await close(local.server);
  }
});

test("register parent target only accepts HTTP(S) and keeps explicit empty tokens", () => {
  assert.deepEqual(
    resolveRegisterParentTarget("https://parent.test/?codexhub_token=url-secret", "", {
      CODEX_HUB_REGISTER_AUTH_TOKEN: "environment-secret"
    }),
    { url: "https://parent.test", authToken: "" }
  );
  assert.throws(
    () => resolveRegisterParentTarget("ftp://parent.test", undefined),
    /http or https/
  );
});

test("register times out while reading the local backend response", async () => {
  const local = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"registration":');
  });

  try {
    await assert.rejects(
      registerParent({
        localServerUrl: local.url,
        parentUrl: "https://parent.test",
        timeoutMs: 25
      }),
      /Timed out waiting for the local CodexHub server response/
    );
  } finally {
    await close(local.server);
  }
});

test("register reports an unavailable local backend without starting one", async () => {
  const unused = await listen((_request, response) => response.end());
  const localUrl = unused.url;
  await close(unused.server);
  const result = await runCli([
    "--server", localUrl,
    "register",
    "--to", "http://127.0.0.1:1/?codexhub_token=parent-url-secret"
  ], { CODEX_HUB_AUTH_TOKEN: "local-secret" });

  assert.equal(result.code, 1);
  assert.match(outputOf(result), /local CodexHub server/);
  assert.equal(outputOf(result).includes("parent-url-secret"), false);
  assert.equal(outputOf(result).includes(localUrl), false);
});

test("register help exposes the required options and missing --to fails", async () => {
  const help = await runCli(["register", "--help"]);
  assert.equal(help.code, 0, outputOf(help));
  assert.match(help.stdout, /--to <url>/);
  assert.match(help.stdout, /--auth-token <token>/);
  assert.match(help.stdout, /--machine-id <id>/);
  assert.match(help.stdout, /--name <name>/);

  const missing = await runCli(["register"]);
  assert.equal(missing.code, 1, outputOf(missing));
  assert.match(outputOf(missing), /--to <url>/);
});
