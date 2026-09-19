import type React from "react";
import { Modal } from "antd";
import { CodexHubApiError } from "../../shared/apiClient.js";
import type { AppServerApprovalDecision, AppServerUserInputAnswers, RealtimeOutgoingMessage, ThreadGoalUpdateInput } from "../../shared/apiContract.js";
import { apiRoutes } from "../../shared/apiRoutes.js";
import type { ProxyInput } from "../../shared/inputTypes.js";
import type { CodexRecord } from "../../shared/recordTypes.js";
import type { ProjectTarget } from "../../shared/petActivityRouting.js";
import {
  adjacentThreadId,
  apiRouteJson,
  authFetch,
  appendThreadOrder,
  browserId,
  combineRecordSources,
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
  threadDisplayTitle,
  threadRecordsForNotifications
} from "../appHelpers.js";
import {
  composerInputHistoryStore,
  type ComposerInputHistoryStore
} from "../helpers/composerInputHistory.js";
import type {
  OpenThreadState,
  ComposerHistoryState,
  GoalDialogState,
  ProjectSummary,
  ProjectsPayload,
  RuntimeSummary,
  ThreadDetail,
  ThreadRenameDialogState,
} from "../types.js";
import type { ConversationThreadAction, OpenThreadAction } from "../openThreadReducer.js";
import { apiErrorDetails } from "../helpers/apiErrors.js";
import { conversationViewsFromRecords } from "../helpers/conversationViews.js";
import {
  formatAgentQuestionAnswers,
  type AgentQuestion,
  type AgentQuestionAnswers
} from "../helpers/agentQuestions.js";

type RealtimeThreadMessage = Extract<RealtimeOutgoingMessage, { type: "subscribe_thread" | "unsubscribe_thread" }>;

