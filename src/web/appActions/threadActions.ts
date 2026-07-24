import type React from "react";
import type { AppServerApprovalDecision, AppServerUserInputAnswers, RealtimeOutgoingMessage, ThreadGoalUpdateInput } from "../../shared/apiContract.js";
import { apiRoutes } from "../../shared/apiRoutes.js";
import type { ProxyInput } from "../../shared/inputTypes.js";
import type { CodexRecord } from "../../shared/recordTypes.js";
import {
  adjacentThreadId,
  apiRouteJson,
  authFetch,
  appendThreadOrder,
  composeUserInputText,
  fastCommandAction,
  fileToDataUrl,
  isModelCommand,
  patchProjectsThread,
  patchRuntimesThread,
  removeProjectsThread,
  removeRuntimesThread,
  removeThreadOrder,
  selectedThreadOptions,
  submissionFailedRecord,
  type ComposerDraftStore,
  threadRecordsForNotifications
} from "../appHelpers.js";
import type {
  OpenThreadState,
  GoalDialogState,
  ProjectSummary,
  ProjectsPayload,
  RuntimeSummary,
  ThreadDetail,
  ThreadRenameDialogState,
} from "../types.js";
import type { OpenThreadAction } from "../openThreadReducer.js";
import { apiErrorDetails } from "../helpers/apiErrors.js";

type RealtimeThreadMessage = Extract<RealtimeOutgoingMessage, { type: "subscribe_thread" | "unsubscribe_thread" }>;

type ThreadActionsContext = {
  activeRuntime?: RuntimeSummary | null;
  activeTabThreadId: string;
  closedThreadIds: React.MutableRefObject<Set<string>>;
  composerDraftStore: ComposerDraftStore;
  forkingMessageKey: string;
  goalDialog: GoalDialogState | null;
  threadRenameDialog: ThreadRenameDialogState | null;
  latestRequestedThreadId: React.MutableRefObject<string>;
  notificationRecordsByThread: React.MutableRefObject<Map<string, CodexRecord[]>>;
  openingThreads: React.MutableRefObject<Map<string, Promise<void>>>;
  realtimeThreadSubscriptions: React.MutableRefObject<Set<string>>;
  selectedProjectKey: string;
  openThreads: OpenThreadState[];
  threadLastSeqs: React.MutableRefObject<Map<string, number>>;
  setActiveMachineId: React.Dispatch<React.SetStateAction<string>>;
  setActiveTabThreadByMachine: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setActiveTabThreadId: React.Dispatch<React.SetStateAction<string>>;
  setActiveWorkspacePath: React.Dispatch<React.SetStateAction<string>>;
  setForkingMessageKey: React.Dispatch<React.SetStateAction<string>>;
  setGoalDialog: React.Dispatch<React.SetStateAction<GoalDialogState | null>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectSummary[]>>;
  setThreadModelDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setThreadRenameDialog: React.Dispatch<React.SetStateAction<ThreadRenameDialogState | null>>;
  setRuntimeList: React.Dispatch<React.SetStateAction<RuntimeSummary[]>>;
  dispatchOpenThreads: React.Dispatch<OpenThreadAction>;
  setThreadOrderByMachine: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
};

export type ThreadActionsDependencies = {
  handleLocalComposerCommand: (input: string) => boolean;
  primeTaskCompletionFeedback: () => void;
  refreshProjects: () => Promise<ProjectsPayload>;
  refreshRuntimes: () => Promise<RuntimeSummary[]>;
  resetComposerHistory: (threadId: string) => void;
  sendRealtime: (message: RealtimeThreadMessage) => boolean;
  showActionError: (key: string, title: string, message: string) => void;
  showForkError: (message: string) => void;
};

type ThreadGoalUpdateOptions = {
  dialog?: boolean;
};

