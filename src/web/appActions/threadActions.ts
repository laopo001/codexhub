import type React from "react";
import type { CodexRecord } from "../../core/codexRecord.js";
import {
  adjacentThreadId,
  apiJson,
  authFetch,
  appendThreadOrder,
  composeUserInputText,
  errorRecord,
  fileToDataUrl,
  isModelCommand,
  mergeRecord,
  patchProjectsThread,
  patchSessionsThread,
  removeProjectsThread,
  removeSessionsThread,
  removeThreadOrder,
  selectedThreadOptions,
  threadGoalClearedRecord,
  threadRecordsForNotifications
} from "../appHelpers.js";
import type {
  ChatSession,
  ComposerMode,
  GoalDialogState,
  ModelSelection,
  ProjectSummary,
  ProjectsPayload,
  ReasoningSelection,
  SessionView,
  ThreadDetail,
  ThreadGoalView,
} from "../types.js";

type ThreadGoalUpdateInput = Partial<Pick<ThreadGoalView, "objective" | "status" | "tokenBudget">>;

type RealtimeThreadMessage =
  | { type: "subscribe_thread"; threadId: string; after: number }
  | { type: "unsubscribe_thread"; threadId: string };

type ThreadActionsContext = {
  activeProjectSession?: SessionView | null;
  activeTabThreadId: string;
  closedThreadIds: React.MutableRefObject<Set<string>>;
  composerMode: ComposerMode;
  goalDialog: GoalDialogState | null;
  latestRequestedThreadId: React.MutableRefObject<string>;
  notificationRecordsByThread: React.MutableRefObject<Map<string, CodexRecord[]>>;
  openingThreads: React.MutableRefObject<Map<string, Promise<void>>>;
  realtimeThreadSubscriptions: React.MutableRefObject<Set<string>>;
  selectedProjectKey: string;
  selectedModel: ModelSelection;
  selectedReasoning: ReasoningSelection;
  sessions: ChatSession[];
  threadLastSeqs: React.MutableRefObject<Map<string, number>>;
  setActiveSessionId: React.Dispatch<React.SetStateAction<string>>;
  setActiveTabThreadBySession: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setActiveTabThreadId: React.Dispatch<React.SetStateAction<string>>;
  setActiveWorkspacePath: React.Dispatch<React.SetStateAction<string>>;
  setGoalDialog: React.Dispatch<React.SetStateAction<GoalDialogState | null>>;
  setProjects: React.Dispatch<React.SetStateAction<ProjectSummary[]>>;
  setSessionDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionList: React.Dispatch<React.SetStateAction<SessionView[]>>;
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  setThreadOrderBySession: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
};

type ThreadActionsDependencies = {
  primeTaskCompletionFeedback: () => void;
  refreshProjects: () => Promise<ProjectsPayload>;
  refreshSessions: () => Promise<SessionView[]>;
  resetComposerHistory: (threadId: string) => void;
  sendRealtime: (message: RealtimeThreadMessage) => boolean;
};

type ThreadGoalUpdateOptions = {
  dialog?: boolean;
};

type TurnInputPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

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
  updateThreadGoal: (threadId: string, goal: ThreadGoalUpdateInput, options?: ThreadGoalUpdateOptions) => Promise<boolean>;
  clearThreadGoal: (threadId: string) => Promise<void>;
  saveGoalDialog: () => Promise<void>;
};

