import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Tabs } from "antd";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { asRecord, type CodexRecord } from "../core/codexRecord.js";
import { recordsToViews, type CodexRecordView } from "../core/codexRecordView.js";
import { compactToolViews, type CompactRecordView } from "../shared/compactRecordViews.js";
import "antd/dist/reset.css";
import "./style.css";

type ThreadSummary = {
  threadId: string;
  workingDirectory: string;
  runtime: ThreadRuntimeSummary;
  model?: string;
  modelReasoningEffort?: ReasoningEffort;
  status: ThreadStatus;
  running: boolean;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastUsage?: Usage;
  codexUsage?: CodexUsageSnapshot;
};

type ThreadRuntimeSummary =
  {
    workerId?: string;
    name?: string;
    online: boolean;
    runnable: boolean;
    lastSeenAt?: string;
  };

type ThreadDetail = ThreadSummary & {
  records: CodexRecord[];
  lastSeq: number;
};

type WorkerSummary = {
  workerId: string;
  name?: string;
  workingDirectory: string;
  appServerUrl?: string;
  online: boolean;
  lastSeenAt: string;
  pid?: number;
  hostname?: string;
  currentThreadId?: string;
  currentThread?: ThreadSummary;
  threads?: ThreadSummary[];
  codexUsage?: CodexUsageSnapshot;
};

type ChatSession = ThreadDetail & {
  input: string;
  imageAttachments: ImageAttachment[];
};

type ImageAttachment = {
  id: string;
  file: File;
  name: string;
  previewUrl: string;
};

type StreamEvent = {
  seq: number;
  kind: "thread" | "record" | "done";
  thread: ThreadSummary;
  record?: CodexRecord;
};

type WorkerStreamEvent = {
  seq: number;
  kind: "workers";
  workers: WorkerSummary[];
};

type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens?: number;
};

type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
type ThreadStatus = "running" | "idle";
type ModelSelection = string;
type ReasoningSelection = "auto" | ReasoningEffort;
type MessageDisplayMode = "compact" | "detailed";
type WebRecordView = CompactRecordView;
type InspectDetail = {
  inputMeta: string;
  inputBlockLabel?: string;
  inputBlock?: string;
  outputMeta?: string;
  outputBlockLabel?: string;
  outputBlock?: string;
};

type SystemStatus = {
  model: string | null;
  modelReasoningEffort: string | null;
  contextWindowTokens: number | null;
};

type RateLimitWindow = {
  used_percent: number;
  window_minutes: number;
  resets_at: number;
};

type CodexUsageSnapshot = {
  rateLimits: {
    limit_id?: string | null;
    limit_name?: string | null;
    primary?: RateLimitWindow | null;
    secondary?: RateLimitWindow | null;
    plan_type?: string | null;
    rate_limit_reached_type?: string | null;
  } | null;
  tokenUsage: {
    totalTokenUsage: Usage & { total_tokens: number } | null;
    lastTokenUsage: (Usage & { total_tokens: number }) | null;
    modelContextWindow: number | null;
  } | null;
  sourceFile: string | null;
  observedAt: string | null;
  source: "latest" | "thread";
};

