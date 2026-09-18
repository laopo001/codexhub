import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppFatalError } from "../src/web/AppErrorBoundary.js";

test("renderer failure fallback offers a frontend-only reload instead of a blank root", () => {
  const html = renderToStaticMarkup(createElement(AppFatalError, {
    message: "record projection failed",
    diagnostics: "diagnostic report",
    onReload: () => undefined
  }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Codex Hub could not render/);
  assert.match(html, /record projection failed/);
  assert.match(html, />Reload frontend</);
  assert.match(html, />Copy diagnostics</);
  assert.match(html, /without restarting your Codex sessions/);
});