type ThreadActionsContext = {
  activeRuntime?: RuntimeSummary | null;
  activeTabThreadId: string;
  activeTabThreadIdRef?: React.MutableRefObject<string>;
  closedThreadIds: React.MutableRefObject<Set<string>>;
  composerDraftStore: ComposerDraftStore;
  composerHistoryByThreadRef?: React.MutableRefObject<Map<string, ComposerHistoryState>>;
  composerInputHistoryStore?: ComposerInputHistoryStore;
  conversationThreadsRef: React.MutableRefObject<Map<string, OpenThreadState>>;
  expandedToolBatchKeys: Record<string, string[]>;
  forkingMessageKey: string;
  goalDialog: GoalDialogState | null;
  threadRenameDialog: ThreadRenameDialogState | null;
  threadRenameRequestTokens: React.MutableRefObject<Map<string, object>>;
  latestRequestedThreadId: React.MutableRefObject<string>;
  notificationRecordsByThread: React.MutableRefObject<Map<string, CodexRecord[]>>;
  openThreadIdsRef: React.MutableRefObject<Set<string>>;
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
  openThreadModelDialog: (threadId: string) => void;
  setThreadRenameDialog: React.Dispatch<React.SetStateAction<ThreadRenameDialogState | null>>;
  setRuntimeList: React.Dispatch<React.SetStateAction<RuntimeSummary[]>>;
  dispatchOpenThreads: React.Dispatch<OpenThreadAction>;
  dispatchConversationThread: (action: ConversationThreadAction) => void;
  setThreadOrderByMachine: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  threadProjectTargets: Readonly<Record<string, ProjectTarget | undefined>>;
  setThreadProjectTargets: React.Dispatch<React.SetStateAction<Record<string, ProjectTarget | undefined>>>;
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

export type OpenThreadOptions = {
  /** Reject stale Web state if this thread was resumed through another machine. */
  expectedMachineId?: string;
  /** Keep workspace context stable while a freshly resumed thread is loading. */
  preferredWorkingDirectory?: string;
  /** Open the thread in the background without changing the active tab. */
  activate?: boolean;
  /** Keep the current tab stable until the requested thread has loaded successfully. */
  deferActivationUntilLoaded?: boolean;
  /** Fresh create response; used once so transient creation metadata reaches the first tab. */
  initialThread?: ThreadDetail;
  /** Preserve the browser's last-opened timestamp while restoring a tab. */
  lastOpenedAt?: string;
  /** Explicit UI origin; never inferred from the returned workingDirectory. */
  projectTarget?: ProjectTarget;
};

type ThreadGoalUpdateOptions = {
  dialog?: boolean;
};

export type ThreadActions = {
  openThread: (threadId: string, options?: OpenThreadOptions) => Promise<void>;
  loadOlderThread: (threadId: string) => Promise<number>;
  clearActiveThreadIfLatest: (threadId: string) => void;
  closeThread: (threadId: string) => Promise<void>;
  removeThreadFromUi: (threadId: string, machineId: string, nextThreadId: string) => void;
  deleteThread: (threadId: string) => Promise<void>;
  subscribeThread: (threadId: string, after: number) => void;
  unsubscribeThread: (threadId: string) => void;
  syncThreadSubscriptions: (threadIds: string[]) => void;
  forkMessage: (threadId: string, messageId: string) => Promise<void>;
  send: (threadId: string) => Promise<void>;
  dismissPendingUserMessage: (threadId: string, messageId: string) => void;
  cancelQueuedSubmission: (threadId: string, messageId: string, submissionId: string) => Promise<void>;
  stopTurn: (threadId: string) => Promise<void>;
  terminateBackgroundTerminal: (threadId: string, processId: string) => Promise<void>;
  compactThread: (threadId: string) => Promise<void>;
  reviewThread: (threadId: string) => Promise<void>;
  respondToApproval: (threadId: string, approvalId: string, decision: AppServerApprovalDecision) => Promise<void>;
  respondToUserInput: (threadId: string, userInputId: string, answers: AppServerUserInputAnswers) => Promise<void>;
  respondToAgentQuestions: (
    threadId: string,
    recordId: string,
    questions: AgentQuestion[],
    answers: AgentQuestionAnswers
  ) => Promise<boolean>;
  updateThreadGoal: (threadId: string, goal: ThreadGoalUpdateInput, options?: ThreadGoalUpdateOptions) => Promise<boolean>;
  clearThreadGoal: (threadId: string) => Promise<void>;
  saveGoalDialog: () => Promise<void>;
  saveThreadRenameDialog: () => Promise<void>;
};

export const createThreadActions = (ctx: ThreadActionsContext, deps: ThreadActionsDependencies): ThreadActions => {
  let forkRequestPending = false;
  const loadingOlderThreads = new Set<string>();
  const resumeCandidateCwdsByMachine = new Map<string, Promise<Map<string, string>>>();
  const resumeCandidateCwd = async (machineId: string, threadId: string) => {
    let pending = resumeCandidateCwdsByMachine.get(machineId);
    if (!pending) {
      pending = apiRouteJson(apiRoutes.threadCandidates, machineId, undefined, 200)
        .then((payload) => new Map(
          (payload.threads ?? []).map((candidate) => [candidate.threadId, candidate.cwd])
        ));
      resumeCandidateCwdsByMachine.set(machineId, pending);
    }
    return (await pending).get(threadId);
  };
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

  const openThread = async (threadId: string, options: OpenThreadOptions = {}) => {
    const activate = options.activate !== false;
    const openedAt = options.lastOpenedAt ?? (activate ? new Date().toISOString() : undefined);
    ctx.closedThreadIds.current.delete(threadId);
    if (activate) {
      ctx.latestRequestedThreadId.current = threadId;
      if (!options.deferActivationUntilLoaded) ctx.setActiveTabThreadId(threadId);
    }
    const updateWorkspaceContext = activate && !ctx.selectedProjectKey;
    if (updateWorkspaceContext && options.preferredWorkingDirectory) {
      ctx.setActiveWorkspacePath(options.preferredWorkingDirectory);
    }

    const existingThread = ctx.openThreads.find((thread) => thread.threadId === threadId);
    const existingThreadMatchesMachine = existingThread && (
      !options.expectedMachineId
      || existingThread.runtime.machineId === options.expectedMachineId
    );
    if (existingThreadMatchesMachine) {
      const machineId = existingThread.runtime.machineId;
      if (activate || options.lastOpenedAt) {
        ctx.dispatchOpenThreads({ type: "set-fields", threadId, fields: { lastOpenedAt: openedAt! } });
      }
      if (options.projectTarget && options.projectTarget.machineId === machineId) {
        ctx.setThreadProjectTargets((current) => ({ ...current, [threadId]: options.projectTarget! }));
      } else if (options.projectTarget) {
        ctx.setThreadProjectTargets((current) => {
          if (!current[threadId]) return current;
          const next = { ...current };
          delete next[threadId];
          return next;
        });
      }
      subscribeThread(threadId, existingThread.lastSeq);
      if (machineId && activate) {
        if (updateWorkspaceContext) ctx.setActiveMachineId(machineId);
        ctx.setActiveTabThreadByMachine((current) => ({ ...current, [machineId]: threadId }));
      }
      if (updateWorkspaceContext) ctx.setActiveWorkspacePath(existingThread.workingDirectory);
      if (
        activate
        && options.deferActivationUntilLoaded
        && ctx.latestRequestedThreadId.current === threadId
      ) {
        ctx.setActiveTabThreadId(threadId);
      }
      return;
    }

    const existingOpen = ctx.openingThreads.current.get(threadId);
    if (existingOpen) {
      if (!options.expectedMachineId) return existingOpen;
      // A machine-scoped resume must not inherit an older in-flight open from
      // another machine. Let that request settle, then refresh canonical state.
      await existingOpen.catch(() => undefined);
    }

    const open = (async () => {
      let thread: ThreadDetail;
      if (options.initialThread) {
        if (options.initialThread.threadId !== threadId) {
          throw new Error(`Initial thread detail does not match ${threadId}.`);
        }
        thread = options.initialThread;
      } else {
        try {
          thread = await apiRouteJson(apiRoutes.thread, threadId);
        } catch (error) {
          if (!(error instanceof CodexHubApiError) || error.status !== 404 || !options.expectedMachineId) {
            throw error;
          }
          const workingDirectory = options.preferredWorkingDirectory
            || await resumeCandidateCwd(options.expectedMachineId, threadId);
          thread = await apiRouteJson(apiRoutes.createMachineThread, options.expectedMachineId, {
            action: "resume",
            threadId,
            ...(workingDirectory ? { cwd: workingDirectory } : {})
          });
        }
      }
      const machineId = thread.runtime.machineId;
      if (options.expectedMachineId && machineId !== options.expectedMachineId) {
        throw new Error(`Thread ${threadId} is attached to ${machineId ?? "an unknown machine"}, not ${options.expectedMachineId}.`);
      }
      if (machineId) {
        ctx.setThreadOrderByMachine((current) => appendThreadOrder(current, machineId, thread.threadId));
      }
      ctx.setRuntimeList((current) => patchRuntimesThread(current, thread));
      const projectTarget = options.projectTarget?.machineId === machineId
        ? options.projectTarget
        : undefined;
      ctx.setProjects((current) => patchProjectsThread(current, thread, projectTarget));
      ctx.notificationRecordsByThread.current.set(thread.threadId, threadRecordsForNotifications(thread.threadId, thread));
      ctx.dispatchOpenThreads({ type: "upsert-detail", thread });
      if (openedAt) {
        ctx.dispatchOpenThreads({ type: "set-fields", threadId: thread.threadId, fields: { lastOpenedAt: openedAt } });
      }
      if (projectTarget) {
        ctx.setThreadProjectTargets((current) => ({ ...current, [threadId]: projectTarget }));
      } else if (options.projectTarget) {
        ctx.setThreadProjectTargets((current) => {
          if (!current[threadId]) return current;
          const next = { ...current };
          delete next[threadId];
          return next;
        });
      }
      const shouldActivateThread = activate && ctx.latestRequestedThreadId.current === thread.threadId;
      if (activate && !shouldActivateThread) return;
      if (shouldActivateThread && machineId) {
        if (updateWorkspaceContext) ctx.setActiveMachineId(machineId);
        ctx.setActiveTabThreadByMachine((current) => ({ ...current, [machineId]: thread.threadId }));
      }
      if (shouldActivateThread && updateWorkspaceContext) ctx.setActiveWorkspacePath(thread.workingDirectory);
      if (shouldActivateThread) ctx.setActiveTabThreadId(thread.threadId);
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
      if (activate && !options.deferActivationUntilLoaded) clearActiveThreadIfLatest(threadId);
      throw error;
    } finally {
      if (ctx.openingThreads.current.get(threadId) === open) {
        ctx.openingThreads.current.delete(threadId);
      }
    }
  };

  const loadOlderThread = async (threadId: string) => {
    if (loadingOlderThreads.has(threadId)) return 0;
    const thread = ctx.conversationThreadsRef.current.get(threadId);
    let before = thread?.history?.oldestRecordId;
    if (!thread?.history?.hasOlder || !before) return 0;
    loadingOlderThreads.add(threadId);
    try {
      const expandedToolBatchKeys = new Set(ctx.expandedToolBatchKeys[threadId] ?? []);
      const initialViewCount = conversationViewsFromRecords(thread.records, expandedToolBatchKeys).length;
      let mergedRecords = thread.records;
      let loadedRecords: CodexRecord[] = [];
      let latestPage: ThreadDetail | null = null;
      const seenCursors = new Set<string>();

      while (before) {
        if (seenCursors.has(before)) throw new Error("Older history cursor repeated");
        seenCursors.add(before);
        const page: ThreadDetail = await apiRouteJson(apiRoutes.threadHistory, threadId, before, 24);
        latestPage = page;
        loadedRecords = combineRecordSources(page.records, loadedRecords);
        mergedRecords = combineRecordSources(page.records, mergedRecords);

        const visibleViewCount = conversationViewsFromRecords(mergedRecords, expandedToolBatchKeys).length;
        const nextBefore: string | undefined = page.history?.oldestRecordId;
        if (visibleViewCount > initialViewCount || !page.history?.hasOlder) break;
        if (!nextBefore || nextBefore === before) {
          throw new Error("Older history cursor did not advance");
        }
        before = nextBefore;
      }

      if (!latestPage) return 0;
      ctx.dispatchConversationThread({
        type: "merge-history",
        threadId,
        thread: {
          ...latestPage,
          records: loadedRecords
        }
      });
      return Math.max(
        0,
        conversationViewsFromRecords(mergedRecords, expandedToolBatchKeys).length - initialViewCount
      );
    } catch (error) {
      deps.showActionError(
        `${threadId}:history`,
        "Older messages failed",
        apiErrorDetails(error, { plainHttpMessage: true }).message
      );
      throw error;
    } finally {
      loadingOlderThreads.delete(threadId);
    }
  };

  const clearActiveThreadIfLatest = (threadId: string) => {
    if (
      ctx.latestRequestedThreadId.current === threadId
      || ctx.activeTabThreadIdRef?.current === threadId
    ) {
      ctx.setActiveTabThreadId("");
    }
  };

  const closeThread = async (threadId: string) => {
    if (ctx.closedThreadIds.current.has(threadId)) return;
    const threadIds = ctx.openThreads.map((thread) => thread.threadId);
    const closingThread = ctx.openThreads.find((thread) => thread.threadId === threadId);
    const machineId = closingThread?.runtime.machineId ?? ctx.activeRuntime?.machineId ?? "";
    const nextThreadId = ctx.activeTabThreadId === threadId
      ? adjacentThreadId(threadIds, threadId)
      : ctx.activeTabThreadId;
    const closingProjectTarget = ctx.threadProjectTargets[threadId];

    ctx.closedThreadIds.current.add(threadId);
    removeThreadFromUi(threadId, machineId, nextThreadId);
    try {
      await deleteThread(threadId);
      if (ctx.activeTabThreadId === threadId && nextThreadId) {
        await openThread(nextThreadId).catch(() => clearActiveThreadIfLatest(nextThreadId));
      }
    } catch (error) {
      ctx.closedThreadIds.current.delete(threadId);
      if (closingProjectTarget) {
        ctx.setThreadProjectTargets((current) => ({ ...current, [threadId]: closingProjectTarget }));
      }
      Modal.error({
        title: "Close thread failed",
        content: error instanceof Error ? error.message : String(error),
        okText: "Close"
      });
      await Promise.all([
        deps.refreshRuntimes().catch(() => undefined),
        deps.refreshProjects().catch(() => undefined)
      ]);
    }
  };

  function removeThreadFromUi(threadId: string, machineId: string, nextThreadId: string) {
    ctx.openingThreads.current.delete(threadId);
    ctx.composerDraftStore.delete(threadId);
    ctx.composerHistoryByThreadRef?.current.delete(threadId);
    ctx.threadLastSeqs.current.delete(threadId);
    unsubscribeThread(threadId);
    for (const image of ctx.openThreads.find((thread) => thread.threadId === threadId)?.imageAttachments ?? []) {
      URL.revokeObjectURL(image.previewUrl);
    }
    ctx.dispatchOpenThreads({ type: "remove", threadId });
    ctx.setThreadProjectTargets((current) => {
      if (!current[threadId]) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
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
    ctx.dispatchConversationThread({ type: "sync-detail", threadId: thread.threadId, thread });
    ctx.setRuntimeList((current) => patchRuntimesThread(current, thread));
    if (ctx.openThreadIdsRef.current.has(thread.threadId)) {
      ctx.setProjects((current) => patchProjectsThread(
        current,
        thread,
        ctx.threadProjectTargets?.[thread.threadId]
      ));
    }
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

  const deliverThreadInput = async (
    thread: OpenThreadState,
    input: ProxyInput,
    pendingMessageId?: string,
    options: { composerMode?: OpenThreadState["composerMode"]; submissionId?: string } = {}
  ): Promise<boolean> => {
    const composerMode = options.composerMode ?? thread.composerMode;
    const updatesActiveGoal = thread.running && composerMode === "goal";
    try {
      const payload = await apiRouteJson(apiRoutes.sendThreadTurn, thread.threadId, {
        ...(options.submissionId || pendingMessageId
          ? { submissionId: options.submissionId ?? pendingMessageId }
          : {}),
        input,
        source: "web",
        options: selectedThreadOptions(
          thread.modelDraft,
          thread.reasoningDraft,
          thread.serviceTierDraft,
          composerMode,
          thread.approvalPolicyDraft,
          thread.approvalsReviewerDraft,
          thread.permissionProfileDraft
        )
      });
      if (pendingMessageId && payload.command) {
        ctx.dispatchConversationThread({
          type: "remove-pending-user-message",
          threadId: thread.threadId,
          messageId: pendingMessageId
        });
      }
      if (composerMode !== "chat") {
        ctx.dispatchConversationThread({ type: "reset-composer-mode", threadId: thread.threadId, expected: composerMode });
      }
      return true;
    } catch (error) {
      if (pendingMessageId) {
        ctx.dispatchConversationThread({
          type: "remove-pending-user-message",
          threadId: thread.threadId,
          messageId: pendingMessageId
        });
      }
      const details = apiErrorDetails(error, { plainHttpMessage: true });
      if (details.delivery === "goal" || (!details.delivery && updatesActiveGoal)) {
        deps.showActionError(`${thread.threadId}:goal-update`, "Goal update failed", details.message);
      } else if (details.delivery !== "turn" && details.delivery !== "steer") {
        ctx.dispatchConversationThread({
          type: "append-record",
          threadId: thread.threadId,
          record: submissionFailedRecord(details.message)
        });
      }
      return false;
    }
  };

  const send = async (threadId: string) => {
    const openThread = ctx.conversationThreadsRef.current.get(threadId);
    if (!openThread) return;
    const rawDraftText = ctx.composerDraftStore.get(threadId);
    const typedText = rawDraftText.trim();
    if (typedText) {
      (ctx.composerInputHistoryStore ?? composerInputHistoryStore).record(rawDraftText);
    }
    const textAttachments = openThread.textAttachments;
    const imageAttachments = openThread.imageAttachments;
    if (!textAttachments.length && !imageAttachments.length && typedText.toLowerCase() === "/rename") {
      deps.resetComposerHistory(threadId);
      ctx.composerDraftStore.set(threadId, "");
      ctx.setThreadRenameDialog({
        threadId,
        title: "",
        generating: true,
        saving: false,
        error: ""
      });
      const requestToken = {};
      ctx.threadRenameRequestTokens.current.set(threadId, requestToken);
      void apiRouteJson(apiRoutes.suggestThreadTitle, threadId).then((payload) => {
        const title = payload.title?.trim();
        if (!title) throw new Error(payload.error || "Codex did not generate a title");
        if (ctx.threadRenameRequestTokens.current.get(threadId) !== requestToken) return;
        ctx.setThreadRenameDialog((current) => current?.threadId === threadId && current.generating
          ? { ...current, title, generating: false }
          : current);
      }).catch((error) => {
        if (ctx.threadRenameRequestTokens.current.get(threadId) !== requestToken) return;
        ctx.setThreadRenameDialog((current) => current?.threadId === threadId && current.generating
          ? {
              ...current,
              title: threadDisplayTitle(openThread),
              generating: false,
              error: apiErrorDetails(error).message
            }
          : current);
      }).finally(() => {
        if (ctx.threadRenameRequestTokens.current.get(threadId) === requestToken) {
          ctx.threadRenameRequestTokens.current.delete(threadId);
        }
      });
      return;
    }
    if (!textAttachments.length && !imageAttachments.length && deps.handleLocalComposerCommand(typedText)) {
      deps.resetComposerHistory(threadId);
      ctx.composerDraftStore.set(threadId, "");
      return;
    }
    deps.primeTaskCompletionFeedback();
    const text = composeUserInputText(typedText, textAttachments);
    if (!text && !imageAttachments.length) return;
    if (!textAttachments.length && !imageAttachments.length && isModelCommand(typedText)) {
      deps.resetComposerHistory(threadId);
      ctx.composerDraftStore.set(threadId, "");
      ctx.openThreadModelDialog(threadId);
      return;
    }
    const fastAction = !textAttachments.length && !imageAttachments.length ? fastCommandAction(typedText) : null;
    if (fastAction === "on" || fastAction === "off") {
      ctx.dispatchConversationThread({
        type: "set-draft",
        threadId,
        field: "serviceTierDraft",
        value: fastAction === "on" ? "priority" : "auto"
      });
    }
    deps.resetComposerHistory(threadId);
    ctx.composerDraftStore.set(threadId, "");
    ctx.dispatchConversationThread({ type: "clear-attachments", threadId });
    let encodedImages: Array<{ url: string }>;
    try {
      encodedImages = await Promise.all(imageAttachments.map(async (image) => ({ url: await fileToDataUrl(image.file) })));
      for (const image of imageAttachments) URL.revokeObjectURL(image.previewUrl);
    } catch (error) {
      ctx.composerDraftStore.set(threadId, typedText);
      ctx.dispatchConversationThread({
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
    const pendingMessageId = openThread.composerMode === "goal" ? undefined : `web:pending:${browserId()}`;
    if (pendingMessageId) {
      ctx.dispatchConversationThread({
        type: "enqueue-user-message",
        threadId,
        message: {
          id: pendingMessageId,
          text,
          imageUrls: encodedImages.map((image) => image.url),
          createdAt: new Date().toISOString()
        }
      });
    }
    await deliverThreadInput(openThread, input, pendingMessageId);
  };

  const stopTurn = async (threadId: string) => {
    await runActionRequest(
      `${threadId}:stop`,
      "Stop failed",
      () => apiRouteJson(apiRoutes.stopThreadTurn, threadId)
    );
  };

  const dismissPendingUserMessage = (threadId: string, messageId: string) => {
    ctx.dispatchConversationThread({
      type: "remove-pending-user-message",
      threadId,
      messageId
    });
  };

  const cancelQueuedSubmission = async (
    threadId: string,
    messageId: string,
    submissionId: string
  ) => {
    try {
      await apiRouteJson(apiRoutes.cancelQueuedThreadTurn, threadId, submissionId);
    } catch (error) {
      deps.showActionError(
        `${threadId}:queue:${submissionId}`,
        "Queue cancellation failed",
        apiErrorDetails(error, { plainHttpMessage: true }).message
      );
      return;
    }
    dismissPendingUserMessage(threadId, messageId);
  };

  const terminateBackgroundTerminal = async (threadId: string, processId: string) => {
    await runActionRequest(
      `${threadId}:background-terminal:${processId}`,
      "Terminate background process failed",
      async () => {
        const payload = await apiRouteJson(apiRoutes.terminateBackgroundTerminal, threadId, processId);
        if (payload.terminated !== true) throw new Error("The app-server did not terminate the background process.");
      }
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

  const respondToAgentQuestions = async (
    threadId: string,
    recordId: string,
    questions: AgentQuestion[],
    answers: AgentQuestionAnswers
  ) => {
    if (!questions.length || questions.some((_question, index) => !answers[index]?.trim())) {
      deps.showActionError(`${threadId}:agent-questions:${recordId}`, "Response failed", "Please answer every question.");
      return false;
    }
    const thread = ctx.conversationThreadsRef.current.get(threadId);
    if (!thread) {
      deps.showActionError(`${threadId}:agent-questions:${recordId}`, "Response failed", "Thread is no longer open.");
      return false;
    }
    const submissionId = `agent-answer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return deliverThreadInput(
      thread,
      formatAgentQuestionAnswers(questions, answers),
      undefined,
      { composerMode: "chat", submissionId }
    );
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
    ctx.setGoalDialog((current) => current ? { ...current, saving: true, error: "" } : current);
    const saved = await updateThreadGoal(dialog.threadId, { objective }, { dialog: true });
    if (saved) ctx.setGoalDialog(null);
  };

  return {
    openThread,
    loadOlderThread,
    clearActiveThreadIfLatest,
    closeThread,
    removeThreadFromUi,
    deleteThread,
    subscribeThread,
    unsubscribeThread,
    syncThreadSubscriptions,
    forkMessage,
    send,
    dismissPendingUserMessage,
    cancelQueuedSubmission,
    stopTurn,
    terminateBackgroundTerminal,
    compactThread,
    reviewThread,
    respondToApproval,
    respondToUserInput,
    respondToAgentQuestions,
    updateThreadGoal,
    clearThreadGoal,
    saveGoalDialog,
    saveThreadRenameDialog
  };
};
