// @ts-nocheck
import {
  adjacentThreadId,
  apiJson,
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

export const createThreadActions = (ctx, actions) => {
  const openThread = async (threadId) => {
    ctx.closedThreadIds.current.delete(threadId);
    ctx.latestRequestedThreadId.current = threadId;
    ctx.setActiveTabThreadId(threadId);

    const existingSession = ctx.sessions.find((session) => session.threadId === threadId);
    if (existingSession) {
      subscribeThread(threadId, existingSession.lastSeq);
      ctx.setActiveWorkspacePath(existingSession.workingDirectory);
      if (existingSession.session.sessionId) {
        ctx.setActiveTabThreadBySession((current) => ({ ...current, [existingSession.session.sessionId]: threadId }));
      }
      return;
    }

    const existingOpen = ctx.openingThreads.current.get(threadId);
    if (existingOpen) return existingOpen;

    const open = (async () => {
      const thread = await apiJson(`/api/threads/${encodeURIComponent(threadId)}`);
      const session = { ...thread, input: "", imageAttachments: [], textAttachments: [] };
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
        ctx.setActiveTabThreadBySession((current) => ({ ...current, [sessionId]: thread.threadId }));
      }
      ctx.setActiveWorkspacePath(thread.workingDirectory);
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

  const clearActiveThreadIfLatest = (threadId) => {
    if (ctx.latestRequestedThreadId.current === threadId) ctx.setActiveTabThreadId("");
  };

  const closeThread = async (threadId) => {
    if (ctx.closedThreadIds.current.has(threadId)) return;
    const threadIds = ctx.activeProjectSessionThreads.map((thread) => thread.threadId);
    const closingThread = ctx.activeProjectSessionThreads.find((thread) => thread.threadId === threadId)
      ?? ctx.sessions.find((session) => session.threadId === threadId);
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
        actions.refreshSessions().catch(() => undefined),
        actions.refreshProjects().catch(() => undefined)
      ]);
    }
  };

  function removeThreadFromUi(threadId, sessionId, nextThreadId) {
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

  const deleteThread = async (threadId) => {
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
    if (response.ok || response.status === 404) return;
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  };

  function subscribeThread(threadId, after) {
    const subscribedAfter = Math.max(after, ctx.threadLastSeqs.current.get(threadId) ?? 0);
    ctx.threadLastSeqs.current.set(threadId, subscribedAfter);
    const alreadySubscribed = ctx.realtimeThreadSubscriptions.current.has(threadId);
    ctx.realtimeThreadSubscriptions.current.add(threadId);
    if (alreadySubscribed) return;
    actions.sendRealtime({
      type: "subscribe_thread",
      threadId,
      after: subscribedAfter
    });
  }

  function unsubscribeThread(threadId) {
    if (!ctx.realtimeThreadSubscriptions.current.delete(threadId)) return;
    actions.sendRealtime({ type: "unsubscribe_thread", threadId });
  }

  function syncThreadSubscriptions(threadIds) {
    const desired = new Set(threadIds);
    for (const threadId of [...ctx.realtimeThreadSubscriptions.current]) {
      if (!desired.has(threadId)) unsubscribeThread(threadId);
    }
    for (const threadId of desired) {
      subscribeThread(threadId, ctx.threadLastSeqs.current.get(threadId) ?? 0);
    }
  }

  const forkMessage = async (threadId, messageId) => {
    try {
      const thread = await apiJson(`/api/threads/${encodeURIComponent(threadId)}/fork`, {
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

  const rollbackMessage = async (threadId, messageId) => {
    try {
      const thread = await apiJson(`/api/threads/${encodeURIComponent(threadId)}/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId })
      });
      const session = { ...thread, input: "", imageAttachments: [], textAttachments: [] };
      ctx.setSessions((current) => {
        const existing = current.find((item) => item.threadId === thread.threadId);
        const nextSession = existing
          ? { ...session, input: existing.input, imageAttachments: existing.imageAttachments, textAttachments: existing.textAttachments ?? [] }
          : session;
        return current.some((item) => item.threadId === thread.threadId)
          ? current.map((item) => item.threadId === thread.threadId ? nextSession : item)
          : [...current, nextSession];
      });
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

  const send = async (threadId) => {
    actions.primeTaskCompletionFeedback();
    const session = ctx.sessions.find((item) => item.threadId === threadId);
    if (!session) return;
    const typedText = session.input.trim();
    const textAttachments = session.textAttachments;
    const text = composeUserInputText(typedText, textAttachments);
    const imageAttachments = session.imageAttachments;
    if (!text && !imageAttachments.length) return;
    if (!textAttachments.length && !imageAttachments.length && isModelCommand(typedText)) {
      actions.resetComposerHistory(threadId);
      ctx.setSessions((current) => current.map((item) => item.threadId === threadId ? { ...item, input: "" } : item));
      ctx.setSessionDialogOpen(true);
      return;
    }
    actions.resetComposerHistory(threadId);
    ctx.setSessions((current) => current.map((item) => item.threadId === threadId ? { ...item, input: "", imageAttachments: [], textAttachments: [] } : item));
    let encodedImages;
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
    const input = encodedImages.length
      ? [
        ...(text ? [{ type: "text", text }] : []),
        ...encodedImages.map((image) => ({ type: "image", url: image.url }))
      ]
      : text;
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/turn`, {
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

  const stopTurn = async (threadId) => {
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/stop`, { method: "POST" });
    if (!response.ok) {
      const text = await response.text();
      ctx.setSessions((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("stop failed", text)] }
        : item));
    }
  };

  const updateThreadGoal = async (
    threadId,
    goal,
    options = {}
  ) => {
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/goal`, {
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

  const clearThreadGoal = async (threadId) => {
    const clearedRecord = threadGoalClearedRecord(threadId);
    ctx.setSessions((current) => current.map((item) => item.threadId === threadId
      ? { ...item, records: mergeRecord(item.records, clearedRecord) }
      : item));
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/goal`, { method: "DELETE" });
    if (response.ok) return;
    const text = await response.text();
    ctx.setSessions((current) => current.map((item) => item.threadId === threadId
      ? { ...item, records: [...item.records, errorRecord("goal clear failed", text)] }
      : item));
  };

  const saveGoalDialog = async () => {
    if (!ctx.goalDialog) return;
    const objective = ctx.goalDialog.objective.trim();
    if (!objective) {
      ctx.setGoalDialog((current) => current ? { ...current, error: "目标不能为空" } : current);
      return;
    }
    ctx.setGoalDialog((current) => current ? { ...current, saving: true, error: "" } : current);
    const saved = await updateThreadGoal(ctx.goalDialog.threadId, { objective, status: "active" }, { dialog: true });
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
