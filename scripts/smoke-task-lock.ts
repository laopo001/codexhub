import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { goalStatusControl } from "../src/web/helpers/core.js";
import { assertNoWorkerId } from "./smoke/support/assertions.js";
import { apiJson } from "./smoke/support/http.js";
import { findFreePort } from "./smoke/support/network.js";
import { delay } from "./smoke/support/time.js";
import {
  appServerTurn,
  executionChanged,
  turnCompleted,
  turnSnapshot
} from "./test-support/appServerEvents.js";

type MachineSummary = {
  machineId: string;
  online?: boolean;
  capabilities?: {
    projectLauncher?: boolean;
  };
};

type ProjectThreadStartResponse = {
  result?: {
    machineId?: string;
    threadId?: string;
    cwd?: string;
  };
};

type LocalTask = {
  taskId: string;
  lastStatus?: "queued" | "completed" | "failed" | "skipped";
  threadId?: string;
  lastError?: string;
  nextRunAt?: string | null;
  runs?: Array<{
    runId: string;
    status: "queued" | "completed" | "failed" | "skipped";
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    threadId?: string;
  }>;
};

type TaskRunResponse = {
  ok?: boolean;
  skipped?: boolean;
  task?: LocalTask;
  sessionId?: string;
  threadId?: string;
};

type RealtimeMessage = {
  type?: string;
  threadId?: string;
  kind?: string;
  historical?: boolean;
  record?: {
    id?: string;
    type?: string;
    payload?: unknown;
  };
};

type PartialRateLimitWindow = {
  usedPercent?: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
};

type PartialThreadUsage = {
  context?: {
    usedTokens?: number;
    windowTokens?: number;
  } | null;
  primaryRateLimit?: PartialRateLimitWindow | null;
  secondaryRateLimit?: PartialRateLimitWindow | null;
};

type PartialRuntimeSummary = {
  machineId?: string;
  accountRateLimits?: {
    primaryRateLimit?: PartialRateLimitWindow | null;
    secondaryRateLimit?: PartialRateLimitWindow | null;
  } | null;
};

type ThreadDetail = {
  running?: boolean;
  activeTurnStartedAt?: string;
  activeTurnObservedAt?: string;
  threadUsage?: PartialThreadUsage;
  records?: Array<{
    id: string;
    type?: string;
    payload?: unknown;
  }>;
};

const weeklyWrapUpObjective = "收尾工作";

type MachineCommand = {
  commandId: string;
  type: "start_session" | "list_directory";
  cwd?: string;
};

type SessionCommand = {
  commandId: string;
  type: string;
  threadId?: string;
  workingDirectory?: string;
  includeHidden?: boolean;
  refresh?: boolean;
  commandPalettePart?: "core" | "plugins" | "all";
  input?: unknown;
  turnId?: string;
  goal?: {
    objective?: string | null;
    status?: string | null;
    tokenBudget?: number | null;
  };
  reviewTarget?: {
    type?: string;
  };
  options?: {
    model?: string | null;
    modelReasoningEffort?: string | null;
    collaborationMode?: "default" | "plan" | null;
    goalMode?: boolean | null;
    goalObjective?: string | null;
    goalTokenBudget?: number | null;
    serviceTier?: string | null;
  };
};

