import assert from "node:assert/strict";
import test from "node:test";
import { surfaceDocumentUsesPersistentState } from "../src/web/helpers/surfaceDocument.js";

test("ordinary Web, VS Code iframe, and native Electron keep persistent UI state", () => {
  assert.equal(surfaceDocumentUsesPersistentState({
    surface: "default",
    nativeElectron: false,
    topLevel: true
  }), true);
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

test("Open in Browser documents keep their exact renderer state tab-local", () => {
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
