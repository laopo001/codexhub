import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyThreadUsage } from "../../src/core/threadUsage.js";
import type { CodexRecord } from "../../src/shared/recordTypes.js";
import type { OpenThreadState } from "../../src/web/types.js";

const childThreadId = "019fc297-cc2c-7cc3-bccc-4dea01abcd42";

const loadSubagentThreadDialog = async () => {
  const browserGlobal = globalThis as unknown as { window?: { location: { search: string } } };
  browserGlobal.window ??= { location: { search: "" } };
  return import("../../src/web/SubagentThreadDialog.js");
};

const toolRecord = (id: string, name: string): CodexRecord => ({
  id: `app:${childThreadId}:turn-1:item:function_call:${id}`,
  type: "response_item",
  payload: {
    type: "function_call",
    call_id: id,
    name,
    arguments: "{}",
    status: "completed"
  }
});

const commentaryRecord = (id: string, message: string): CodexRecord => ({
  id: `app:${childThreadId}:turn-1:agent:${id}`,
  type: "event_msg",
  payload: { type: "agent_message", phase: "commentary", message }
});

const subagentThread = (records: CodexRecord[]): OpenThreadState => ({
  threadId: childThreadId,
  workingDirectory: "/projects/codexhub",
  runtime: { machineId: "machine-1", online: true, runnable: true },
  status: "idle",
  running: false,
  title: "Child thread",
  updatedAt: "2026-08-03T00:00:00.000Z",
  messageCount: records.length,
  threadUsage: emptyThreadUsage(),
  records,
  lastSeq: 0,
  composerMode: "chat",
  modelDraft: "",
  reasoningDraft: "auto",
  serviceTierDraft: "",
  approvalPolicyDraft: "auto",
  approvalsReviewerDraft: "auto",
  permissionProfileDraft: null,
  imageAttachments: [],
  textAttachments: []
});

test("subagent dialog exposes the complete child thread id as selectable text", async () => {
  const { SubagentThreadDialog } = await loadSubagentThreadDialog();
  const html = renderToStaticMarkup(createElement(SubagentThreadDialog, {
    dialog: {
      threadId: childThreadId,
      parentThreadId: "parent-thread",
      agentPath: "/root/readme_accuracy",
      workingDirectory: "/projects/codexhub",
      status: "loading",
      error: ""
    },
    onClose: () => undefined,
    onRetry: () => undefined
  }));

  assert.match(html, /class="subagentThreadDialogThreadId"/);
  assert.match(html, new RegExp(`<code title="Child thread ID: ${childThreadId}">${childThreadId}</code>`));
  assert.match(html.replace(/<[^>]+>/g, ""), new RegExp(`Child thread${childThreadId}`));
});

test("subagent compact views collapse and re-expand historical tool batches", async () => {
  const { subagentThreadDialogViews } = await loadSubagentThreadDialog();
  const toolA = toolRecord("tool-a", "exec_command");
  const toolB = toolRecord("tool-b", "apply_patch");
  const toolC = toolRecord("tool-c", "exec_command");
  const thread = subagentThread([
    commentaryRecord("before-tools", "First tool round"),
    toolA,
    toolB,
    commentaryRecord("between-tools", "Second tool round"),
    toolC
  ]);

  const collapsed = subagentThreadDialogViews(thread);
  const summary = collapsed.find((view) => view.toolBatch);
  assert.equal(summary?.toolBatch?.count, 2);
  assert.equal(collapsed.some((view) => view.id === toolA.id), false);
  assert.equal(collapsed.some((view) => view.id === toolB.id), false);
  assert.equal(collapsed.some((view) => view.id === toolC.id), true);

  assert.ok(summary?.toolBatch);
  const expanded = subagentThreadDialogViews(thread, new Set([summary.toolBatch.key]));
  assert.equal(expanded.find((view) => view.toolBatch)?.toolBatch?.expanded, true);
  assert.equal(expanded.some((view) => view.id === toolA.id), true);
  assert.equal(expanded.some((view) => view.id === toolB.id), true);
});

test("historical tool batch expansion survives prepending an older tool", async () => {
  const { subagentThreadDialogViews } = await loadSubagentThreadDialog();
  const toolA = toolRecord("tool-a", "exec_command");
  const toolB = toolRecord("tool-b", "apply_patch");
  const toolC = toolRecord("tool-c", "exec_command");
  const boundary = commentaryRecord("between-tools", "Second tool round");

  const beforePrepend = subagentThreadDialogViews(subagentThread([
    toolB,
    boundary,
    toolC
  ]));
  const originalBatch = beforePrepend.find((view) => view.toolBatch);
  assert.ok(originalBatch?.toolBatch);

  const afterPrepend = subagentThreadDialogViews(
    subagentThread([toolA, toolB, boundary, toolC]),
    new Set([originalBatch.toolBatch.key])
  );
  const prependedBatch = afterPrepend.find((view) => view.toolBatch);
  assert.equal(prependedBatch?.toolBatch?.key, originalBatch.toolBatch.key);
  assert.equal(prependedBatch?.toolBatch?.expanded, true);
  assert.equal(afterPrepend.some((view) => view.id === toolA.id), true);
  assert.equal(afterPrepend.some((view) => view.id === toolB.id), true);
});