export type ThreadActions = {
  openThread: (threadId: string) => Promise<void>;
  clearActiveThreadIfLatest: (threadId: string) => void;
  closeThread: (threadId: string) => Promise<void>;
  removeThreadFromUi: (threadId: string, machineId: string, nextThreadId: string) => void;
  deleteThread: (threadId: string) => Promise<void>;
  subscribeThread: (threadId: string, after: number) => void;
  unsubscribeThread: (threadId: string) => void;
  syncThreadSubscriptions: (threadIds: string[]) => void;
  forkMessage: (threadId: string, messageId: string) => Promise<void>;
  send: (threadId: string) => Promise<void>;
  stopTurn: (threadId: string) => Promise<void>;
  compactThread: (threadId: string) => Promise<void>;
  reviewThread: (threadId: string) => Promise<void>;
  respondToApproval: (threadId: string, approvalId: string, decision: AppServerApprovalDecision) => Promise<void>;
  respondToUserInput: (threadId: string, userInputId: string, answers: AppServerUserInputAnswers) => Promise<void>;
  updateThreadGoal: (threadId: string, goal: ThreadGoalUpdateInput, options?: ThreadGoalUpdateOptions) => Promise<boolean>;
  clearThreadGoal: (threadId: string) => Promise<void>;
  saveGoalDialog: () => Promise<void>;
  saveThreadRenameDialog: () => Promise<void>;
};