const main = async () => {
  assertGoalStatusControls();
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhub-task-lock."));
  const dataDir = path.join(root, "state");
  const projectDir = path.join(root, "project");
  await mkdir(dataDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  process.env.CODEX_HUB_DATA_DIR = dataDir;
  process.env.CODEX_HUB_LOCAL_MACHINE = "0";
  process.env.CODEX_HUB_PLUGIN_TELEGRAM = "0";
  process.env.CODEX_HUB_THREAD_RECORD_SUBSCRIPTION_IDLE_MS = "25";
  process.env.TELEGRAM_BOT_TOKEN = "";

  const port = await findFreePort();
  const { startServer } = await import("../src/server/index.js");
  const server = await startServer({ host: "127.0.0.1", port });
  const apiBase = `http://127.0.0.1:${port}`;
  const fake = new FakeMachine(apiBase, {
    machineId: `task-lock-machine-${process.pid}`,
    sessionId: `task-lock-session-${process.pid}`,
    threadId: `task-lock-thread-${process.pid}`,
    cwd: projectDir
  });

  try {
    await fake.start();
    const machine = await waitForMachine(apiBase, fake.machineId);
    console.log(`fake machine ok: ${machine.machineId}`);

    const open = await apiJson<ProjectThreadStartResponse>(apiBase, "/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: fake.machineId, path: projectDir })
    });
    assertNoWorkerId(open, "/api/projects/open");
    if (open.result?.machineId !== fake.machineId || open.result?.threadId !== fake.threadId) {
      throw new Error(`project thread start returned unexpected machine/thread: ${JSON.stringify(open)}`);
    }
    const modelCatalogPromise = apiJson<{
      models?: Array<{
        model?: string;
        supportedReasoningEfforts?: Array<{ value?: string; description?: string }>;
        serviceTiers?: Array<{ value?: string }>;
      }>;
    }>(apiBase, `/api/machines/${encodeURIComponent(fake.machineId)}/models`);
    const modelListCommand = await fake.nextSessionCommand("list_models");
    if (modelListCommand.includeHidden !== false) {
      throw new Error(`model catalog command should not include hidden models by default: ${JSON.stringify(modelListCommand)}`);
    }
    if (modelListCommand.refresh !== false) {
      throw new Error(`ordinary model catalog command should not force refresh: ${JSON.stringify(modelListCommand)}`);
    }
    const modelCatalog = await modelCatalogPromise;
    const catalogModel = modelCatalog.models?.find((model) => model.model === "gpt-5.6-sol");
    if (!catalogModel) {
      throw new Error(`model catalog response missing gpt-5.6-sol: ${JSON.stringify(modelCatalog)}`);
    }
    const ultraOption = catalogModel.supportedReasoningEfforts?.find((option) => option.value === "ultra");
    if (
      !catalogModel.supportedReasoningEfforts?.some((option) => option.value === "max")
      || ultraOption?.description !== "Maximum reasoning with automatic task delegation"
    ) {
      throw new Error(`model catalog response missing max/ultra reasoning efforts: ${JSON.stringify(modelCatalog)}`);
    }
    if (!catalogModel.serviceTiers?.some((option) => option.value === "fast")) {
      throw new Error(`model catalog response missing fast service tier: ${JSON.stringify(modelCatalog)}`);
    }
    const refreshedModelCatalogPromise = apiJson(
      apiBase,
      `/api/machines/${encodeURIComponent(fake.machineId)}/models?refresh=true`
    );
    const refreshedModelListCommand = await fake.nextSessionCommand("list_models");
    if (refreshedModelListCommand.refresh !== true) {
      throw new Error(`forced model catalog refresh was not forwarded: ${JSON.stringify(refreshedModelListCommand)}`);
    }
    await refreshedModelCatalogPromise;
    console.log("runtime model catalog ok");
    const permissionProfilesPromise = apiJson<{
      profiles?: Array<{ id?: string; description?: string | null; allowed?: boolean }>;
    }>(
      apiBase,
      `/api/machines/${encodeURIComponent(fake.machineId)}/permission-profiles?cwd=${encodeURIComponent(projectDir)}`
    );
    const permissionProfilesCommand = await fake.nextSessionCommand("list_permission_profiles");
    if (permissionProfilesCommand.workingDirectory !== projectDir) {
      throw new Error(`permission profile cwd mismatch: ${JSON.stringify(permissionProfilesCommand)}`);
    }
    const permissionProfiles = await permissionProfilesPromise;
    if (JSON.stringify(permissionProfiles.profiles) !== JSON.stringify([
      { id: "team-safe", description: "Fake runtime profile", allowed: true }
    ])) {
      throw new Error(`permission profile response was not runtime-authoritative: ${JSON.stringify(permissionProfiles)}`);
    }
    const secondPermissionProfilesPromise = apiJson(
      apiBase,
      `/api/machines/${encodeURIComponent(fake.machineId)}/permission-profiles?cwd=${encodeURIComponent(projectDir)}`
    );
    await fake.nextSessionCommand("list_permission_profiles");
    await secondPermissionProfilesPromise;
    console.log("runtime permission profile catalog live load ok");
    const commandPalettePromise = apiJson<{
      palette?: { entries?: Array<{ name?: string; kind?: string }> };
    }>(
      apiBase,
      `/api/machines/${encodeURIComponent(fake.machineId)}/command-palette?cwd=${encodeURIComponent(projectDir)}&part=plugins`
    );
    const commandPaletteCommand = await fake.nextSessionCommand("list_command_palette");
    if (commandPaletteCommand.workingDirectory !== projectDir || commandPaletteCommand.commandPalettePart !== "plugins") {
      throw new Error(`command palette plugin scope mismatch: ${JSON.stringify(commandPaletteCommand)}`);
    }
    const commandPalette = await commandPalettePromise;
    if (!commandPalette.palette?.entries?.some((entry) => entry.name === "fake-plugin" && entry.kind === "plugin")) {
      throw new Error(`command palette response missing runtime plugin: ${JSON.stringify(commandPalette)}`);
    }
    console.log("runtime command palette plugin catalog live load ok");
    await fake.expectNoSessionCommand("subscribe_thread_records", 100);
    await assertThreadRecordSubscription(apiBase, fake.threadId, fake);
    console.log("thread record subscription ok");
    await assertAppServerOnlyThreadSubscription(apiBase, fake.threadId, fake);
    console.log("app-server-only thread subscription ok");
    await assertHistoricalSnapshotPublishesMarkedRecordEvents(apiBase, fake.threadId, fake);
    console.log("historical snapshot record events marked ok");

    const compactPromise = apiJson<{ ok?: boolean }>(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}/compact`,
      { method: "POST" }
    );
    const compactCommand = await fake.nextSessionCommand("compact_thread");
    if (compactCommand.threadId !== fake.threadId) {
      throw new Error(`thread compact command mismatch: ${JSON.stringify(compactCommand)}`);
    }
    const compactResult = await compactPromise;
    if (!compactResult.ok) throw new Error(`thread compact response mismatch: ${JSON.stringify(compactResult)}`);
    console.log("thread compact command ok");

    const reviewPromise = apiJson<{ ok?: boolean; reviewThreadId?: string }>(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}/review`,
      { method: "POST" }
    );
    const reviewCommand = await fake.nextSessionCommand("review_thread");
    if (reviewCommand.threadId !== fake.threadId || reviewCommand.reviewTarget?.type !== "uncommittedChanges") {
      throw new Error(`thread review command mismatch: ${JSON.stringify(reviewCommand)}`);
    }
    const reviewResult = await reviewPromise;
    if (!reviewResult.ok || reviewResult.reviewThreadId !== fake.threadId) {
      throw new Error(`thread review response mismatch: ${JSON.stringify(reviewResult)}`);
    }
    console.log("thread review command ok");

    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "plan and pursue this smoke task",
        source: "web",
        options: {
          model: "gpt-5.6-sol",
          modelReasoningEffort: "ultra",
          collaborationMode: "plan",
          goalMode: true,
          goalObjective: "finish the plan and goal smoke",
          goalTokenBudget: 1234,
          serviceTier: "priority"
        }
      })
    });
    const modeTurn = await fake.nextTurn();
    await fake.expectNoSessionCommand("subscribe_thread_records", 100);
    const runningTimingDetail = await apiJson<ThreadDetail>(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}`
    );
    const runningStartedAtMs = Date.parse(runningTimingDetail.activeTurnStartedAt ?? "");
    const runningObservedAtMs = Date.parse(runningTimingDetail.activeTurnObservedAt ?? "");
    if (
      !runningTimingDetail.running
      || !Number.isFinite(runningStartedAtMs)
      || !Number.isFinite(runningObservedAtMs)
      || runningObservedAtMs < runningStartedAtMs
    ) {
      throw new Error(`running timing anchor missing from thread detail: ${JSON.stringify(runningTimingDetail)}`);
    }
    if (modeTurn.options?.collaborationMode !== "plan" || modeTurn.options?.goalMode !== true) {
      throw new Error(`web turn mode options were not forwarded: ${JSON.stringify(modeTurn.options)}`);
    }
    if (modeTurn.options.goalObjective !== "finish the plan and goal smoke" || modeTurn.options.goalTokenBudget !== 1234) {
      throw new Error(`web turn goal options were not forwarded: ${JSON.stringify(modeTurn.options)}`);
    }
    if (modeTurn.options.serviceTier !== "priority") {
      throw new Error(`web turn service tier option was not forwarded: ${JSON.stringify(modeTurn.options)}`);
    }
    if (modeTurn.options.model !== "gpt-5.6-sol" || modeTurn.options.modelReasoningEffort !== "ultra") {
      throw new Error(`web turn model/effort options were not forwarded: ${JSON.stringify(modeTurn.options)}`);
    }
    fake.completeTurn(modeTurn);
    console.log("web turn mode options ok");

    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "default follow-up should not inherit composer modes",
        source: "web"
      })
    });
    const defaultTurn = await fake.nextTurn();
    if (defaultTurn.options?.collaborationMode || defaultTurn.options?.goalMode) {
      throw new Error(`composer mode options leaked into default turn: ${JSON.stringify(defaultTurn.options)}`);
    }
    fake.completeTurn(defaultTurn);
    console.log("web turn mode one-shot ok");

    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "hold this web turn open",
        source: "web"
      })
    });
    const activeWebTurn = await fake.nextTurn();
    const activeWebTurnId = activeWebTurn.turnId;
    if (!activeWebTurnId) throw new Error(`active web turn missing turnId: ${JSON.stringify(activeWebTurn)}`);
    const beforeSteerDetail = await apiJson<ThreadDetail>(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}`
    );
    if (!beforeSteerDetail.running || !beforeSteerDetail.activeTurnStartedAt) {
      throw new Error(`active web turn timing missing before steer: ${JSON.stringify(beforeSteerDetail)}`);
    }
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "steered web follow-up",
        source: "web"
      })
    });
    const steer = await fake.nextSteer();
    if (steer.input !== "steered web follow-up") {
      throw new Error(`web steer input mismatch: ${JSON.stringify(steer.input)}`);
    }
    if (steer.turnId !== activeWebTurn.turnId) {
      throw new Error(`web steer used wrong turnId: ${JSON.stringify({ expected: activeWebTurn.turnId, actual: steer.turnId })}`);
    }
    const afterSteerDetail = await apiJson<ThreadDetail>(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}`
    );
    if (
      !afterSteerDetail.running
      || afterSteerDetail.activeTurnStartedAt !== beforeSteerDetail.activeTurnStartedAt
    ) {
      throw new Error(`web steer restarted running timing: ${JSON.stringify({ beforeSteerDetail, afterSteerDetail })}`);
    }
    const usageScopeItemId = `${activeWebTurnId}-usage-user`;
    fake.emitUserMessage(activeWebTurnId, usageScopeItemId, "steered web follow-up");
    fake.emitAccountRateLimits();
    fake.emitTokenUsage(activeWebTurn);
    fake.emitTokenUsageForTurnId(fake.threadId, activeWebTurnId, {
      tokenUsage: {
        last: {
          inputTokens: 300,
          cachedInputTokens: 200,
          outputTokens: 40,
          reasoningOutputTokens: 5,
          totalTokens: 340
        },
        total: {
          inputTokens: 1500,
          cachedInputTokens: 1000,
          outputTokens: 130,
          reasoningOutputTokens: 15,
          totalTokens: 1630
        },
        modelContextWindow: 200000
      }
    });
    await assertTurnTokenUsageRecords(apiBase, fake.threadId, activeWebTurnId, [1300, 340]);
    fake.emitTokenUsageForTurnId(fake.threadId, activeWebTurnId, {
      tokenUsage: {
        last: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 29329
        },
        total: {
          inputTokens: 1500,
          cachedInputTokens: 1000,
          outputTokens: 130,
          reasoningOutputTokens: 15,
          totalTokens: 1630
        },
        modelContextWindow: 200000
      }
    });
    await assertStatusUsage(apiBase, fake.threadId, { input: 1500, output: 130, total: 1630 });
    fake.emitTurnsSnapshot(activeWebTurnId);
    fake.emitTokenUsageForTurnId(fake.threadId, `${activeWebTurnId}-goal-next`, {
      tokenUsage: {
        last: {
          inputTokens: 200,
          cachedInputTokens: 100,
          outputTokens: 50,
          reasoningOutputTokens: 8,
          totalTokens: 250
        },
        total: {
          inputTokens: 1700,
          cachedInputTokens: 1100,
          outputTokens: 180,
          reasoningOutputTokens: 23,
          totalTokens: 1880
        },
        modelContextWindow: 200000
      }
    });
    await assertStatusUsage(apiBase, fake.threadId, { input: 1700, output: 180, total: 1880 });
    const nextUsageTurnId = `${activeWebTurnId}-next-user`;
    const nextUsageScopeItemId = `${nextUsageTurnId}-usage-user`;
    fake.emitUserMessage(nextUsageTurnId, nextUsageScopeItemId, "start a fresh usage scope");
    fake.emitTokenUsageForTurnId(fake.threadId, nextUsageTurnId, {
      tokenUsage: {
        last: {
          inputTokens: 89_000,
          cachedInputTokens: 88_000,
          outputTokens: 31,
          reasoningOutputTokens: 3,
          totalTokens: 89_031
        },
        total: {
          inputTokens: 2600,
          cachedInputTokens: 1900,
          outputTokens: 211,
          reasoningOutputTokens: 26,
          totalTokens: 2811
        },
        modelContextWindow: 200000
      }
    });
    await assertStatusUsage(apiBase, fake.threadId, { input: 900, output: 31, total: 931 });
    await assertRuntimeAccountRateLimits(apiBase, fake.machineId);
    fake.emitTokenUsageForTurnId(fake.threadId, "context-only-usage");
    await assertRuntimeAccountRateLimits(apiBase, fake.machineId);
    fake.emitContextTokenUsage("context-usage");
    await assertThreadUsageContext(apiBase, fake.threadId, 321, 456000);
    await assertRuntimeAccountRateLimits(apiBase, fake.machineId);
    fake.emitSparsePrimaryAccountRateLimit(27);
    await assertRuntimeAccountRateLimits(apiBase, fake.machineId, {
      primaryUsedPercent: 27
    });
    console.log("app-server token usage and account rate limits ok");
    fake.completeTurn(activeWebTurn);
    fake.emitTurnsSnapshotWithUser(nextUsageTurnId, nextUsageScopeItemId, "start a fresh usage scope");
    await assertStatusUsage(apiBase, fake.threadId, { input: 2421, output: 343, total: 2764 });
    console.log("status usage accumulation and snapshot retention ok");
    console.log("web running turn steer ok");

    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "hold goal web turn open",
        source: "web"
      })
    });
    const activeGoalTurn = await fake.nextTurn();
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "replace the active goal",
        source: "web",
        options: { goalMode: true }
      })
    });
    const setGoal = await fake.nextSessionCommand("set_goal");
    if (setGoal.options?.goalMode) {
      throw new Error(`web goal update command mismatch: ${JSON.stringify(setGoal)}`);
    }
    if (setGoal.goal?.objective !== "replace the active goal" || setGoal.goal.status !== "active") {
      throw new Error(`web goal update payload mismatch: ${JSON.stringify(setGoal.goal)}`);
    }
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "paused" })
    });
    const pausedGoal = await fake.nextSessionCommand("set_goal");
    if (pausedGoal.goal?.status !== "paused") {
      throw new Error(`web goal pause payload mismatch: ${JSON.stringify(pausedGoal.goal)}`);
    }
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, { method: "DELETE" });
    const clearedGoal = await fake.nextSessionCommand("clear_goal");
    if (clearedGoal.threadId !== fake.threadId) {
      throw new Error(`web goal clear command mismatch: ${JSON.stringify(clearedGoal)}`);
    }
    const clearedDetail = await apiJson<{ records?: Array<{ payload?: { type?: string } }> }>(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}`
    );
    if (!clearedDetail.records?.some((record) => record.payload?.type === "thread_goal_cleared")) {
      throw new Error(`web goal clear record missing: ${JSON.stringify(clearedDetail.records)}`);
    }
    fake.completeTurn(activeGoalTurn);
    console.log("web running goal update ok");

    fake.emitGoalUpdated({
      threadId: fake.threadId,
      objective: "current app-server goal",
      status: "paused",
      tokenBudget: 777,
      tokensUsed: 12,
      timeUsedSeconds: 34,
      createdAt: 1,
      updatedAt: 2
    });
    const currentGoalDetail = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}`);
    const currentGoalRecords = currentGoalDetail.records?.filter((record) => {
      const payload = objectValue(record.payload);
      return payload?.type === "thread_goal_updated";
    }) ?? [];
    const latestCurrentGoalPayload = objectValue(currentGoalRecords.at(-1)?.payload);
    const latestCurrentGoal = objectValue(latestCurrentGoalPayload?.goal);
    if (
      latestCurrentGoal?.objective !== "current app-server goal"
      || latestCurrentGoal.status !== "paused"
      || latestCurrentGoal.tokenBudget !== 777
      || latestCurrentGoal.tokensUsed !== 12
    ) {
      throw new Error(`current goal update did not preserve goal fields: ${JSON.stringify(latestCurrentGoal)}`);
    }
    console.log("app-server current goal update ok");

    await expectApiError(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}/goal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objective: "invalid weekly target",
          status: "active",
          runPolicy: {
            type: "consumeUntilWeeklyRemainingAtOrBelow",
            targetRemainingPercent: 100
          }
        })
      },
      400
    );
    console.log("consume-until invalid target rejected ok");

    const nonWeeklyObjective = "do not continue on non-weekly secondary window";
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: nonWeeklyObjective,
        status: "active",
        runPolicy: {
          type: "consumeUntilWeeklyRemainingAtOrBelow",
          targetRemainingPercent: 20
        }
      })
    });
    await fake.nextSessionCommand("set_goal");
    const nonWeeklyTurn = await fake.nextTurn();
    fake.emitAccountRateLimits(64, 300);
    fake.emitTokenUsage(nonWeeklyTurn);
    fake.completeTurn(nonWeeklyTurn);
    await fake.expectNoTurn(150);
    console.log("consume-until ignores non-weekly secondary window ok");

    const consumeObjective = "consume weekly budget until target";
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: consumeObjective,
        status: "active",
        runPolicy: {
          type: "consumeUntilWeeklyRemainingAtOrBelow",
          targetRemainingPercent: 20
        }
      })
    });
    const consumeSetGoal = await fake.nextSessionCommand("set_goal");
    const consumeGoal = objectValue(consumeSetGoal.goal);
    if (
      consumeGoal?.objective !== consumeObjective
      || consumeGoal.status !== "active"
      || objectValue(consumeGoal.runPolicy) !== null
    ) {
      throw new Error(`consume goal set payload mismatch: ${JSON.stringify(consumeSetGoal.goal)}`);
    }
    const consumeDetail = await apiJson<ThreadDetail & {
      goalRunPolicy?: { type?: string; targetRemainingPercent?: number } | null;
    }>(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}`);
    if (
      consumeDetail.goalRunPolicy?.type !== "consumeUntilWeeklyRemainingAtOrBelow"
      || consumeDetail.goalRunPolicy.targetRemainingPercent !== 20
    ) {
      throw new Error(`consume goal policy missing from thread detail: ${JSON.stringify(consumeDetail.goalRunPolicy)}`);
    }
    const consumeTurn = await fake.nextTurn();
    assertGoalContinuationTurn(consumeTurn, consumeObjective, "consume goal initial turn mismatch");
    fake.emitAccountRateLimits(64);
    fake.emitTokenUsage(consumeTurn);
    fake.emitGoalUpdated({
      threadId: fake.threadId,
      objective: consumeObjective,
      status: "complete",
      tokenBudget: null,
      tokensUsed: 100,
      timeUsedSeconds: 60,
      createdAt: 3,
      updatedAt: 4
    });
    await waitForGoalStatus(apiBase, fake.threadId, "complete", consumeObjective);
    fake.completeTurn(consumeTurn);
    const retryTurn = await fake.nextTurn();
    assertGoalContinuationTurn(retryTurn, consumeObjective, "consume goal retry turn mismatch");
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runPolicy: {
          type: "consumeUntilWeeklyRemainingAtOrBelow",
          targetRemainingPercent: 17
        }
      })
    });
    await fake.expectNoSessionCommand("set_goal", 150);
    const retargetDetail = await apiJson<ThreadDetail & {
      goalRunPolicy?: { type?: string; targetRemainingPercent?: number } | null;
    }>(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}`);
    if (
      retargetDetail.goalRunPolicy?.type !== "consumeUntilWeeklyRemainingAtOrBelow"
      || retargetDetail.goalRunPolicy.targetRemainingPercent !== 17
    ) {
      throw new Error(`consume policy-only retarget missing from thread detail: ${JSON.stringify(retargetDetail.goalRunPolicy)}`);
    }
    fake.emitWeeklyAccountRateLimits(84);
    fake.emitTokenUsage(retryTurn);
    const wrapUpSetGoal = await fake.nextSessionCommand("set_goal");
    const wrapUpGoal = objectValue(wrapUpSetGoal.goal);
    if (
      wrapUpSetGoal.threadId !== fake.threadId
      || wrapUpGoal?.objective !== weeklyWrapUpObjective
      || wrapUpGoal.status !== "active"
      || objectValue(wrapUpGoal.runPolicy) !== null
    ) {
      throw new Error(`weekly wrap-up goal payload mismatch: ${JSON.stringify(wrapUpSetGoal.goal)}`);
    }
    const wrapUpDetail = await waitForGoalStatus(apiBase, fake.threadId, "active", weeklyWrapUpObjective) as ThreadDetail & {
      goalRunPolicy?: { type?: string; targetRemainingPercent?: number } | null;
    };
    if (wrapUpDetail.goalRunPolicy !== null) {
      throw new Error(`weekly wrap-up did not clear run policy: ${JSON.stringify(wrapUpDetail.goalRunPolicy)}`);
    }
    fake.completeTurn(retryTurn);
    await fake.expectNoTurn(150);
    console.log("consume-until weekly goal wrap-up retarget ok");

    const rollbackBaselineObjective = "rollback policy baseline";
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: rollbackBaselineObjective,
        status: "active",
        runPolicy: {
          type: "consumeUntilWeeklyRemainingAtOrBelow",
          targetRemainingPercent: 30
        }
      })
    });
    await fake.nextSessionCommand("set_goal");
    await fake.expectNoTurn(150);

    fake.failNextSetGoal("set goal rejected");
    const failedGoalRequest = expectApiError(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}/goal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          objective: "failed goal update should roll back",
          status: "active",
          runPolicy: {
            type: "consumeUntilWeeklyRemainingAtOrBelow",
            targetRemainingPercent: 90
          }
        })
      },
      409
    );
    await fake.nextSessionCommand("set_goal");
    await failedGoalRequest;
    const rollbackDetail = await apiJson<ThreadDetail & {
      goalRunPolicy?: { type?: string; targetRemainingPercent?: number } | null;
    }>(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}`);
    if (
      rollbackDetail.goalRunPolicy?.type !== "consumeUntilWeeklyRemainingAtOrBelow"
      || rollbackDetail.goalRunPolicy.targetRemainingPercent !== 30
    ) {
      throw new Error(`failed goal update did not roll back policy: ${JSON.stringify(rollbackDetail.goalRunPolicy)}`);
    }
    console.log("consume-until failed goal update rollback ok");

    const rateLimitedObjective = "pause consume policy on quota error";
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: rateLimitedObjective,
        status: "active",
        runPolicy: {
          type: "consumeUntilWeeklyRemainingAtOrBelow",
          targetRemainingPercent: 10
        }
      })
    });
    await fake.nextSessionCommand("set_goal");
    const rateLimitedTurn = await fake.nextTurn();
    fake.failTurn(rateLimitedTurn, "5h quota exhausted");
    await waitForGoalStatus(apiBase, fake.threadId, "paused", rateLimitedObjective);
    await fake.expectNoTurn(150);
    console.log("consume-until quota error pauses policy ok");

    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" })
    });
    const resumedGoal = await fake.nextSessionCommand("set_goal");
    if (resumedGoal.goal?.status !== "active") {
      throw new Error(`consume goal resume payload mismatch: ${JSON.stringify(resumedGoal.goal)}`);
    }
    const resumedTurn = await fake.nextTurn();
    assertGoalContinuationTurn(resumedTurn, rateLimitedObjective, "consume goal resumed turn mismatch");
    fake.emitAccountRateLimits(95);
    fake.emitTokenUsage(resumedTurn);
    const resumedWrapUpSetGoal = await fake.nextSessionCommand("set_goal");
    const resumedWrapUpGoal = objectValue(resumedWrapUpSetGoal.goal);
    if (
      resumedWrapUpSetGoal.threadId !== fake.threadId
      || resumedWrapUpGoal?.objective !== weeklyWrapUpObjective
      || resumedWrapUpGoal.status !== "active"
    ) {
      throw new Error(`manual resume wrap-up goal payload mismatch: ${JSON.stringify(resumedWrapUpSetGoal.goal)}`);
    }
    fake.completeTurn(resumedTurn);
    await fake.expectNoTurn(150);
    console.log("consume-until manual resume ok");

    const clearRollbackObjective = "clear rollback policy baseline";
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: clearRollbackObjective,
        status: "active",
        runPolicy: {
          type: "consumeUntilWeeklyRemainingAtOrBelow",
          targetRemainingPercent: 30
        }
      })
    });
    await fake.nextSessionCommand("set_goal");
    await fake.expectNoTurn(150);

    fake.failNextClearGoal("clear goal rejected");
    const failedClearGoalRequest = expectApiError(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}/goal`,
      { method: "DELETE" },
      409
    );
    await fake.nextSessionCommand("clear_goal");
    await failedClearGoalRequest;
    const clearRollbackDetail = await apiJson<ThreadDetail & {
      goalRunPolicy?: { type?: string; targetRemainingPercent?: number } | null;
    }>(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}`);
    if (
      clearRollbackDetail.goalRunPolicy?.type !== "consumeUntilWeeklyRemainingAtOrBelow"
      || clearRollbackDetail.goalRunPolicy.targetRemainingPercent !== 30
    ) {
      throw new Error(`failed goal clear did not roll back policy: ${JSON.stringify(clearRollbackDetail.goalRunPolicy)}`);
    }
    console.log("consume-until failed clear rollback ok");

    const stoppedObjective = "stop consume policy without retry";
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objective: stoppedObjective,
        status: "active",
        runPolicy: {
          type: "consumeUntilWeeklyRemainingAtOrBelow",
          targetRemainingPercent: 1
        }
      })
    });
    await fake.nextSessionCommand("set_goal");
    const stoppedTurn = await fake.nextTurn();
    const stopResult = await apiJson<{ stopped?: boolean }>(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}/stop`,
      { method: "POST" }
    );
    if (!stopResult.stopped) {
      throw new Error(`consume policy stop did not report stopped: ${JSON.stringify(stopResult)}`);
    }
    const stopCommand = await fake.nextSessionCommand("stop");
    if (stopCommand.threadId !== fake.threadId || stopCommand.turnId !== stoppedTurn.turnId) {
      throw new Error(`consume policy stop command mismatch: ${JSON.stringify(stopCommand)}`);
    }
    fake.emitAccountRateLimits(64);
    fake.emitTokenUsage(stoppedTurn);
    fake.completeTurn(stoppedTurn, "interrupted");
    await fake.expectNoTurn(150);
    console.log("consume-until manual stop halts continuation ok");

    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" })
    });
    const resumedAfterStopGoal = await fake.nextSessionCommand("set_goal");
    if (resumedAfterStopGoal.goal?.status !== "active") {
      throw new Error(`stopped consume goal resume payload mismatch: ${JSON.stringify(resumedAfterStopGoal.goal)}`);
    }
    const resumedAfterStopTurn = await fake.nextTurn();
    assertGoalContinuationTurn(resumedAfterStopTurn, stoppedObjective, "stopped consume goal did not resume");

    await apiJson<{ stopped?: boolean }>(
      apiBase,
      `/api/threads/${encodeURIComponent(fake.threadId)}/stop`,
      { method: "POST" }
    );
    const rapidResumeStopCommand = await fake.nextSessionCommand("stop");
    if (rapidResumeStopCommand.turnId !== resumedAfterStopTurn.turnId) {
      throw new Error(`rapid resume stop used wrong turn: ${JSON.stringify(rapidResumeStopCommand)}`);
    }
    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "active" })
    });
    await fake.nextSessionCommand("set_goal");
    await fake.expectNoTurn(100);
    fake.completeTurn(resumedAfterStopTurn, "interrupted");
    const rapidResumeTurn = await fake.nextTurn();
    assertGoalContinuationTurn(rapidResumeTurn, stoppedObjective, "consume goal rapid resume was lost");
    fake.completeTurn(rapidResumeTurn, "interrupted");
    await fake.expectNoTurn(150);
    console.log("consume-until manual stop resume timing ok");

    await apiJson(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}/goal`, { method: "DELETE" });
    await fake.nextSessionCommand("clear_goal");
    const clearedPolicyDetail = await apiJson<ThreadDetail & {
      goalRunPolicy?: { type?: string; targetRemainingPercent?: number } | null;
    }>(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}`);
    if (clearedPolicyDetail.goalRunPolicy !== null) {
      throw new Error(`goal clear did not clear run policy: ${JSON.stringify(clearedPolicyDetail.goalRunPolicy)}`);
    }
    console.log("consume-until clear removes policy ok");

    const created = await apiJson<{ task?: LocalTask }>(apiBase, "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Task lock smoke",
        enabled: false,
        schedule: "* * * * *",
        machineId: fake.machineId,
        projectPath: projectDir,
        input: "hold this task open"
      })
    });
    assertNoWorkerId(created, "POST /api/tasks");
    const task = created.task;
    const taskId = task?.taskId;
    if (!taskId) throw new Error("task create did not return taskId");
    if (task.nextRunAt !== null) {
      throw new Error(`disabled task should not expose nextRunAt: ${JSON.stringify(task)}`);
    }

    const firstRun = apiJson<TaskRunResponse>(apiBase, `/api/tasks/${encodeURIComponent(taskId)}/run`, { method: "POST" });
    const secondRun = apiJson<TaskRunResponse>(apiBase, `/api/tasks/${encodeURIComponent(taskId)}/run`, { method: "POST" });
    const results = await Promise.all([firstRun, secondRun]);
    for (const result of results) assertNoWorkerId(result, "POST /api/tasks/:taskId/run");
    const queued = results.find((result) => !result.skipped);
    const skipped = results.find((result) => result.skipped);
    if (!queued || queued.task?.lastStatus !== "queued") {
      throw new Error(`one concurrent task run should be queued: ${JSON.stringify(results)}`);
    }
    if (!queued.task.runs?.some((run) => run.status === "queued")) {
      throw new Error(`queued task run summary missing: ${JSON.stringify(queued.task)}`);
    }
    if (!skipped || skipped.task?.lastStatus !== "skipped") {
      throw new Error(`one concurrent task run should be skipped: ${JSON.stringify(results)}`);
    }
    if (!skipped.task.runs?.some((run) => run.status === "skipped")) {
      throw new Error(`skipped task run summary missing: ${JSON.stringify(skipped.task)}`);
    }
    console.log("task duplicate skip ok");

    await fake.completeNextTurn();
    const completed = await waitForTaskStatus(apiBase, taskId, "completed");
    const completedRun = completed.runs?.find((run) => run.status === "completed");
    if (!completedRun || completedRun.durationMs == null) {
      throw new Error(`completed task run summary missing duration: ${JSON.stringify(completed)}`);
    }
    console.log("task completion unlock ok");

    const third = await apiJson<TaskRunResponse>(apiBase, `/api/tasks/${encodeURIComponent(taskId)}/run`, { method: "POST" });
    assertNoWorkerId(third, "POST /api/tasks/:taskId/run after unlock");
    if (third.skipped || third.task?.lastStatus !== "queued") {
      throw new Error(`task lock did not release after completion: ${JSON.stringify(third)}`);
    }
    await fake.completeNextTurn();
    const rerun = await waitForTaskStatus(apiBase, taskId, "completed");
    if ((rerun.runs ?? []).filter((run) => run.status === "completed").length < 2) {
      throw new Error(`task rerun history missing completed runs: ${JSON.stringify(rerun)}`);
    }
    console.log("task rerun ok");
  } finally {
    fake.stop();
    await server.stop();
  }
};

const assertGoalStatusControls = () => {
  const active = goalStatusControl("active");
  if (active?.label !== "暂停目标" || active.icon !== "Ⅱ" || active.nextStatus !== "paused") {
    throw new Error(`active goal control mismatch: ${JSON.stringify(active)}`);
  }
  for (const status of ["paused", "blocked", "usageLimited"] as const) {
    const control = goalStatusControl(status);
    if (control?.label !== "继续目标" || control.icon !== "▶" || control.nextStatus !== "active") {
      throw new Error(`${status} goal control mismatch: ${JSON.stringify(control)}`);
    }
  }
  for (const status of ["budgetLimited", "complete"] as const) {
    const control = goalStatusControl(status);
    if (control !== null) throw new Error(`${status} goal control should be hidden: ${JSON.stringify(control)}`);
  }
  console.log("goal status controls ok");
};

const assertGoalContinuationTurn = (
  command: SessionCommand,
  objective: string,
  description: string
) => {
  if (
    command.input !== objective
    || command.options?.goalMode !== true
    || command.options.goalObjective !== objective
  ) {
    throw new Error(`${description}: ${JSON.stringify(command)}`);
  }
};

class FakeMachine {
  private ws: WebSocket | null = null;
  private sessionRegistered = false;
  private nextSetGoalError: string | null = null;
  private nextClearGoalError: string | null = null;
  private pendingTurns: SessionCommand[] = [];
  private pendingSteers: SessionCommand[] = [];
  private pendingSessionCommandsByType = new Map<string, SessionCommand[]>();
  private turnWaiters: Array<(command: SessionCommand) => void> = [];
  private steerWaiters: Array<(command: SessionCommand) => void> = [];
  private sessionCommandWaitersByType = new Map<string, Array<(command: SessionCommand) => void>>();

  constructor(
    private readonly apiBase: string,
    readonly options: {
      machineId: string;
      sessionId: string;
      threadId: string;
      cwd: string;
    }
  ) {}

  get machineId() {
    return this.options.machineId;
  }

  get sessionId() {
    return this.options.sessionId;
  }

  get threadId() {
    return this.options.threadId;
  }

  async start() {
    const ws = new WebSocket(machineTransportUrl(this.apiBase));
    this.ws = ws;
    ws.addEventListener("message", (event) => this.handleMessage(event.data));
    await waitForWebSocketOpen(ws);
    this.send({
      type: "register",
      commandCursor: 0,
      registration: {
        machineId: this.options.machineId,
        type: "registered",
        name: "Task Lock Fake Machine",
        hostname: "task-lock-host",
        cwd: this.options.cwd,
        capabilities: { projectLauncher: true }
      }
    });
  }

  stop() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: "unregister" });
      this.ws.close();
    }
    this.ws = null;
  }

  async completeNextTurn() {
    const command = await this.waitForTurn();
    this.completeTurn(command);
  }

  async nextTurn() {
    return await this.waitForTurn();
  }

  async expectNoTurn(timeoutMs = 100) {
    const existing = this.pendingTurns.shift();
    if (existing) throw new Error(`unexpected turn command: ${JSON.stringify(existing)}`);
    let resolved = false;
    await new Promise<void>((resolve, reject) => {
      const waiter = (command: SessionCommand) => {
        resolved = true;
        reject(new Error(`unexpected turn command: ${JSON.stringify(command)}`));
      };
      this.turnWaiters.push(waiter);
      setTimeout(() => {
        if (resolved) return;
        this.turnWaiters = this.turnWaiters.filter((item) => item !== waiter);
        resolve();
      }, timeoutMs);
    });
  }

  async nextSteer() {
    return await this.waitForSteer();
  }

  async nextSessionCommand(type: string, timeoutMs = 5000) {
    return await this.waitForSessionCommand(type, timeoutMs);
  }

  failNextSetGoal(message: string) {
    this.nextSetGoalError = message;
  }

  failNextClearGoal(message: string) {
    this.nextClearGoalError = message;
  }

  async expectNoSessionCommand(type: string, timeoutMs = 100) {
    const existing = this.pendingSessionCommandsByType.get(type)?.shift();
    if (existing) throw new Error(`unexpected ${type} command: ${JSON.stringify(existing)}`);
    let resolved = false;
    await new Promise<void>((resolve, reject) => {
      const waiter = (command: SessionCommand) => {
        resolved = true;
        reject(new Error(`unexpected ${type} command: ${JSON.stringify(command)}`));
      };
      const waiters = this.sessionCommandWaitersByType.get(type) ?? [];
      waiters.push(waiter);
      this.sessionCommandWaitersByType.set(type, waiters);
      setTimeout(() => {
        if (resolved) return;
        const current = this.sessionCommandWaitersByType.get(type) ?? [];
        this.sessionCommandWaitersByType.set(type, current.filter((item) => item !== waiter));
        resolve();
      }, timeoutMs);
    });
  }

  emitTokenUsage(command: SessionCommand) {
    const threadId = command.threadId ?? this.options.threadId;
    if (!command.turnId) throw new Error(`fake turn missing turnId: ${JSON.stringify(command)}`);
    this.emitTokenUsageForTurnId(threadId, command.turnId);
  }

  emitAccountRateLimits(secondaryUsedPercent = 64, secondaryWindowMinutes = 10080) {
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: {
        type: "account_rate_limits_updated",
        heartbeat: false,
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent: 12.5,
            windowDurationMins: 300,
            resetsAt: 1781058359
          },
          secondary: {
            usedPercent: secondaryUsedPercent,
            windowDurationMins: secondaryWindowMinutes,
            resetsAt: 1781140554
          },
          credits: null,
          planType: "pro",
          rateLimitReachedType: null
        }
      }
    });
  }

  emitWeeklyAccountRateLimits(usedPercent: number) {
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: {
        type: "account_rate_limits_updated",
        heartbeat: false,
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent,
            windowDurationMins: 10080,
            resetsAt: 1781140554
          },
          secondary: null,
          credits: null,
          planType: "pro",
          rateLimitReachedType: null
        }
      }
    });
  }

  emitSparsePrimaryAccountRateLimit(usedPercent: number) {
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: {
        type: "account_rate_limits_updated",
        heartbeat: false,
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: {
            usedPercent,
            windowDurationMins: null,
            resetsAt: null
          },
          secondary: null,
          credits: null,
          planType: "pro",
          rateLimitReachedType: null
        }
      }
    });
  }

  emitContextTokenUsage(turnId: string) {
    this.emitTokenUsageForTurnId(this.options.threadId, turnId, {
      tokenUsage: {
        last: {
          inputTokens: 321,
          cachedInputTokens: 123,
          outputTokens: 222,
          reasoningOutputTokens: 111,
          totalTokens: 654
        },
        total: {
          inputTokens: 321,
          cachedInputTokens: 123,
          outputTokens: 222,
          reasoningOutputTokens: 111,
          totalTokens: 543
        },
        modelContextWindow: 456000
      }
    });
  }

  emitTokenUsageForTurnId(
    threadId: string,
    turnId: string,
    options: {
      tokenUsage?: Record<string, unknown>;
    } = {}
  ) {
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: {
        type: "thread_event",
        threadId,
        heartbeat: false,
        message: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId,
            turnId,
            tokenUsage: {
              ...(options.tokenUsage ?? {
                last: {
                  inputTokens: 1200,
                  cachedInputTokens: 800,
                  outputTokens: 90,
                  reasoningOutputTokens: 10,
                  totalTokens: 1300
                },
                total: {
                  inputTokens: 1200,
                  cachedInputTokens: 800,
                  outputTokens: 90,
                  reasoningOutputTokens: 10,
                  totalTokens: 1290
                },
                modelContextWindow: 200000
              })
            }
          }
        }
      }
    });
  }

  emitUserMessage(turnId: string, itemId: string, text: string) {
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: {
        type: "thread_event",
        threadId: this.options.threadId,
        heartbeat: false,
        message: {
          method: "item/completed",
          params: {
            threadId: this.options.threadId,
            turnId,
            item: {
              id: itemId,
              type: "userMessage",
              content: [{ type: "text", text }]
            }
          }
        }
      }
    });
  }

  emitTurnsSnapshotWithUser(turnId: string, itemId: string, text: string) {
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: turnSnapshot(this.options.threadId, [
        appServerTurn(turnId, {
          startedAt: 1781058300,
          completedAt: 1781058360,
          durationMs: 60_000,
          items: [
            { id: itemId, type: "userMessage", content: [{ type: "text", text }] },
            { id: `${turnId}-agent`, type: "agentMessage", text: "usage snapshot final answer" }
          ]
        })
      ])
    });
  }

  emitTurnsSnapshot(turnId: string) {
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: turnSnapshot(this.options.threadId, [
        appServerTurn(turnId, {
          startedAt: 1781058300,
          completedAt: 1781058360,
          durationMs: 60_000,
          items: [{
            id: `${turnId}-agent`,
            type: "agentMessage",
            text: "historical snapshot final answer"
          }]
        })
      ])
    });
  }

  completeTurn(command: SessionCommand, status: "completed" | "interrupted" = "completed") {
    this.emitTurnCompleted(command, status);
  }

  failTurn(command: SessionCommand, message: string) {
    this.emitTurnCompleted(command, "failed", message);
  }

  emitTurnCompleted(
    command: SessionCommand,
    status: "completed" | "failed" | "interrupted",
    message?: string,
    turnId = command.turnId ?? `fake-turn-${command.commandId}`
  ) {
    const threadId = command.threadId ?? this.options.threadId;
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: turnCompleted(threadId, turnId, { status, errorMessage: message })
    });
  }

  emitGoalUpdated(goal: Record<string, unknown>) {
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: {
        type: "thread_event",
        threadId: this.options.threadId,
        heartbeat: false,
        message: {
          method: "thread/goal/updated",
          params: {
            threadId: this.options.threadId,
            goal
          }
        }
      }
    });
  }

  emitGoalSnapshot(goal: Record<string, unknown> | null) {
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: {
        type: "thread_event",
        threadId: this.options.threadId,
        heartbeat: false,
        historical: true,
        message: { result: { goal } }
      }
    });
  }

  private handleMessage(data: unknown) {
    const message = JSON.parse(String(data)) as {
      type: string;
      commands?: MachineCommand[] | SessionCommand[];
    };
    assertNoWorkerId(message, `machine websocket ${message.type}`);
    if (message.type === "commands") {
      for (const command of message.commands as MachineCommand[] ?? []) this.handleMachineCommand(command);
    }
    if (message.type === "session_commands") {
      for (const command of message.commands as SessionCommand[] ?? []) this.handleSessionCommand(command);
    }
  }

  private handleMachineCommand(command: MachineCommand) {
    if (command.type !== "start_session") {
      this.send({ type: "command_error", commandId: command.commandId, message: `Unsupported machine command: ${command.type}` });
      return;
    }
    this.registerSession();
    this.send({
      type: "command_result",
      commandId: command.commandId,
      result: {
        sessionId: this.options.sessionId,
        threadId: this.options.threadId,
        appServerUrl: "ws://127.0.0.1:9",
        cwd: this.options.cwd,
        reused: this.sessionRegistered
      }
    });
  }

  private handleSessionCommand(command: SessionCommand) {
    this.recordSessionCommand(command);
    if (command.type === "resume_thread" || command.type === "start_thread") {
      this.send({
        type: "session_command_result",
        sessionId: this.options.sessionId,
        commandId: command.commandId,
        result: { threadId: command.threadId ?? this.options.threadId }
      });
      return;
    }
    if (command.type === "subscribe_thread_records" || command.type === "unsubscribe_thread_records") {
      this.send({
        type: "session_command_result",
        sessionId: this.options.sessionId,
        commandId: command.commandId,
        result: { ok: true }
      });
      return;
    }
    if (command.type === "list_models") {
      this.send({
        type: "session_command_result",
        sessionId: this.options.sessionId,
        commandId: command.commandId,
        result: {
          models: [
            {
              id: "model-gpt-5.6-sol",
              model: "gpt-5.6-sol",
              displayName: "GPT-5.6 Sol",
              description: "Fake smoke model",
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [
                { value: "high", label: "High" },
                { value: "xhigh", label: "Extra High" },
                { value: "max", label: "Max", description: "Maximum reasoning depth" },
                {
                  value: "ultra",
                  label: "Ultra",
                  description: "Maximum reasoning with automatic task delegation"
                }
              ],
              defaultServiceTier: "default",
              serviceTiers: [
                { value: "default", label: "Default" },
                { value: "fast", label: "Fast" }
              ]
            }
          ]
        }
      });
      return;
    }
    if (command.type === "list_permission_profiles") {
      this.send({
        type: "session_command_result",
        sessionId: this.options.sessionId,
        commandId: command.commandId,
        result: {
          profiles: [{ id: "team-safe", description: "Fake runtime profile", allowed: true }]
        }
      });
      return;
    }
    if (command.type === "list_command_palette") {
      this.send({
        type: "session_command_result",
        sessionId: this.options.sessionId,
        commandId: command.commandId,
        result: {
          palette: {
            cwd: command.workingDirectory,
            generatedAt: new Date().toISOString(),
            entries: [{
              id: "plugin:fake-plugin",
              kind: "plugin",
              name: "fake-plugin",
              title: "Fake Plugin",
              description: "Fake runtime plugin",
              insertText: "@fake-plugin",
              action: "insert",
              enabled: true
            }]
          }
        }
      });
      return;
    }
    if (command.type !== "turn") {
      if (command.type === "set_goal") {
        if (this.nextSetGoalError) {
          const message = this.nextSetGoalError;
          this.nextSetGoalError = null;
          this.send({
            type: "session_command_error",
            sessionId: this.options.sessionId,
            commandId: command.commandId,
            message
          });
          return;
        }
        this.send({
          type: "session_command_result",
          sessionId: this.options.sessionId,
          commandId: command.commandId,
          result: { ok: true }
        });
        return;
      }
      if (command.type === "clear_goal") {
        if (this.nextClearGoalError) {
          const message = this.nextClearGoalError;
          this.nextClearGoalError = null;
          this.send({
            type: "session_command_error",
            sessionId: this.options.sessionId,
            commandId: command.commandId,
            message
          });
          return;
        }
        this.send({
          type: "session_event",
          sessionId: this.options.sessionId,
          event: {
            type: "thread_event",
            threadId: command.threadId ?? this.options.threadId,
            commandId: command.commandId,
            message: { id: command.commandId, result: { cleared: true } },
            heartbeat: false
          }
        });
        return;
      }
      if (command.type === "compact_thread") {
        this.send({
          type: "session_command_result",
          sessionId: this.options.sessionId,
          commandId: command.commandId,
          result: { ok: true }
        });
        return;
      }
      if (command.type === "review_thread") {
        const turnId = `fake-review-${command.commandId}`;
        this.send({
          type: "session_event",
          sessionId: this.options.sessionId,
          event: executionChanged(command.threadId ?? this.options.threadId, true, turnId)
        });
        this.send({
          type: "session_command_result",
          sessionId: this.options.sessionId,
          commandId: command.commandId,
          result: { ok: true, reviewThreadId: command.threadId ?? this.options.threadId }
        });
        this.emitTurnCompleted(command, "completed", undefined, turnId);
        return;
      }
      if (command.type === "steer") {
        this.pendingSteers.push(command);
        const waiter = this.steerWaiters.shift();
        if (waiter) waiter(this.pendingSteers.shift()!);
        this.send({
          type: "session_command_result",
          sessionId: this.options.sessionId,
          commandId: command.commandId,
          result: { turnId: command.turnId }
        });
        return;
      }
      if (command.type === "stop") {
        this.send({
          type: "session_command_result",
          sessionId: this.options.sessionId,
          commandId: command.commandId,
          result: { ok: true }
        });
        return;
      }
      this.send({
        type: "session_command_error",
        sessionId: this.options.sessionId,
        commandId: command.commandId,
        message: `Unsupported session command: ${command.type}`
      });
      return;
    }
    const turn = { ...command, turnId: `fake-turn-${command.commandId}` };
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: executionChanged(command.threadId ?? this.options.threadId, true, turn.turnId)
    });
    this.pendingTurns.push(turn);
    const waiter = this.turnWaiters.shift();
    if (waiter) waiter(this.pendingTurns.shift()!);
  }

  private recordSessionCommand(command: SessionCommand) {
    const waiters = this.sessionCommandWaitersByType.get(command.type) ?? [];
    const waiter = waiters.shift();
    if (waiter) {
      this.sessionCommandWaitersByType.set(command.type, waiters);
      waiter(command);
      return;
    }
    const pending = this.pendingSessionCommandsByType.get(command.type) ?? [];
    pending.push(command);
    this.pendingSessionCommandsByType.set(command.type, pending);
  }

  private registerSession() {
    if (this.sessionRegistered) return;
    this.sessionRegistered = true;
    this.send({
      type: "session_register",
      sessionId: this.options.sessionId,
      commandCursor: 0,
      registration: {
        machineId: this.options.machineId,
	        name: "Task Lock Fake Session",
	        workingDirectory: this.options.cwd,
	        appServerUrl: "ws://127.0.0.1:9",
	        hostname: "task-lock-host"
	      }
	    });
  }

  private waitForTurn(timeoutMs = 5000) {
    const existing = this.pendingTurns.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise<SessionCommand>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for fake session turn command")), timeoutMs);
      this.turnWaiters.push((command) => {
        clearTimeout(timer);
        resolve(command);
      });
    });
  }

  private waitForSteer(timeoutMs = 5000) {
    const existing = this.pendingSteers.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise<SessionCommand>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for fake session steer command")), timeoutMs);
      this.steerWaiters.push((command) => {
        clearTimeout(timer);
        resolve(command);
      });
    });
  }

  private waitForSessionCommand(type: string, timeoutMs = 5000) {
    const existing = this.pendingSessionCommandsByType.get(type)?.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise<SessionCommand>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for fake session ${type} command`)), timeoutMs);
      const waiters = this.sessionCommandWaitersByType.get(type) ?? [];
      waiters.push((command) => {
        clearTimeout(timer);
        resolve(command);
      });
      this.sessionCommandWaitersByType.set(type, waiters);
    });
  }

  private send(message: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error("fake machine websocket is not open");
    this.ws.send(JSON.stringify(message));
  }
}

