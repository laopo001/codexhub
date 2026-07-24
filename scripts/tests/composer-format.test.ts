import assert from "node:assert/strict";
import test from "node:test";

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
