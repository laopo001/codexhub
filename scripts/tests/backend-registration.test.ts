import assert from "node:assert/strict";
import { mkdtemp, open, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  apiJson,
  createBackendRegistrationFixture,
  subscribeRealtimeThread,
  waitFor,
  type BackendRegistrationFixture
} from "../test-support/backendRegistrationFixture.js";

type RegistrationBody = {
  registration?: {
    status?: string;
    machineId?: string;
  };
};

type MachinesBody = {
  machines?: Array<{
    machineId?: string;
    type?: string;
    name?: string;
    online?: boolean;
  }>;
};

type RuntimesBody = {
  runtimes?: Array<{
    machineId?: string;
    online?: boolean;
    pid?: number;
  }>;
};

type ThreadBody = {
  threadId?: string;
  records?: PublicRecord[];
};

type PublicRecord = {
  id?: string;
  payload?: unknown;
};

const jsonHeaders = { "content-type": "application/json" };
const projectRoot = path.resolve(import.meta.dirname, "../..");
const tsxCli = path.join(projectRoot, "node_modules/tsx/dist/cli.mjs");

test("backend registration reuses child runtime and survives parent restart or cancellation", { timeout: 35_000 }, async () => {
  const fixture = await createBackendRegistrationFixture();
  let lifecycleEvents: Awaited<ReturnType<typeof subscribeRealtimeThread>> | undefined;
  const failures: string[] = [];
  const check = (condition: unknown, message: string) => {
    if (!condition) failures.push(message);
  };

  try {
    const localRuntime = await waitFor(
      async () => (await apiJson<RuntimesBody>(
        fixture.childUrl,
        "/api/runtimes?includeOffline=true",
        fixture.childAuthToken
      )).body.runtimes?.find((runtime) => runtime.machineId === fixture.childLocalMachineId),
      (runtime) => runtime?.online === true,
      "child local runtime online"
    );
    const initialStats = await waitFor(
      () => fixture.readMockCodexStats(),
      (stats) => stats.startCount >= 1,
      "initial mock app-server start"
    );
    const localPid = initialStats.pids[0];
    check(initialStats.startCount === 1, `expected one initial app-server, got ${initialStats.startCount}`);
    check(typeof localPid === "number", "initial local app-server pid was not recorded");

    const registration = await apiJson<RegistrationBody>(
      fixture.childUrl,
      "/api/registered/parent",
      fixture.childAuthToken,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          url: fixture.parentUrl,
          authToken: fixture.parentAuthToken,
          machineId: "backend-registration-child",
          name: "Backend registration child"
        })
      }
    );
    check(registration.status === 200, `registration request returned HTTP ${registration.status}`);

    await waitFor(
      async () => (await apiJson<RegistrationBody>(
        fixture.childUrl,
        "/api/registered/parent",
        fixture.childAuthToken
      )).body.registration,
      (current) => current?.status === "online",
      "child parent registration online"
    );
    const registeredMachineId = "backend-registration-child";
    await waitFor(
      async () => (await apiJson<MachinesBody>(
        fixture.parentUrl,
        "/api/machines",
        fixture.parentAuthToken
      )).body.machines,
      (machines) => machines?.some((machine) =>
        machine.machineId === registeredMachineId && machine.online === true
      ) === true,
      "registered child machine online at parent"
    );
    await waitFor(
      async () => (await apiJson<RuntimesBody>(
        fixture.parentUrl,
        "/api/runtimes?includeOffline=true",
        fixture.parentAuthToken
      )).body.runtimes,
      (runtimes) => runtimes?.some((runtime) =>
        runtime.machineId === registeredMachineId && runtime.online === true
      ) === true,
      "registered child runtime online at parent"
    );

    const lifecycleThread = await apiJson<ThreadBody>(
      fixture.parentUrl,
      "/api/machines/backend-registration-child/threads",
      fixture.parentAuthToken,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ action: "new", cwd: process.cwd() })
      }
    );
    const lifecycleThreadId = lifecycleThread.body.threadId;
    check(
      lifecycleThread.status === 200 && Boolean(lifecycleThreadId),
      `parent could not create lifecycle thread: HTTP ${lifecycleThread.status}`
    );
    if (lifecycleThreadId) {
      const childLifecycleThread = await apiJson<ThreadBody>(
        fixture.childUrl,
        `/api/threads/${lifecycleThreadId}`,
        fixture.childAuthToken
      );
      check(
        childLifecycleThread.status === 200 && childLifecycleThread.body.threadId === lifecycleThreadId,
        `child could not read lifecycle thread ${lifecycleThreadId} before parent restart (HTTP ${childLifecycleThread.status})`
      );
      lifecycleEvents = await subscribeRealtimeThread(
        fixture.childUrl,
        fixture.childAuthToken,
        lifecycleThreadId
      );
    }

    const afterRegistrationStats = await fixture.readMockCodexStats();
    check(
      afterRegistrationStats.startCount === initialStats.startCount,
      `registration started ${afterRegistrationStats.startCount - initialStats.startCount} extra app-server process(es)`
    );
    check(
      localPid === afterRegistrationStats.pids[0],
      `local app-server pid changed from ${localPid ?? "unknown"} to ${afterRegistrationStats.pids[0] ?? "unknown"}`
    );
    check(localRuntime?.online === true, "child local runtime was not online before parent restart");

    await fixture.stopParent();
    check(pidIsAlive(localPid), `initial local app-server pid ${localPid ?? "unknown"} died when parent closed`);
    await fixture.startParent();
    await waitFor(
      async () => (await apiJson<MachinesBody>(
        fixture.parentUrl,
        "/api/machines",
        fixture.parentAuthToken
      )).body.machines,
      (machines) => machines?.some((machine) =>
        machine.machineId === registeredMachineId && machine.online === true
      ) === true,
      "registered child machine reconnected after parent restart",
      15_000
    );
    await waitFor(
      async () => (await apiJson<RuntimesBody>(
        fixture.childUrl,
        "/api/runtimes?includeOffline=true",
        fixture.childAuthToken
      )).body.runtimes?.find((runtime) => runtime.machineId === fixture.childLocalMachineId),
      (runtime) => runtime?.online === true,
      "same child local runtime after parent restart"
    );
    const afterRestartStats = await fixture.readMockCodexStats();
    check(pidIsAlive(localPid), `initial local app-server pid ${localPid ?? "unknown"} is not alive after parent restart`);
    check(
      afterRestartStats.startCount === initialStats.startCount,
      `parent restart changed app-server start count to ${afterRestartStats.startCount}`
    );
    check(
      afterRestartStats.pids.includes(localPid ?? -1),
      `parent restart lost original local app-server pid ${localPid ?? "unknown"}`
    );
    if (lifecycleThreadId) {
      const resumed = await apiJson<ThreadBody>(
        fixture.parentUrl,
        "/api/machines/backend-registration-child/threads",
        fixture.parentAuthToken,
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ action: "resume", threadId: lifecycleThreadId, cwd: process.cwd() })
        }
      );
      check(
        resumed.status === 200 && resumed.body.threadId === lifecycleThreadId,
        `lifecycle thread did not resume after parent restart (HTTP ${resumed.status})`
      );
    }

    const disconnected = await apiJson<RegistrationBody>(
      fixture.childUrl,
      "/api/registered/parent",
      fixture.childAuthToken,
      { method: "DELETE" }
    );
    check(disconnected.status === 200, `cancellation returned HTTP ${disconnected.status}`);
    await waitFor(
      async () => (await apiJson<MachinesBody>(
        fixture.parentUrl,
        "/api/machines",
        fixture.parentAuthToken
      )).body.machines,
      (machines) => machines?.every((machine) => machine.machineId !== registeredMachineId) === true,
      "registered child machine removed after cancellation"
    );
    await waitFor(
      async () => (await apiJson<RuntimesBody>(
        fixture.childUrl,
        "/api/runtimes?includeOffline=true",
        fixture.childAuthToken
      )).body.runtimes?.find((runtime) => runtime.machineId === fixture.childLocalMachineId),
      (runtime) => runtime?.online === true,
      "child local runtime after cancellation"
    );
    const afterCancellationStats = await fixture.readMockCodexStats();
    check(pidIsAlive(localPid), `initial local app-server pid ${localPid ?? "unknown"} died after parent DELETE`);
    check(
      afterCancellationStats.startCount === initialStats.startCount,
      `cancellation changed app-server start count to ${afterCancellationStats.startCount}`
    );
    check(
      afterCancellationStats.pids.includes(localPid ?? -1),
      `cancellation lost original local app-server pid ${localPid ?? "unknown"}`
    );
    if (lifecycleThreadId) {
      const childAfterCancellation = await apiJson<ThreadBody>(
        fixture.childUrl,
        `/api/threads/${lifecycleThreadId}`,
        fixture.childAuthToken
      );
      check(
        childAfterCancellation.status === 200 && childAfterCancellation.body.threadId === lifecycleThreadId,
        `child could not read lifecycle thread ${lifecycleThreadId} after cancellation (HTTP ${childAfterCancellation.status})`
      );
      const childTurn = await apiJson<{ ok?: boolean }>(
        fixture.childUrl,
        `/api/threads/${lifecycleThreadId}/turn`,
        fixture.childAuthToken,
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ input: "post-cancellation child turn", source: "web" })
        }
      );
      check(childTurn.status === 200, `child could not execute a turn after cancellation (HTTP ${childTurn.status})`);
      await waitFor(
        async () => apiJson<ThreadBody>(fixture.childUrl, `/api/threads/${lifecycleThreadId}`, fixture.childAuthToken),
        (detail) => detail.status === 200 && recordTexts(detail.body.records).includes("post-cancellation child turn") && recordTexts(detail.body.records).includes("mock response"),
        "post-cancellation child turn completion"
      );
    }
    assert.deepEqual(failures, [], failures.join("\n"));
  } finally {
    await lifecycleEvents?.close();
    await fixture.stop();
  }
});