const waitForMachine = async (apiBase: string, machineId: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const data = await apiJson<{ machines?: MachineSummary[] }>(apiBase, "/api/machines").catch(() => ({ machines: [] }));
    const machine = data.machines?.find((item) => item.machineId === machineId && item.online && item.capabilities?.projectLauncher);
    if (machine) return machine;
    await delay(100);
  }
  throw new Error(`fake machine did not register: ${machineId}`);
};

const waitForTaskStatus = async (
  apiBase: string,
  taskId: string,
  status: NonNullable<LocalTask["lastStatus"]>
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const data = await apiJson<{ tasks?: LocalTask[] }>(apiBase, "/api/tasks");
    const task = data.tasks?.find((item) => item.taskId === taskId);
    if (task?.lastStatus === status) return task;
    await delay(100);
  }
  throw new Error(`task ${taskId} did not reach status ${status}`);
};

const assertRuntimeAccountRateLimits = async (
  apiBase: string,
  machineId: string,
  expected: {
    primaryUsedPercent?: number;
    primaryResetsAt?: number;
  } = {}
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const data = await apiJson<{ runtimes?: PartialRuntimeSummary[] }>(apiBase, "/api/runtimes");
    const accountRateLimits = data.runtimes?.find((runtime) => runtime.machineId === machineId)?.accountRateLimits;
    const primary = accountRateLimits?.primaryRateLimit;
    const secondary = accountRateLimits?.secondaryRateLimit;
    if (
      primary?.usedPercent === (expected.primaryUsedPercent ?? 12.5)
      && primary.windowMinutes === 300
      && primary.resetsAt === (expected.primaryResetsAt ?? 1781058359)
      && secondary?.usedPercent === 64
      && secondary.windowMinutes === 10080
      && secondary.resetsAt === 1781140554
    ) return;
    await delay(100);
  }
  throw new Error(`runtime ${machineId} did not receive account rate limits`);
};

