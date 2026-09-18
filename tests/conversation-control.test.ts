import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";

const projectRoot = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const authToken = "conversation-control-test-token";
const threadId = "delegation-thread";
const otherThreadId = "other-thread";

test("stop waits for canonical idle and keeps thread history", { timeout: 30_000 }, async () => {
  const fixture = await createFixture({ running: true, queue: [] });
  const dataDir = await mkdtemp(path.join(fixture.root, "cli-stop-"));
  try {
    const result = await runCli(fixture.url, dataDir, [
      "stop", threadId, "--timeout", "5", "--json"
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const output = parseJson(result.stdout);
    assert.deepEqual(output, {
      operation: "stop",
      threadId,
      stopped: true,
      running: false,
      idle: true,
      cancelledSubmissionIds: [],
      historyRetained: true,
      resumable: true
    });
    assert.equal(fixture.stopRequests, 1);
    assert.ok(fixture.idleObservedAt !== undefined, "CLI did not poll canonical running=false");
    assert.ok(fixture.idleObservedAt >= (fixture.runningFalseAt ?? 0));
    assert.equal(fixture.requests.some((request) => request === `DELETE /api/threads/${threadId}`), false);
    assert.equal(fixture.thread.records.length, 1, "stop must preserve transcript history");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await fixture.close();
  }
});

test("end cancels the target queue before stopping it and leaves other threads alone", { timeout: 30_000 }, async () => {
  const fixture = await createFixture({
    running: true,
    queue: ["queued-one", "queued-two"],
    otherRunning: true,
    otherQueue: ["other-queued"],
    restartOnQueueSnapshot: 3
  });
  const dataDir = await mkdtemp(path.join(fixture.root, "cli-end-"));
  try {
    const result = await runCli(fixture.url, dataDir, [
      "end", threadId, "--timeout", "5", "--json"
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const output = parseJson(result.stdout);
    assert.deepEqual(output, {
      operation: "end",
      threadId,
      stopped: true,
      running: false,
      idle: true,
      cancelledSubmissionIds: ["queued-one", "queued-two"],
      queueRemaining: 0,
      historyRetained: true,
      resumable: true
    });
    const firstDelete = fixture.requests.indexOf(`DELETE /api/threads/${threadId}/queue/queued-one`);
    const secondDelete = fixture.requests.indexOf(`DELETE /api/threads/${threadId}/queue/queued-two`);
    const stop = fixture.requests.indexOf(`POST /api/threads/${threadId}/stop`);
    assert.ok(firstDelete >= 0 && secondDelete > firstDelete && stop > secondDelete);
    assert.equal(fixture.stopRequests, 1);
    assert.deepEqual(fixture.thread.queue, []);
    assert.equal(fixture.thread.running, false, "end must re-check idle after the final queue snapshot");
    assert.ok(fixture.idleObservations >= 2, "end must observe canonical idle after final queue verification");
    assert.equal(fixture.other.running, true, "end must not stop another thread");
    assert.deepEqual(fixture.other.queue, ["other-queued"], "end must not cancel another thread's queue");
    assert.equal(fixture.thread.records.length, 1, "end must retain transcript history");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await fixture.close();
  }
});

test("end on an idle thread succeeds without sending a stop request", { timeout: 30_000 }, async () => {
  const fixture = await createFixture({ running: false, queue: [] });
  const dataDir = await mkdtemp(path.join(fixture.root, "cli-end-idle-"));
  try {
    const result = await runCli(fixture.url, dataDir, [
      "end", threadId, "--timeout", "5", "--json"
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const output = parseJson(result.stdout);
    assert.equal(output.operation, "end");
    assert.equal(output.running, false);
    assert.equal(output.queueRemaining, 0);
    assert.deepEqual(output.cancelledSubmissionIds, []);
    assert.equal(fixture.stopRequests, 0);
    assert.equal(fixture.requests.some((request) => request.includes("/queue/")), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await fixture.close();
  }
});

test("end rejects a realtime snapshot that omits the queue field", { timeout: 30_000 }, async () => {
  const fixture = await createFixture({ running: false, queue: [], omitQueueField: true });
  const dataDir = await mkdtemp(path.join(fixture.root, "cli-end-missing-queue-"));
  try {
    const result = await runCli(fixture.url, dataDir, [
      "end", threadId, "--timeout", "5", "--json"
    ]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /queue field/);
    assert.equal(fixture.stopRequests, 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await fixture.close();
  }
});

test("stop errors and idle timeouts never print a successful result", { timeout: 30_000 }, async () => {
  const errorFixture = await createFixture({ running: true, queue: [], stopMode: "error" });
  const errorDataDir = await mkdtemp(path.join(errorFixture.root, "cli-stop-error-"));
  try {
    const result = await runCli(errorFixture.url, errorDataDir, [
      "stop", threadId, "--timeout", "5", "--json"
    ]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /HTTP 409/);
  } finally {
    await rm(errorDataDir, { recursive: true, force: true });
    await errorFixture.close();
  }

  const timeoutFixture = await createFixture({ running: true, queue: [], stopMode: "never" });
  const timeoutDataDir = await mkdtemp(path.join(timeoutFixture.root, "cli-stop-timeout-"));
  try {
    const result = await runCli(timeoutFixture.url, timeoutDataDir, [
      "stop", threadId, "--timeout", "0.05", "--json"
    ]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /timed out|timeout/i);
  } finally {
    await rm(timeoutDataDir, { recursive: true, force: true });
    await timeoutFixture.close();
  }
});

type Fixture = {
  root: string;
  url: string;
  requests: string[];
  stopRequests: number;
  runningFalseAt?: number;
  idleObservedAt?: number;
  idleObservations: number;
  thread: ThreadState;
  other: ThreadState;
  close: () => Promise<void>;
};

type ThreadState = {
  running: boolean;
  queue: string[];
  records: Array<Record<string, unknown>>;
};

const createFixture = async (options: {
  running: boolean;
  queue: string[];
  otherRunning?: boolean;
  otherQueue?: string[];
  stopMode?: "delayed" | "error" | "never";
  restartOnQueueSnapshot?: number;
  omitQueueField?: boolean;
}): Promise<Fixture> => {
  const root = await mkdtemp(path.join("/tmp", "codexhub-control-fixture-"));
  const thread: ThreadState = {
    running: options.running,
    queue: [...options.queue],
    records: [{ id: "history", type: "event_msg", payload: { type: "agent_message", message: "kept history" } }]
  };
  const other: ThreadState = {
    running: options.otherRunning ?? false,
    queue: [...(options.otherQueue ?? [])],
    records: []
  };
  const requests: string[] = [];
  let stopRequests = 0;
  let runningFalseAt: number | undefined;
  let idleObservedAt: number | undefined;
  let idleObservations = 0;
  let queueSnapshotCount = 0;
  const sockets = new Set<WebSocket>();
  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(`${method} ${pathname}`);
    if (request.headers.authorization !== `Bearer ${authToken}`) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (method === "POST" && pathname === `/api/threads/${threadId}/stop`) {
      stopRequests += 1;
      if (options.stopMode === "error") {
        writeJson(response, 409, { error: "stop rejected" });
        return;
      }
      if (options.stopMode !== "never") {
        setTimeout(() => {
          thread.running = false;
          runningFalseAt = Date.now();
        }, 40);
      }
      writeJson(response, 200, { stopped: true });
      return;
    }

    if (method === "POST" && pathname === `/api/threads/${threadId}/end`) {
      if (thread.running || thread.queue.length > 0) {
        writeJson(response, 409, { ended: false, error: "thread is not idle and queue is not empty" });
        return;
      }
      writeJson(response, 200, { ended: true, lastSeq: 2 });
      return;
    }

    const threadMatch = pathname.match(/^\/api\/threads\/([^/]+)(?:\/queue\/([^/]+))?$/);
    if (!threadMatch) {
      writeJson(response, 404, { error: "not found" });
      return;
    }
    const requestedThread = decodeURIComponent(threadMatch[1]);
    const state = requestedThread === threadId ? thread : requestedThread === otherThreadId ? other : undefined;
    if (!state) {
      writeJson(response, 404, { error: "thread_not_found" });
      return;
    }

    if (method === "GET" && !threadMatch[2]) {
      if (requestedThread === threadId && !state.running) {
        idleObservedAt = Date.now();
        idleObservations += 1;
      }
      writeJson(response, 200, {
        threadId: requestedThread,
        running: state.running,
        status: state.running ? "running" : "idle",
        records: state.records,
        lastSeq: 1
      });
      return;
    }
    if (method === "DELETE" && threadMatch[2]) {
      const submissionId = decodeURIComponent(threadMatch[2]);
      const index = state.queue.indexOf(submissionId);
      if (index < 0) {
        writeJson(response, 409, { cancelled: false, error: "not queued" });
        return;
      }
      state.queue.splice(index, 1);
      writeJson(response, 200, { cancelled: true, submissionId });
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
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { type?: string; threadId?: string };
      if (message.type !== "subscribe_thread" || message.threadId !== threadId) return;
      queueSnapshotCount += 1;
      if (options.restartOnQueueSnapshot === queueSnapshotCount) {
        thread.running = true;
        setTimeout(() => {
          thread.running = false;
          runningFalseAt = Date.now();
        }, 40);
      }
      const snapshot = {
        type: "thread",
        kind: "thread",
        threadId,
        historical: true,
        seq: 1,
        thread: { running: thread.running },
        records: thread.records,
        queue: thread.queue.map((submissionId, index) => ({
          submissionId,
          text: submissionId,
          imageCount: 0,
          source: "web",
          createdAt: new Date(0).toISOString(),
          position: index + 1
        }))
      };
      if (options.omitQueueField) delete (snapshot as { queue?: unknown }).queue;
      socket.send(JSON.stringify(snapshot));
      socket.send(JSON.stringify({ type: "thread_subscribed", threadId }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    root,
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get stopRequests() { return stopRequests; },
    get runningFalseAt() { return runningFalseAt; },
    get idleObservedAt() { return idleObservedAt; },
    get idleObservations() { return idleObservations; },
    thread,
    other,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  };
};

const runCli = async (url: string, dataDir: string, args: string[]) => {
  const child = spawn(process.execPath, [tsxCli, "src/cli/codexhub.ts", "--connect", url, ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_HUB_DATA_DIR: dataDir,
      CODEX_HUB_AUTH_TOKEN: authToken,
      CODEX_HUB_PLUGIN_TELEGRAM: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8").trim(),
    stderr: Buffer.concat(stderr).toString("utf8").trim()
  };
};

const parseJson = (value: string): Record<string, any> => {
  try {
    return JSON.parse(value) as Record<string, any>;
  } catch (error) {
    throw new Error(`CLI did not print JSON: ${value}\n${error instanceof Error ? error.message : String(error)}`);
  }
};

const writeJson = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};