const cssBlock = (css: string, selector: string) => {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  assert.ok(block, `missing CSS block for ${selector}`);
  return block;
};

const zIndex = (css: string, selector: string) => {
  const value = /z-index:\s*(\d+)/.exec(cssBlock(css, selector))?.[1];
  assert.ok(value, `missing z-index for ${selector}`);
  return Number(value);
};

test("subagent modal stacking stays above the responsive sidebar and below child overlays", async () => {
  const [modalsCss, responsiveCss] = await Promise.all([
    readFile(new URL("../../src/web/styles/modals.css", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/styles/responsive.css", import.meta.url), "utf8")
  ]);
  const sidebar = zIndex(responsiveCss, ".sidebar");
  const subagent = zIndex(modalsCss, ".subagentThreadDialogOverlay");

  assert.ok(subagent > sidebar);
  assert.ok(zIndex(modalsCss, ".sessionDialogOverlay") > subagent);
  assert.ok(zIndex(modalsCss, ".goalDialogOverlay") > subagent);
  assert.ok(zIndex(modalsCss, ".detailModalOverlay") > subagent);
  assert.ok(zIndex(modalsCss, ".imagePreviewOverlay") > subagent);
  assert.ok(zIndex(modalsCss, ".messageContextMenuLayer") > subagent);
  assert.match(cssBlock(modalsCss, ".subagentThreadDialogThreadId code"), /user-select:\s*all/);
});

test("child thread overlays consume Escape before the subagent dialog", async () => {
  const dialogsSource = await readFile(new URL("../../src/web/AppDialogs.tsx", import.meta.url), "utf8");

  assert.match(
    dialogsSource,
    /if \(!imagePreview && !inspectMessage && !goalDialog && !threadModelDialogOpen\) return undefined/
  );
  assert.match(dialogsSource, /event\.stopImmediatePropagation\(\)/);
  assert.match(dialogsSource, /else if \(goalDialog\) \{[\s\S]*?setGoalDialog\(null\)/);
  assert.match(dialogsSource, /else \{\s*setThreadModelDialogOpen\(false\)/);
});

test("thread model fields edit the target thread drafts and retain the default option", async () => {
  const [dialogsSource, selectorsSource, modalsCss, responsiveCss] = await Promise.all([
    readFile(new URL("../../src/web/AppDialogs.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/appSelectors.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/styles/modals.css", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/styles/responsive.css", import.meta.url), "utf8")
  ]);

  assert.match(dialogsSource, /value=\{threadModelDialogModelSelection\}/);
  assert.match(dialogsSource, /value=\{threadModelDialogReasoningSelection\}/);
  assert.match(dialogsSource, /value=\{threadModelDialogServiceTierSelection\}/);
  assert.match(dialogsSource, /<span>Response speed<\/span>/);
  assert.match(dialogsSource, /options=\{serviceTierOptions\.map/);
  assert.match(dialogsSource, /optionsWithoutAutoWhenResolved\(modelOptions, threadModelDialogModelSelection\)/);
  assert.match(dialogsSource, /optionsWithoutAutoWhenResolved\(reasoningOptions, threadModelDialogReasoningSelection\)/);
  assert.match(
    selectorsSource,
    /serviceTierOptionsForSelection\(\s*threadModelDialogServiceTierDraft,\s*activeModelCatalog,\s*threadModelDialogModelSelection/
  );
  assert.match(cssBlock(modalsCss, ".sessionDialog"), /max-height:\s*calc\(100svh - 48px\)/);
  assert.match(cssBlock(modalsCss, ".sessionDialog"), /overflow-y:\s*auto/);
  assert.match(responsiveCss, /\.projectPickerModal,\s*\.sessionDialog,\s*\.settingsDialog,/);
});

test("workspace and subagent model entries always bind the visible thread id", async () => {
  const [workspaceSource, subagentSource] = await Promise.all([
    readFile(new URL("../../src/web/WorkspaceThreadConversation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/SubagentThreadConversation.tsx", import.meta.url), "utf8")
  ]);

  assert.match(
    workspaceSource,
    /onThreadModelDialogChange=\{\(targetThreadId, open\) => \{[\s\S]*?openThreadModelDialog\(targetThreadId\)/
  );
  assert.match(
    subagentSource,
    /onThreadModelDialogChange=\{\(threadId, open\) => \{[\s\S]*?openThreadModelDialog\(threadId\)/
  );
});

test("workspace and subagent conversations share one thread body, status bar, and composer chrome", async () => {
  const [
    workspaceSource,
    subagentSource,
    conversationSource,
    chromeSource,
    viewSelectorSource,
    modalsCss
  ] = await Promise.all([
    readFile(new URL("../../src/web/WorkspaceThreadConversation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/SubagentThreadConversation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/ThreadConversation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/ThreadComposerChrome.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/appViewSelectors.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/styles/modals.css", import.meta.url), "utf8")
  ]);

  for (const source of [workspaceSource, subagentSource]) {
    assert.match(source, /<ThreadConversation/);
    assert.match(source, /<ThreadComposerLeftActions/);
    assert.match(source, /<ThreadComposerRightActions/);
    assert.match(source, /expandedStatusKeys=/);
    assert.match(source, /expandedStatusTurns=/);
    assert.doesNotMatch(source, /<ActivityStatusBar/);
  }
  assert.match(conversationSource, /<ActivityStatusBar/);
  assert.match(conversationSource, /className="messages"/);
  assert.match(conversationSource, /className="composer"/);
  assert.doesNotMatch(subagentSource, /messagesClassName|composerClassName|messageItemClassName/);
  assert.doesNotMatch(modalsCss, /\.subagentThread(?:Messages|Composer|MessageItem)/);
  assert.doesNotMatch(subagentSource, /composerModeOptions|Paperclip/);
  assert.match(chromeSource, /workspace\.reviewThread\(thread\.threadId\)/);
  assert.match(chromeSource, /workspace\.setThreadApprovalPolicyDraft\(thread\.threadId/);
  assert.match(chromeSource, /workspace\.setThreadPermissionProfileDraft\(thread\.threadId/);
  assert.match(chromeSource, /workspace\.renderComposerThreadControls\(thread, "inline"/);
  assert.match(viewSelectorSource, /renderComposerThreadControls = \(\s*thread: OpenThreadState/);
  assert.match(viewSelectorSource, /openThreadModelDialog\(thread\.threadId\)/);
  assert.match(viewSelectorSource, /compactThread\(thread\.threadId\)/);
});

test("message image preview keeps markdown component identities stable across parent state updates", async () => {
  const [workspaceSource, subagentSource, conversationSource, componentsSource] = await Promise.all([
    readFile(new URL("../../src/web/WorkspaceThreadConversation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/SubagentThreadConversation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/ThreadConversation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/helpers/components.tsx", import.meta.url), "utf8")
  ]);

  assert.match(workspaceSource, /onOpenImage=\{setImagePreview\}/);
  assert.match(subagentSource, /onOpenImage=\{workspace\.setImagePreview\}/);
  assert.match(conversationSource, /onOpenImage\?: \(image: ImagePreviewState\) => void;/);
  assert.match(conversationSource, /onOpenImage=\{onOpenImage\}/);
  assert.doesNotMatch(conversationSource, /onOpenImage=\{onOpenImage \? \(image\)/);
  assert.match(componentsSource, /export const markdownComponents: Components = \{/);
  assert.match(componentsSource, /<MarkdownInteractionContext\.Provider value=\{markdownInteraction\}>/);
  assert.doesNotMatch(componentsSource, /markdownComponents\(threadWorkingDirectory,/);
});

test("mouse selection opens a compact toolbar while messages keep the native context menu", async () => {
  const [actionsSource, componentsSource, conversationSource, dialogsSource, modalsCss] = await Promise.all([
    readFile(new URL("../../src/web/appActions/composerActions.ts", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/helpers/components.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/ThreadConversation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/AppDialogs.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/web/styles/modals.css", import.meta.url), "utf8")
  ]);

  assert.match(componentsSource, /onMouseUp=\{onSelectionMenu\}/);
  assert.doesNotMatch(componentsSource, /onContextMenu=\{onContextMenu\}/);
  assert.doesNotMatch(conversationSource, /onContextMenu=\{onMessage/);
  assert.doesNotMatch(actionsSource, /contextMenuPosition|MessageContextMenuState|presentation === "contextMenu"/);
  assert.match(actionsSource, /const openMessageSelectionToolbar = \(/);
  assert.match(actionsSource, /window\.requestAnimationFrame\(\(\) => \{/);
  assert.match(dialogsSource, /className="messageContextMenuLayer selectionToolbarLayer"/);
  assert.doesNotMatch(dialogsSource, /messageSelectionToolbar\.canInspect|inspectContextMessage/);
  assert.match(cssBlock(modalsCss, ".messageContextMenuLayer.selectionToolbarLayer"), /pointer-events:\s*none/);
  assert.match(
    cssBlock(modalsCss, ".messageContextMenuLayer.selectionToolbarLayer .messageContextMenu"),
    /pointer-events:\s*auto/
  );
  assert.match(cssBlock(modalsCss, ".messageContextMenu.selectionToolbar"), /display:\s*flex/);
  assert.match(cssBlock(modalsCss, ".messageContextMenu.selectionToolbar"), /min-width:\s*0/);
});