test("parent and child backends expose one thread and one turn record stream", { timeout: 35_000 }, async () => {
  const fixture = await createBackendRegistrationFixture();
  const failures: string[] = [];
  const check = (condition: unknown, message: string) => {
    if (!condition) failures.push(message);
  };

  try {
    await waitFor(
      async () => (await apiJson<RuntimesBody>(
        fixture.childUrl,
        "/api/runtimes?includeOffline=true",
        fixture.childAuthToken
      )).body.runtimes,
      (runtimes) => runtimes?.some((runtime) =>
        runtime.machineId === fixture.childLocalMachineId && runtime.online === true
      ) === true,
      "child local runtime for thread test"
    );
    await registerChildBackend(fixture);
    const registeredMachineId = "backend-registration-child";
    await waitFor(
      async () => (await apiJson<MachinesBody>(
        fixture.parentUrl,
        "/api/machines",
        fixture.parentAuthToken
      )).body.machines,
      (machines) => machines?.some((machine) =>
        machine.machineId === registeredMachineId && machine.online === true
      ) === true,
      "parent machine for thread test"
    );
    await waitFor(
      async () => (await apiJson<RuntimesBody>(
        fixture.parentUrl,
        "/api/runtimes?includeOffline=true",
        fixture.parentAuthToken
      )).body.runtimes,
      (runtimes) => runtimes?.some((runtime) =>
        runtime.machineId === registeredMachineId && runtime.online === true
      ) === true,
      "parent runtime for thread test"
    );

    const cwd = process.cwd();
    const parentNew = await apiJson<ThreadBody>(
      fixture.parentUrl,
      `/api/machines/${registeredMachineId}/threads`,
      fixture.parentAuthToken,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ action: "new", cwd })
      }
    );
    check(parentNew.status === 200, `parent new thread returned HTTP ${parentNew.status}: ${JSON.stringify(parentNew.body)}`);
    const parentThreadId = parentNew.body.threadId;
    check(Boolean(parentThreadId), "parent did not return a thread id");

    const childRead = parentThreadId
      ? await apiJson<ThreadBody>(fixture.childUrl, `/api/threads/${parentThreadId}`, fixture.childAuthToken)
      : { status: 0, body: {} as ThreadBody };
    check(
      childRead.status === 200 && childRead.body.threadId === parentThreadId,
      `child could not read parent-created thread ${parentThreadId ?? "unknown"} (HTTP ${childRead.status})`
    );

    const childNew = await apiJson<ThreadBody>(
      fixture.childUrl,
      `/api/machines/${fixture.childLocalMachineId}/threads`,
      fixture.childAuthToken,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ action: "new", cwd })
      }
    );
    check(childNew.status === 200, `child new thread returned HTTP ${childNew.status}: ${JSON.stringify(childNew.body)}`);
    const childThreadId = childNew.body.threadId;
    check(Boolean(childThreadId), "child did not return a thread id");

    const parentResume = childThreadId
      ? await apiJson<ThreadBody>(
        fixture.parentUrl,
        `/api/machines/${registeredMachineId}/threads`,
        fixture.parentAuthToken,
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ action: "resume", threadId: childThreadId, cwd })
        }
      )
      : { status: 0, body: {} as ThreadBody };
    check(
      parentResume.status === 200 && parentResume.body.threadId === childThreadId,
      `parent could not resume child-created thread ${childThreadId ?? "unknown"} (HTTP ${parentResume.status})`
    );

    if (parentThreadId && childRead.status === 200 && childThreadId && parentResume.status === 200) {
      const [parentEvents, childEvents] = await Promise.all([
        subscribeRealtimeThread(fixture.parentUrl, fixture.parentAuthToken, parentThreadId),
        subscribeRealtimeThread(fixture.childUrl, fixture.childAuthToken, parentThreadId)
      ]);
      try {
        for (const [side, apiBase, token, input] of [
          ["parent", fixture.parentUrl, fixture.parentAuthToken, "parent-side turn"],
          ["child", fixture.childUrl, fixture.childAuthToken, "child-side turn"]
        ] as const) {
          const turn = await apiJson<{ ok?: boolean }>(
            apiBase,
            `/api/threads/${parentThreadId}/turn`,
            token,
            {
              method: "POST",
              headers: jsonHeaders,
              body: JSON.stringify({ input, source: "web" })
            }
          );
          check(turn.status === 200, `${side} turn returned HTTP ${turn.status}`);
          const details = await waitFor(
            () => loadThreadPair(fixture, parentThreadId),
            (pair) => pair.parent.status === 200
              && pair.child.status === 200
              && textProjection(pair.parent.body.records).user.includes(input)
              && textProjection(pair.parent.body.records).assistant.includes("mock response")
              && sameIds(pair.parent.body.records, pair.child.body.records)
              && JSON.stringify(textProjection(pair.parent.body.records)) === JSON.stringify(textProjection(pair.child.body.records)),
            `${side} turn records on both backends`
          );
          check(
            textProjection(details.parent.body.records).user.includes(input),
            `${side} user text was missing from the public records`
          );
          check(
            textProjection(details.parent.body.records).assistant.includes("mock response"),
            `${side} assistant text was missing from the public records`
          );
          await waitFor(
            () => ({ parent: eventRecordIds(parentEvents.messages), child: eventRecordIds(childEvents.messages) }),
            (records) => recordIds(details.parent.body.records).every((id) => records.parent.includes(id) && records.child.includes(id)),
            `${side} record IDs on both events streams`
          );
        }
      } finally {
        await Promise.all([parentEvents.close(), childEvents.close()]);
      }
    }

    assert.deepEqual(failures, [], failures.join("\n"));
  } finally {
    await fixture.stop();
  }
});

