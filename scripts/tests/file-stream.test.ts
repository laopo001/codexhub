import assert from "node:assert/strict";
import test from "node:test";
import { FileStreamTicketStore } from "../../src/core/fileStreamTickets.js";
import { fileStreamFilename, parseFileByteRange } from "../../src/server/fileStreamRoutes.js";

test("file stream tickets expire, refresh on access, delete, and stay bounded", () => {
  let now = 1_000;
  const store = new FileStreamTicketStore({ ttlMs: 100, maxTickets: 2, now: () => now });
  const input = {
    machineId: "machine-test",
    path: "/tmp/video.mp4",
    size: 1000,
    modifiedAtMs: 900,
    contentType: "video/mp4" as const
  };
  const first = store.create(input);
  now = 1_050;
  assert.equal(store.get(first.ticketId)?.expiresAtMs, 1_150);
  now = 1_149;
  assert.equal(store.get(first.ticketId)?.ticketId, first.ticketId);
  now = 1_250;
  assert.equal(store.get(first.ticketId), null);

  const second = store.create({ ...input, path: "/tmp/second.mp4" });
  const third = store.create({ ...input, path: "/tmp/third.mp4" });
  const fourth = store.create({ ...input, path: "/tmp/fourth.mp4" });
  assert.equal(store.get(second.ticketId), null);
  assert.equal(store.get(third.ticketId)?.path, "/tmp/third.mp4");
  assert.equal(store.delete(fourth.ticketId), true);
  assert.equal(store.get(fourth.ticketId), null);
});

test("file byte ranges support full, bounded, open, and suffix requests", () => {
  assert.deepEqual(parseFileByteRange(undefined, 1000), { start: 0, end: 999, partial: false });
  assert.deepEqual(parseFileByteRange("bytes=0-99", 1000), { start: 0, end: 99, partial: true });
  assert.deepEqual(parseFileByteRange("bytes=900-", 1000), { start: 900, end: 999, partial: true });
  assert.deepEqual(parseFileByteRange("bytes=-100", 1000), { start: 900, end: 999, partial: true });
  assert.deepEqual(parseFileByteRange("bytes=900-2000", 1000), { start: 900, end: 999, partial: true });
});

test("file byte ranges reject malformed, multiple, reversed, and unsatisfied requests", () => {
  assert.equal(parseFileByteRange("items=0-10", 1000), null);
  assert.equal(parseFileByteRange("bytes=0-1,4-5", 1000), null);
  assert.equal(parseFileByteRange("bytes=100-99", 1000), null);
  assert.equal(parseFileByteRange("bytes=1000-", 1000), null);
  assert.equal(parseFileByteRange("bytes=-0", 1000), null);
  assert.equal(parseFileByteRange("bytes=-", 1000), null);
  assert.equal(parseFileByteRange(undefined, 0), null);
});

test("file stream response filenames never expose a remote absolute path", () => {
  assert.equal(fileStreamFilename("/home/user/videos/demo.mp4"), "demo.mp4");
  assert.equal(fileStreamFilename("D:\\music\\demo.mp3"), "demo.mp3");
  assert.equal(fileStreamFilename("/"), "media");
});
