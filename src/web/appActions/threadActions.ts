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
  errorRecord,
  fastCommandAction,
  fileToDataUrl,
  isModelCommand,
  mergeRecord,
  patchProjectsThread,
  patchSessionsThread,
  removeProjectsThread,
  removeSessionsThread,
  removeThreadOrder,
  selectedThreadOptions,
  type ComposerDraftStore,
  threadRecordsForNotifications
} from "../appHelpers.js";
import type {
  OpenThreadState,
  GoalDialogState,
  ProjectSummary,
  ProjectsPayload,
  SessionView,
  ThreadDetail,
  ThreadRenameDialogState,
} from "../types.js";

type RealtimeThreadMessage = Extract<RealtimeOutgoingMessage, { type: "subscribe_thread" | "unsubscribe_thread" }>;

type ThreadActionsContext = {
  activeRuntimeSession?: SessionView | null;
  activeTabThreadId: string;
  closedThreadIds: React.MutableRefObject<Set<string>>;
  composerDraftStore: ComposerDraftStore;
  goalDialog: GoalDialogState | null;
  threadRenameDialog: ThreadRenameDialogState | null;
  latestRequestedThreadId: React.MutableRefObject<string>;
  notificationRecordsByThread: React.MutableRefObject<Map<string, CodexRecord[]>>;
  openingThreads: React.MutableRefObject<Map<string, Promise<void>>>;
  realtimeThreadSubscriptions: React.MutableRefObject<Set<string>>;
  selectedProjectKey: string;
  openThreads: OpenThreadState[];
  threadLastSeqs: React.MutableRefObject<Map<string, number>>;
  setActiveSessionId: React.Dispatch<React.SetStateAction<string>>;
  setActiveTabThreadBySession: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setActiveTabThreadId: React.Dispatch<React.SetStateAction<string>>;
  setActiveWorkspacePath: React.Dispatch<React.SetStateAction<string>>;
  setGoalDialog: React.Dispatch<React.SetStateAction<GoalDialogState | null>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectSummary[]>>;
  setThreadModelDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setThreadRenameDialog: React.Dispatch<React.SetStateAction<ThreadRenameDialogState | null>>;
  setSessionList: React.Dispatch<React.SetStateAction<SessionView[]>>;
  setOpenThreads: React.Dispatch<React.SetStateAction<OpenThreadState[]>>;
  setThreadOrderBySession: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
};

export type ThreadActionsDependencies = {
  primeTaskCompletionFeedback: () => void;
  refreshProjects: () => Promise<ProjectsPayload>;
  refreshSessions: () => Promise<SessionView[]>;
  resetComposerHistory: (threadId: string) => void;
  sendRealtime: (message: RealtimeThreadMessage) => boolean;
};

type ThreadGoalUpdateOptions = {
  dialog?: boolean;
};

const openThreadStateFromDetail = (
  thread: ThreadDetail,
  existing?: OpenThreadState
): OpenThreadState => ({
  ...thread,
  composerMode: existing?.composerMode ?? "chat",
  modelDraft: existing?.modelDraft ?? thread.model ?? "auto",
  reasoningDraft: existing?.reasoningDraft ?? thread.modelReasoningEffort ?? "auto",
  serviceTierDraft: existing?.serviceTierDraft ?? serviceTierDraftFromThread(thread.serviceTier),
  approvalPolicyDraft: existing?.approvalPolicyDraft ?? "auto",
  sandboxPolicyDraft: existing?.sandboxPolicyDraft ?? "auto",
  imageAttachments: existing?.imageAttachments ?? [],
  textAttachments: existing?.textAttachments ?? []
});

const serviceTierDraftFromThread = (serviceTier: string | null | undefined) =>
  serviceTier && serviceTier !== "default" ? serviceTier : "auto";

