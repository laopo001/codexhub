import { mkdir, mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

type MachineSummary = {
  machineId: string;
  online?: boolean;
  capabilities?: {
    projectLauncher?: boolean;
  };
};

type ProjectThreadStartResponse = {
  result?: {
    sessionId?: string;
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
  windowMinutes?: number;
  resetsAt?: number;
};

type PartialThreadUsage = {
  context?: {
    usedTokens?: number;
    windowTokens?: number;
  } | null;
  primaryRateLimit?: PartialRateLimitWindow | null;
  secondaryRateLimit?: PartialRateLimitWindow | null;
};

type ThreadDetail = {
  threadUsage?: PartialThreadUsage;
  records?: Array<{
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
  includeHidden?: boolean;
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
    collaborationMode?: "default" | "plan" | null;
    goalMode?: boolean | null;
    goalObjective?: string | null;
    goalTokenBudget?: number | null;
    serviceTier?: string | null;
  };
};

const main = async () => {
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
    if (open.result?.sessionId !== fake.sessionId || open.result?.threadId !== fake.threadId) {
      throw new Error(`project thread start returned unexpected session/thread: ${JSON.stringify(open)}`);
    }
    const modelCatalogPromise = apiJson<{
      models?: Array<{
        model?: string;
        supportedReasoningEfforts?: Array<{ value?: string }>;
        serviceTiers?: Array<{ value?: string }>;
      }>;
    }>(apiBase, `/api/sessions/${encodeURIComponent(fake.sessionId)}/models`);
    const modelListCommand = await fake.nextSessionCommand("list_models");
    if (modelListCommand.includeHidden !== false) {
      throw new Error(`model catalog command should not include hidden models by default: ${JSON.stringify(modelListCommand)}`);
    }
    const modelCatalog = await modelCatalogPromise;
    const catalogModel = modelCatalog.models?.find((model) => model.model === "gpt-5.5");
    if (!catalogModel) {
      throw new Error(`model catalog response missing gpt-5.5: ${JSON.stringify(modelCatalog)}`);
    }
    if (!catalogModel.supportedReasoningEfforts?.some((option) => option.value === "xhigh")) {
      throw new Error(`model catalog response missing reasoning effort: ${JSON.stringify(modelCatalog)}`);
    }
    if (!catalogModel.serviceTiers?.some((option) => option.value === "fast")) {
      throw new Error(`model catalog response missing fast service tier: ${JSON.stringify(modelCatalog)}`);
    }
    console.log("session model catalog ok");
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
    if (modeTurn.options?.collaborationMode !== "plan" || modeTurn.options?.goalMode !== true) {
      throw new Error(`web turn mode options were not forwarded: ${JSON.stringify(modeTurn.options)}`);
    }
    if (modeTurn.options.goalObjective !== "finish the plan and goal smoke" || modeTurn.options.goalTokenBudget !== 1234) {
      throw new Error(`web turn goal options were not forwarded: ${JSON.stringify(modeTurn.options)}`);
    }
    if (modeTurn.options.serviceTier !== "priority") {
      throw new Error(`web turn service tier option was not forwarded: ${JSON.stringify(modeTurn.options)}`);
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
    const usageScopeItemId = `${activeWebTurnId}-usage-user`;
    fake.emitUserMessage(activeWebTurnId, usageScopeItemId, "steered web follow-up");
    fake.emitTokenUsage(activeWebTurn);
    fake.emitTokenUsageForTurnId(fake.threadId, activeWebTurnId, {
      rateLimits: {
        primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1781058359 },
        secondary: { usedPercent: 64, windowMinutes: 10080, resetsAt: 1781140554 }
      },
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
    fake.emitTokenUsageForTurnId(fake.threadId, activeWebTurnId, {
      rateLimits: {
        primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1781058359 },
        secondary: { usedPercent: 64, windowMinutes: 10080, resetsAt: 1781140554 }
      },
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
      rateLimits: {
        primary: { usedPercent: 12.5, windowMinutes: 300, resetsAt: 1781058359 },
        secondary: { usedPercent: 64, windowMinutes: 10080, resetsAt: 1781140554 }
      },
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
    await assertThreadUsageRateLimits(apiBase, fake.threadId);
    fake.emitTokenUsageWithoutRateLimits("context-only-usage");
    await assertThreadUsageRateLimits(apiBase, fake.threadId);
    fake.emitSnakeCaseTokenUsageWithoutRateLimits("snake-context-usage");
    await assertThreadUsageContext(apiBase, fake.threadId, 321, 456000);
    await assertThreadUsageRateLimits(apiBase, fake.threadId);
    console.log("app-server token usage rate limits ok");
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
      objective: "status-only app-server goal",
      status: "active",
      tokenBudget: 777
    });
    fake.emitGoalUpdated({ status: "paused" });
    const statusOnlyGoalDetail = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(fake.threadId)}`);
    const statusOnlyGoalRecords = statusOnlyGoalDetail.records?.filter((record) => {
      const payload = objectValue(record.payload);
      return payload?.type === "thread_goal_updated";
    }) ?? [];
    const latestStatusOnlyGoalPayload = objectValue(statusOnlyGoalRecords.at(-1)?.payload);
    const latestStatusOnlyGoal = objectValue(latestStatusOnlyGoalPayload?.goal);
    if (
      latestStatusOnlyGoal?.objective !== "status-only app-server goal"
      || latestStatusOnlyGoal.status !== "paused"
      || latestStatusOnlyGoal.tokenBudget !== 777
    ) {
      throw new Error(`status-only goal update did not preserve goal fields: ${JSON.stringify(latestStatusOnlyGoal)}`);
    }
    console.log("app-server status-only goal update preserves objective ok");

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
    fake.emitTokenUsage(nonWeeklyTurn, 64, 300);
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
    if (
      consumeTurn.input !== consumeObjective
      || consumeTurn.options?.goalMode !== true
      || consumeTurn.options.goalObjective !== consumeObjective
    ) {
      throw new Error(`consume goal initial turn mismatch: ${JSON.stringify(consumeTurn)}`);
    }
    fake.emitTokenUsage(consumeTurn, 64);
    fake.emitGoalUpdated({ objective: consumeObjective, status: "complete" });
    await waitForGoalStatus(apiBase, fake.threadId, "complete", consumeObjective);
    fake.completeTurn(consumeTurn);
    const retryTurn = await fake.nextTurn();
    if (
      retryTurn.input !== consumeObjective
      || retryTurn.options?.goalMode !== true
      || retryTurn.options.goalObjective !== consumeObjective
    ) {
      throw new Error(`consume goal retry turn mismatch: ${JSON.stringify(retryTurn)}`);
    }
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
    fake.emitTokenUsage(retryTurn, 84);
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
    if (
      resumedTurn.input !== rateLimitedObjective
      || resumedTurn.options?.goalMode !== true
      || resumedTurn.options.goalObjective !== rateLimitedObjective
    ) {
      throw new Error(`consume goal resumed turn mismatch: ${JSON.stringify(resumedTurn)}`);
    }
    fake.emitTokenUsage(resumedTurn, 95);
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
    fake.emitTokenUsage(stoppedTurn, 64);
    fake.completeTurn(stoppedTurn);
    await fake.expectNoTurn(150);
    console.log("consume-until manual stop halts continuation ok");

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

  emitTokenUsage(command: SessionCommand, secondaryUsedPercent = 64, secondaryWindowMinutes = 10080) {
    const threadId = command.threadId ?? this.options.threadId;
    if (!command.turnId) throw new Error(`fake turn missing turnId: ${JSON.stringify(command)}`);
    this.emitTokenUsageForTurnId(threadId, command.turnId, {
      rateLimits: {
        primary: {
          usedPercent: 12.5,
          windowMinutes: 300,
          resetsAt: 1781058359
        },
        secondary: {
          usedPercent: secondaryUsedPercent,
          windowMinutes: secondaryWindowMinutes,
          resetsAt: 1781140554
        }
      }
    });
  }

  emitTokenUsageWithoutRateLimits(turnId: string) {
    this.emitTokenUsageForTurnId(this.options.threadId, turnId);
  }

  emitSnakeCaseTokenUsageWithoutRateLimits(turnId: string) {
    this.emitTokenUsageForTurnId(this.options.threadId, turnId, {
      tokenUsage: {
        last: {
          input_tokens: 321,
          cached_input_tokens: 123,
          output_tokens: 222,
          reasoning_output_tokens: 111,
          total_tokens: 654
        },
        total: {
          input_tokens: 321,
          cached_input_tokens: 123,
          output_tokens: 222,
          reasoning_output_tokens: 111,
          total_tokens: 543
        },
        model_context_window: 456000
      }
    });
  }

  emitTokenUsageForTurnId(
    threadId: string,
    turnId: string,
    options: {
      rateLimits?: {
        primary: { usedPercent: number; windowMinutes: number; resetsAt: number };
        secondary: { usedPercent: number; windowMinutes: number; resetsAt: number };
      };
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
              }),
              ...(options.rateLimits
                ? {
                  rateLimits: {
                    limitId: "codex",
                    limitName: null,
                    primary: options.rateLimits.primary,
                    secondary: options.rateLimits.secondary,
                    credits: null,
                    individualLimit: null,
                    planType: "pro",
                    rateLimitReachedType: null
                  }
                }
                : {})
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
      event: {
        type: "thread_turns_snapshot",
        threadId: this.options.threadId,
        heartbeat: false,
        turns: [{
          id: turnId,
          startedAt: 1781058300,
          completedAt: 1781058360,
          items: [
            { id: itemId, type: "userMessage", content: [{ type: "text", text }] },
            { id: `${turnId}-agent`, type: "agentMessage", text: "usage snapshot final answer" }
          ]
        }]
      }
    });
  }

  emitTurnsSnapshot(turnId: string) {
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: {
        type: "thread_turns_snapshot",
        threadId: this.options.threadId,
        heartbeat: false,
        turns: [
          {
            id: turnId,
            startedAt: 1781058300,
            completedAt: 1781058360,
            items: [
              {
                id: `${turnId}-agent`,
                type: "agentMessage",
                text: "historical snapshot final answer"
              }
            ]
          }
        ]
      }
    });
  }

  completeTurn(command: SessionCommand) {
    this.send({
      type: "session_event",
      sessionId: this.options.sessionId,
      event: {
        type: "thread_execution_changed",
        threadId: command.threadId ?? this.options.threadId,
        running: false,
        heartbeat: false
      }
    });
    this.send({
      type: "session_command_result",
      sessionId: this.options.sessionId,
      commandId: command.commandId,
      result: { ok: true }
    });
  }

  failTurn(command: SessionCommand, message: string) {
    this.send({
      type: "session_command_error",
      sessionId: this.options.sessionId,
      commandId: command.commandId,
      message
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
              id: "model-gpt-5.5",
              model: "gpt-5.5",
              displayName: "GPT-5.5",
              description: "Fake smoke model",
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [
                { value: "high", label: "High" },
                { value: "xhigh", label: "XHigh" }
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
          event: {
            type: "thread_execution_changed",
            threadId: command.threadId ?? this.options.threadId,
            running: true,
            turnId,
            heartbeat: false
          }
        });
        this.send({
          type: "session_command_result",
          sessionId: this.options.sessionId,
          commandId: command.commandId,
          result: { ok: true, reviewThreadId: command.threadId ?? this.options.threadId }
        });
        this.send({
          type: "session_event",
          sessionId: this.options.sessionId,
          event: {
            type: "thread_execution_changed",
            threadId: command.threadId ?? this.options.threadId,
            running: false,
            heartbeat: false
          }
        });
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
      event: {
        type: "thread_execution_changed",
        threadId: command.threadId ?? this.options.threadId,
        running: true,
        turnId: turn.turnId,
        heartbeat: false
      }
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

const assertThreadUsageRateLimits = async (apiBase: string, threadId: string) => {
  const detail = await waitForThreadUsage(apiBase, threadId);
  const primary = detail.threadUsage?.primaryRateLimit;
  const secondary = detail.threadUsage?.secondaryRateLimit;
  if (
    primary?.usedPercent !== 12.5
    || primary.windowMinutes !== 300
    || primary.resetsAt !== 1781058359
    || secondary?.usedPercent !== 64
    || secondary.windowMinutes !== 10080
    || secondary.resetsAt !== 1781140554
  ) {
    throw new Error(`thread usage did not include rate limits: ${JSON.stringify(detail.threadUsage)}`);
  }
  const usageRecord = detail.records?.find((record) => {
    const payload = objectValue(record.payload);
    return record.type === "event_msg" && payload?.type === "token_count";
  });
  const rateLimits = objectValue(objectValue(usageRecord?.payload)?.rate_limits);
  const recordPrimary = objectValue(rateLimits?.primary);
  const recordSecondary = objectValue(rateLimits?.secondary);
  if (
    recordPrimary?.used_percent !== 12.5
    || recordPrimary.window_minutes !== 300
    || recordPrimary.resets_at !== 1781058359
    || recordSecondary?.used_percent !== 64
    || recordSecondary.window_minutes !== 10080
    || recordSecondary.resets_at !== 1781140554
  ) {
    throw new Error(`token_count record did not preserve rate_limits: ${JSON.stringify(usageRecord)}`);
  }
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

const waitForThreadUsage = async (apiBase: string, threadId: string) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const detail = await apiJson<ThreadDetail>(apiBase, `/api/threads/${encodeURIComponent(threadId)}`);
    if (detail.threadUsage?.primaryRateLimit && detail.threadUsage.secondaryRateLimit) return detail;
    await delay(100);
  }
  throw new Error(`thread ${threadId} did not receive token usage rate limits`);
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

const apiJson = async <T = unknown>(apiBase: string, pathname: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(new URL(pathname, apiBase), {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`HTTP ${response.status} ${pathname}: ${text}`);
  return data as T;
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

const assertNoWorkerId = (value: unknown, label: string) => {
  const path = findKey(value, "workerId");
  if (path) throw new Error(`${label} exposed workerId at ${path}`);
};

const findKey = (value: unknown, key: string, trail = "$"): string | null => {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findKey(value[index], key, `${trail}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const entryTrail = `${trail}.${entryKey}`;
    if (entryKey === key) return entryTrail;
    const found = findKey(entryValue, key, entryTrail);
    if (found) return found;
  }
  return null;
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

const findFreePort = async () => await new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close(() => reject(new Error("failed to allocate port")));
      return;
    }
    const port = address.port;
    server.close(() => resolve(port));
  });
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await main();
