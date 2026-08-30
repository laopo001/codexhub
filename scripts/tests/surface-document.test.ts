import assert from "node:assert/strict";
import test from "node:test";
import { surfaceDocumentUsesPersistentState } from "../../src/web/helpers/surfaceDocument.js";

test("VS Code iframe and native Electron documents keep exact UI state across renderer reloads", () => {
  assert.equal(surfaceDocumentUsesPersistentState({
    surface: "vscode",
    nativeElectron: false,
    topLevel: false
  }), true);
  assert.equal(surfaceDocumentUsesPersistentState({
    surface: "electron",
    nativeElectron: true,
    topLevel: true
  }), true);
});

test("ordinary and Open in Browser documents keep exact UI state tab-local", () => {
  assert.equal(surfaceDocumentUsesPersistentState({
    surface: "default",
    nativeElectron: false,
    topLevel: true
  }), false);
  assert.equal(surfaceDocumentUsesPersistentState({
    surface: "vscode",
    nativeElectron: false,
    topLevel: true
  }), false);
  assert.equal(surfaceDocumentUsesPersistentState({
    surface: "electron",
    nativeElectron: false,
    topLevel: true
  }), false);
});
