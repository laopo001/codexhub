import assert from "node:assert/strict";
import test from "node:test";
import { SessionTransportPeer } from "../../src/core/sessionTransportPeer.js";
import type { SessionCommand } from "../../src/shared/threadTypes.js";

const command = (seq: number, commandId: string, type: SessionCommand["type"]): SessionCommand => ({
  seq,
  commandId,
  type,
  workingDirectory: "/tmp/project",
  createdAt: new Date(0).toISOString()
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for session command");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const createPeer = (
  handleCommand: (next: SessionCommand) => Promise<unknown>,
  sent: unknown[]
) => new SessionTransportPeer({
  sessionId: "session-1",
  send: (message) => sent.push(message),
  callbacks: {
    registration: () => ({ machineId: "machine-1", workingDirectory: "/tmp/project" }),
    handleCommand,
    onState: () => undefined
  }
});

const connectPeer = (peer: SessionTransportPeer) => {
  peer.start();
  peer.handleServerMessage({ type: "session_registered", sessionId: "session-1" });
};

test("read-only thread and model catalogs do not block thread creation", async () => {
  const sent: unknown[] = [];
  const listThreads = deferred();
  const listModels = deferred();
  const started: string[] = [];
  const peer = createPeer(async (next) => {
    started.push(next.type);
    if (next.type === "list_threads") {
      await listThreads.promise;
      return { threads: [] };
    }
    if (next.type === "list_models") {
      await listModels.promise;
      return { models: [] };
    }
    if (next.type === "start_thread") return { threadId: "thread-new" };
    throw new Error(`Unexpected command: ${next.type}`);
  }, sent);
  connectPeer(peer);

  peer.handleServerMessage({
    type: "session_commands",
    sessionId: "session-1",
    cursor: 3,
    commands: [
      command(1, "list-threads", "list_threads"),
      command(2, "list-models", "list_models"),
      command(3, "start", "start_thread")
    ]
  });

  await waitFor(() => started.includes("start_thread"));
  assert.deepEqual(started, ["list_threads", "list_models", "start_thread"]);
  assert.deepEqual(sent.filter((message) => (message as { commandId?: string }).commandId === "start"), [{
    type: "session_command_result",
    sessionId: "session-1",
    commandId: "start",
    result: { threadId: "thread-new" }
  }]);

  listThreads.resolve();
  listModels.resolve();
  await waitFor(() => sent.filter((message) => (message as { type?: string }).type === "session_command_result").length === 3);
});

test("state-changing session commands remain ordered", async () => {
  const sent: unknown[] = [];
  const firstCommand = deferred();
  const started: string[] = [];
  const peer = createPeer(async (next) => {
    started.push(next.commandId);
    if (next.commandId === "first") await firstCommand.promise;
    return { threadId: next.commandId };
  }, sent);
  connectPeer(peer);

  peer.handleServerMessage({
    type: "session_commands",
    sessionId: "session-1",
    cursor: 2,
    commands: [
      command(1, "first", "start_thread"),
      command(2, "second", "resume_thread")
    ]
  });

  await waitFor(() => started.length === 1);
  assert.deepEqual(started, ["first"]);
  firstCommand.resolve();
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ["first", "second"]);
});