export const createThreadActions = (ctx: ThreadActionsContext, deps: ThreadActionsDependencies): ThreadActions => {
  let forkRequestPending = false;
  const runActionRequest = async (
    key: string,
    title: string,
    request: () => Promise<unknown>
  ) => {
    try {
      await request();
    } catch (error) {
      deps.showActionError(key, title, apiErrorDetails(error, { plainHttpMessage: true }).message);
    }
  };

  const openThread = async (threadId: string) => {
    ctx.closedThreadIds.current.delete(threadId);
    ctx.latestRequestedThreadId.current = threadId;
    ctx.setActiveTabThreadId(threadId);
    const updateWorkspaceContext = !ctx.selectedProjectKey;

    const existingThread = ctx.openThreads.find((thread) => thread.threadId === threadId);
    if (existingThread) {
      subscribeThread(threadId, existingThread.lastSeq);
      const machineId = existingThread.runtime.machineId;
      if (machineId) {
        if (updateWorkspaceContext) ctx.setActiveMachineId(machineId);
        ctx.setActiveTabThreadByMachine((current) => ({ ...current, [machineId]: threadId }));
      }
      if (updateWorkspaceContext) ctx.setActiveWorkspacePath(existingThread.workingDirectory);
      return;
    }

    const existingOpen = ctx.openingThreads.current.get(threadId);
    if (existingOpen) return existingOpen;

    const open = (async () => {
      const thread = await apiRouteJson(apiRoutes.thread, threadId);
      const machineId = thread.runtime.machineId;
      if (machineId) {
        ctx.setThreadOrderByMachine((current) => appendThreadOrder(current, machineId, thread.threadId));
      }
      ctx.setRuntimeList((current) => patchRuntimesThread(current, thread));
      ctx.setProjects((current) => patchProjectsThread(current, thread));
      ctx.notificationRecordsByThread.current.set(thread.threadId, threadRecordsForNotifications(thread.threadId, thread));
      ctx.dispatchOpenThreads({ type: "upsert-detail", thread });
      if (ctx.latestRequestedThreadId.current !== thread.threadId) return;
      if (machineId) {
        if (updateWorkspaceContext) ctx.setActiveMachineId(machineId);
        ctx.setActiveTabThreadByMachine((current) => ({ ...current, [machineId]: thread.threadId }));
      }
      if (updateWorkspaceContext) ctx.setActiveWorkspacePath(thread.workingDirectory);
      ctx.setActiveTabThreadId(thread.threadId);
      ctx.threadLastSeqs.current.set(
        thread.threadId,
        Math.max(ctx.threadLastSeqs.current.get(thread.threadId) ?? 0, thread.lastSeq)
      );
      subscribeThread(thread.threadId, thread.lastSeq);
    })();

    ctx.openingThreads.current.set(threadId, open);
    try {
      await open;
    } catch (error) {
      clearActiveThreadIfLatest(threadId);
      throw error;
    } finally {
      ctx.openingThreads.current.delete(threadId);
    }
  };

  const clearActiveThreadIfLatest = (threadId: string) => {
    if (ctx.latestRequestedThreadId.current === threadId) ctx.setActiveTabThreadId("");
  };

  const closeThread = async (threadId: string) => {
    if (ctx.closedThreadIds.current.has(threadId)) return;
    const threadIds = ctx.openThreads.map((thread) => thread.threadId);
    const closingThread = ctx.openThreads.find((thread) => thread.threadId === threadId);
    const machineId = closingThread?.runtime.machineId ?? ctx.activeRuntime?.machineId ?? "";
    const nextThreadId = ctx.activeTabThreadId === threadId
      ? adjacentThreadId(threadIds, threadId)
      : ctx.activeTabThreadId;

    ctx.closedThreadIds.current.add(threadId);
    removeThreadFromUi(threadId, machineId, nextThreadId);
    try {
      await deleteThread(threadId);
      if (ctx.activeTabThreadId === threadId && nextThreadId) {
        await openThread(nextThreadId).catch(() => clearActiveThreadIfLatest(nextThreadId));
      }
    } catch (error) {
      ctx.closedThreadIds.current.delete(threadId);
      window.alert(error instanceof Error ? error.message : String(error));
      await Promise.all([
        deps.refreshRuntimes().catch(() => undefined),
        deps.refreshProjects().catch(() => undefined)
      ]);
    }
  };

  function removeThreadFromUi(threadId: string, machineId: string, nextThreadId: string) {
    ctx.openingThreads.current.delete(threadId);
    ctx.composerDraftStore.delete(threadId);
    ctx.threadLastSeqs.current.delete(threadId);
    unsubscribeThread(threadId);
    for (const image of ctx.openThreads.find((thread) => thread.threadId === threadId)?.imageAttachments ?? []) {
      URL.revokeObjectURL(image.previewUrl);
    }
    ctx.dispatchOpenThreads({ type: "remove", threadId });
    ctx.setRuntimeList((current) => removeRuntimesThread(current, threadId));
    ctx.setProjects((current) => removeProjectsThread(current, threadId));
    ctx.setThreadOrderByMachine((current) => removeThreadOrder(current, threadId));
    ctx.setActiveTabThreadByMachine((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(current)) {
        if (value === threadId) delete next[key];
      }
      if (machineId && nextThreadId) next[machineId] = nextThreadId;
      return next;
    });
    if (ctx.activeTabThreadId === threadId) {
      ctx.latestRequestedThreadId.current = nextThreadId;
      ctx.setActiveTabThreadId(nextThreadId);
    }
  }

  const deleteThread = async (threadId: string) => {
    const response = await authFetch(`/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
    if (response.ok || response.status === 404) return;
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  };

  const applyThreadDetail = (thread: ThreadDetail) => {
    ctx.dispatchOpenThreads({ type: "upsert-detail", thread });
    ctx.setRuntimeList((current) => patchRuntimesThread(current, thread));
    ctx.setProjects((current) => patchProjectsThread(current, thread));
  };

  const saveThreadRenameDialog = async () => {
    const dialog = ctx.threadRenameDialog;
    if (!dialog) return;
    const title = dialog.title.replace(/\s+/g, " ").trim();
    if (!title) {
      ctx.setThreadRenameDialog((current) => current ? { ...current, error: "名称不能为空" } : current);
      return;
    }
    ctx.setThreadRenameDialog((current) => current ? { ...current, saving: true, error: "" } : current);
    try {
      const payload = await apiRouteJson(apiRoutes.renameThread, dialog.threadId, { title });
      if (payload.thread) applyThreadDetail(payload.thread);
      ctx.setThreadRenameDialog(null);
    } catch (error) {
      ctx.setThreadRenameDialog((current) => current && current.threadId === dialog.threadId
        ? { ...current, saving: false, error: apiErrorDetails(error).message }
        : current);
    }
  };

  function subscribeThread(threadId: string, after: number) {
    const subscribedAfter = Math.max(after, ctx.threadLastSeqs.current.get(threadId) ?? 0);
    ctx.threadLastSeqs.current.set(threadId, subscribedAfter);
    const alreadySubscribed = ctx.realtimeThreadSubscriptions.current.has(threadId);
    ctx.realtimeThreadSubscriptions.current.add(threadId);
    if (alreadySubscribed) return;
    deps.sendRealtime({
      type: "subscribe_thread",
      threadId,
      after: subscribedAfter
    });
  }

  function unsubscribeThread(threadId: string) {
    if (!ctx.realtimeThreadSubscriptions.current.delete(threadId)) return;
    deps.sendRealtime({ type: "unsubscribe_thread", threadId });
  }

  function syncThreadSubscriptions(threadIds: string[]) {
    const desired = new Set(threadIds);
    for (const threadId of [...ctx.realtimeThreadSubscriptions.current]) {
      if (!desired.has(threadId)) unsubscribeThread(threadId);
    }
    for (const threadId of desired) {
      subscribeThread(threadId, ctx.threadLastSeqs.current.get(threadId) ?? 0);
    }
  }

  const forkMessage = async (threadId: string, messageId: string) => {
    if (forkRequestPending || ctx.forkingMessageKey) return;
    const actionKey = `${threadId}:${messageId}`;
    forkRequestPending = true;
    ctx.setForkingMessageKey(actionKey);
    try {
      const thread = await apiRouteJson(apiRoutes.forkThread, threadId, { messageId });
      const machineId = thread.runtime.machineId ?? ctx.activeRuntime?.machineId;
      if (machineId) {
        ctx.setActiveTabThreadByMachine((current) => ({ ...current, [machineId]: thread.threadId }));
        ctx.setThreadOrderByMachine((current) => appendThreadOrder(current, machineId, thread.threadId));
      }
      await openThread(thread.threadId);
    } catch (error) {
      deps.showForkError(apiErrorDetails(error).message);
    } finally {
      forkRequestPending = false;
      ctx.setForkingMessageKey((current) => current === actionKey ? "" : current);
    }
  };

  const send = async (threadId: string) => {
    const openThread = ctx.openThreads.find((item) => item.threadId === threadId);
    if (!openThread) return;
    const typedText = ctx.composerDraftStore.get(threadId).trim();
    const textAttachments = openThread.textAttachments;
    const imageAttachments = openThread.imageAttachments;
    if (!textAttachments.length && !imageAttachments.length && deps.handleLocalComposerCommand(typedText)) {
      deps.resetComposerHistory(threadId);
      ctx.composerDraftStore.set(threadId, "");
      return;
    }
    deps.primeTaskCompletionFeedback();
    const text = composeUserInputText(typedText, textAttachments);
    const composerMode = openThread.composerMode;
    if (!text && !imageAttachments.length) return;
    if (!textAttachments.length && !imageAttachments.length && isModelCommand(typedText)) {
      deps.resetComposerHistory(threadId);
      ctx.composerDraftStore.set(threadId, "");
      ctx.setThreadModelDialogOpen(true);
      return;
    }
    const fastAction = !textAttachments.length && !imageAttachments.length ? fastCommandAction(typedText) : null;
    if (fastAction === "on" || fastAction === "off") {
      ctx.dispatchOpenThreads({
        type: "set-draft",
        threadId,
        field: "serviceTierDraft",
        value: fastAction === "on" ? "priority" : "auto"
      });
    }
    deps.resetComposerHistory(threadId);
    ctx.composerDraftStore.set(threadId, "");
    ctx.dispatchOpenThreads({ type: "clear-attachments", threadId });
    let encodedImages: Array<{ url: string }>;
    try {
      encodedImages = await Promise.all(imageAttachments.map(async (image) => ({ url: await fileToDataUrl(image.file) })));
      for (const image of imageAttachments) URL.revokeObjectURL(image.previewUrl);
    } catch (error) {
      ctx.composerDraftStore.set(threadId, typedText);
      ctx.dispatchOpenThreads({
        type: "set-fields",
        threadId,
        fields: {
          imageAttachments,
          textAttachments
        }
      });
      deps.showActionError(`${threadId}:image-encode`, "Image attachment failed", apiErrorDetails(error).message);
      return;
    }
    const input: ProxyInput = encodedImages.length
      ? [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...encodedImages.map((image) => ({ type: "image" as const, url: image.url }))
      ]
      : text;
    const updatesActiveGoal = openThread.running && composerMode === "goal";
    try {
      await apiRouteJson(apiRoutes.sendThreadTurn, threadId, {
        input,
        source: "web",
        options: selectedThreadOptions(
          openThread.modelDraft,
          openThread.reasoningDraft,
          openThread.serviceTierDraft,
          composerMode,
          openThread.approvalPolicyDraft,
          openThread.approvalsReviewerDraft,
          openThread.permissionProfileDraft
        )
      });
      if (composerMode !== "chat") {
        ctx.dispatchOpenThreads({ type: "reset-composer-mode", threadId, expected: composerMode });
      }
    } catch (error) {
      const details = apiErrorDetails(error, { plainHttpMessage: true });
      if (details.delivery === "goal" || (!details.delivery && updatesActiveGoal)) {
        deps.showActionError(`${threadId}:goal-update`, "Goal update failed", details.message);
      } else if (details.delivery !== "turn" && details.delivery !== "steer") {
        ctx.dispatchOpenThreads({
          type: "append-record",
          threadId,
          record: submissionFailedRecord(details.message)
        });
      }
    }
  };

  const stopTurn = async (threadId: string) => {
    await runActionRequest(
      `${threadId}:stop`,
      "Stop failed",
      () => apiRouteJson(apiRoutes.stopThreadTurn, threadId)
    );
  };

  const compactThread = async (threadId: string) => {
    await runActionRequest(
      `${threadId}:compact`,
      "Compact failed",
      () => apiRouteJson(apiRoutes.compactThread, threadId)
    );
  };

  const reviewThread = async (threadId: string) => {
    await runActionRequest(
      `${threadId}:review`,
      "Review failed",
      () => apiRouteJson(apiRoutes.reviewThread, threadId)
    );
  };

  const respondToApproval = async (
    threadId: string,
    approvalId: string,
    decision: AppServerApprovalDecision
  ) => {
    try {
      const payload = await apiRouteJson(apiRoutes.respondThreadApproval, threadId, { approvalId, decision });
      if (payload.thread) applyThreadDetail(payload.thread);
    } catch (error) {
      deps.showActionError(
        `${threadId}:approval:${approvalId}`,
        "Approval failed",
        apiErrorDetails(error).message
      );
    }
  };

  const respondToUserInput = async (
    threadId: string,
    userInputId: string,
    answers: AppServerUserInputAnswers
  ) => {
    try {
      const payload = await apiRouteJson(apiRoutes.respondThreadUserInput, threadId, { userInputId, answers });
      if (payload.thread) applyThreadDetail(payload.thread);
    } catch (error) {
      deps.showActionError(
        `${threadId}:user-input:${userInputId}`,
        "Response failed",
        apiErrorDetails(error).message
      );
    }
  };

  const updateThreadGoal = async (
    threadId: string,
    goal: ThreadGoalUpdateInput,
    options: ThreadGoalUpdateOptions = {}
  ) => {
    try {
      await apiRouteJson(apiRoutes.updateThreadGoal, threadId, goal);
      return true;
    } catch (error) {
      const message = apiErrorDetails(error, { plainHttpMessage: true }).message;
      if (options.dialog) {
        ctx.setGoalDialog((current) => current && current.threadId === threadId
          ? { ...current, saving: false, error: message || "保存失败" }
          : current);
      } else {
        deps.showActionError(`${threadId}:goal-update`, "Goal update failed", message);
      }
      return false;
    }
  };

  const clearThreadGoal = async (threadId: string) => {
    await runActionRequest(
      `${threadId}:goal-clear`,
      "Goal clear failed",
      () => apiRouteJson(apiRoutes.clearThreadGoal, threadId)
    );
  };

  const saveGoalDialog = async () => {
    const dialog = ctx.goalDialog;
    if (!dialog) return;
    const objective = dialog.objective.trim();
    if (!objective) {
      ctx.setGoalDialog((current) => current ? { ...current, error: "目标不能为空" } : current);
      return;
    }
    const targetRemainingPercentText = dialog.targetRemainingPercent.trim();
    const targetRemainingPercent = Number(targetRemainingPercentText);
    if (
      !targetRemainingPercentText
      || !Number.isFinite(targetRemainingPercent)
      || targetRemainingPercent < 0
      || targetRemainingPercent >= 100
    ) {
      ctx.setGoalDialog((current) => current ? { ...current, error: "7d 剩余目标必须在 0 到小于 100 之间" } : current);
      return;
    }
    ctx.setGoalDialog((current) => current ? { ...current, saving: true, error: "" } : current);
    const saved = await updateThreadGoal(dialog.threadId, {
      objective,
      status: "active",
      runPolicy: {
        type: "consumeUntilWeeklyRemainingAtOrBelow",
        targetRemainingPercent
      }
    }, { dialog: true });
    if (saved) ctx.setGoalDialog(null);
  };

  return {
    openThread,
    clearActiveThreadIfLatest,
    closeThread,
    removeThreadFromUi,
    deleteThread,
    subscribeThread,
    unsubscribeThread,
    syncThreadSubscriptions,
    forkMessage,
    send,
    stopTurn,
    compactThread,
    reviewThread,
    respondToApproval,
    respondToUserInput,
    updateThreadGoal,
    clearThreadGoal,
    saveGoalDialog,
    saveThreadRenameDialog
  };
};
