import assert from "node:assert/strict";
import test from "node:test";
import { NtfyNotificationRunner } from "../../src/core/notificationHooks.js";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import type { ThreadInputSource, ThreadStreamEvent, ThreadSummary } from "../../src/shared/threadTypes.js";

type TestTimer = ReturnType<typeof setTimeout>;

class FakeClock {
  private current = 0;
  private nextTimerId = 0;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();

  readonly now = () => this.current;

  readonly setTimeout = (callback: () => void, delayMs: number): TestTimer => {
    const id = ++this.nextTimerId;
    const handle = { id, unref: () => undefined };
    this.timers.set(id, { due: this.current + delayMs, callback });
    return handle as unknown as TestTimer;
  };

  readonly clearTimeout = (timer: TestTimer) => {
    const id = (timer as unknown as { id: number }).id;
    this.timers.delete(id);
  };

  async advance(milliseconds: number) {
    const target = this.current + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort(([leftId, left], [rightId, right]) => left.due - right.due || leftId - rightId)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.current = timer.due;
      timer.callback();
      await this.flush();
    }
    this.current = target;
    await this.flush();
  }

  async flush() {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }
}

type MockCall = {
  at: number;
  url: string;
  title: string;
  tags: string;
  body: string;
};

const createRunner = (
  clock: FakeClock,
  calls: MockCall[],
  response: (callNumber: number) => Response = () => new Response("{}", { status: 200 }),
  errors: string[] = [],
  requestIntervalMs = 1
) => new NtfyNotificationRunner({
  url: "https://ntfy.example.test/codexhub",
  timeoutMs: 1_000,
  updateIntervalMs: 1,
  requestIntervalMs
}, {
  error: (message) => errors.push(message)
}, {
  now: clock.now,
  setTimeout: clock.setTimeout,
  clearTimeout: clock.clearTimeout,
  fetch: async (input, init) => {
    const headers = new Headers(init?.headers);
    const call: MockCall = {
      at: clock.now(),
      url: String(input),
      title: headers.get("Title") ?? "",
      tags: headers.get("Tags") ?? "",
      body: typeof init?.body === "string" ? init.body : String(init?.body ?? "")
    };
    calls.push(call);
    return response(calls.length);
  }
});

test("terminal notifications repeat with the same payload and stop at the fixed window", async () => {
  const terminalCases = [
    { type: "task_complete", extra: {}, status: "completed", tags: "white_check_mark", source: "web", title: "Terminal 0" },
    { type: "turn_aborted", extra: { status: "failed", reason: "failed" }, status: "failed", tags: "x", source: "cli", title: "Terminal 1" },
    { type: "turn_aborted", extra: { status: "interrupted", reason: "cancelled" }, status: "cancelled", tags: "stop_sign", source: "cli", title: "Terminal 2" }
  ] as const;

  for (const [index, terminalCase] of terminalCases.entries()) {
    const clock = new FakeClock();
    const calls: MockCall[] = [];
    const runner = createRunner(clock, calls);
    const turnId = `terminal-${index}`;
    const record = lifecycleRecord(terminalCase.type, turnId, terminalCase.extra);
    const thread = testThread(`thread-${index}`, undefined, terminalCase.source, terminalCase.title);

    runner.handleThreadEvent(lifecycleEvent(record, thread), [record]);
    await clock.flush();
    await clock.advance(50_000);
    const lateRunning = { ...thread, status: "running" as const, running: true, activeTurnId: turnId };
    const lateRecord = lifecycleRecord("agent_message", turnId);
    runner.handleThreadEvent(lifecycleEvent(lateRecord, lateRunning), [record, lateRecord]);
    runner.handleThreadEvent(lifecycleEvent(record, thread), [record]);
    await clock.advance(10_000);

    assert.equal(calls.length, 6, `${terminalCase.status} should publish once plus five repeats`);
    assert.ok(calls.every((call) => call.url === calls[0].url));
    assert.ok(calls.every((call) => call.title === calls[0].title));
    assert.ok(calls.every((call) => call.body === calls[0].body));
    assert.ok(calls.every((call) => call.tags === terminalCase.tags));
    assert.equal(calls[0].title, terminalCase.source === "cli" ? `[cli] ${terminalCase.title}` : terminalCase.title);
    assert.deepEqual(calls.map((call) => call.at), [0, 10_000, 20_000, 30_000, 40_000, 50_000]);
  }
});

