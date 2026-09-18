import assert from "node:assert/strict";
import test from "node:test";
import {
  readSurfaceUiStateRaw,
  writeSurfaceUiStateRaw,
  type UiStateStorage
} from "../src/web/helpers/surfaceUiStateStorage.js";

class MemoryStorage implements UiStateStorage {
  readonly values = new Map<string, string>();
  writes = 0;

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.writes += 1;
    this.values.set(key, value);
  }
}

test("surface UI state prefers the exact live-surface snapshot over its profile fallback", () => {
  const exact = new MemoryStorage();
  const profile = new MemoryStorage();
  exact.setItem("live", JSON.stringify({ activeTabThreadId: "thread-a" }));
  profile.setItem("profile", JSON.stringify({ activeTabThreadId: "thread-b" }));

  assert.equal(
    readSurfaceUiStateRaw([
      { storage: exact, key: "live" },
      { storage: profile, key: "profile" }
    ]),
    JSON.stringify({ activeTabThreadId: "thread-a" })
  );
});

test("surface UI state falls back to the stable profile and writes both layers", () => {
  const exact = new MemoryStorage();
  const profile = new MemoryStorage();
  profile.setItem("profile", "profile-state");
  const targets = [
    { storage: exact, key: "live" },
    { storage: profile, key: "profile" }
  ];

  assert.equal(readSurfaceUiStateRaw(targets), "profile-state");
  writeSurfaceUiStateRaw(targets, "next-state");
  assert.equal(exact.getItem("live"), "next-state");
  assert.equal(profile.getItem("profile"), "next-state");
});

test("Web tabs in one browser profile share one canonical state key", () => {
  const browserProfile = new MemoryStorage();
  const tabATarget = [{ storage: browserProfile, key: "web-surface" }];
  const tabBTarget = [{ storage: browserProfile, key: "web-surface" }];

  writeSurfaceUiStateRaw(tabATarget, "thread-a");
  assert.equal(readSurfaceUiStateRaw(tabBTarget), "thread-a");

  writeSurfaceUiStateRaw(tabBTarget, "thread-b");
  assert.equal(readSurfaceUiStateRaw(tabATarget), "thread-b");
});

test("different browser profiles keep independent Web surface states", () => {
  const browserA = new MemoryStorage();
  const browserB = new MemoryStorage();
  writeSurfaceUiStateRaw([{ storage: browserA, key: "web-surface" }], "thread-a");
  writeSurfaceUiStateRaw([{ storage: browserB, key: "web-surface" }], "thread-b");

  assert.equal(browserA.getItem("web-surface"), "thread-a");
  assert.equal(browserB.getItem("web-surface"), "thread-b");
});

test("embedded surface scopes in one profile keep independent exact snapshots", () => {
  const browserProfile = new MemoryStorage();
  const surfaceA = [{ storage: browserProfile, key: "surface:a" }];
  const surfaceB = [{ storage: browserProfile, key: "surface:b" }];

  writeSurfaceUiStateRaw(surfaceA, "thread-a");
  writeSurfaceUiStateRaw(surfaceB, "thread-b");

  assert.equal(readSurfaceUiStateRaw(surfaceA), "thread-a");
  assert.equal(readSurfaceUiStateRaw(surfaceB), "thread-b");
});

test("writing an unchanged surface snapshot is a no-op", () => {
  const storage = new MemoryStorage();
  const targets = [{ storage, key: "surface" }];
  writeSurfaceUiStateRaw(targets, "same");
  writeSurfaceUiStateRaw(targets, "same");

  assert.equal(storage.writes, 1);
});

test("an unavailable exact storage area does not block profile recovery", () => {
  const profile = new MemoryStorage();
  profile.setItem("profile", "profile-state");
  const unavailable: UiStateStorage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); }
  };

  assert.equal(readSurfaceUiStateRaw([
    { storage: unavailable, key: "live" },
    { storage: profile, key: "profile" }
  ]), "profile-state");
  writeSurfaceUiStateRaw([
    { storage: unavailable, key: "live" },
    { storage: profile, key: "profile" }
  ], "next-state");
  assert.equal(profile.getItem("profile"), "next-state");
});
