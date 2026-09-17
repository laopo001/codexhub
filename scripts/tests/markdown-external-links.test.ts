import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildWebviewBridgeScript } from "../../targets/vscode/src/webviewBridge.js";
import { httpUrlFromValue } from "../../src/shared/externalUrl.js";
import { MessageText } from "../../src/web/helpers/components.js";

test("HTTP(S) external URL validation rejects non-web protocols", () => {
  assert.equal(httpUrlFromValue("https://example.test/docs"), "https://example.test/docs");
  assert.equal(httpUrlFromValue(" http://example.test/path?q=1 "), "http://example.test/path?q=1");
  assert.equal(httpUrlFromValue("javascript:alert(1)"), null);
  assert.equal(httpUrlFromValue("file:///tmp/notes.md"), null);
  assert.equal(httpUrlFromValue("mailto:user@example.test"), null);
  assert.equal(httpUrlFromValue("not a URL"), null);
  assert.equal(httpUrlFromValue({ url: "https://example.test" }), null);
});

test("Web Markdown HTTP(S) links expose an action menu and safe new-tab fallback", () => {
  const markup = renderToStaticMarkup(createElement(MessageText, {
    text: "[Documentation](https://example.test/docs)",
    mode: "markdown",
    markdownEnabled: true
  }));

  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /href="https:\/\/example\.test\/docs"/);
  assert.match(markup, /target="_blank"/);
  assert.match(markup, /rel="noopener noreferrer"/);
});

test("Markdown local file links expose the same action menu without external navigation", () => {
  const markup = renderToStaticMarkup(createElement(MessageText, {
    text: "[Notes](/tmp/notes.md:12:3)",
    mode: "markdown",
    markdownEnabled: true
  }));

  assert.match(markup, /class="[^"]*\blocalFileLink\b[^"]*"/);
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /href="\/tmp\/notes\.md:12:3"/);
  assert.doesNotMatch(markup, /target="_blank"/);
  assert.doesNotMatch(markup, /rel="noopener noreferrer"/);
});

test("Markdown local file links display decoded non-ASCII paths", () => {
  const path = "/tmp/特黄会谈AI危机-v1.mp4";
  const encodedPath = encodeURI(path);
  const markup = renderToStaticMarkup(createElement(MessageText, {
    text: `已导出：[${encodedPath}](${encodedPath})`,
    mode: "markdown",
    markdownEnabled: true
  }));

  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(markup, new RegExp(`>${escapedPath}</a>`));
  assert.match(markup, /href="[^"]*%E[0-9A-F]/i);
});

test("VS Code webview bridge forwards only same-origin HTTP(S) external links", () => {
  const handlers = new Map<string, (event: { data: unknown; source: unknown; origin: string }) => void>();
  const vscodeMessages: unknown[] = [];
  const frameWindow = {};
  const frame = {
    contentWindow: frameWindow,
    addEventListener: () => undefined
  };
  const context = {
    URL,
    acquireVsCodeApi: () => ({ postMessage: (value: unknown) => vscodeMessages.push(value) }),
    document: { getElementById: () => frame },
    window: { addEventListener: (type: string, handler: (event: { data: unknown; source: unknown; origin: string }) => void) => handlers.set(type, handler) }
  };
  vm.runInNewContext(buildWebviewBridgeScript("https://codexhub.test"), context);
  const dispatch = (data: unknown, origin = "https://codexhub.test", source: unknown = frameWindow) => {
    handlers.get("message")?.({ data, origin, source });
  };
  const serializableMessages = () => JSON.parse(JSON.stringify(vscodeMessages));

  dispatch({ type: "codexhub.openExternal", url: "https://example.test/docs" });
  assert.deepEqual(serializableMessages(), [{ type: "codexhub.openExternal", url: "https://example.test/docs" }]);

  dispatch({ type: "codexhub.openExternal", url: "javascript:alert(1)" });
  dispatch({ type: "codexhub.openExternal", url: "file:///tmp/notes.md" });
  dispatch({ type: "codexhub.openExternal", url: "https://evil.test" }, "https://other-origin.test");
  dispatch({ type: "codexhub.openExternal", url: "https://evil.test" }, "https://codexhub.test", {});
  assert.deepEqual(serializableMessages(), [{ type: "codexhub.openExternal", url: "https://example.test/docs" }]);
});

test("host consumers validate external URLs before using the operating system", async () => {
  const [extension, electron] = await Promise.all([
    readFile(new URL("../../targets/vscode/src/extension.ts", import.meta.url), "utf8"),
    readFile(new URL("../../targets/electron/src/main.ts", import.meta.url), "utf8")
  ]);

  assert.match(extension, /record\?\.type === "codexhub\.openExternal"/);
  assert.match(extension, /httpUrlFromValue\(record\.url\)/);
  assert.match(extension, /vscode\.env\.openExternal\(vscode\.Uri\.parse\(url\)\)/);
  assert.match(electron, /const externalUrl = httpUrlFromValue\(url\)/);
  assert.match(electron, /if \(externalUrl\) void shell\.openExternal\(externalUrl\)/);
});