const assertThreadUsageContext = async (
  apiBase: string,
  threadId: string,
  usedTokens: number,
  windowTokens: number
) => {
  const detail = await waitForThreadUsageContext(apiBase, threadId, usedTokens, windowTokens);
  const usageRecord = detail.records?.find((record) => {
    const payload = objectValue(record.payload);
    const info = objectValue(payload?.info);
    const lastUsage = objectValue(info?.last_token_usage);
    return record.type === "event_msg"
      && payload?.type === "token_count"
      && lastUsage?.input_tokens === usedTokens;
  });
  const payload = objectValue(usageRecord?.payload);
  const info = objectValue(payload?.info);
  const lastUsage = objectValue(info?.last_token_usage);
  if (
    !usageRecord
    || lastUsage?.cached_input_tokens !== 123
    || lastUsage?.output_tokens !== 222
    || lastUsage?.reasoning_output_tokens !== 111
    || lastUsage?.total_tokens !== 654
    || info?.model_context_window !== windowTokens
  ) {
    throw new Error(`token_count record did not normalize usage context: ${JSON.stringify(usageRecord)}`);
  }
};

const assertStatusUsage = async (
  apiBase: string,
  threadId: string,
  expected: { input: number; output: number; total: number }
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const detail = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    const usageRecord = detail.records?.find((record) => {
      const payload = objectValue(record.payload);
      const usage = objectValue(payload?.usage);
      return record.type === "event_msg"
        && payload?.type === "status_usage"
        && usage?.input_tokens === expected.input
        && usage.output_tokens === expected.output
        && usage.total_tokens === expected.total;
    });
    if (usageRecord) return;
    await delay(100);
  }
  throw new Error(`thread ${threadId} did not reach status usage ${JSON.stringify(expected)}`);
};

