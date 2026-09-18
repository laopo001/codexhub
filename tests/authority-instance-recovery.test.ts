import assert from "node:assert/strict";
import test from "node:test";
import { AuthorityInstanceRecoveryController } from "../src/web/helpers/authorityInstanceRecovery.js";

test("authority recovery keeps a same-instance realtime reconnect in place", async () => {
  const controller = new AuthorityInstanceRecoveryController();
  let reloads = 0;
  controller.accept("instance-a");

  assert.equal(await controller.checkAfterReconnect(
    async () => ({ serverInstanceId: "instance-a" }),
    () => { reloads += 1; }
  ), false);
  assert.equal(reloads, 0);
});

test("authority recovery reloads once when the server instance changes", async () => {
  const controller = new AuthorityInstanceRecoveryController();
  let reloads = 0;
  controller.accept("instance-a");

  assert.equal(await controller.checkAfterReconnect(
    async () => ({ serverInstanceId: "instance-b" }),
    () => { reloads += 1; }
  ), true);
  assert.equal(await controller.checkAfterReconnect(
    async () => ({ serverInstanceId: "instance-c" }),
    () => { reloads += 1; }
  ), false);
  assert.equal(reloads, 1);
});

test("authority recovery coalesces concurrent reconnect health checks", async () => {
  const controller = new AuthorityInstanceRecoveryController();
  let reads = 0;
  let release: (() => void) | undefined;
  controller.accept("instance-a");
  const readHealth = async () => {
    reads += 1;
    await new Promise<void>((resolve) => { release = resolve; });
    return { serverInstanceId: "instance-b" };
  };
  let reloads = 0;

  const first = controller.checkAfterReconnect(readHealth, () => { reloads += 1; });
  const second = controller.checkAfterReconnect(readHealth, () => { reloads += 1; });
  release?.();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(reads, 1);
  assert.equal(reloads, 1);
});