test("a queued first repeat past the window is dropped while global pacing remains enforced", async () => {
  const clock = new FakeClock();
  const calls: MockCall[] = [];
  const runner = createRunner(clock, calls, undefined, [], 15_000);
  const record = lifecycleRecord("task_complete", "paced-terminal");
  const thread = testThread("paced-thread", undefined, "web", "Paced terminal");

  runner.handleThreadEvent(lifecycleEvent(record, thread), [record]);
  await clock.flush();
  await clock.advance(60_000);

  assert.deepEqual(calls.map((call) => call.at), [0, 15_000, 30_000, 45_000]);
  assert.ok(calls.every((call) => call.at < 60_000));
});

test("CLI and non-CLI lifecycle titles use only the explicit cli source", async () => {
  for (const source of ["cli", "web"] as const) {
    const clock = new FakeClock();
    const calls: MockCall[] = [];
    const runner = createRunner(clock, calls);
    const turnId = `${source}-lifecycle`;
    const started = lifecycleRecord("task_started", turnId);
    const waiting = lifecycleRecord("user_input_request", turnId, {
      userInput: { status: "pending" },
      isBlocking: true
    });
    const completed = lifecycleRecord("task_complete", turnId);
    const runningThread = testThread(`${source}-thread`, turnId, source, `${source} activity`);
    const idleThread = { ...runningThread, status: "idle" as const, running: false, activeTurnId: undefined };

    runner.handleThreadEvent(lifecycleEvent(started, runningThread), [started]);
    await clock.flush();
    runner.handleThreadEvent(lifecycleEvent(waiting, runningThread), [started, waiting]);
    await clock.advance(1);
    runner.handleThreadEvent(lifecycleEvent(completed, idleThread), [started, waiting, completed]);
    await clock.advance(1);
    await clock.flush();

    const expectedTitle = source === "cli" ? "[cli] cli activity" : "web activity";
    assert.deepEqual(calls.map((call) => call.title), [expectedTitle, expectedTitle, expectedTitle]);
    assert.match(calls[0].body, /运行中/);
    assert.match(calls[1].body, /等待输入/);
    assert.match(calls[2].body, /已完成/);
  }

  const unknownClock = new FakeClock();
  const unknownCalls: MockCall[] = [];
  const unknownRunner = createRunner(unknownClock, unknownCalls);
  const unknownTurnId = "unknown-lifecycle";
  const unknownStarted = lifecycleRecord("task_started", unknownTurnId);
  const unknownThread = testThread(
    "unknown-thread",
    unknownTurnId,
    undefined,
    "unknown activity"
  );
  unknownRunner.handleThreadEvent(lifecycleEvent(unknownStarted, unknownThread), [unknownStarted]);
  await unknownClock.flush();
  assert.equal(unknownCalls[0].title, "unknown activity");
});

