import assert from "node:assert/strict";
import test from "node:test";
import { initAuthTokenFromUrl } from "../src/web/helpers/core.js";

const stored = new Map<string, string>();
let replacedUrl = "";

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    location: {
      href: "http://codexhub.test/?codexhub_token%3Dautomatic-secret%26surface%3Dvscode%26workspacePath%3D%252Ftmp"
    },
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key)
    },
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, url: URL) => {
        replacedUrl = url.toString();
      }
    }
  }
});

test("VSCode whole-query token is consumed automatically and removed from the visible URL", () => {
  assert.equal(initAuthTokenFromUrl(), "automatic-secret");
  assert.equal(stored.get("codexhub.authToken"), "automatic-secret");
  assert.equal(replacedUrl.includes("automatic-secret"), false);
  const replaced = new URL(replacedUrl);
  assert.equal(replaced.searchParams.get("surface"), "vscode");
  assert.equal(replaced.searchParams.get("workspacePath"), "/tmp");
});
