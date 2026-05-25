import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { asRecord, type CodexRecord } from "../core/codexRecord.js";
import { recordsToViews, type CodexRecordView } from "../core/codexRecordView.js";
import "./style.css";

type InstanceSummary = {
  instanceId: string;
  workingDirectory: string;
  threadId?: string;
  model?: string;
  modelReasoningEffort?: ReasoningEffort;
  running: boolean;
  attachCount: number;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastUsage?: Usage;
};

type InstanceDetail = InstanceSummary & {
  records: CodexRecord[];
  lastSeq: number;
};

type ChatSession = InstanceDetail & {
  input: string;
  clientId: string;
  imageAttachments: ImageAttachment[];
};

type ImageAttachment = {
  id: string;
  file: File;
  name: string;
  previewUrl: string;
};

type DirectoryListing = {
  path: string;
  parent: string | null;
  children: Array<{ name: string; path: string; hasChildren: boolean }>;
};

type CodexThreadSummary = {
  threadId: string;
  updatedAt: string;
  firstUserMessage?: string;
  lastAssistantMessage?: string;
  messageCount: number;
  artifactCount: number;
};

type StreamEvent = {
  seq: number;
  kind: "instance" | "record" | "event" | "done";
  instance: InstanceSummary;
  record?: CodexRecord;
};

type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens?: number;
};

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
type ModelSelection = "auto" | "gpt-5.5" | "gpt-5.4" | "gpt-5.4-mini" | "gpt-5.3-codex" | "gpt-5.3-codex-spark" | "gpt-5.2";
type ReasoningSelection = "auto" | ReasoningEffort;
type MessageDisplayMode = "compact" | "detailed";
type WebRecordView = CodexRecordView & {
  inspectRecord?: CodexRecord;
  inspectCallText?: string;
  inspectText?: string;
};
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