test("terminal retries retain Retry-After recovery and permanent 4xx stops delivery", async () => {
  const clock = new FakeClock();
  const calls: MockCall[] = [];
  const errors: string[] = [];
  const runner = createRunner(
    clock,
    calls,
    (callNumber) => callNumber === 1
      ? new Response("busy", { status: 503, headers: { "retry-after": "0.025" } })
      : new Response("{}", { status: 200 }),
    errors,
    10
  );
  const record = lifecycleRecord("task_complete", "retry-terminal");
  const thread = testThread("retry-thread", undefined, "web", "Retry terminal");

  runner.handleThreadEvent(lifecycleEvent(record, thread), [record]);
  await clock.flush();
  await clock.advance(24);
  assert.equal(calls.length, 1);
  await clock.advance(1);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.at), [0, 25]);
  assert.equal(calls[0].url, calls[1].url);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /retrying in 25ms/);

  const lateRetryClock = new FakeClock();
  const lateRetryCalls: MockCall[] = [];
  const lateRetryErrors: string[] = [];
  const lateRetryRunner = createRunner(
    lateRetryClock,
    lateRetryCalls,
    (callNumber) => callNumber === 2
      ? new Response("busy", { status: 503, headers: { "retry-after": "70" } })
      : new Response("{}", { status: 200 }),
    lateRetryErrors
  );
  const lateRetryRecord = lifecycleRecord("task_complete", "late-retry-terminal");
  const lateRetryThread = testThread("late-retry-thread", undefined, "web", "Late retry");
  lateRetryRunner.handleThreadEvent(lifecycleEvent(lateRetryRecord, lateRetryThread), [lateRetryRecord]);
  await lateRetryClock.flush();
  await lateRetryClock.advance(10_000);
  await lateRetryClock.advance(70_000);

  assert.deepEqual(lateRetryCalls.map((call) => call.at), [0, 10_000, 80_000]);
  assert.equal(lateRetryCalls[0].url, lateRetryCalls[1].url);
  assert.equal(lateRetryCalls[1].url, lateRetryCalls[2].url);
  assert.equal(lateRetryCalls[0].body, lateRetryCalls[1].body);
  assert.equal(lateRetryCalls[1].body, lateRetryCalls[2].body);
  assert.equal(lateRetryErrors.length, 1);
  assert.match(lateRetryErrors[0], /retrying in 70000ms/);
  await lateRetryClock.advance(60_000);
  assert.equal(lateRetryCalls.length, 3);

  const permanentClock = new FakeClock();
  const permanentCalls: MockCall[] = [];
  const permanentErrors: string[] = [];
  const permanentRunner = createRunner(
    permanentClock,
    permanentCalls,
    () => new Response("forbidden", { status: 403 }),
    permanentErrors
  );
  const permanentRecord = lifecycleRecord("task_complete", "permanent-terminal");
  permanentRunner.handleThreadEvent(
    lifecycleEvent(permanentRecord, testThread("permanent-thread", undefined, "web", "Permanent")),
    [permanentRecord]
  );
  await permanentClock.flush();
  await permanentClock.advance(60_000);

  assert.equal(permanentCalls.length, 1);
  assert.equal(permanentErrors.length, 1);
  assert.doesNotMatch(permanentErrors[0], /retrying/);
});

function lifecycleRecord(
  type: string,
  turnId: string,
  extra: Record<string, unknown> = {}
): CodexRecord {
  return {
    id: `app:thread:${turnId}:${type}`,
    timestamp: "2026-09-09T00:00:00.000Z",
    type: "event_msg",
    payload: { type, turn_id: turnId, ...extra }
  };
}

function lifecycleEvent(record: CodexRecord, thread: ThreadSummary): ThreadStreamEvent {
  return {
    seq: 1,
    threadId: thread.threadId,
    kind: "record",
    thread,
    record
  };
}

function testThread(
  threadId: string,
  activeTurnId: string | undefined,
  source: ThreadInputSource | undefined,
  activityTitle: string
): ThreadSummary {
  return {
    threadId,
    workingDirectory: "/tmp/codexhub-notification-test",
    runtime: { machineId: "machine-test", online: true, runnable: true },
    status: activeTurnId ? "running" : "idle",
    running: Boolean(activeTurnId),
    ...(activeTurnId ? { activeTurnId, activeTurnStartedAt: "1970-01-01T00:00:00.000Z" } : {}),
    title: activityTitle,
    activityTitle,
    ...(source === undefined ? {} : { source }),
    updatedAt: "2026-09-09T00:00:00.000Z",
    messageCount: 1,
    threadUsage: emptyThreadUsage()
  };
}