export const createThreadActions = (ctx: ThreadActionsContext, actions: Record<string, any>): ThreadActions => {
  const deps = actions as ThreadActionsDependencies;

  const openThread = async (threadId: string) => {
    ctx.closedThreadIds.current.delete(threadId);
    ctx.latestRequestedThreadId.current = threadId;
    ctx.setActiveTabThreadId(threadId);
    const updateWorkspaceContext = !ctx.selectedProjectKey;

    const existingSession = ctx.sessions.find((session) => session.threadId === threadId);
    if (existingSession) {
      subscribeThread(threadId, existingSession.lastSeq);
      const sessionId = existingSession.session.sessionId;
      if (sessionId) {
        if (updateWorkspaceContext) ctx.setActiveSessionId(sessionId);
        ctx.setActiveTabThreadBySession((current) => ({ ...current, [sessionId]: threadId }));
      }
      if (updateWorkspaceContext) ctx.setActiveWorkspacePath(existingSession.workingDirectory);
      return;
    }

    const existingOpen = ctx.openingThreads.current.get(threadId);
    if (existingOpen) return existingOpen;

    const open = (async () => {
      const thread = await apiJson<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}`);
      const session: ChatSession = { ...thread, input: "", imageAttachments: [], textAttachments: [] };
      const sessionId = thread.session.sessionId;
      if (sessionId) {
        ctx.setThreadOrderBySession((current) => appendThreadOrder(current, sessionId, thread.threadId));
      }
      ctx.setSessionList((current) => patchSessionsThread(current, thread));
      ctx.setProjects((current) => patchProjectsThread(current, thread));
      ctx.notificationRecordsByThread.current.set(thread.threadId, threadRecordsForNotifications(thread.threadId, thread));
      ctx.setSessions((current) => {
        const existing = current.find((item) => item.threadId === thread.threadId);
        const nextSession = existing
          ? { ...session, input: existing.input, imageAttachments: existing.imageAttachments, textAttachments: existing.textAttachments ?? [] }
          : session;
        return current.some((item) => item.threadId === thread.threadId)
          ? current.map((item) => item.threadId === thread.threadId ? nextSession : item)
          : [...current, nextSession];
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
    const threadIds = ctx.sessions.map((session) => session.threadId);
    const closingThread = ctx.sessions.find((session) => session.threadId === threadId);
    const sessionId = closingThread?.session.sessionId ?? ctx.activeProjectSession?.sessionId ?? "";
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
    ctx.threadLastSeqs.current.delete(threadId);
    unsubscribeThread(threadId);
    ctx.setSessions((current) => {
      for (const session of current) {
        if (session.threadId !== threadId) continue;
        for (const image of session.imageAttachments) URL.revokeObjectURL(image.previewUrl);
      }
      return current.filter((session) => session.threadId !== threadId);
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
      const thread = await apiJson<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId })
      });
      const sessionId = thread.session.sessionId ?? ctx.activeProjectSession?.sessionId;
      if (sessionId) {
        ctx.setActiveTabThreadBySession((current) => ({ ...current, [sessionId]: thread.threadId }));
        ctx.setThreadOrderBySession((current) => appendThreadOrder(current, sessionId, thread.threadId));
      }
      await openThread(thread.threadId);
    } catch (error) {
      ctx.setSessions((current) => current.map((item) => item.threadId === threadId
        ? {
          ...item,
          records: [...item.records, errorRecord("fork failed", error)]
        }
        : item));
    }
  };

  const rollbackMessage = async (threadId: string, messageId: string) => {
    try {
      const thread = await apiJson<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId })
      });
      const session: ChatSession = { ...thread, input: "", imageAttachments: [], textAttachments: [] };
      ctx.setSessions((current) => {
        const existing = current.find((item) => item.threadId === thread.threadId);
        const nextSession = existing
          ? { ...session, input: existing.input, imageAttachments: existing.imageAttachments, textAttachments: existing.textAttachments ?? [] }
          : session;
        return current.some((item) => item.threadId === thread.threadId)
          ? current.map((item) => item.threadId === thread.threadId ? nextSession : item)
          : [...current, nextSession];
      });
      if (thread.session.sessionId) ctx.setActiveSessionId(thread.session.sessionId);
      ctx.setActiveWorkspacePath(thread.workingDirectory);
      ctx.setActiveTabThreadId(thread.threadId);
      subscribeThread(thread.threadId, thread.lastSeq);
    } catch (error) {
      ctx.setSessions((current) => current.map((item) => item.threadId === threadId
        ? {
          ...item,
          records: [...item.records, errorRecord("rollback failed", error)]
        }
        : item));
    }
  };

  const send = async (threadId: string) => {
    deps.primeTaskCompletionFeedback();
    const session = ctx.sessions.find((item) => item.threadId === threadId);
    if (!session) return;
    const typedText = session.input.trim();
    const textAttachments = session.textAttachments;
    const text = composeUserInputText(typedText, textAttachments);
    const imageAttachments = session.imageAttachments;
    if (!text && !imageAttachments.length) return;
    if (!textAttachments.length && !imageAttachments.length && isModelCommand(typedText)) {
      deps.resetComposerHistory(threadId);
      ctx.setSessions((current) => current.map((item) => item.threadId === threadId ? { ...item, input: "" } : item));
      ctx.setSessionDialogOpen(true);
      return;
    }
    deps.resetComposerHistory(threadId);
    ctx.setSessions((current) => current.map((item) => item.threadId === threadId ? { ...item, input: "", imageAttachments: [], textAttachments: [] } : item));
    let encodedImages: Array<{ url: string }>;
    try {
      encodedImages = await Promise.all(imageAttachments.map(async (image) => ({ url: await fileToDataUrl(image.file) })));
      for (const image of imageAttachments) URL.revokeObjectURL(image.previewUrl);
    } catch (error) {
      ctx.setSessions((current) => current.map((item) => item.threadId === threadId
        ? {
          ...item,
          input: typedText,
          imageAttachments,
          textAttachments,
          records: [...item.records, errorRecord("image encode failed", error)]
        }
        : item));
      return;
    }
    const input: string | TurnInputPart[] = encodedImages.length
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
        options: selectedThreadOptions(ctx.selectedModel, ctx.selectedReasoning, ctx.composerMode)
      })
    });
    if (!response.ok) {
      const text = await response.text();
      ctx.setSessions((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("error", text)] }
        : item));
    }
  };

  const stopTurn = async (threadId: string) => {
    const response = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/stop`, { method: "POST" });
    if (!response.ok) {
      const text = await response.text();
      ctx.setSessions((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("stop failed", text)] }
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
      ctx.setSessions((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("goal update failed", text)] }
        : item));
    }
    return false;
  };

  const clearThreadGoal = async (threadId: string) => {
    const clearedRecord = threadGoalClearedRecord(threadId);
    ctx.setSessions((current) => current.map((item) => item.threadId === threadId
      ? { ...item, records: mergeRecord(item.records, clearedRecord) }
      : item));
    const response = await authFetch(`/api/threads/${encodeURIComponent(threadId)}/goal`, { method: "DELETE" });
    if (response.ok) return;
    const text = await response.text();
    ctx.setSessions((current) => current.map((item) => item.threadId === threadId
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
    ctx.setGoalDialog((current) => current ? { ...current, saving: true, error: "" } : current);
    const saved = await updateThreadGoal(dialog.threadId, { objective, status: "active" }, { dialog: true });
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
    updateThreadGoal,
    clearThreadGoal,
    saveGoalDialog
  };
};
