import assert from "node:assert/strict";
import test from "node:test";
import { enqueueActiveTelegramMirrorTask } from "../../plugins/telegram/bot.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const assertQueuedTaskIsDroppedAfter = async (
  invalidate: (state: { controller: AbortController; replaceMirror: () => void }) => void
) => {
  const previousForward = deferred();
  const controller = new AbortController();
  const mirror = {};
  let currentMirror: object | undefined = mirror;
  let forwarded = false;
  const errors: unknown[] = [];

  const queue = enqueueActiveTelegramMirrorTask(
    previousForward.promise,
    () => !controller.signal.aborted && currentMirror === mirror,
    async () => {
      forwarded = true;
    },
    (error) => errors.push(error)
  );

  invalidate({
    controller,
    replaceMirror: () => {
      currentMirror = {};
    }
  });
  previousForward.resolve();
  await queue;

  assert.equal(forwarded, false);
  assert.deepEqual(errors, []);
};

test("telegram mirror drops queued records after detach aborts the binding", async () => {
  await assertQueuedTaskIsDroppedAfter(({ controller }) => controller.abort());
});

test("telegram mirror drops queued records after a thread switch replaces the binding", async () => {
  await assertQueuedTaskIsDroppedAfter(({ replaceMirror }) => replaceMirror());
});

test("telegram mirror forwards a queued record while the binding remains active", async () => {
  let forwarded = false;
  const errors: unknown[] = [];

  await enqueueActiveTelegramMirrorTask(
    Promise.resolve(),
    () => true,
    async () => {
      forwarded = true;
    },
    (error) => errors.push(error)
  );

  assert.equal(forwarded, true);
  assert.deepEqual(errors, []);
});
