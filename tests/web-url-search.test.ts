import assert from "node:assert/strict";
import test from "node:test";
import {
  codexHubSearchParams,
  normalizeCodexHubSearch
} from "../src/web/urlSearch.js";

test("CodexHub web query normalization accepts ordinary search parameters", () => {
  const raw = "?codexhub_token=secret&surface=vscode&workspacePath=%2Ftmp";
  assert.equal(normalizeCodexHubSearch(raw), raw);
  const params = codexHubSearchParams(raw);
  assert.equal(params.get("codexhub_token"), "secret");
  assert.equal(params.get("surface"), "vscode");
  assert.equal(params.get("workspacePath"), "/tmp");
});

test("CodexHub web query normalization decodes VSCode whole-query serialization", () => {
  const raw = "?codexhub_token%3Dsecret%26surface%3Dvscode%26workspacePath%3D%252Ftmp";
  const params = codexHubSearchParams(raw);
  assert.equal(params.get("codexhub_token"), "secret");
  assert.equal(params.get("surface"), "vscode");
  assert.equal(params.get("workspacePath"), "/tmp");
});

test("CodexHub web query normalization leaves unrelated malformed search intact", () => {
  const raw = "?unrelated%3Dbroken%ZZ";
  assert.equal(normalizeCodexHubSearch(raw), raw);
});
