import assert from "node:assert/strict";
import test from "node:test";
import { VscodeWebviewHtmlController } from "../../targets/vscode/src/webviewHtmlController.js";
import { vscodeWorkspaceStateScope } from "../../targets/vscode/src/workspaceStateScope.js";
import {
  normalizeVscodeWorkspaceIdentity,
  workspaceFileForAuthorityRegistration
} from "../../src/shared/surfaceTypes.js";
import { vscodeUiStateStorageKey, webUiStateStorageKey } from "../../src/web/appConfig.js";

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

test("VscodeWebviewHtmlController forces HTML reload after explicit refresh", () => {
  const writtenHtmls: string[] = [];
  const controller = new VscodeWebviewHtmlController((html) => writtenHtmls.push(html));

  controller.update("iframe:http://127.0.0.1:28789/?surface=vscode", "<html>iframe-1</html>");
  assert.deepEqual(writtenHtmls, ["<html>iframe-1</html>"]);

  // 用户主动 Refresh（force: true）时，即使 stable authority URL
  // 没变，也必须换掉旧 iframe document。
  assert.equal(controller.update("iframe:http://127.0.0.1:28789/?surface=vscode", "<html>iframe-1-refreshed</html>", true), true);
  assert.deepEqual(writtenHtmls, ["<html>iframe-1</html>", "<html>iframe-1-refreshed</html>"]);
});