const assertTurnTokenUsageRecords = async (
  apiBase: string,
  threadId: string,
  turnId: string,
  expectedTotals: number[]
) => {
  const idPrefix = `app:${threadId}:${turnId}:usage:`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const detail = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    const totals = (detail.records ?? [])
      .filter((record) => record.id.startsWith(idPrefix))
      .map((record) => {
        const payload = objectValue(record.payload);
        const info = objectValue(payload?.info);
        return objectValue(info?.last_token_usage)?.total_tokens;
      })
      .filter((value): value is number => typeof value === "number")
      .sort((left, right) => left - right);
    const expected = [...expectedTotals].sort((left, right) => left - right);
    if (JSON.stringify(totals) === JSON.stringify(expected)) return;
    await delay(100);
  }
  throw new Error(`turn ${turnId} did not preserve token usage records ${JSON.stringify(expectedTotals)}`);
};

const waitForThreadUsageContext = async (
  apiBase: string,
  threadId: string,
  usedTokens: number,
  windowTokens: number
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const detail = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    const context = detail.threadUsage?.context;
    if (context?.usedTokens === usedTokens && context.windowTokens === windowTokens) return detail;
    await delay(100);
  }
  throw new Error(`thread ${threadId} did not receive token usage context`);
};

const waitForGoalStatus = async (
  apiBase: string,
  threadId: string,
  status: string,
  objective: string
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const detail = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    const match = detail.records?.some((record) => {
      const payload = objectValue(record.payload);
      const goal = objectValue(payload?.goal);
      return payload?.type === "thread_goal_updated"
        && goal?.objective === objective
        && goal.status === status;
    });
    if (match) return detail;
    await delay(100);
  }
  throw new Error(`thread ${threadId} did not reach goal status ${status}`);
};

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const assertHistoricalSnapshotPublishesMarkedRecordEvents = async (apiBase: string, threadId: string, fake: FakeMachine) => {
  const subscription = await subscribeThread(apiBase, threadId);
  try {
    const subscribe = await fake.nextSessionCommand("subscribe_thread_records");
    if (subscribe.threadId !== threadId) throw new Error(`subscribe command used wrong thread: ${JSON.stringify(subscribe)}`);
    subscription.messages.length = 0;

    fake.emitGoalSnapshot({
      threadId,
      objective: "historical goal/get snapshot",
      status: "active",
      tokenBudget: null,
      tokensUsed: 1,
      timeUsedSeconds: 2,
      createdAt: 1,
      updatedAt: 2
    });
    await waitForRealtimeMessage(
      subscription.messages,
      (message) => message.type === "record"
        && message.historical === true
        && objectValue(message.record?.payload)?.type === "thread_goal_updated",
      "historical goal/get snapshot"
    );
    fake.emitGoalSnapshot(null);
    await waitForRealtimeMessage(
      subscription.messages,
      (message) => message.type === "record"
        && message.historical === true
        && objectValue(message.record?.payload)?.type === "thread_goal_cleared",
      "historical empty goal/get snapshot"
    );

    const turnId = `historical-turn-${process.pid}`;
    fake.emitTurnsSnapshot(turnId);
    await waitForRealtimeMessage(
      subscription.messages,
      (message) =>
        message.type === "record"
        && message.historical === true
        && typeof message.record?.id === "string"
        && message.record.id.includes(`:${turnId}:`),
      "historical snapshot record event"
    );
    await delay(100);
    const unmarkedHistoricalRecordEvent = subscription.messages.find((message) =>
      message.type === "record"
      && message.historical !== true
      && typeof message.record?.id === "string"
      && message.record.id.includes(`:${turnId}:`)
    );
    if (unmarkedHistoricalRecordEvent) {
      throw new Error(`historical snapshot published an unmarked record event: ${JSON.stringify(unmarkedHistoricalRecordEvent)}`);
    }

    const detail = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    if (!detail.records?.some((record) => {
      const payload = objectValue(record.payload);
      return record.type === "event_msg" && payload?.type === "task_complete" && payload.turn_id === turnId;
    })) {
      throw new Error(`historical snapshot task_complete was not retained in thread detail: ${JSON.stringify(detail.records)}`);
    }
  } finally {
    subscription.ws.send(JSON.stringify({ type: "unsubscribe_thread", threadId }));
    await fake.nextSessionCommand("unsubscribe_thread_records").catch(() => undefined);
    subscription.ws.close();
  }
};