const storageKey = "codex-proxy-ui-state-v4";
const modelOptions: Array<{ value: ModelSelection; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4-Mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
  { value: "gpt-5.2", label: "GPT-5.2" }
];
const reasoningOptions: Array<{ value: ReasoningSelection; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" }
];
const App = () => {
  const [activeWorkspacePath, setActiveWorkspacePath] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeTabThreadId, setActiveTabThreadId] = useState("");
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [activeWorkerId, setActiveWorkerId] = useState("");
  const [activeTabThreadByWorker, setActiveTabThreadByWorker] = useState<Record<string, string>>({});
  const [threadOrderByWorker, setThreadOrderByWorker] = useState<Record<string, string[]>>({});
  const [initialized, setInitialized] = useState(false);
  const [inspectMessage, setInspectMessage] = useState<WebRecordView | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({
    model: null,
    modelReasoningEffort: null,
    contextWindowTokens: null
  });
  const [selectedModel, setSelectedModel] = useState<ModelSelection>("auto");
  const [selectedReasoning, setSelectedReasoning] = useState<ReasoningSelection>("auto");
  const [messageDisplayMode, setMessageDisplayMode] = useState<MessageDisplayMode>("compact");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const workersEventSource = useRef<EventSource | null>(null);
  const eventSources = useRef(new Map<string, EventSource>());
  const messagesRef = useRef<VirtuosoHandle>(null);
  const messagesScrollerRef = useRef<HTMLElement | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.threadId === activeTabThreadId),
    [activeTabThreadId, sessions]
  );
  const activeWorker = useMemo(
    () => workers.find((worker) => worker.workerId === activeWorkerId),
    [activeWorkerId, workers]
  );
  const activeWorkerThreads = useMemo(() => {
    const byId = new Map<string, ThreadSummary>();
    for (const thread of activeWorker?.threads ?? []) byId.set(thread.threadId, thread);
    if (activeWorker?.currentThread) byId.set(activeWorker.currentThread.threadId, activeWorker.currentThread);
    const orderedIds = threadOrderByWorker[activeWorker?.workerId ?? ""] ?? [];
    return [
      ...orderedIds.flatMap((threadId) => {
        const thread = byId.get(threadId);
        if (!thread) return [];
        byId.delete(threadId);
        return [thread];
      }),
      ...byId.values()
    ];
  }, [activeWorker, threadOrderByWorker]);
  const activeWorkerThreadTabs = useMemo(() => activeWorkerThreads.map((thread) => {
    const title = thread.title || shortId(thread.threadId);
    const isWorkerCurrentThread = thread.threadId === activeWorker?.currentThreadId;
    return {
      key: thread.threadId,
      label: (
        <span className="workspaceThreadTabLabel" title={`${title}\n${thread.threadId}`}>
          <span
            className={`workerCurrentThreadMark ${isWorkerCurrentThread ? "visible" : ""}`}
            title={isWorkerCurrentThread ? "Worker current thread" : undefined}
            aria-label={isWorkerCurrentThread ? "Worker current thread" : undefined}
            aria-hidden={isWorkerCurrentThread ? undefined : true}
          />
          <span>{title}</span>
          <code>{shortId(thread.threadId)}</code>
        </span>
      )
    };
  }), [activeWorker?.currentThreadId, activeWorkerThreads]);
  const detailedViews = useMemo<CodexRecordView[]>(
    () => recordsToViews(activeSession?.records ?? []),
    [activeSession?.records]
  );
  const activeViews = useMemo<WebRecordView[]>(
    () => messageDisplayMode === "compact" ? compactToolViews(detailedViews) : detailedViews,
    [detailedViews, messageDisplayMode]
  );
  const latestView = activeViews.at(-1);
  const latestViewKey = latestView
    ? `${latestView.id}:${latestView.status ?? ""}:${latestView.text.length}:${latestView.usage ? usageTotal(latestView.usage) : ""}`
    : "";
  const activeWorkerThreadId = activeWorker?.currentThreadId ?? "";
  const activeDisplayThreadId = activeSession?.threadId ?? activeWorkerThreadId;
  const activeSessionBelongsToWorker = Boolean(activeSession && activeWorkerThreads.some((thread) => thread.threadId === activeSession.threadId));
  const activeCanSend = Boolean(
    activeSession
    && activeSessionBelongsToWorker
    && activeWorker?.online
    && (activeSession.input.trim() || activeSession.imageAttachments.length)
  ) && !activeSession?.running;
  const activeCanSubmit = Boolean(activeSessionBelongsToWorker && (activeSession?.running || activeCanSend));
  const runtimeModelOptions = useMemo(() => modelOptionsForSelection(selectedModel), [selectedModel]);
  const activeCodexUsage = activeSession?.codexUsage
    ?? activeWorkerThreads.find((thread) => thread.threadId === activeTabThreadId)?.codexUsage
    ?? activeWorker?.currentThread?.codexUsage
    ?? activeWorker?.codexUsage
    ?? null;

  useEffect(() => {
    void initialize();
    return () => {
      workersEventSource.current?.close();
      for (const source of eventSources.current.values()) source.close();
    };
  }, []);

  useEffect(() => {
    if (!initialized) return;
    localStorage.setItem(storageKey, JSON.stringify({
      activeWorkspacePath,
      activeWorkerId,
      selectedModel,
      selectedReasoning,
      messageDisplayMode,
      sidebarCollapsed
    }));
  }, [activeWorkspacePath, activeWorkerId, selectedModel, selectedReasoning, messageDisplayMode, sidebarCollapsed, initialized]);

  useEffect(() => {
    if (!initialized) return;
    if (!workers.length) {
      if (activeWorkerId) setActiveWorkerId("");
      if (activeTabThreadId) setActiveTabThreadId("");
      return;
    }

    const worker = activeWorker ?? workers[0];
    if (!activeWorker) {
      setActiveWorkerId(worker.workerId);
      return;
    }

    setActiveWorkspacePath(worker.workingDirectory);
    const threadIds = new Set((worker.threads ?? []).map((thread) => thread.threadId));
    if (worker.currentThreadId) threadIds.add(worker.currentThreadId);
    const activeTabThreadIdForWorker = activeTabThreadByWorker[worker.workerId];
    const desiredThreadId = activeTabThreadIdForWorker && threadIds.has(activeTabThreadIdForWorker)
      ? activeTabThreadIdForWorker
      : worker.currentThreadId;

    if (activeTabThreadIdForWorker && !threadIds.has(activeTabThreadIdForWorker)) {
      setActiveTabThreadByWorker(({ [worker.workerId]: _removed, ...rest }) => rest);
    }

    if (!desiredThreadId) {
      if (activeTabThreadId) setActiveTabThreadId("");
      return;
    }
    if (activeTabThreadId !== desiredThreadId) {
      void openThread(desiredThreadId).catch(() => setActiveTabThreadId(""));
    }
  }, [activeTabThreadId, activeWorker, activeWorkerId, initialized, activeTabThreadByWorker, workers]);

  useEffect(() => {
    if (!activeSession) return;
    setSelectedModel(activeSession.model ?? "auto");
    setSelectedReasoning(activeSession.modelReasoningEffort ?? "auto");
  }, [activeSession?.threadId, activeSession?.model, activeSession?.modelReasoningEffort]);

  useEffect(() => {
    if (!activeViews.length) return;
    const scrollToBottom = (behavior: "auto" | "smooth" = "smooth") => {
      messagesRef.current?.scrollToIndex({
        index: "LAST",
        align: "end",
        behavior
      });
      const scroller = messagesScrollerRef.current;
      if (scroller) {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior });
      }
    };
    const firstFrame = window.requestAnimationFrame(() => {
      scrollToBottom(activeSession?.running ? "auto" : "smooth");
      window.setTimeout(() => scrollToBottom("auto"), 80);
    });
    return () => window.cancelAnimationFrame(firstFrame);
  }, [activeTabThreadId, activeViews.length, latestViewKey, activeSession?.running]);

  useEffect(() => {
    if (!composerMenuOpen) return undefined;
    const close = () => setComposerMenuOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [composerMenuOpen]);

  useEffect(() => {
    const stopOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !activeSession?.running) return;
      event.preventDefault();
      void stopTurn(activeSession.threadId);
    };
    window.addEventListener("keydown", stopOnEscape);
    return () => window.removeEventListener("keydown", stopOnEscape);
  }, [activeSession?.threadId, activeSession?.running]);

  const initialize = async () => {
    const [health, workerData] = await Promise.all([
      apiJson<{ defaultWorkingDirectory?: string | null } & SystemStatus>("/api/health"),
      apiJson<{ workers?: WorkerSummary[] }>("/api/workers")
    ]);
    const defaultDirectory = health.defaultWorkingDirectory ?? "";
    const loadedWorkers = normalizeWorkers(workerData.workers);
    const saved = readStoredUiState();
    const savedWorker = saved?.activeWorkerId
      ? loadedWorkers.find((worker) => worker.workerId === saved.activeWorkerId)
      : undefined;
    const initialWorker = savedWorker ?? loadedWorkers[0];

    setSystemStatus({
      model: health.model,
      modelReasoningEffort: health.modelReasoningEffort,
      contextWindowTokens: health.contextWindowTokens
    });
    setActiveWorkspacePath(saved?.activeWorkspacePath ?? defaultDirectory);
    setSelectedModel(saved?.selectedModel ?? "auto");
    setSelectedReasoning(saved?.selectedReasoning ?? "auto");
    setMessageDisplayMode(saved?.messageDisplayMode ?? "compact");
    setSidebarCollapsed(window.matchMedia("(max-width: 860px)").matches ? true : saved?.sidebarCollapsed ?? false);
    setWorkers(loadedWorkers);
    setThreadOrderByWorker((current) => mergeThreadOrderByWorker(current, loadedWorkers));
    subscribeWorkers(0);
    if (initialWorker) {
      setActiveWorkerId(initialWorker.workerId);
      setActiveWorkspacePath(initialWorker.workingDirectory);
      if (initialWorker.currentThreadId) await openThread(initialWorker.currentThreadId);
    }
    setInitialized(true);
  };

  const subscribeWorkers = (after: number) => {
    workersEventSource.current?.close();
    const source = new EventSource(`/api/workers/events?after=${after}`);
    source.addEventListener("workers", (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as WorkerStreamEvent;
      const nextWorkers = normalizeWorkers(payload.workers);
      setWorkers(nextWorkers);
      setThreadOrderByWorker((current) => mergeThreadOrderByWorker(current, nextWorkers));
    });
    workersEventSource.current = source;
  };

  const openThread = async (threadId: string) => {
    const thread = await apiJson<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}`);
    const session: ChatSession = { ...thread, input: "", imageAttachments: [] };
    const workerId = thread.runtime.workerId;
    if (workerId) {
      setThreadOrderByWorker((current) => appendThreadOrder(current, workerId, thread.threadId));
    }
    closeThreadSubscriptionsExcept(thread.threadId);
    setSessions((current) => [...current.filter((item) => item.threadId !== thread.threadId), session]);
    setActiveWorkspacePath(thread.workingDirectory);
    setActiveTabThreadId(thread.threadId);
    subscribeThread(thread.threadId, thread.lastSeq);
  };

  const closeThreadSubscriptionsExcept = (threadId: string) => {
    for (const [subscribedThreadId, source] of eventSources.current) {
      if (subscribedThreadId === threadId) continue;
      source.close();
      eventSources.current.delete(subscribedThreadId);
    }
  };

  const subscribeThread = (threadId: string, after: number) => {
    eventSources.current.get(threadId)?.close();
    const source = new EventSource(`/api/threads/${encodeURIComponent(threadId)}/events?after=${after}`);
    const handle = (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as StreamEvent;
      setSessions((current) => current.map((session) => {
        if (session.threadId !== payload.thread.threadId) return session;
        const records = payload.record ? mergeRecord(session.records, payload.record) : session.records;
        return { ...session, ...payload.thread, records };
      }));
    };
    source.addEventListener("thread", handle);
    source.addEventListener("record", handle);
    source.addEventListener("message", handle);
    source.addEventListener("done", handle);
    eventSources.current.set(threadId, source);
  };

  const forkMessage = async (threadId: string, messageId: string) => {
    try {
      const thread = await apiJson<ThreadDetail>(`/api/threads/${encodeURIComponent(threadId)}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId })
      });
      const workerId = thread.runtime.workerId ?? activeWorker?.workerId;
      if (workerId) {
        setActiveTabThreadByWorker((current) => ({ ...current, [workerId]: thread.threadId }));
        setThreadOrderByWorker((current) => appendThreadOrder(current, workerId, thread.threadId));
      }
      await openThread(thread.threadId);
    } catch (error) {
      setSessions((current) => current.map((item) => item.threadId === threadId
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
      const session: ChatSession = { ...thread, input: "", imageAttachments: [] };
      setSessions((current) => {
        const existing = current.find((item) => item.threadId === thread.threadId);
        const nextSession = existing
          ? { ...session, input: existing.input, imageAttachments: existing.imageAttachments }
          : session;
        return current.some((item) => item.threadId === thread.threadId)
          ? current.map((item) => item.threadId === thread.threadId ? nextSession : item)
          : [...current, nextSession];
      });
      setActiveWorkspacePath(thread.workingDirectory);
      setActiveTabThreadId(thread.threadId);
      subscribeThread(thread.threadId, thread.lastSeq);
    } catch (error) {
      setSessions((current) => current.map((item) => item.threadId === threadId
        ? {
          ...item,
          records: [...item.records, errorRecord("rollback failed", error)]
        }
        : item));
    }
  };

  const send = async (threadId: string) => {
    const session = sessions.find((item) => item.threadId === threadId);
    if (!session || session.running) return;
    const text = session.input.trim();
    const imageAttachments = session.imageAttachments;
    if (!text && !imageAttachments.length) return;
    if (!imageAttachments.length && isModelCommand(text)) {
      setSessions((current) => current.map((item) => item.threadId === threadId ? { ...item, input: "" } : item));
      setRuntimeDialogOpen(true);
      return;
    }
    setSessions((current) => current.map((item) => item.threadId === threadId ? { ...item, input: "", imageAttachments: [] } : item));
    let encodedImages: Array<{ url: string }>;
    try {
      encodedImages = await Promise.all(imageAttachments.map(async (image) => ({ url: await fileToDataUrl(image.file) })));
      for (const image of imageAttachments) URL.revokeObjectURL(image.previewUrl);
    } catch (error) {
      setSessions((current) => current.map((item) => item.threadId === threadId
        ? {
          ...item,
          input: text,
          imageAttachments,
          records: [...item.records, errorRecord("image encode failed", error)]
        }
        : item));
      return;
    }
    const input = encodedImages.length
      ? [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...encodedImages.map((image) => ({ type: "image" as const, url: image.url }))
      ]
      : text;
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, source: "web", options: selectedThreadOptions(selectedModel, selectedReasoning) })
    });
    if (!response.ok) {
      const text = await response.text();
      setSessions((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("error", text)] }
        : item));
    }
  };

  const stopTurn = async (threadId: string) => {
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/stop`, { method: "POST" });
    if (!response.ok) {
      const text = await response.text();
      setSessions((current) => current.map((item) => item.threadId === threadId
        ? { ...item, records: [...item.records, errorRecord("stop failed", text)] }
        : item));
    }
  };

  const updateSessionInput = (threadId: string, input: string) => {
    setSessions((current) => current.map((session) => session.threadId === threadId ? { ...session, input } : session));
  };

  const addSessionImageFiles = (threadId: string, files: File[]) => {
    if (!files.length) return;
    const images = files
      .filter((file) => file.type.startsWith("image/"))
      .map((file) => ({
        id: browserId(),
        file,
        name: file.name,
        previewUrl: URL.createObjectURL(file)
      }));
    if (!images.length) return;
    setSessions((current) => current.map((session) => session.threadId === threadId
      ? { ...session, imageAttachments: [...session.imageAttachments, ...images] }
      : session));
  };

  const addSessionImages = (threadId: string, files: FileList | null) => {
    if (!files?.length) return;
    addSessionImageFiles(threadId, [...files]);
  };

  const pasteSessionImages = (threadId: string, clipboardData: DataTransfer) => {
    const images = clipboardImageFiles(clipboardData);
    if (!images.length) return false;
    addSessionImageFiles(threadId, images);
    return true;
  };

  const removeSessionImage = (threadId: string, imageId: string) => {
    setSessions((current) => current.map((session) => {
      if (session.threadId !== threadId) return session;
      const image = session.imageAttachments.find((item) => item.id === imageId);
      if (image) URL.revokeObjectURL(image.previewUrl);
      return { ...session, imageAttachments: session.imageAttachments.filter((item) => item.id !== imageId) };
    }));
  };

  const selectWorker = async (worker: WorkerSummary) => {
    setActiveWorkerId(worker.workerId);
    setActiveWorkspacePath(worker.workingDirectory);
    const activeTabThreadIdForWorker = activeTabThreadByWorker[worker.workerId];
    const targetThreadId = activeTabThreadIdForWorker ?? worker.currentThreadId;
    if (targetThreadId) {
      await openThread(targetThreadId);
    } else {
      setActiveTabThreadId("");
    }
  };

  const switchWorkerThread = async (threadId: string) => {
    if (!activeWorker || threadId === activeTabThreadId) return;
    setActiveTabThreadByWorker((current) => ({ ...current, [activeWorker.workerId]: threadId }));
    await openThread(threadId);
  };

  return (
    <main className={`app ${sidebarCollapsed ? "sidebarCollapsed" : ""}`}>
      {!sidebarCollapsed ? (
        <button
          type="button"
          className="sidebarScrim"
          onClick={() => setSidebarCollapsed(true)}
          aria-label="Hide workers"
        />
      ) : null}
      <aside className="sidebar">
        <div className="brand">
          <div>
            <h1>Codex Proxy</h1>
            <p>Local agent workbench</p>
          </div>
        </div>

        <section className="proxyWorkers expanded">
          <h2>Codex Workers</h2>
          {workers.length === 0 ? (
            <div className="proxyWorkerEmpty">No connected codexp</div>
          ) : (
            <div className="proxyWorkerList">
              {workers.map((worker) => {
                const workerLabel = worker.name ?? shortId(worker.workerId);
                const threadTitle = worker.currentThread?.title ?? "No current thread";
                const threadLabel = worker.currentThreadId ? `thread ${worker.currentThreadId}` : "no thread";
                return (
                  <button
                    type="button"
                    className={`proxyWorkerRow ${worker.workerId === activeWorkerId ? "active" : ""}`}
                    key={worker.workerId}
                    onClick={() => void selectWorker(worker)}
                  >
                    <span title={workerLabel}>{workerLabel}</span>
                    <strong>{worker.currentThread?.status ?? "idle"}</strong>
                    <code title={threadTitle}>{threadTitle}</code>
                    <em className="proxyWorkerMeta">
                      <span className="proxyWorkerDirectory" title={worker.workingDirectory}>{worker.workingDirectory}</span>
                      <span className="proxyWorkerThread" title={threadLabel}>{threadLabel}</span>
                    </em>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button
            type="button"
            className="sidebarPanelToggle"
            onClick={() => setSidebarCollapsed((current) => !current)}
            aria-label={sidebarCollapsed ? "Show workers" : "Hide workers"}
            title={sidebarCollapsed ? "Show workers" : "Hide workers"}
          >
            {sidebarCollapsed ? "Workers" : "Hide"}
          </button>
          <div className="workspaceTitle">
            <span title={activeWorker ? activeWorker.name ?? shortId(activeWorker.workerId) : "No connected codexp"}>
              {activeWorker ? activeWorker.name ?? shortId(activeWorker.workerId) : "No connected codexp"}
            </span>
            <code className="workspaceMeta">
              <span className="workspacePath" title={activeWorker?.workingDirectory ?? activeWorkspacePath}>
                {activeWorker?.workingDirectory ?? activeWorkspacePath}
              </span>
              {activeDisplayThreadId ? (
                <span className="workspaceThreadId" title={`thread: ${activeDisplayThreadId}`}>thread: {activeDisplayThreadId}</span>
              ) : activeWorker ? (
                <span className="workspaceThreadId" title="thread: none">thread: none</span>
              ) : null}
            </code>
          </div>
          <div className="workbar" aria-label="Runtime status">
            <span title={formatContextTitle(activeCodexUsage)}>
              Context {formatContextUsage(activeCodexUsage)}
            </span>
            <span title={formatResetTitle(activeCodexUsage?.rateLimits?.primary)}>5h {formatRateLimitRemaining(activeCodexUsage?.rateLimits?.primary)}</span>
            <span title={formatResetTitle(activeCodexUsage?.rateLimits?.secondary)}>weekly {formatRateLimitRemaining(activeCodexUsage?.rateLimits?.secondary)}</span>
            <label className="switchControl">
              <span>View</span>
              <button
                type="button"
                className={`switchButton ${messageDisplayMode === "compact" ? "active" : ""}`}
                aria-pressed={messageDisplayMode === "compact"}
                onClick={() => setMessageDisplayMode((current) => current === "compact" ? "detailed" : "compact")}
              >
                {messageDisplayMode === "compact" ? "Simple" : "Detailed"}
              </button>
            </label>
          </div>
        </header>

        {activeWorker && activeSession && activeSessionBelongsToWorker ? (
          <Tabs
            className="workspaceThreadTabs"
            size="small"
            activeKey={activeSession.threadId}
            items={activeWorkerThreadTabs.map((item) => ({
              ...item,
              children: item.key === activeSession.threadId ? (
                <div className="threadWorkspacePane">
                  <Virtuoso
                    key={activeSession.threadId}
                    ref={messagesRef}
                    scrollerRef={(ref) => {
                      messagesScrollerRef.current = ref instanceof HTMLElement ? ref : null;
                    }}
                    className="messages"
                    data={activeViews}
                    followOutput={() => "smooth"}
                    initialTopMostItemIndex={Math.max(activeViews.length - 1, 0)}
                    increaseViewportBy={{ top: 360, bottom: 720 }}
                    computeItemKey={(_, message) => message.id}
                    components={{ EmptyPlaceholder: EmptyMessages }}
                    itemContent={(_, message) => (
                      <MessageCard
                        message={message}
                        showStatus={messageDisplayMode === "compact" || message.role !== "tool"}
                        onInspect={messageDisplayMode === "compact" && message.role === "tool" ? () => setInspectMessage(message) : undefined}
                        onFork={canForkAtMessage(activeSession.threadId, message) ? () => void forkMessage(activeSession.threadId, message.record.id) : undefined}
                        onRollback={canForkAtMessage(activeSession.threadId, message) ? () => void rollbackMessage(activeSession.threadId, message.record.id) : undefined}
                      />
                    )}
                  />

                  <form
                    className="composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (activeSession.running) void stopTurn(activeSession.threadId);
                      else void send(activeSession.threadId);
                    }}
                  >
                    <div className="composerLayout">
                      <div className="composerSurface">
                        <div className="composerInput">
                          {activeSession.imageAttachments.length ? (
                            <div className="imageAttachmentList">
                              {activeSession.imageAttachments.map((image) => (
                                <div className="imageAttachment" key={image.id}>
                                  <img src={image.previewUrl} alt={image.name} />
                                  <button type="button" onClick={() => removeSessionImage(activeSession.threadId, image.id)} aria-label={`Remove ${image.name}`}>x</button>
                                </div>
                              ))}
                            </div>
                          ) : null}
                          <textarea
                            value={activeSession.input}
                            onChange={(event) => updateSessionInput(activeSession.threadId, event.target.value)}
                            onPaste={(event) => {
                              if (!pasteSessionImages(activeSession.threadId, event.clipboardData)) return;
                              event.preventDefault();
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                              event.preventDefault();
                              if (activeCanSend) void send(activeSession.threadId);
                            }}
                            placeholder="例如：检查这个 repo 的结构并给我下一步建议"
                            rows={1}
                          />
                        </div>
                        <div className="composerActions">
                          <div className="composerLeftActions">
                            <div className="composerMenuHost" onClick={(event) => event.stopPropagation()}>
                              <button
                                type="button"
                                className="composerIconButton"
                                aria-label="Open composer menu"
                                aria-expanded={composerMenuOpen}
                                onClick={() => setComposerMenuOpen((open) => !open)}
                              >
                                +
                              </button>
                              {composerMenuOpen ? (
                                <div className="composerMenu" role="menu">
                                  <button
                                    type="button"
                                    className="composerMenuItem"
                                    role="menuitem"
                                    onClick={() => {
                                      setComposerMenuOpen(false);
                                      imageFileInputRef.current?.click();
                                    }}
                                  >
                                    <span className="composerMenuIcon" aria-hidden="true">[]</span>
                                    <span>添加照片和文件</span>
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                          <div className="composerRightActions">
                            <button
                              type="button"
                              className="composerModelButton"
                              onClick={() => setRuntimeDialogOpen(true)}
                            >
                              {modelLabel(selectedModel)}
                            </button>
                            <button type="submit" className="composerSendButton" disabled={!activeCanSubmit} aria-label={activeSession.running ? "Stop current turn" : "Send message"}>
                              {activeSession.running ? <span className="composerStopIcon" aria-hidden="true" /> : "↑"}
                            </button>
                          </div>
                        </div>
                        <input
                          ref={imageFileInputRef}
                          className="imageUploadInput"
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={(event) => {
                            addSessionImages(activeSession.threadId, event.currentTarget.files);
                            event.currentTarget.value = "";
                          }}
                        />
                      </div>
                    </div>
                  </form>
                </div>
              ) : null
            }))}
            onChange={(threadId) => void switchWorkerThread(threadId)}
          />
        ) : (
          <div className="empty">{activeWorker ? activeWorker.currentThreadId ? "Loading thread" : "No current thread" : "No connected codexp"}</div>
        )}
      </section>

      {runtimeDialogOpen ? (
        <div className="runtimeDialogOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setRuntimeDialogOpen(false);
        }}>
          <section className="runtimeDialog" role="dialog" aria-modal="true" aria-labelledby="runtimeDialogTitle">
            <header className="runtimeDialogHeader">
              <h2 id="runtimeDialogTitle">Runtime</h2>
              <button type="button" className="iconButton" onClick={() => setRuntimeDialogOpen(false)} aria-label="Close">x</button>
            </header>
            <label className="runtimeDialogField">
              <span>Model</span>
              <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value as ModelSelection)}>
                {runtimeModelOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="runtimeDialogField">
              <span>Thinking</span>
              <select value={selectedReasoning} onChange={(event) => setSelectedReasoning(event.target.value as ReasoningSelection)}>
                {reasoningOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
          </section>
        </div>
      ) : null}

      {inspectMessage ? (
        <div className="modalOverlay" role="dialog" aria-modal="true" onClick={() => setInspectMessage(null)}>
          <section className="modal detailModal" onClick={(event) => event.stopPropagation()}>
            <header className="modalHeader">
              <div>
                <h2>{inspectMessage.label}</h2>
                <p>{inspectMessage.status ? statusLabel(inspectMessage.status) : "Details"}</p>
              </div>
              <button type="button" className="iconButton" onClick={() => setInspectMessage(null)} aria-label="Close">x</button>
            </header>
            <ToolInspectBody message={inspectMessage} />
          </section>
        </div>
      ) : null}
    </main>
  );
};

const MessageCard = ({
  message,
  showStatus = true,
  onInspect,
  onFork,
  onRollback
}: {
  message: WebRecordView;
  showStatus?: boolean;
  onInspect?: () => void;
  onFork?: () => void;
  onRollback?: () => void;
}) => (
  <article
    className={`message ${message.role} ${onInspect ? "inspectable" : ""}`}
    onClick={onInspect}
    role={onInspect ? "button" : undefined}
    tabIndex={onInspect ? 0 : undefined}
    onKeyDown={onInspect ? (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onInspect();
      }
    } : undefined}
  >
    <span className="messageHeader">
      <b>{message.label ?? message.role}</b>
      {showStatus && message.status ? <em className={`messageStatus ${message.status}`}>{statusLabel(message.status)}</em> : null}
    </span>
    {message.text ? <pre>{message.text}</pre> : null}
    {message.attachments?.length ? (
      <div className="messageAttachments">
        {message.attachments.map((attachment) => attachment.type === "image" ? (
          <a
            href={attachment.url}
            target="_blank"
            rel="noreferrer"
            className="messageImage"
            key={attachment.url}
            onClick={(event) => event.stopPropagation()}
          >
            <img src={attachment.url} alt="attachment" />
          </a>
        ) : null)}
      </div>
    ) : null}
    {message.at || message.usage || onFork || onRollback ? (
      <footer className="messageMeta" title={formatMessageMetaTitle(message)} onClick={(event) => event.stopPropagation()}>
        <span>{formatMessageMeta(message)}</span>
        {onFork ? (
          <a href="#" onClick={(event) => {
            event.preventDefault();
            onFork();
          }}>Fork</a>
        ) : null}
        {onRollback ? (
          <a href="#" onClick={(event) => {
            event.preventDefault();
            onRollback();
          }}>Rollback</a>
        ) : null}
      </footer>
    ) : null}
  </article>
);

const EmptyMessages = () => (
  <div className="empty">输入一个任务，让本地 Codex 代理开始工作。</div>
);

const ToolInspectBody = ({ message }: { message: WebRecordView }) => {
  const detail = formatInspectDetail(message);
  return (
    <div className="detailBody">
      <section className="detailSection">
        <h3>Input</h3>
        <pre>{detail.inputMeta || "(empty)"}</pre>
        {detail.inputBlock ? (
          <div className="detailCodeBlock">
            <h4>{detail.inputBlockLabel ?? "Content"}</h4>
            <pre>{detail.inputBlock}</pre>
          </div>
        ) : null}
      </section>
      {detail.outputMeta || detail.outputBlock ? (
        <section className="detailSection">
          <h3>Output</h3>
          {detail.outputMeta ? <pre>{detail.outputMeta}</pre> : null}
          {detail.outputBlock ? (
            <div className="detailCodeBlock">
              <h4>{detail.outputBlockLabel ?? "Text"}</h4>
              <pre>{detail.outputBlock}</pre>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
};

const apiJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
};

const fileToDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
  reader.readAsDataURL(file);
});

const shortId = (id: string) => id.slice(0, 8);

const canForkAtMessage = (threadId: string, message: WebRecordView) =>
  Boolean(message.canFork && turnIdFromAppRecordId(threadId, message.record.id));

const turnIdFromAppRecordId = (threadId: string, recordId: string) => {
  const prefix = `app:${threadId}:`;
  if (!recordId.startsWith(prefix)) return null;
  const rest = recordId.slice(prefix.length);
  const [turnId, kind] = rest.split(":");
  if (!turnId || !kind) return null;
  return kind === "user" || kind === "agent" || kind === "usage" ? turnId : null;
};

const normalizeWorkers = (workers: WorkerSummary[] | undefined) =>
  Array.isArray(workers)
    ? workers.filter((worker) => worker.online)
    : [];

const appendThreadOrder = (current: Record<string, string[]>, workerId: string, threadId: string) => {
  const existing = current[workerId] ?? [];
  if (existing.includes(threadId)) return current;
  return { ...current, [workerId]: [...existing, threadId] };
};

const mergeThreadOrderByWorker = (current: Record<string, string[]>, workers: WorkerSummary[]) => {
  const next: Record<string, string[]> = {};
  for (const worker of workers) {
    const threadIds = workerThreadIds(worker);
    const liveThreadIds = new Set(threadIds);
    const existing = (current[worker.workerId] ?? []).filter((threadId) => liveThreadIds.has(threadId));
    const appended = threadIds.filter((threadId) => !existing.includes(threadId));
    next[worker.workerId] = [...existing, ...appended];
  }
  return next;
};

const workerThreadIds = (worker: WorkerSummary) => {
  const threadIds: string[] = [];
  const pushThreadId = (threadId?: string) => {
    if (threadId && !threadIds.includes(threadId)) threadIds.push(threadId);
  };
  for (const thread of worker.threads ?? []) pushThreadId(thread.threadId);
  pushThreadId(worker.currentThread?.threadId);
  pushThreadId(worker.currentThreadId);
  return threadIds;
};

const selectedThreadOptions = (model: ModelSelection, reasoning: ReasoningSelection) => ({
  model: model === "auto" ? null : model,
  modelReasoningEffort: reasoning === "auto" ? null : reasoning
});

const isModelCommand = (text: string) => /^\/model\s*$/i.test(text);

const modelLabel = (model: ModelSelection) =>
  model === "auto" ? "Auto" : modelOptions.find((option) => option.value === model)?.label ?? model;

const modelOptionsForSelection = (model: ModelSelection) => {
  if (!model || modelOptions.some((option) => option.value === model)) return modelOptions;
  return [...modelOptions, { value: model, label: model }];
};

const formatContextUsage = (usageSnapshot: CodexUsageSnapshot | null) => {
  const context = contextUsage(usageSnapshot);
  if (!context) return "--";
  return `${Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100))}%`;
};

const formatContextTitle = (usageSnapshot: CodexUsageSnapshot | null) => {
  const context = contextUsage(usageSnapshot);
  if (!context) return undefined;
  return `${formatCompactNumber(context.usedTokens)} / ${formatCompactNumber(context.windowTokens)} tokens used`;
};

const contextUsage = (usageSnapshot: CodexUsageSnapshot | null) => {
  const tokenUsage = usageSnapshot?.tokenUsage;
  const jsonlUsed = tokenUsage?.totalTokenUsage?.total_tokens;
  const modelContextWindow = tokenUsage?.modelContextWindow;
  if (typeof jsonlUsed !== "number" || typeof modelContextWindow !== "number" || modelContextWindow <= 0) return null;
  return {
    usedTokens: jsonlUsed,
    windowTokens: modelContextWindow
  };
};

const formatCompactNumber = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
};

const formatMessageMeta = (message: CodexRecordView) => [
  message.at ? formatMessageTime(message.at) : null,
  message.usage ? `${formatCompactNumber(usageTotal(message.usage))} tokens` : null
].filter(Boolean).join(" · ");

const formatMessageMetaTitle = (message: CodexRecordView) => {
  if (!message.usage) return message.at ? formatDate(message.at) : undefined;
  return [
    message.at ? formatDate(message.at) : null,
    `input ${formatCompactNumber(message.usage.input_tokens)}`,
    `cached ${formatCompactNumber(message.usage.cached_input_tokens)}`,
    `output ${formatCompactNumber(message.usage.output_tokens)}`,
    `reasoning ${formatCompactNumber(message.usage.reasoning_output_tokens)}`
  ].filter(Boolean).join(" · ");
};

const formatMessageTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const usageTotal = (usage: Usage) =>
  usage.total_tokens ?? usage.input_tokens + usage.output_tokens + usage.reasoning_output_tokens;

const formatRateLimitRemaining = (window: RateLimitWindow | null | undefined) => {
  if (!window) return "--";
  return `${formatPercent(100 - window.used_percent)}`;
};

const formatPercent = (value: number) => {
  if (!Number.isFinite(value)) return "--";
  const normalized = Math.max(0, Math.min(100, value));
  return `${Number.isInteger(normalized) ? normalized : normalized.toFixed(1)}%`;
};

const formatResetTitle = (window: RateLimitWindow | null | undefined) => {
  if (!window) return undefined;
  const resetAt = new Date(window.resets_at * 1000);
  if (Number.isNaN(resetAt.getTime())) return undefined;
  return `${formatPercent(100 - window.used_percent)} remaining, ${formatPercent(window.used_percent)} used. Resets ${resetAt.toLocaleString()}`;
};

const mergeRecord = (records: CodexRecord[], incoming: CodexRecord) => {
  if (hasMatchingJsonlTranscriptRecord(records, incoming)) return records;
  const existingIndex = records.findIndex((record) => record.id === incoming.id);
  if (existingIndex === -1) {
    return [
      ...records.filter((record) => !isMatchingOptimisticUserRecord(record, incoming) && !isMatchingAppServerTranscriptRecord(record, incoming)),
      incoming
    ];
  }
  return records.map((record, index) => index === existingIndex ? incoming : record);
};

const isMatchingOptimisticUserRecord = (record: CodexRecord, incoming: CodexRecord) => {
  if (!record.id.startsWith("proxy:user:")) return false;
  const recordPayload = asRecord(record.payload);
  const incomingPayload = asRecord(incoming.payload);
  return record.type === "event_msg"
    && incoming.type === "event_msg"
    && recordPayload?.type === "user_message"
    && incomingPayload?.type === "user_message"
    && recordPayload.message === incomingPayload.message;
};

const hasMatchingJsonlTranscriptRecord = (records: CodexRecord[], incoming: CodexRecord) => {
  if (incoming.line) return false;
  if (!incoming.id.startsWith("app:") || incoming.type !== "event_msg") return false;
  const incomingPayload = asRecord(incoming.payload);
  if (!incomingPayload) return false;
  const incomingType = incomingPayload?.type;
  if (incomingType !== "user_message" && incomingType !== "agent_message") return false;
  const incomingTurnId = turnIdFromAppRecordId(String(incoming.sourceThreadId ?? ""), incoming.id);
  return records.some((record) => {
    if (!record.line || record.type !== "event_msg") return false;
    const threadId = String(record.sourceThreadId ?? incoming.sourceThreadId ?? "");
    const recordTurnId = turnIdFromAppRecordId(threadId, record.id);
    if (incomingTurnId || recordTurnId) return incomingTurnId === recordTurnId && recordTurnId !== null;
    const payload = asRecord(record.payload);
    if (payload?.type !== incomingType || payload.message !== incomingPayload.message) return false;
    if (incomingType === "agent_message") return payload.phase === incomingPayload.phase;
    return JSON.stringify(payload.images ?? []) === JSON.stringify(incomingPayload.images ?? []);
  });
};

const isMatchingAppServerTranscriptRecord = (record: CodexRecord, incoming: CodexRecord) => {
  if (!incoming.line || incoming.type !== "event_msg" || !record.id.startsWith("app:") || record.line) return false;
  const recordPayload = asRecord(record.payload);
  const incomingPayload = asRecord(incoming.payload);
  if (!incomingPayload) return false;
  const incomingType = incomingPayload?.type;
  if (incomingType !== "user_message" && incomingType !== "agent_message") return false;
  const threadId = String(incoming.sourceThreadId ?? record.sourceThreadId ?? "");
  const incomingTurnId = turnIdFromAppRecordId(threadId, incoming.id);
  const recordTurnId = turnIdFromAppRecordId(threadId, record.id);
  if (incomingTurnId || recordTurnId) return incomingTurnId === recordTurnId && recordTurnId !== null;
  if (recordPayload?.type !== incomingType || recordPayload.message !== incomingPayload.message) return false;
  if (incomingType === "agent_message") return recordPayload.phase === incomingPayload.phase;
  return JSON.stringify(recordPayload.images ?? []) === JSON.stringify(incomingPayload.images ?? []);
};

const formatInspectDetail = (message: WebRecordView): InspectDetail => {
  const inspectRecord = message.inspectRecord ?? message.record;
  const payload = asRecord(inspectRecord.payload);
  const output = normalizeWebToolOutput(message.inspectText ?? (typeof payload?.output === "string" ? payload.output.trimEnd() : ""));
  const callText = message.inspectCallText ?? message.text;
  return {
    ...formatInspectInput(message.record, callText.trimEnd()),
    ...formatInspectOutput(message.record, output)
  };
};

const normalizeWebToolOutput = (output: string) => {
  const parsed = parseJsonObject(output);
  const preview = textPreview(parsed);
  return preview ?? output;
};

const textPreview = (value: unknown) => {
  const record = asRecord(value);
  if (!record || record.text_omitted !== true || typeof record.text_preview !== "string") return null;
  const suffix = typeof record.text_length === "number" ? `\n[output truncated: ${record.text_length} chars]` : "";
  return `${record.text_preview}${suffix}`;
};

const formatInspectOutput = (record: CodexRecord, output: string): Pick<InspectDetail, "outputMeta" | "outputBlockLabel" | "outputBlock"> => {
  const text = output.trimEnd();
  if (!text) return {};
  if (shouldShowRawToolOutput(record)) return formatStructuredToolOutput(text);
  return { outputMeta: formatToolOutputFields(text) ?? text };
};

const formatToolOutputFields = (output: string) => {
  const fields = parseJsonObject(output);
  if (!fields) return null;
  return Object.entries(fields).map(([key, value]) => `${key}: ${formatArgumentValue(value)}`).join("\n");
};

const shouldShowRawToolOutput = (record: CodexRecord) => {
  const payload = asRecord(record.payload);
  return payload?.type === "function_call"
    && (payload.name === "exec_command" || payload.name === "write_stdin");
};

const formatStructuredToolOutput = (output: string): Pick<InspectDetail, "outputMeta" | "outputBlockLabel" | "outputBlock"> => {
  const marker = "\nOutput:\n";
  const index = output.indexOf(marker);
  if (index === -1) return { outputBlockLabel: "Text", outputBlock: output };
  const meta = output.slice(0, index).trimEnd();
  const body = output.slice(index + marker.length).trimEnd();
  return {
    outputMeta: meta,
    outputBlockLabel: "Stdout",
    outputBlock: cleanTerminalOutput(body) || "<empty>"
  };
};

const cleanTerminalOutput = (text: string) => text
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/\x1b[@-Z\\-_]/g, "")
  .replace(/\r\n/g, "\n")
  .replace(/\r/g, "\n");

const formatInspectInput = (record: CodexRecord, fallback: string): Omit<InspectDetail, "output"> => {
  const payload = asRecord(record.payload);
  if (payload?.type !== "function_call") return { inputMeta: fallback };
  const name = typeof payload.name === "string" ? payload.name : "tool";
  const args = parseJsonObject(typeof payload.arguments === "string" ? payload.arguments : "");
  if (!args) return { inputMeta: fallback };
  return formatToolInput(name, args);
};

const formatToolInput = (name: string, args: Record<string, unknown>): Omit<InspectDetail, "output"> => {
  if (name === "write_stdin") {
    return {
      inputMeta: [
        `tool: write_stdin`,
        `action: ${describeWriteStdinAction(args)}`,
        typeof args.session_id === "number" || typeof args.session_id === "string" ? `session_id: ${args.session_id}` : null,
        typeof args.yield_time_ms === "number" ? `wait: ${formatMilliseconds(args.yield_time_ms)}` : null,
        typeof args.max_output_tokens === "number" ? `max_output: ${formatCompactNumber(args.max_output_tokens)} tokens` : null
      ].filter((line): line is string => Boolean(line)).join("\n"),
      inputBlockLabel: "Stdin",
      inputBlock: formatWriteStdinBlock(args)
    };
  }
  if (name === "exec_command") {
    return {
      inputMeta: [
        `tool: exec_command`,
        typeof args.workdir === "string" ? `workdir: ${args.workdir}` : null,
        typeof args.yield_time_ms === "number" ? `wait: ${formatMilliseconds(args.yield_time_ms)}` : null,
        typeof args.max_output_tokens === "number" ? `max_output: ${formatCompactNumber(args.max_output_tokens)} tokens` : null
      ].filter((line): line is string => Boolean(line)).join("\n"),
      inputBlockLabel: "Command",
      inputBlock: typeof args.cmd === "string" ? formatCommandBlock(args.cmd) : "<missing>"
    };
  }
  return {
    inputMeta: [
      `tool: ${name}`,
      ...Object.entries(args).map(([key, value]) => `${key}: ${formatArgumentValue(value)}`)
    ].join("\n")
  };
};

const formatWriteStdinSummary = (args: Record<string, unknown>) => {
  const session = typeof args.session_id === "number" || typeof args.session_id === "string" ? `session ${args.session_id}` : "session";
  return `stdin: ${formatWriteStdinChars(args)} -> ${session}`;
};

const describeWriteStdinAction = (args: Record<string, unknown>) => {
  const chars = typeof args.chars === "string" ? args.chars : "";
  if (!chars) return "poll";
  if (chars === "\u0003") return "send Ctrl-C";
  if (chars === "\n") return "send Enter";
  if (chars.length <= 48) return `send ${JSON.stringify(chars)}`;
  return `send ${chars.length} chars`;
};

const formatWriteStdinChars = (args: Record<string, unknown>) => {
  if (typeof args.chars !== "string") return "<missing>";
  if (!args.chars) return "<empty> (poll only; no stdin was written)";
  if (args.chars === "\u0003") return "Ctrl-C (\\u0003)";
  if (args.chars === "\n") return "Enter (\\n)";
  return JSON.stringify(args.chars);
};

const formatWriteStdinBlock = (args: Record<string, unknown>) => {
  if (typeof args.chars !== "string") return "<missing>";
  if (!args.chars) return "<empty> (poll only; no stdin was written)";
  if (args.chars === "\u0003") return "Ctrl-C (\\u0003)";
  if (args.chars === "\n") return "Enter (\\n)";
  return args.chars.trimEnd();
};

const formatCommandBlock = (value: string) => value.trimEnd();

const formatMilliseconds = (value: number) => {
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}s`;
  return `${value}ms`;
};