test("VscodeWebviewHtmlController preserves iframe on an ordinary render when URL is unchanged", () => {
  const writtenHtmls: string[] = [];
  const controller = new VscodeWebviewHtmlController((html) => writtenHtmls.push(html));

  controller.update("iframe:http://127.0.0.1:28789/?surface=vscode&workspacePath=/repo", "<html>iframe-repo</html>");
  assert.equal(writtenHtmls.length, 1);

  // 普通 render：相同 key 不重载 iframe。Authority replacement 由
  // iframe 内的 Web app 在 realtime 重连后比较 serverInstanceId 并自行 reload。
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

test("normalizeVscodeWorkspaceIdentity and vscodeWorkspaceStateScope prioritize workspaceFile without mixing folders", () => {
  const workspaceFile = "/home/laop/projects/codexhub/team.code-workspace";
  const folders1 = [{ path: "/home/laop/projects/codexhub" }];
  const folders2 = [{ path: "/home/laop/projects/codexhub" }, { path: "/home/laop/projects/sdk" }];
  const folders3 = [{ path: "/home/laop/projects/codexhub" }, { path: "/home/laop/projects/sdk" }, { path: "/home/laop/projects/docs" }];

  // 1. Saved workspace identity remains constant when adding or removing folders
  const identity1 = normalizeVscodeWorkspaceIdentity(workspaceFile, folders1);
  const identity2 = normalizeVscodeWorkspaceIdentity(workspaceFile, folders2);
  const identity3 = normalizeVscodeWorkspaceIdentity(workspaceFile, folders3);
  assert.equal(identity1, "workspace-file:/home/laop/projects/codexhub/team.code-workspace");
  assert.equal(identity1, identity2);
  assert.equal(identity2, identity3);

  const scope1 = vscodeWorkspaceStateScope(folders1, workspaceFile);
  const scope2 = vscodeWorkspaceStateScope(folders2, workspaceFile);
  const scope3 = vscodeWorkspaceStateScope(folders3, workspaceFile);
  assert.equal(scope1, scope2);
  assert.equal(scope2, scope3);

  // 2. Different workspaceFiles with identical folders produce distinct identities and scopes
  const workspaceFileA = "/home/laop/projects/backend.code-workspace";
  const workspaceFileB = "/home/laop/projects/frontend.code-workspace";
  assert.notEqual(
    normalizeVscodeWorkspaceIdentity(workspaceFileA, folders1),
    normalizeVscodeWorkspaceIdentity(workspaceFileB, folders1)
  );
  assert.notEqual(
    vscodeWorkspaceStateScope(folders1, workspaceFileA),
    vscodeWorkspaceStateScope(folders1, workspaceFileB)
  );

  // 3. Single folder fallback: folder A vs folder B produce distinct identities and scopes
  const folderA = [{ path: "/home/laop/projects/repo-a" }];
  const folderB = [{ path: "/home/laop/projects/repo-b" }];
  assert.equal(normalizeVscodeWorkspaceIdentity(undefined, folderA), "workspace-folder:/home/laop/projects/repo-a");
  assert.equal(normalizeVscodeWorkspaceIdentity(undefined, folderB), "workspace-folder:/home/laop/projects/repo-b");
  assert.notEqual(vscodeWorkspaceStateScope(folderA), vscodeWorkspaceStateScope(folderB));

  // 4. Untitled workspace identity is stable and distinct per untitled URI
  const untitledUri1 = { scheme: "untitled", path: "Untitled-1.code-workspace" };
  const untitledUri2 = { scheme: "untitled", path: "Untitled-2.code-workspace" };
  assert.equal(normalizeVscodeWorkspaceIdentity(untitledUri1, folders1), "workspace-untitled:Untitled-1.code-workspace");
  assert.equal(
    normalizeVscodeWorkspaceIdentity(untitledUri1, folders1),
    normalizeVscodeWorkspaceIdentity(untitledUri1, folders2)
  );
  assert.notEqual(
    normalizeVscodeWorkspaceIdentity(untitledUri1, folders1),
    normalizeVscodeWorkspaceIdentity(untitledUri2, folders1)
  );

  // 5. Folder order does not affect fallback identity
  const order1 = [{ path: "/home/laop/projects/b" }, { path: "/home/laop/projects/a" }];
  const order2 = [{ path: "/home/laop/projects/a" }, { path: "/home/laop/projects/b" }];
  assert.equal(
    normalizeVscodeWorkspaceIdentity(undefined, order1),
    normalizeVscodeWorkspaceIdentity(undefined, order2)
  );
  assert.equal(vscodeWorkspaceStateScope(order1), vscodeWorkspaceStateScope(order2));

  // 6. Stable and Insiders share the same workspace identity and stateScope (channel is not an input)
  const stableScope = vscodeWorkspaceStateScope(folders1, workspaceFile);
  const insidersScope = vscodeWorkspaceStateScope(folders1, workspaceFile);
  assert.equal(stableScope, insidersScope);

  // 7. Remote workspace identity preserves scheme, authority, and path
  const remoteUri = {
    scheme: "vscode-remote",
    authority: "wsl+Ubuntu",
    path: "/home/laop/projects/codexhub/team.code-workspace"
  };
  assert.equal(
    normalizeVscodeWorkspaceIdentity(remoteUri, folders1),
    "workspace-remote:vscode-remote://wsl+Ubuntu/home/laop/projects/codexhub/team.code-workspace"
  );
  assert.equal(
    normalizeVscodeWorkspaceIdentity(remoteUri, folders1),
    normalizeVscodeWorkspaceIdentity(remoteUri, folders3)
  );

  // 8. Rejects control characters and falls back safely
  assert.equal(normalizeVscodeWorkspaceIdentity("/bad\0path.code-workspace", folderA), "workspace-folder:/home/laop/projects/repo-a");
});

test("vscodeUiStateStorageKey generates canonical v4 profile keys and rejects v3 migration", () => {
  const scope = vscodeWorkspaceStateScope([{ path: "/home/laop/projects/codexhub" }]);

  // 1. With stateScope: produces codexhub-ui-state-vscode-v4:<scope>
  const keyWithScope = vscodeUiStateStorageKey(scope);
  assert.match(keyWithScope, /^codexhub-ui-state-vscode-v4:[0-9a-f]{24}$/);
  assert.equal(keyWithScope.includes("vscode-v3"), false);

  // 2. Without stateScope (empty / undefined / null / whitespace): produces base codexhub-ui-state-vscode-v4
  assert.equal(vscodeUiStateStorageKey(""), "codexhub-ui-state-vscode-v4");
  assert.equal(vscodeUiStateStorageKey("   "), "codexhub-ui-state-vscode-v4");
  assert.equal(vscodeUiStateStorageKey(undefined), "codexhub-ui-state-vscode-v4");
  assert.equal(vscodeUiStateStorageKey(null), "codexhub-ui-state-vscode-v4");
});

test("ordinary Web uses one canonical browser-profile state key", () => {
  assert.equal(webUiStateStorageKey, "codexhub-ui-state-v6");
});

test("replacement extensions omit new workspace fields until the old authority yields", () => {
  const workspaceFile = "/home/laop/projects/codexhub/team.code-workspace";
  assert.equal(workspaceFileForAuthorityRegistration(workspaceFile, true), undefined);
  assert.equal(workspaceFileForAuthorityRegistration(workspaceFile, false), workspaceFile);
  assert.equal(workspaceFileForAuthorityRegistration(workspaceFile), workspaceFile);
});