const storageKey = "codex-proxy-ui-state-v3";
const webClientId = readWebClientId();
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
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" }
];
const App = () => {
  const [activeWorkspacePath, setActiveWorkspacePath] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [lastFolderPath, setLastFolderPath] = useState("");
  const [folderListing, setFolderListing] = useState<DirectoryListing | null>(null);
  const [folderError, setFolderError] = useState("");
  const [threadMode, setThreadMode] = useState(false);
  const [threads, setThreads] = useState<CodexThreadSummary[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [instanceMenu, setInstanceMenu] = useState<{ instanceId: string; x: number; y: number } | null>(null);
  const [inspectMessage, setInspectMessage] = useState<WebRecordView | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({
    model: null,
    modelReasoningEffort: null,
    contextWindowTokens: null
  });
  const [selectedModel, setSelectedModel] = useState<ModelSelection>("auto");
  const [selectedReasoning, setSelectedReasoning] = useState<ReasoningSelection>("auto");
  const [messageDisplayMode, setMessageDisplayMode] = useState<MessageDisplayMode>("compact");
  const [codexUsage, setCodexUsage] = useState<CodexUsageSnapshot | null>(null);
  const eventSources = useRef(new Map<string, EventSource>());
  const messagesRef = useRef<VirtuosoHandle>(null);
  const messagesScrollerRef = useRef<HTMLElement | null>(null);

  const activeSession = useMemo(
    () => sessions.find((session) => session.instanceId === activeSessionId),
    [activeSessionId, sessions]
  );
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
  const activeCanSend = Boolean(activeSession && (activeSession.input.trim() || activeSession.imageAttachments.length)) && !activeSession?.running;
  const activeCanSubmit = Boolean(activeSession?.running || activeCanSend);

  useEffect(() => {
    void initialize();
    return () => {
      for (const source of eventSources.current.values()) source.close();
    };
  }, []);

  useEffect(() => {
    if (!initialized) return;
    localStorage.setItem(storageKey, JSON.stringify({
      activeWorkspacePath,
      activeSessionId,
      lastFolderPath,
      selectedModel,
      selectedReasoning,
      messageDisplayMode
    }));
  }, [activeWorkspacePath, activeSessionId, lastFolderPath, selectedModel, selectedReasoning, messageDisplayMode, initialized]);

  useEffect(() => {
    const interval = window.setInterval(() => void refreshInstances(), 3000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => void refreshCodexUsage(activeSession?.threadId), 30_000);
    return () => window.clearInterval(interval);
  }, [activeSession?.threadId]);

  useEffect(() => {
    void refreshCodexUsage(activeSession?.threadId);
  }, [activeSession?.threadId]);

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
  }, [activeSessionId, activeViews.length, latestViewKey, activeSession?.running]);

  useEffect(() => {
    if (!instanceMenu) return undefined;
    const close = () => setInstanceMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [instanceMenu]);

  useEffect(() => {
    const stopOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !activeSession?.running) return;
      event.preventDefault();
      void stopTurn(activeSession.instanceId);
    };
    window.addEventListener("keydown", stopOnEscape);
    return () => window.removeEventListener("keydown", stopOnEscape);
  }, [activeSession?.instanceId, activeSession?.running]);

  const initialize = async () => {
    const [health, instanceData, usageData] = await Promise.all([
      apiJson<{ defaultWorkingDirectory?: string } & SystemStatus>("/api/health"),
      apiJson<{ instances?: InstanceSummary[] }>("/api/instances"),
      apiJson<CodexUsageSnapshot>("/api/codex-usage")
    ]);
    const defaultDirectory = health.defaultWorkingDirectory ?? "/home/laop/projects/codex-proxy";
    const loadedInstances = Array.isArray(instanceData.instances) ? instanceData.instances : [];
    const saved = readStoredUiState();

    setSystemStatus({
      model: health.model,
      modelReasoningEffort: health.modelReasoningEffort,
      contextWindowTokens: health.contextWindowTokens
    });
    setCodexUsage(usageData);
    setActiveWorkspacePath(saved?.activeWorkspacePath ?? defaultDirectory);
    setLastFolderPath(saved?.lastFolderPath ?? "");
    setFolderPath(saved?.lastFolderPath ?? "");
    setSelectedModel(saved?.selectedModel ?? "auto");
    setSelectedReasoning(saved?.selectedReasoning ?? "auto");
    setMessageDisplayMode(saved?.messageDisplayMode ?? "compact");
    setInstances(loadedInstances);
    const savedInstanceExists = saved?.activeSessionId
      ? loadedInstances.some((instance) => instance.instanceId === saved.activeSessionId)
      : false;
    const instanceToOpen = savedInstanceExists
      ? saved?.activeSessionId
      : loadedInstances.length === 1 ? loadedInstances[0]?.instanceId : undefined;
    if (instanceToOpen) {
      await openInstance(instanceToOpen);
    }
    setInitialized(true);
  };

  const refreshInstances = async () => {
    const data = await apiJson<{ instances?: InstanceSummary[] }>("/api/instances");
    setInstances(Array.isArray(data.instances) ? data.instances : []);
  };

  const refreshCodexUsage = async (threadId?: string) => {
    const query = threadId ? `?${new URLSearchParams({ threadId }).toString()}` : "";
    setCodexUsage(await apiJson<CodexUsageSnapshot>(`/api/codex-usage${query}`));
  };

  const openPicker = async () => {
    setThreadMode(false);
    setThreads([]);
    setFolderModalOpen(true);
    await loadDirectory(lastFolderPath || undefined);
  };

  const loadDirectory = async (targetPath?: string) => {
    setFolderError("");
    setThreadMode(false);
    setThreads([]);
    try {
      const query = targetPath ? `?${new URLSearchParams({ path: targetPath }).toString()}` : "";
      const listing = await apiJson<DirectoryListing>(`/api/fs/children${query}`);
      setFolderListing(listing);
      setFolderPath(listing.path);
      setLastFolderPath(listing.path);
    } catch (error) {
      setFolderListing(null);
      if (targetPath) setFolderPath(targetPath);
      setFolderError(error instanceof Error ? error.message : String(error));
    }
  };

  const createInstanceForSelectedFolder = async () => {
    const workingDirectory = folderListing?.path ?? folderPath;
    const instance = await apiJson<InstanceDetail>("/api/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workingDirectory, options: selectedThreadOptions(selectedModel, selectedReasoning) })
    });
    setFolderModalOpen(false);
    await openInstance(instance.instanceId);
    await refreshInstances();
  };

  const showRestorableThreads = async () => {
    const workingDirectory = folderListing?.path ?? folderPath;
    setLoadingThreads(true);
    setThreadMode(true);
    setFolderError("");
    try {
      const params = new URLSearchParams({ workingDirectory });
      const data = await apiJson<{ threads?: CodexThreadSummary[] }>(`/api/codex-threads?${params.toString()}`);
      setThreads(Array.isArray(data.threads) ? data.threads : []);
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : String(error));
      setThreads([]);
    } finally {
      setLoadingThreads(false);
    }
  };

  const restoreThread = async (threadId: string) => {
    const workingDirectory = folderListing?.path ?? folderPath;
    const instance = await apiJson<InstanceDetail>("/api/instances/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workingDirectory, threadId, options: selectedThreadOptions(selectedModel, selectedReasoning) })
    });
    setFolderModalOpen(false);
    await openInstance(instance.instanceId);
    await refreshInstances();
  };

  const openInstance = async (instanceId: string) => {
    const clientId = webInstanceClientId(instanceId);
    const instance = await apiJson<InstanceDetail>(`/api/instances/${encodeURIComponent(instanceId)}/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId })
    });
    const session: ChatSession = { ...instance, input: "", clientId, imageAttachments: [] };
    setSessions((current) => [session, ...current.filter((item) => item.instanceId !== instance.instanceId)]);
    setActiveWorkspacePath(instance.workingDirectory);
    setActiveSessionId(instance.instanceId);
    subscribeInstance(instance.instanceId, instance.lastSeq);
  };

  const subscribeInstance = (instanceId: string, after: number) => {
    eventSources.current.get(instanceId)?.close();
    const source = new EventSource(`/api/instances/${encodeURIComponent(instanceId)}/events?after=${after}`);
    const handle = (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as StreamEvent;
      setSessions((current) => current.map((session) => {
        if (session.instanceId !== payload.instance.instanceId) return session;
        const records = payload.record ? mergeRecord(session.records, payload.record) : session.records;
        return { ...session, ...payload.instance, records };
      }));
      void refreshInstances();
    };
    source.addEventListener("instance", handle);
    source.addEventListener("record", handle);
    source.addEventListener("message", handle);
    source.addEventListener("done", handle);
    eventSources.current.set(instanceId, source);
  };

  const closeSession = async (instanceId: string) => {
    const session = sessions.find((item) => item.instanceId === instanceId);
    eventSources.current.get(instanceId)?.close();
    eventSources.current.delete(instanceId);
    const query = `?clientId=${encodeURIComponent(session?.clientId ?? webInstanceClientId(instanceId))}`;
    await fetch(`/api/instances/${encodeURIComponent(instanceId)}${query}`, { method: "DELETE" });
    setSessions((current) => {
      const next = current.filter((session) => session.instanceId !== instanceId);
      if (activeSessionId !== instanceId) return next;
      const replacement = next[0];
      setActiveSessionId(replacement?.instanceId ?? "");
      if (replacement) setActiveWorkspacePath(replacement.workingDirectory);
      return next;
    });
    await refreshInstances();
  };

  const forkMessage = async (instanceId: string, messageId: string) => {
    try {
      const instance = await apiJson<InstanceDetail>(`/api/instances/${encodeURIComponent(instanceId)}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId })
      });
      await openInstance(instance.instanceId);
      await refreshInstances();
    } catch (error) {
      setSessions((current) => current.map((item) => item.instanceId === instanceId
        ? {
          ...item,
          records: [...item.records, errorRecord("fork failed", error)]
        }
        : item));
    }
  };

  const send = async (instanceId: string) => {
    const session = sessions.find((item) => item.instanceId === instanceId);
    if (!session || session.running) return;
    const text = session.input.trim();
    const imageAttachments = session.imageAttachments;
    if (!text && !imageAttachments.length) return;
    setSessions((current) => current.map((item) => item.instanceId === instanceId ? { ...item, input: "", imageAttachments: [] } : item));
    let uploadedImages: Array<{ path: string }>;
    try {
      uploadedImages = await Promise.all(imageAttachments.map((image) => uploadImage(session.workingDirectory, image)));
      for (const image of imageAttachments) URL.revokeObjectURL(image.previewUrl);
    } catch (error) {
      setSessions((current) => current.map((item) => item.instanceId === instanceId
        ? {
          ...item,
          input: text,
          imageAttachments,
          records: [...item.records, errorRecord("image upload failed", error)]
        }
        : item));
      return;
    }
    const input = uploadedImages.length
      ? [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...uploadedImages.map((image) => ({ type: "local_image" as const, path: image.path }))
      ]
      : text;
    const response = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, source: "web" })
    });
    if (!response.ok) {
      const text = await response.text();
      setSessions((current) => current.map((item) => item.instanceId === instanceId
        ? { ...item, records: [...item.records, errorRecord("error", text)] }
        : item));
    }
  };

  const stopTurn = async (instanceId: string) => {
    const response = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/stop`, { method: "POST" });
    if (!response.ok) {
      const text = await response.text();
      setSessions((current) => current.map((item) => item.instanceId === instanceId
        ? { ...item, records: [...item.records, errorRecord("stop failed", text)] }
        : item));
    }
  };

  const updateSessionInput = (instanceId: string, input: string) => {
    setSessions((current) => current.map((session) => session.instanceId === instanceId ? { ...session, input } : session));
  };

  const addSessionImages = (instanceId: string, files: FileList | null) => {
    if (!files?.length) return;
    const images = [...files]
      .filter((file) => file.type.startsWith("image/"))
      .map((file) => ({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        previewUrl: URL.createObjectURL(file)
      }));
    setSessions((current) => current.map((session) => session.instanceId === instanceId
      ? { ...session, imageAttachments: [...session.imageAttachments, ...images] }
      : session));
  };

  const removeSessionImage = (instanceId: string, imageId: string) => {
    setSessions((current) => current.map((session) => {
      if (session.instanceId !== instanceId) return session;
      const image = session.imageAttachments.find((item) => item.id === imageId);
      if (image) URL.revokeObjectURL(image.previewUrl);
      return { ...session, imageAttachments: session.imageAttachments.filter((item) => item.id !== imageId) };
    }));
  };

  const openInstanceMenu = (event: React.MouseEvent, instanceId: string) => {
    event.preventDefault();
    setInstanceMenu({ instanceId, x: event.clientX, y: event.clientY });
  };

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>Codex Proxy</h1>
          <p>Local agent workbench</p>
        </div>

        <div className="sidebarActions single">
          <button type="button" onClick={() => void openPicker()}>New Thread</button>
        </div>

        <section className="proxyInstances expanded">
          <h2>Codex Instances</h2>
          {instances.length === 0 ? (
            <div className="proxyInstanceEmpty">No active instances</div>
          ) : (
            <div className="proxyInstanceList">
              {instances.map((instance) => (
                <button
                  type="button"
                  className={`proxyInstanceRow ${instance.instanceId === activeSessionId ? "active" : ""}`}
                  key={instance.instanceId}
                  onClick={() => void openInstance(instance.instanceId)}
                  onContextMenu={(event) => openInstanceMenu(event, instance.instanceId)}
                >
                  <span>{instance.threadId ? shortId(instance.threadId) : shortId(instance.instanceId)}</span>
                  <strong>{instance.running ? "running" : "idle"}</strong>
                  <code>{instance.title}</code>
                  <em>{instance.attachCount} attached · {instance.workingDirectory}</em>
                </button>
              ))}
            </div>
          )}
        </section>
        {instanceMenu ? (
          <div
            className="instanceContextMenu"
            style={{ left: instanceMenu.x, top: instanceMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => {
                const instanceId = instanceMenu.instanceId;
                setInstanceMenu(null);
                void closeSession(instanceId);
              }}
            >
              Close
            </button>
          </div>
        ) : null}
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="workspaceTitle">
            <span>{activeSession?.title ?? "No active instance"}</span>
            <code>{activeSession?.workingDirectory ?? activeWorkspacePath}</code>
          </div>
          <div className="workbar" aria-label="Runtime status">
            <label className="runtimeSelect">
              <span>Model</span>
              <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value as ModelSelection)}>
                {modelOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label className="runtimeSelect">
              <span>Thinking</span>
              <select value={selectedReasoning} onChange={(event) => setSelectedReasoning(event.target.value as ReasoningSelection)}>
                {reasoningOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>
            </label>
            <span title={formatContextTitle(codexUsage)}>
              Context {formatContextUsage(codexUsage)}
            </span>
            <span title={formatResetTitle(codexUsage?.rateLimits?.primary)}>5h {formatRateLimitRemaining(codexUsage?.rateLimits?.primary)}</span>
            <span title={formatResetTitle(codexUsage?.rateLimits?.secondary)}>weekly {formatRateLimitRemaining(codexUsage?.rateLimits?.secondary)}</span>
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

        {activeSession ? (
          <>
            <Virtuoso
              key={activeSession.instanceId}
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
                  onFork={message.canFork ? () => void forkMessage(activeSession.instanceId, message.record.id) : undefined}
                />
              )}
            />

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (activeSession.running) void stopTurn(activeSession.instanceId);
                else void send(activeSession.instanceId);
              }}
            >
              <div className="composerInput">
                {activeSession.imageAttachments.length ? (
                  <div className="imageAttachmentList">
                    {activeSession.imageAttachments.map((image) => (
                      <div className="imageAttachment" key={image.id}>
                        <img src={image.previewUrl} alt={image.name} />
                        <button type="button" onClick={() => removeSessionImage(activeSession.instanceId, image.id)} aria-label={`Remove ${image.name}`}>x</button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <textarea
                  value={activeSession.input}
                  onChange={(event) => updateSessionInput(activeSession.instanceId, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    if (activeCanSend) void send(activeSession.instanceId);
                  }}
                  placeholder="例如：检查这个 repo 的结构并给我下一步建议"
                  rows={4}
                />
              </div>
              <div className="composerActions">
                <label className="imageUploadButton">
                  Image
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(event) => {
                      addSessionImages(activeSession.instanceId, event.currentTarget.files);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
                <button type="submit" disabled={!activeCanSubmit} aria-label={activeSession.running ? "Stop current turn" : "Send message"}>
                  {activeSession.running ? "Stop" : "Send"}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="empty">新建实例或从 Codex 对话记录还原。</div>
        )}
      </section>

      {folderModalOpen ? (
        <div className="modalOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setFolderModalOpen(false);
        }}>
          <section className="modal folderModal" role="dialog" aria-modal="true" aria-labelledby="folderTitle">
            <header className="modalHeader">
              <div>
                <h2 id="folderTitle">Open Folder</h2>
                <p>{folderListing?.path ?? folderPath}</p>
              </div>
              <button type="button" className="iconButton" onClick={() => setFolderModalOpen(false)} aria-label="Close">x</button>
            </header>
            <form
              className="folderPathForm"
              onSubmit={(event) => {
                event.preventDefault();
                void loadDirectory(folderPath);
              }}
            >
              <input value={folderPath} onChange={(event) => setFolderPath(event.target.value)} />
              <button type="submit">Go</button>
            </form>
            {folderError ? <div className="threadEmpty">{folderError}</div> : null}
            <div className="folderModalActions">
              <button type="button" onClick={() => void createInstanceForSelectedFolder()} disabled={!folderListing}>New Thread</button>
              <button type="button" className="secondaryButton" onClick={() => void showRestorableThreads()} disabled={!folderListing}>
                Restore Conversation
              </button>
            </div>
            {threadMode ? (
              <div className="threadList">
                {loadingThreads ? (
                  <div className="threadEmpty">Loading conversations...</div>
                ) : threads.length === 0 ? (
                  <div className="threadEmpty">No Codex conversations found for this folder.</div>
                ) : (
                  threads.map((thread, index) => (
                    <button
                      type="button"
                      className="threadRow"
                      key={`${thread.threadId}:${thread.updatedAt}:${index}`}
                      onClick={() => void restoreThread(thread.threadId)}
                    >
                      <span className="threadTitle">{thread.firstUserMessage || thread.threadId}</span>
                      <span className="threadMeta">
                        {formatDate(thread.updatedAt)} · {thread.messageCount} messages
                        {thread.artifactCount ? ` · ${thread.artifactCount} files` : ""}
                      </span>
                      {thread.lastAssistantMessage ? <span className="threadPreview">{thread.lastAssistantMessage}</span> : null}
                    </button>
                  ))
                )}
              </div>
            ) : folderListing ? (
              <div className="folderBrowser">
                <div className="folderList">
                  {folderListing.parent ? (
                    <button type="button" className="folderRow" onClick={() => void loadDirectory(folderListing.parent ?? undefined)}>
                      <span>..</span>
                    </button>
                  ) : null}
                  {folderListing.children.map((child) => (
                    <button type="button" className="folderRow" key={child.path} onClick={() => void loadDirectory(child.path)}>
                      <span>{child.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
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
  onFork
}: {
  message: WebRecordView;
  showStatus?: boolean;
  onInspect?: () => void;
  onFork?: () => void;
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
            href={imageUrl(attachment.path)}
            target="_blank"
            rel="noreferrer"
            className="messageImage"
            key={attachment.path}
            onClick={(event) => event.stopPropagation()}
          >
            <img src={imageUrl(attachment.path)} alt={attachment.path.split("/").at(-1) ?? "image"} />
          </a>
        ) : null)}
      </div>
    ) : null}
    {message.at || message.usage || onFork ? (
      <footer className="messageMeta" title={formatMessageMetaTitle(message)} onClick={(event) => event.stopPropagation()}>
        <span>{formatMessageMeta(message)}</span>
        {onFork ? (
          <a href="#" onClick={(event) => {
            event.preventDefault();
            onFork();
          }}>Fork</a>
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

const imageUrl = (filePath: string) => `/api/uploads/images?${new URLSearchParams({ path: filePath }).toString()}`;

const uploadImage = async (workingDirectory: string, image: ImageAttachment) => apiJson<{ path: string }>("/api/uploads/images", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    workingDirectory,
    filename: image.name,
    contentBase64: await fileToBase64(image.file)
  })
});

const fileToBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
  reader.readAsDataURL(file);
});

const shortId = (id: string) => id.slice(0, 8);

const selectedThreadOptions = (model: ModelSelection, reasoning: ReasoningSelection) => ({
  ...(model === "auto" ? {} : { model }),
  ...(reasoning === "auto" ? {} : { modelReasoningEffort: reasoning })
});

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

function webInstanceClientId(instanceId: string) {
  return `${webClientId}:${instanceId}`;
}

function readWebClientId() {
  const key = "codex-proxy-web-client-id";
  const existing = sessionStorage.getItem(key);
  if (existing) return existing;
  const next = `web:${crypto.randomUUID()}`;
  sessionStorage.setItem(key, next);
  return next;
}

const mergeRecord = (records: CodexRecord[], incoming: CodexRecord) => {
  const existingIndex = records.findIndex((record) => record.id === incoming.id);
  if (existingIndex === -1) {
    return [
      ...records.filter((record) => !isMatchingOptimisticUserRecord(record, incoming)),
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

const compactToolViews = (views: CodexRecordView[]): WebRecordView[] => {
  const compacted: WebRecordView[] = [];
  const toolIndexes = new Map<string, number>();
  for (const view of views) {
    if (view.role !== "tool") {
      compacted.push(view);
      continue;
    }

    const payload = asRecord(view.record.payload);
    if (view.status === "pending") {
      const callId = compactToolCallId(view);
      toolIndexes.set(callId, compacted.length);
      compacted.push({
        ...view,
        id: `compact-tool:${callId}`,
        label: view.label.replace(/^tool call:\s*/i, "tool: "),
        text: formatCompactToolCall(view),
        inspectCallText: view.text
      });
      continue;
    }

    const callId = compactToolCallId(view);
    const callIndex = toolIndexes.get(callId);
    if (callIndex == null || payload?.type !== "function_call_output") {
      compacted.push(view);
      continue;
    }

    const callView = compacted[callIndex];
    compacted[callIndex] = {
      ...callView,
      text: view.status === "failed" && view.text ? [callView.text, `Output:\n${view.text.trimEnd()}`].join("\n\n") : callView.text,
      at: view.at ?? callView.at,
      status: view.status,
      record: callView.record,
      inspectRecord: view.record,
      inspectText: view.text
    };
  }
  return compacted;
};

const compactToolCallId = (view: CodexRecordView) => {
  const payload = asRecord(view.record.payload);
  return typeof payload?.call_id === "string" ? payload.call_id : view.id;
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
  return { outputBlockLabel: "Text", outputBlock: text };
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

const formatCompactToolCall = (view: CodexRecordView) => {
  const payload = asRecord(view.record.payload);
  if (payload?.type !== "function_call") return view.text;
  const name = typeof payload.name === "string" ? payload.name : "tool";
  const args = parseJsonObject(typeof payload.arguments === "string" ? payload.arguments : "");
  if (name === "write_stdin" && args) return formatWriteStdinSummary(args);
  if (name === "exec_command" && typeof args?.cmd === "string") return `$ ${args.cmd}`;
  return view.text;
};

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

const errorRecord = (label: string, error: unknown): CodexRecord => ({
  id: `web:${crypto.randomUUID()}`,
  timestamp: new Date().toISOString(),
  type: "error",
  payload: {
    type: label,
    message: error instanceof Error ? error.message : String(error)
  }
});

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
  typeof value === "string" && modelOptions.some((option) => option.value === value);

const isReasoningSelection = (value: unknown): value is ReasoningSelection =>
  typeof value === "string" && reasoningOptions.some((option) => option.value === value);

const isMessageDisplayMode = (value: unknown): value is MessageDisplayMode =>
  value === "compact" || value === "detailed";

const readStoredUiState = (): {
  activeWorkspacePath?: string;
  activeSessionId?: string;
  lastFolderPath?: string;
  selectedModel?: ModelSelection;
  selectedReasoning?: ReasoningSelection;
  messageDisplayMode?: MessageDisplayMode;
} | null => {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    return {
      activeWorkspacePath: typeof parsed.activeWorkspacePath === "string" ? parsed.activeWorkspacePath : undefined,
      activeSessionId: typeof parsed.activeSessionId === "string" ? parsed.activeSessionId : undefined,
      lastFolderPath: typeof parsed.lastFolderPath === "string" ? parsed.lastFolderPath : undefined,
      selectedModel: isModelSelection(parsed.selectedModel) ? parsed.selectedModel : undefined,
      selectedReasoning: isReasoningSelection(parsed.selectedReasoning) ? parsed.selectedReasoning : undefined,
      messageDisplayMode: isMessageDisplayMode(parsed.messageDisplayMode)
        ? parsed.messageDisplayMode
        : isMessageDisplayMode(parsed.toolDisplayMode) ? parsed.toolDisplayMode : undefined
    };
  } catch {
    return null;
  }
};

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(<App />);