const assertThreadRecordSubscription = async (apiBase: string, threadId: string, fake: FakeMachine) => {
  const first = await subscribeThread(apiBase, threadId);
  try {
    const subscribe = await fake.nextSessionCommand("subscribe_thread_records");
    if (subscribe.threadId !== threadId) throw new Error(`subscribe command used wrong thread: ${JSON.stringify(subscribe)}`);

    const second = await subscribeThread(apiBase, threadId);
    try {
      await fake.expectNoSessionCommand("subscribe_thread_records", 100);
      first.ws.send(JSON.stringify({ type: "unsubscribe_thread", threadId }));
      await fake.expectNoSessionCommand("unsubscribe_thread_records", 100);
      second.ws.send(JSON.stringify({ type: "unsubscribe_thread", threadId }));
      const unsubscribe = await fake.nextSessionCommand("unsubscribe_thread_records");
      if (unsubscribe.threadId !== threadId) throw new Error(`unsubscribe command used wrong thread: ${JSON.stringify(unsubscribe)}`);
    } finally {
      second.ws.close();
    }
  } finally {
    first.ws.close();
  }
};

const assertAppServerOnlyThreadSubscription = async (apiBase: string, threadId: string, fake: FakeMachine) => {
  const subscription = await subscribeThread(apiBase, threadId);
  try {
    const subscribe = await fake.nextSessionCommand("subscribe_thread_records");
    if (subscribe.threadId !== threadId) throw new Error(`subscribe command used wrong thread: ${JSON.stringify(subscribe)}`);

    const detail = await apiJson<Record<string, unknown>>(
      apiBase,
      `/api/threads/${encodeURIComponent(threadId)}`
    );
    if (!Array.isArray(detail.records)) throw new Error(`thread detail did not expose normalized records: ${JSON.stringify(detail)}`);

    subscription.ws.send(JSON.stringify({ type: "unsubscribe_thread", threadId }));
    const unsubscribe = await fake.nextSessionCommand("unsubscribe_thread_records");
    if (unsubscribe.threadId !== threadId) throw new Error(`unsubscribe command used wrong thread: ${JSON.stringify(unsubscribe)}`);
  } finally {
    subscription.ws.close();
  }
};

