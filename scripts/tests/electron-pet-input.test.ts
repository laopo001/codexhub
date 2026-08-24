import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateDesktopPetUnionBounds,
  parsePetHitRegions,
  petHitRegionContainsPoint,
  petHitRegionsContainPoint,
  screenPointToWindowLocalPoint,
  shouldDesktopPetBeInteractive,
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

test("calculateDesktopPetUnionBounds spans all monitors including negative coordinates", () => {
  const primaryDisplay = { x: 0, y: 0, width: 1920, height: 1080 };
  const leftSecondaryDisplay = { x: -1920, y: 0, width: 1920, height: 1080 };
  const rightSecondaryDisplay = { x: 1920, y: 0, width: 2560, height: 1440 };
  const topSecondaryDisplay = { x: 0, y: -1080, width: 1920, height: 1080 };

  // Fallback when no display is reported
  assert.deepEqual(
    calculateDesktopPetUnionBounds([], primaryDisplay),
    { x: 0, y: 0, width: 1920, height: 1080 }
  );

  // Single display
  assert.deepEqual(
    calculateDesktopPetUnionBounds([primaryDisplay]),
    { x: 0, y: 0, width: 1920, height: 1080 }
  );

  // Dual display with secondary monitor on the left (negative x)
  assert.deepEqual(
    calculateDesktopPetUnionBounds([leftSecondaryDisplay, primaryDisplay]),
    { x: -1920, y: 0, width: 3840, height: 1080 }
  );

  // Dual display with secondary monitor on top (negative y)
  assert.deepEqual(
    calculateDesktopPetUnionBounds([topSecondaryDisplay, primaryDisplay]),
    { x: 0, y: -1080, width: 1920, height: 2160 }
  );

  // Triple display with different resolutions
  assert.deepEqual(
    calculateDesktopPetUnionBounds([leftSecondaryDisplay, primaryDisplay, rightSecondaryDisplay]),
    { x: -1920, y: 0, width: 6400, height: 1440 }
  );
});

test("screenPointToWindowLocalPoint converts global cursor coordinates to local window space", () => {
  const unionBounds = { x: -1920, y: -200, width: 3840, height: 1280 };
  assert.deepEqual(
    screenPointToWindowLocalPoint({ x: -1920, y: -200 }, unionBounds),
    { x: 0, y: 0 }
  );
  assert.deepEqual(
    screenPointToWindowLocalPoint({ x: 0, y: 0 }, unionBounds),
    { x: 1920, y: 200 }
  );
  assert.deepEqual(
    screenPointToWindowLocalPoint({ x: -960, y: 500 }, unionBounds),
    { x: 960, y: 700 }
  );
});

test("shouldDesktopPetBeInteractive decides hit testing across secondary displays and drag states", () => {
  const windowBounds = { x: -1920, y: 0, width: 3840, height: 1080 };
  // Desktop pet moved to the secondary display on the left (local x: 960, y: 540)
  const hitRegions = [{ x: 960, y: 540, width: 126, height: 136 }];

  // 1. Cursor is directly over the pet on the secondary monitor (screen x: -960, y: 540)
  assert.equal(shouldDesktopPetBeInteractive({
    cursorScreenPoint: { x: -960, y: 540 },
    windowBounds,
    hitRegions,
    isDragActive: false,
    hitPadding: 12,
  }), true);

  // 2. Cursor is slightly outside but within the 12px padding on secondary monitor
  assert.equal(shouldDesktopPetBeInteractive({
    cursorScreenPoint: { x: -970, y: 540 },
    windowBounds,
    hitRegions,
    isDragActive: false,
    hitPadding: 12,
  }), true);

  // 3. Cursor is outside hit regions on secondary monitor -> non-interactive (pass-through)
  assert.equal(shouldDesktopPetBeInteractive({
    cursorScreenPoint: { x: -500, y: 200 },
    windowBounds,
    hitRegions,
    isDragActive: false,
    hitPadding: 12,
  }), false);

  // 4. While drag is active, it must remain interactive everywhere even across monitors
  assert.equal(shouldDesktopPetBeInteractive({
    cursorScreenPoint: { x: 1000, y: 200 }, // Over primary display far away
    windowBounds,
    hitRegions,
    isDragActive: true,
    hitPadding: 12,
  }), true);
});