test("the real register CLI attaches a running child backend without another app-server", { timeout: 25_000 }, async () => {
  const fixture = await createBackendRegistrationFixture();
  try {
    await waitFor(
      async () => (await apiJson<RuntimesBody>(fixture.childUrl, "/api/runtimes?includeOffline=true", fixture.childAuthToken)).body.runtimes,
      (runtimes) => runtimes?.some((runtime) => runtime.machineId === fixture.childLocalMachineId && runtime.online === true) === true,
      "child local runtime for register CLI"
    );
    const before = await waitFor(() => fixture.readMockCodexStats(), (stats) => stats.startCount === 1, "one initial app-server for register CLI");
    const cli = await runRegisterCli(fixture);
    assert.equal(cli.code, 0, `register CLI failed: ${cli.stderrTail || cli.stdoutTail}`);
    await waitFor(
      async () => (await apiJson<RegistrationBody>(fixture.childUrl, "/api/registered/parent", fixture.childAuthToken)).body.registration,
      (registration) => registration?.status === "online",
      "CLI-created parent registration online"
    );
    await waitFor(
      async () => (await apiJson<MachinesBody>(fixture.parentUrl, "/api/machines", fixture.parentAuthToken)).body.machines,
      (machines) => machines?.some((machine) => machine.machineId === "backend-registration-cli-child" && machine.online === true) === true,
      "CLI-created registered machine online"
    );
    const after = await fixture.readMockCodexStats();
    assert.equal(after.startCount, before.startCount, `register CLI started ${after.startCount - before.startCount} extra app-server process(es)`);
  } finally {
    await fixture.stop();
  }
});

