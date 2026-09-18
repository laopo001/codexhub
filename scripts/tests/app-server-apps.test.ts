import assert from "node:assert/strict";
import test from "node:test";
import { readAppServerApps, reconcileAppServerPlugins } from "../../src/cli/appServerApps.js";

test("应用目录分批读取元数据并区分可访问、启用与可调用", async () => {
  const batches: string[][] = [];
  const result = await readAppServerApps(async (method, raw) => {
    const params = raw as { appIds?: string[]; threadId?: string };
    assert.equal(params.threadId, "thread-a");
    if (method === "app/installed") return { apps: Array.from({ length: 205 }, (_,i) => ({ id: `app-${i}`, runtimeName: null, enabled: true, callable: false })) };
    if (method === "app/list") return { data: [{ id: "app-0", isAccessible: true }], nextCursor: null };
    assert.equal(method, "app/read");
    batches.push(params.appIds!);
    return { apps: params.appIds!.map((id) => ({ id, name: id, toolSummaries: null })), missingAppIds: [] };
  }, "thread-a");
  assert.deepEqual(batches.map((ids) => ids.length), [100, 100, 5]);
  assert.equal(result.installed[0]!.accessible, true);
  assert.equal(result.installed[0]!.callable, false);
  assert.equal(result.installed[1]!.accessible, null);
  assert.equal(result.metadata.length, 205);
  assert.deepEqual(result.missingAppIds, []);
});

test("元数据或账号目录失败时保留真实安装快照并标明未知", async () => {
  const result = await readAppServerApps(async (method) => {
    if (method === "app/installed") return { apps: [{ id: "app-a", enabled: true, callable: true }] };
    throw new Error("服务暂不可用");
  });
  assert.equal(result.installed[0]!.callable, true);
  assert.equal(result.installed[0]!.accessible, null);
  assert.deepEqual(result.missingAppIds, ["app-a"]);
  assert.equal(result.warnings?.length, 2);
});

test("不支持或畸形的安装目录不会被伪装成空列表", async () => {
  await assert.rejects(readAppServerApps(async () => { throw new Error("method not found"); }), /does not support/);
  await assert.rejects(readAppServerApps(async () => ({})), /did not return apps/);
  await assert.rejects(readAppServerApps(async () => ({ apps: [{ id: "bad", enabled: "true", callable: false }] })), /invalid app state/);
});

test("账号目录重复cursor终止并保留unknown而不是永久循环", async () => {
  let reads = 0;
  const result = await readAppServerApps(async (method) => {
    if (method === "app/installed") return { apps: [{ id: "app-a", enabled: true, callable: false }] };
    if (method === "app/list") { reads++; return { data: [], nextCursor: "same" }; }
    return { apps: [], missingAppIds: ["app-a"] };
  });
  assert.equal(reads, 2);
  assert.equal(result.installed[0]!.accessible, null);
  assert.ok(result.warnings?.length);
});

test("插件同步只投影协议公开字段并拒绝畸形成功响应", async () => {
  const expected = { changedPlugins: [{ id: "plugin-a", hasMcps: true, hasApps: false, hasHooks: false, hasSkills: true }], failedRemotePluginIds: ["failed-a"], failedMaterializationRemotePluginIds: [] };
  const actual = await reconcileAppServerPlugins(async (method, params) => {
    assert.equal(method, "plugin/reconcile");
    assert.deepEqual(params, { reason: "用户主动刷新" });
    return { ...expected, privateInternalField: "不应暴露" };
  }, "用户主动刷新");
  assert.deepEqual(actual, expected);
  await assert.rejects(reconcileAppServerPlugins(async () => ({}), null), /did not return/);
  await assert.rejects(reconcileAppServerPlugins(async () => { throw new Error("method not found"); }, null), /does not support/);
});
