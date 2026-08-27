import assert from "node:assert/strict";
import test from "node:test";
import { VscodeWebviewHtmlController } from "../../targets/vscode/src/webviewHtmlController.js";

test("VscodeWebviewHtmlController deduplicates ordinary renders with the same key", () => {
  const writtenHtmls: string[] = [];
  const controller = new VscodeWebviewHtmlController((html) => writtenHtmls.push(html));

  // 第一次普通 render：正常写入
  assert.equal(controller.update("iframe:http://127.0.0.1:28789/?surface=vscode", "<html>iframe-1</html>"), true);
  assert.equal(controller.currentKey, "iframe:http://127.0.0.1:28789/?surface=vscode");
  assert.deepEqual(writtenHtmls, ["<html>iframe-1</html>"]);

  // 第二次普通 render 且 URL 相同：去重跳过
  assert.equal(controller.update("iframe:http://127.0.0.1:28789/?surface=vscode", "<html>iframe-1-dup</html>"), false);
  assert.deepEqual(writtenHtmls, ["<html>iframe-1</html>"]);
});

test("VscodeWebviewHtmlController forces HTML reload after explicit refresh or authority recovery", () => {
  const writtenHtmls: string[] = [];
  const controller = new VscodeWebviewHtmlController((html) => writtenHtmls.push(html));

  controller.update("iframe:http://127.0.0.1:28789/?surface=vscode", "<html>iframe-1</html>");
  assert.deepEqual(writtenHtmls, ["<html>iframe-1</html>"]);

  // 用户主动 Refresh 或宿主确认 authority 恢复后（force: true），即使
  // stable authority URL 没变，也必须换掉旧 iframe document。
  assert.equal(controller.update("iframe:http://127.0.0.1:28789/?surface=vscode", "<html>iframe-1-refreshed</html>", true), true);
  assert.deepEqual(writtenHtmls, ["<html>iframe-1</html>", "<html>iframe-1-refreshed</html>"]);
});

test("VscodeWebviewHtmlController preserves iframe on an ordinary render when URL is unchanged", () => {
  const writtenHtmls: string[] = [];
  const controller = new VscodeWebviewHtmlController((html) => writtenHtmls.push(html));

  controller.update("iframe:http://127.0.0.1:28789/?surface=vscode&workspacePath=/repo", "<html>iframe-repo</html>");
  assert.equal(writtenHtmls.length, 1);

  // 普通 render：相同 key 不重载 iframe。真正的 authority recovery
  // 由宿主显式传 force=true，与普通 heartbeat 更新分开。
  const updated = controller.update("iframe:http://127.0.0.1:28789/?surface=vscode&workspacePath=/repo", "<html>iframe-repo-heartbeat</html>", false);
  assert.equal(updated, false);
  assert.equal(writtenHtmls.length, 1);
});

test("VscodeWebviewHtmlController updates HTML when workspace or authority URL changes", () => {
  const writtenHtmls: string[] = [];
  const controller = new VscodeWebviewHtmlController((html) => writtenHtmls.push(html));

  controller.update("iframe:http://127.0.0.1:28789/?surface=vscode&workspacePath=/repo-a", "<html>iframe-a</html>");
  assert.deepEqual(writtenHtmls, ["<html>iframe-a</html>"]);

  // 切换工作区：key 改变，正常写入
  const updated = controller.update("iframe:http://127.0.0.1:28789/?surface=vscode&workspacePath=/repo-b", "<html>iframe-b</html>");
  assert.equal(updated, true);
  assert.deepEqual(writtenHtmls, ["<html>iframe-a</html>", "<html>iframe-b</html>"]);
});

test("VscodeWebviewHtmlController allows re-rendering after reset", () => {
  const writtenHtmls: string[] = [];
  const controller = new VscodeWebviewHtmlController((html) => writtenHtmls.push(html));

  controller.update("iframe:http://127.0.0.1:28789/?surface=vscode", "<html>iframe-1</html>");
  assert.equal(controller.currentKey, "iframe:http://127.0.0.1:28789/?surface=vscode");

  controller.reset();
  assert.equal(controller.currentKey, null);

  assert.equal(controller.update("iframe:http://127.0.0.1:28789/?surface=vscode", "<html>iframe-1-reopened</html>"), true);
  assert.deepEqual(writtenHtmls, ["<html>iframe-1</html>", "<html>iframe-1-reopened</html>"]);
});