const subscribeThread = async (apiBase: string, threadId: string) => {
  const messages: RealtimeMessage[] = [];
  const ws = new WebSocket(webRealtimeUrl(apiBase));
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as RealtimeMessage);
  });
  await waitForWebSocketOpen(ws);
  ws.send(JSON.stringify({ type: "subscribe_thread", threadId, after: 0 }));
  await waitForRealtimeMessage(
    messages,
    (message) => message.type === "thread_subscribed" && message.threadId === threadId,
    "thread subscription acknowledgement"
  );
  return { ws, messages };
};

const waitForRealtimeMessage = async (
  messages: RealtimeMessage[],
  predicate: (message: RealtimeMessage) => boolean,
  label: string,
  timeoutMs = 5000
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const message = messages.find(predicate);
    if (message) return message;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const expectApiError = async (
  apiBase: string,
  pathname: string,
  init: RequestInit,
  expectedStatus: number
) => {
  const response = await fetch(new URL(pathname, apiBase), {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`expected HTTP ${expectedStatus} ${pathname}, got ${response.status}: ${text}`);
  }
};

const machineTransportUrl = (apiBase: string) => {
  const url = new URL("/api/machines/connect", apiBase);
  url.protocol = "ws:";
  return url.toString();
};

const webRealtimeUrl = (apiBase: string) => {
  const url = new URL("/api/events/ws", apiBase);
  url.protocol = "ws:";
  return url.toString();
};

const waitForWebSocketOpen = async (ws: WebSocket) => await new Promise<void>((resolve, reject) => {
  if (ws.readyState === WebSocket.OPEN) {
    resolve();
    return;
  }
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", () => reject(new Error("fake machine websocket failed")), { once: true });
});

await main();
