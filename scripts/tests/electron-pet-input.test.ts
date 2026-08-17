import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePetHitRegions,
  petHitRegionContainsPoint,
  petHitRegionsContainPoint,
} from "../../src/shared/petInput.js";

test("pet hit regions accept finite non-negative DOM rectangles", () => {
  assert.deepEqual(parsePetHitRegions([
    { x: 20, y: 30, width: 126, height: 136 },
    { x: 4, y: 5, width: 200, height: 80 },
  ]), [
    { x: 20, y: 30, width: 126, height: 136 },
    { x: 4, y: 5, width: 200, height: 80 },
  ]);
  assert.equal(parsePetHitRegions([{ x: 0, y: 0, width: -1, height: 2 }]), null);
  assert.equal(parsePetHitRegions([{ x: 0, y: 0, width: Number.NaN, height: 2 }]), null);
  assert.equal(parsePetHitRegions("not-regions"), null);
  assert.equal(
    parsePetHitRegions(Array.from({ length: 9 }, () => ({ x: 0, y: 0, width: 1, height: 1 }))),
    null
  );
});

test("pet hit testing supports a small bridge between the pet and activity tray", () => {
  const button = { x: 100, y: 100, width: 126, height: 136 };
  const tray = { x: 100, y: 246, width: 300, height: 180 };
  assert.equal(petHitRegionContainsPoint({ x: 100, y: 100 }, button), true);
  assert.equal(petHitRegionContainsPoint({ x: 99, y: 100 }, button), false);
  assert.equal(petHitRegionContainsPoint({ x: 99, y: 100 }, button, 2), true);
  assert.equal(petHitRegionsContainPoint({ x: 100, y: 242 }, [button, tray], 4), true);
  assert.equal(petHitRegionsContainPoint({ x: 500, y: 500 }, [button, tray], 12), false);
});