test("a child backend without localMachine is rejected by parent registration", { timeout: 15_000 }, async () => {
  const fixture = await createBackendRegistrationFixture({ childLocalMachine: false });
  try {
    const response = await apiJson<RegistrationBody>(
      fixture.childUrl,
      "/api/registered/parent",
      fixture.childAuthToken,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({
          url: fixture.parentUrl,
          authToken: fixture.parentAuthToken,
          machineId: "backend-registration-no-local-machine"
        })
      }
    );
    assert.equal(response.status, 409, `expected localMachine=false registration rejection with HTTP 409, got HTTP ${response.status}`);
    const current = await apiJson<RegistrationBody>(
      fixture.childUrl,
      "/api/registered/parent",
      fixture.childAuthToken
    );
    assert.equal(current.body.registration?.status, "idle");
    const config = await readFile(path.join(fixture.root, "child-data", "config.yaml"), "utf8").catch(() => "");
    assert.doesNotMatch(config, /parentRegistration|backend-registration-parent-auth/);
  } finally {
    await fixture.stop();
  }
});

const registerChildBackend = async (fixture: BackendRegistrationFixture) => {
  const response = await apiJson<RegistrationBody>(
    fixture.childUrl,
    "/api/registered/parent",
    fixture.childAuthToken,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        url: fixture.parentUrl,
        authToken: fixture.parentAuthToken,
        machineId: "backend-registration-child",
        name: "Backend registration child"
      })
    }
  );
  assert.equal(response.status, 200, `backend registration returned HTTP ${response.status}`);
  await waitFor(
    async () => (await apiJson<RegistrationBody>(
      fixture.childUrl,
      "/api/registered/parent",
      fixture.childAuthToken
    )).body.registration,
    (registration) => registration?.status === "online",
    "child backend registration online"
  );
};

