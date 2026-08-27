import assert from "node:assert/strict";
import test from "node:test";
import { hostManagesSurfaceDocument } from "../../src/web/helpers/surfaceDocument.js";

test("only the VS Code iframe and native Electron document delegate reload to their hosts", () => {
  assert.equal(hostManagesSurfaceDocument({
    surface: "vscode",
    nativeElectron: false,
    topLevel: false
  }), true);
  assert.equal(hostManagesSurfaceDocument({
    surface: "electron",
    nativeElectron: true,
    topLevel: true
  }), true);
});

test("ordinary and Open in Browser documents own authority replacement reload", () => {
  assert.equal(hostManagesSurfaceDocument({
    surface: "default",
    nativeElectron: false,
    topLevel: true
  }), false);
  assert.equal(hostManagesSurfaceDocument({
    surface: "vscode",
    nativeElectron: false,
    topLevel: true
  }), false);
  assert.equal(hostManagesSurfaceDocument({
    surface: "electron",
    nativeElectron: false,
    topLevel: true
  }), false);
});
