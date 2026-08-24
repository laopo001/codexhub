import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  calculateDesktopPetUnionBounds,
  parsePetHitRegions,
  petHitRegionContainsPoint,
  petHitRegionsContainPoint,
  petHitRegionsContainScreenPoint,
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

test("screen-space pet hit testing uses the window origin on a secondary display", () => {
  assert.equal(petHitRegionsContainScreenPoint({
    cursorScreenPoint: { x: 3_244, y: 684 },
    windowBounds: { x: 0, y: 0, width: 5_120, height: 1_600 },
    hitRegions: [{ x: 3_181, y: 615, width: 126, height: 137 }],
    hitPadding: 12,
  }), true);
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

  // 5. Native mouse-down hold bridges the event-to-renderer drag-active IPC gap
  assert.equal(shouldDesktopPetBeInteractive({
    cursorScreenPoint: { x: 1000, y: 200 },
    windowBounds,
    hitRegions,
    isDragActive: false,
    inputHoldActive: true,
    hitPadding: 12,
  }), true);
});

test("Windows desktop pet establishes one physical coordinate space before creating windows", async () => {
  const source = await readFile(
    new URL("../../targets/electron/src/main.ts", import.meta.url),
    "utf8"
  );
  const forceScaleIndex = source.indexOf(
    'electronApp.commandLine.appendSwitch("force-device-scale-factor", "1")'
  );
  const singleInstanceIndex = source.indexOf("electronApp.requestSingleInstanceLock()");
  const showIndex = source.indexOf("petWindow.showInactive()");
  const repositionAfterShowIndex = source.indexOf("repositionDesktopPetWindow();", showIndex);
  const inputPollingAfterShowIndex = source.indexOf("startDesktopPetInputPolling();", showIndex);

  assert.ok(forceScaleIndex >= 0, "Windows Electron must disable mixed-DPI renderer coordinates");
  assert.ok(
    forceScaleIndex < singleInstanceIndex,
    "the device scale switch must be applied before Electron creates or attaches windows"
  );
  assert.ok(showIndex >= 0 && repositionAfterShowIndex > showIndex);
  assert.ok(
    repositionAfterShowIndex < inputPollingAfterShowIndex,
    "the first visible pet window must reapply virtual-desktop bounds before input polling"
  );
});
