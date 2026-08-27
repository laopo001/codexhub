import assert from "node:assert/strict";
import test from "node:test";
import {
  readSurfaceUiStateRaw,
  writeSurfaceUiStateRaw,
  type UiStateStorage
} from "../../src/web/helpers/surfaceUiStateStorage.js";

class MemoryStorage implements UiStateStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
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

test("independent Web tab storage areas keep exact active threads isolated", () => {
  const tabA = new MemoryStorage();
  const tabB = new MemoryStorage();
  const profile = new MemoryStorage();

  writeSurfaceUiStateRaw([
    { storage: tabA, key: "web-tab" },
    { storage: profile, key: "web-profile" }
  ], "thread-a");
  writeSurfaceUiStateRaw([
    { storage: tabB, key: "web-tab" },
    { storage: profile, key: "web-profile" }
  ], "thread-b");

  assert.equal(readSurfaceUiStateRaw([{ storage: tabA, key: "web-tab" }]), "thread-a");
  assert.equal(readSurfaceUiStateRaw([{ storage: tabB, key: "web-tab" }]), "thread-b");
  assert.equal(profile.getItem("web-profile"), "thread-b");
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