export type ThreadActions = {
  openThread: (threadId: string) => Promise<void>;
  clearActiveThreadIfLatest: (threadId: string) => void;
  closeThread: (threadId: string) => Promise<void>;
  removeThreadFromUi: (threadId: string, sessionId: string, nextThreadId: string) => void;
  deleteThread: (threadId: string) => Promise<void>;
  subscribeThread: (threadId: string, after: number) => void;
  unsubscribeThread: (threadId: string) => void;
  syncThreadSubscriptions: (threadIds: string[]) => void;
  forkMessage: (threadId: string, messageId: string) => Promise<void>;
  rollbackMessage: (threadId: string, messageId: string) => Promise<void>;
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
  const openThread = async (threadId: string) => {
    ctx.closedThreadIds.current.delete(threadId);
    ctx.latestRequestedThreadId.current = threadId;
    ctx.setActiveTabThreadId(threadId);
    const updateWorkspaceContext = !ctx.selectedProjectKey;

    const existingThread = ctx.openThreads.find((thread) => thread.threadId === threadId);
    if (existingThread) {
      subscribeThread(threadId, existingThread.lastSeq);
      const sessionId = existingThread.session.sessionId;
      if (sessionId) {
        if (updateWorkspaceContext) ctx.setActiveSessionId(sessionId);
        ctx.setActiveTabThreadBySession((current) => ({ ...current, [sessionId]: threadId }));
      }
      if (updateWorkspaceContext) ctx.setActiveWorkspacePath(existingThread.workingDirectory);
      return;
    }

    const existingOpen = ctx.openingThreads.current.get(threadId);
    if (existingOpen) return existingOpen;

    const open = (async () => {
      const thread = await apiRouteJson(apiRoutes.thread, threadId);
      const sessionId = thread.session.sessionId;
      if (sessionId) {
        ctx.setThreadOrderBySession((current) => appendThreadOrder(current, sessionId, thread.threadId));
      }
      ctx.setSessionList((current) => patchSessionsThread(current, thread));
      ctx.setProjects((current) => patchProjectsThread(current, thread));
      ctx.notificationRecordsByThread.current.set(thread.threadId, threadRecordsForNotifications(thread.threadId, thread));
      ctx.setOpenThreads((current) => {
        const existing = current.find((item) => item.threadId === thread.threadId);
        const nextThread = openThreadStateFromDetail(thread, existing);
        return current.some((item) => item.threadId === thread.threadId)
          ? current.map((item) => item.threadId === thread.threadId ? nextThread : item)
          : [...current, nextThread];
      });
      if (ctx.latestRequestedThreadId.current !== thread.threadId) return;
      if (sessionId) {
        if (updateWorkspaceContext) ctx.setActiveSessionId(sessionId);
        ctx.setActiveTabThreadBySession((current) => ({ ...current, [sessionId]: thread.threadId }));
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
    const sessionId = closingThread?.session.sessionId ?? ctx.activeRuntimeSession?.sessionId ?? "";
    const nextThreadId = ctx.activeTabThreadId === threadId
      ? adjacentThreadId(threadIds, threadId)
      : ctx.activeTabThreadId;

    ctx.closedThreadIds.current.add(threadId);
    removeThreadFromUi(threadId, sessionId, nextThreadId);
    try {
      await deleteThread(threadId);
      if (ctx.activeTabThreadId === threadId && nextThreadId) {
        await openThread(nextThreadId).catch(() => clearActiveThreadIfLatest(nextThreadId));
      }
    } catch (error) {
      ctx.closedThreadIds.current.delete(threadId);
      window.alert(error instanceof Error ? error.message : String(error));
      await Promise.all([
        deps.refreshSessions().catch(() => undefined),
        deps.refreshProjects().catch(() => undefined)
      ]);
    }
  };

  function removeThreadFromUi(threadId: string, sessionId: string, nextThreadId: string) {
    ctx.openingThreads.current.delete(threadId);
    ctx.composerDraftStore.delete(threadId);
    ctx.threadLastSeqs.current.delete(threadId);
    unsubscribeThread(threadId);
    ctx.setOpenThreads((current) => {
      for (const thread of current) {
        if (thread.threadId !== threadId) continue;
        for (const image of thread.imageAttachments) URL.revokeObjectURL(image.previewUrl);
      }
      return current.filter((thread) => thread.threadId !== threadId);
    });
    ctx.setSessionList((current) => removeSessionsThread(current, threadId));
    ctx.setProjects((current) => removeProjectsThread(current, threadId));
    ctx.setThreadOrderBySession((current) => removeThreadOrder(current, threadId));
    ctx.setActiveTabThreadBySession((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(current)) {
        if (value === threadId) delete next[key];
      }
      if (sessionId && nextThreadId) next[sessionId] = nextThreadId;
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
    ctx.setOpenThreads((current) => {
      const existing = current.find((item) => item.threadId === thread.threadId);
      const nextThread = openThreadStateFromDetail(thread, existing);
      return current.some((item) => item.threadId === thread.threadId)
        ? current.map((item) => item.threadId === thread.threadId ? nextThread : item)
        : [...current, nextThread];
    });
    ctx.setSessionList((current) => patchSessionsThread(current, thread));
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
        ? { ...current, saving: false, error: error instanceof Error ? error.message : String(error) }
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
    try {
      const thread = await apiRouteJson(apiRoutes.forkThread, threadId, { messageId });
      const sessionId = thread.session.sessionId ?? ctx.activeRuntimeSession?.sessionId;
      if (sessionId) {
        ctx.setActiveTabThreadBySession((current) => ({ ...current, [sessionId]: thread.threadId }));
        ctx.setThreadOrderBySession((current) => appendThreadOrder(current, sessionId, thread.threadId));
      }
      await openThread(thread.threadId);
    } catch (error) {
      ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId
        ? {
          ...item,
          records: [...item.records, errorRecord("fork failed", error)]
        }
        : item));
    }
  };

  const rollbackMessage = async (threadId: string, messageId: string) => {
    try {
      const thread = await apiRouteJson(apiRoutes.rollbackThread, threadId, { messageId });
      ctx.setOpenThreads((current) => {
        const existing = current.find((item) => item.threadId === thread.threadId);
        const nextThread = openThreadStateFromDetail(thread, existing);
        return current.some((item) => item.threadId === thread.threadId)
          ? current.map((item) => item.threadId === thread.threadId ? nextThread : item)
          : [...current, nextThread];
      });
      if (thread.session.sessionId) ctx.setActiveSessionId(thread.session.sessionId);
      ctx.setActiveWorkspacePath(thread.workingDirectory);
      ctx.setActiveTabThreadId(thread.threadId);
      subscribeThread(thread.threadId, thread.lastSeq);
    } catch (error) {
      ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId
        ? {
          ...item,
          records: [...item.records, errorRecord("rollback failed", error)]
        }
        : item));
    }
  };

  const send = async (threadId: string) => {
    deps.primeTaskCompletionFeedback();
    const openThread = ctx.openThreads.find((item) => item.threadId === threadId);
    if (!openThread) return;
    const typedText = ctx.composerDraftStore.get(threadId).trim();
    const textAttachments = openThread.textAttachments;
    const text = composeUserInputText(typedText, textAttachments);
    const imageAttachments = openThread.imageAttachments;
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
      ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId
        ? { ...item, serviceTierDraft: fastAction === "on" ? "priority" : "auto" }
        : item));
    }
    deps.resetComposerHistory(threadId);
    ctx.composerDraftStore.set(threadId, "");
    ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId ? { ...item, imageAttachments: [], textAttachments: [] } : item));
    let encodedImages: Array<{ url: string }>;
    try {
      encodedImages = await Promise.all(imageAttachments.map(async (image) => ({ url: await fileToDataUrl(image.file) })));
      for (const image of imageAttachments) URL.revokeObjectURL(image.previewUrl);
    } catch (error) {
      ctx.composerDraftStore.set(threadId, typedText);
      ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId
        ? {
          ...item,
          imageAttachments,
          textAttachments,
          records: [...item.records, errorRecord("image encode failed", error)]
        }
        : item));
      return;
    }
    const input: ProxyInput = encodedImages.length
      ? [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...encodedImages.map((image) => ({ type: "image" as const, url: image.url }))
      ]
      : text;
    const response = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input,
        source: "web",
        options: selectedThreadOptions(
          openThread.modelDraft,
          openThread.reasoningDraft,
          openThread.serviceTierDraft,
          composerMode,
          openThread.approvalPolicyDraft,
          openThread.sandboxPolicyDraft,
          openThread.workingDirectory
        )
      })
    });
    if (!response.ok) {
      const text = await response.text();
      ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("error", text)] }
        : item));
    } else if (composerMode !== "chat") {
      ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId
        ? { ...item, composerMode: item.composerMode === composerMode ? "chat" : item.composerMode }
        : item));
    }
  };

  const stopTurn = async (threadId: string) => {
    const response = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/stop`, { method: "POST" });
    if (!response.ok) {
      const text = await response.text();
      ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("stop failed", text)] }
        : item));
    }
  };

  const compactThread = async (threadId: string) => {
    const response = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/compact`, { method: "POST" });
    if (!response.ok) {
      const text = await response.text();
      ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("compact failed", text)] }
        : item));
    }
  };

  const reviewThread = async (threadId: string) => {
    const response = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/review`, { method: "POST" });
    if (!response.ok) {
      const text = await response.text();
      ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("review failed", text)] }
        : item));
    }
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
      ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("approval failed", error)] }
        : item));
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
      ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("user input failed", error)] }
        : item));
    }
  };

  const updateThreadGoal = async (
    threadId: string,
    goal: ThreadGoalUpdateInput,
    options: ThreadGoalUpdateOptions = {}
  ) => {
    const response = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/goal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(goal)
    });
    if (response.ok) return true;
    const text = await response.text();
    if (options.dialog) {
      ctx.setGoalDialog((current) => current && current.threadId === threadId
        ? { ...current, saving: false, error: text || "保存失败" }
        : current);
    } else {
      ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("goal update failed", text)] }
        : item));
    }
    return false;
  };

  const clearThreadGoal = async (threadId: string) => {
    const response = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/goal`, { method: "DELETE" });
    if (response.ok) return;
    const text = await response.text();
    ctx.setOpenThreads((current) => current.map((item) => item.threadId === threadId
      ? { ...item, records: [...item.records, errorRecord("goal clear failed", text)] }
      : item));
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
      ctx.setGoalDialog((current) => current ? { ...current, error: "weekly 剩余目标必须在 0 到小于 100 之间" } : current);
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
    rollbackMessage,
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