const runRegisterCli = async (fixture: BackendRegistrationFixture) => {
  const cliDataDir = await mkdtemp(path.join(fixture.root, "cli-data-"));
  const logDir = await mkdtemp(path.join(fixture.root, "cli-logs-"));
  const stdoutFile = await open(path.join(logDir, "stdout.log"), "w");
  const stderrFile = await open(path.join(logDir, "stderr.log"), "w");
  let code: number | null = null;
  try {
    const child = spawn(process.execPath, [
      tsxCli,
      "src/cli/codexhub.ts",
      "--server",
      fixture.childUrl,
      "register",
      "--to",
      fixture.parentUrl,
      "--machine-id",
      "backend-registration-cli-child",
      "--name",
      "Backend registration CLI child"
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CODEX_HUB_DATA_DIR: cliDataDir,
        CODEX_HUB_AUTH_TOKEN: fixture.childAuthToken,
        CODEX_HUB_REGISTER_AUTH_TOKEN: fixture.parentAuthToken,
        CODEX_HUB_PLUGIN_TELEGRAM: "0"
      },
      stdio: ["ignore", stdoutFile.fd, stderrFile.fd]
    });
    code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    await stdoutFile.close();
    await stderrFile.close();
  }
  const [stdout, stderr] = await Promise.all([
    readFile(path.join(logDir, "stdout.log"), "utf8"),
    readFile(path.join(logDir, "stderr.log"), "utf8")
  ]);
  return { code, stdoutTail: tail(stdout), stderrTail: tail(stderr) };
};

const loadThreadPair = async (fixture: BackendRegistrationFixture, threadId: string) => ({
  parent: await apiJson<ThreadBody>(fixture.parentUrl, `/api/threads/${threadId}`, fixture.parentAuthToken),
  child: await apiJson<ThreadBody>(fixture.childUrl, `/api/threads/${threadId}`, fixture.childAuthToken)
});

const pidIsAlive = (pid: number | undefined) => {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const recordTexts = (records: PublicRecord[] | undefined) => textProjection(records).all;

const textProjection = (records: PublicRecord[] | undefined) => {
  const projection = { user: [] as string[], assistant: [] as string[], all: [] as string[] };
  for (const record of records ?? []) {
    const payload = record.payload;
    const type = payload && typeof payload === "object" && !Array.isArray(payload)
      && typeof (payload as { type?: unknown }).type === "string"
      ? (payload as { type: string }).type.toLowerCase()
      : "";
    const texts = collectTexts(payload ?? record);
    projection.all.push(...texts);
    if (type.includes("user") || type.includes("input")) projection.user.push(...texts);
    if (type.includes("agent") || type.includes("assistant")) projection.assistant.push(...texts);
  }
  return projection;
};

const collectTexts = (value: unknown, key = ""): string[] => {
  if (typeof value === "string") {
    return ["text", "message", "content", "aggregated_output", "aggregatedOutput"].includes(key) ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => collectTexts(item, key));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([entryKey, entryValue]) => collectTexts(entryValue, entryKey));
};

const tail = (value: string, limit = 600) => value.length <= limit ? value : value.slice(-limit);

const recordIds = (records: PublicRecord[] | undefined) => (records ?? [])
  .map((record) => record.id)
  .filter((id): id is string => Boolean(id));

const eventRecordIds = (messages: unknown[]) => messages.flatMap((message) => {
  if (!message || typeof message !== "object") return [];
  const value = message as { kind?: unknown; record?: { id?: unknown } };
  return value.kind === "record" && typeof value.record?.id === "string" ? [value.record.id] : [];
});

const sameIds = (left: Array<{ id?: string }> | undefined, right: Array<{ id?: string }> | undefined) => {
  const leftIds = recordIds(left);
  const rightIds = recordIds(right);
  return leftIds.length === rightIds.length && leftIds.every((id) => rightIds.includes(id));
};