const formatArgumentValue = (value: unknown) => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "null";
  return JSON.stringify(value);
};

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
};

const clipboardImageFiles = (clipboardData: DataTransfer) => {
  const itemFiles = [...clipboardData.items]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (itemFiles.length) return itemFiles;
  return [...clipboardData.files].filter((file) => file.type.startsWith("image/"));
};

const errorRecord = (label: string, error: unknown): CodexRecord => ({
  id: `web:${browserId()}`,
  timestamp: new Date().toISOString(),
  type: "error",
  payload: {
    type: label,
    message: error instanceof Error ? error.message : String(error)
  }
});

function browserId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const statusLabel = (status: NonNullable<CodexRecordView["status"]>) => {
  if (status === "pending") return "Waiting";
  if (status === "failed") return "Failed";
  return "Done";
};

const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const isModelSelection = (value: unknown): value is ModelSelection =>
  typeof value === "string" && value.trim().length > 0;

const isReasoningSelection = (value: unknown): value is ReasoningSelection =>
  typeof value === "string" && reasoningOptions.some((option) => option.value === value);

const isMessageDisplayMode = (value: unknown): value is MessageDisplayMode =>
  value === "compact" || value === "detailed";

const readStoredUiState = (): {
  activeWorkspacePath?: string;
  activeWorkerId?: string;
  selectedModel?: ModelSelection;
  selectedReasoning?: ReasoningSelection;
  messageDisplayMode?: MessageDisplayMode;
  sidebarCollapsed?: boolean;
} | null => {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    return {
      activeWorkspacePath: typeof parsed.activeWorkspacePath === "string" ? parsed.activeWorkspacePath : undefined,
      activeWorkerId: typeof parsed.activeWorkerId === "string" ? parsed.activeWorkerId : undefined,
      selectedModel: isModelSelection(parsed.selectedModel) ? parsed.selectedModel : undefined,
      selectedReasoning: isReasoningSelection(parsed.selectedReasoning) ? parsed.selectedReasoning : undefined,
      messageDisplayMode: isMessageDisplayMode(parsed.messageDisplayMode)
        ? parsed.messageDisplayMode
        : isMessageDisplayMode(parsed.toolDisplayMode) ? parsed.toolDisplayMode : undefined,
      sidebarCollapsed: typeof parsed.sidebarCollapsed === "boolean" ? parsed.sidebarCollapsed : undefined
    };
  } catch {
    return null;
  }
};

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(<App />);
