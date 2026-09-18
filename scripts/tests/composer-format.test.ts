import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const loadComposerHelpers = async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "" } }
  });
  return import("../../src/web/helpers/composer.js");
};

test("selected code metadata stays outside the code fence", async () => {
  const { formatTextAttachmentReference } = await loadComposerHelpers();
  const text = [
    "File: config.toml:L2665-L2677",
    "Path: /home/laop/.codex/config.toml",
    "Language: toml",
    "",
    "[shell_environment_policy]",
    'inherit = "core"'
  ].join("\n");

  assert.equal(formatTextAttachmentReference(1, text), [
    "## Reference 1",
    "",
    "File: config.toml:L2665-L2677",
    "Path: /home/laop/.codex/config.toml",
    "Language: toml",
    "",
    "```",
    "[shell_environment_policy]",
    'inherit = "core"',
    "```"
  ].join("\n"));
});

test("uploaded text file metadata uses the same reference layout", async () => {
  const { formatTextAttachmentReference } = await loadComposerHelpers();

  assert.equal(formatTextAttachmentReference(2, "File: notes.txt\n\nhello"), [
    "## Reference 2",
    "",
    "File: notes.txt",
    "",
    "```",
    "hello",
    "```"
  ].join("\n"));
});

test("plain text and path-only attachments remain entirely fenced", async () => {
  const { formatTextAttachmentReference } = await loadComposerHelpers();

  assert.equal(
    formatTextAttachmentReference(1, "first paragraph\n\nsecond paragraph"),
    "## Reference 1\n\n```\nfirst paragraph\n\nsecond paragraph\n```"
  );
  assert.equal(
    formatTextAttachmentReference(2, "Path: /tmp/example.ts"),
    "## Reference 2\n\n```\nPath: /tmp/example.ts\n```"
  );
});

test("code fence length is calculated from the selected code body", async () => {
  const { formatTextAttachmentReference } = await loadComposerHelpers();

  assert.equal(
    formatTextAttachmentReference(1, "File: README.md\nLanguage: markdown\n\n```ts\nconst value = 1;\n```"),
    "## Reference 1\n\nFile: README.md\nLanguage: markdown\n\n````\n```ts\nconst value = 1;\n```\n````"
  );
});

test("pending user messages are immediately visible and included in composer history", async () => {
  const { pendingUserMessageViews, userMessageHistoryFromRecords } = await loadComposerHelpers();
  const pending = [{
    id: "web:pending:1",
    text: "queued prompt",
    imageUrls: [],
    createdAt: "2026-08-28T00:00:00.000Z"
  }];

  const views = pendingUserMessageViews(pending);
  assert.equal(views.length, 1);
  assert.equal(views[0].role, "user");
  assert.equal(views[0].text, "queued prompt");
  assert.equal(views[0].status, "pending");
  assert.equal(views[0].statusText, "queued");
  assert.equal(views[0].pendingUserMessage, true);
  assert.deepEqual(userMessageHistoryFromRecords([], pending), ["queued prompt"]);
});

test("queued user messages expose an explicit dismiss control", async () => {
  const { pendingUserMessageViews } = await loadComposerHelpers();
  const { MessageCard } = await import("../../src/web/helpers/components.js");
  const pending = {
    id: "web:pending:dismiss",
    text: "queued prompt",
    imageUrls: [],
    createdAt: "2026-08-28T00:00:00.000Z"
  };
  const message = pendingUserMessageViews([pending], [{
    submissionId: pending.id,
    text: pending.text,
    imageCount: 0,
    source: "web",
    createdAt: pending.createdAt,
    position: 1
  }])[0];
  assert.ok(message);
  assert.equal(message.queuedSubmissionId, pending.id);

  const markup = renderToStaticMarkup(createElement(MessageCard, {
    message,
    renderMode: "raw",
    markdownEnabled: false,
    onDismiss: () => undefined,
    dismissLabel: "Cancel queued message"
  }));

  assert.match(markup, /class="messageHeaderAction"/);
  assert.match(markup, /aria-label="Cancel queued message"/);
});
