import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Virtuoso } from "react-virtuoso";
import "./style.css";

type Role = "user" | "codex" | "event" | "error" | "tool" | "thinking";

type Message = {
  id: string;
  role: Role;
  source?: "web" | "telegram" | "codex" | "proxy-runtime";
  label?: string;
  text: string;
  at?: string;
  status?: "pending" | "completed" | "failed";
  itemType?: string;
};

type InstanceSummary = {
  instanceId: string;
  workingDirectory: string;
  threadId?: string;
  running: boolean;
  attachCount: number;
  title: string;
  updatedAt: string;
  messageCount: number;
  lastUsage?: Usage;
};

type InstanceDetail = InstanceSummary & {
  messages: Message[];
  lastSeq: number;
};

type ChatSession = InstanceDetail & {
  input: string;
  clientId: string;
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
  kind: "instance" | "message" | "event" | "done";
  instance: InstanceSummary;
  message?: Message;
};

type Usage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
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
  sourceFile: string | null;
  observedAt: string | null;
  source: "latest" | "thread";
};

const storageKey = "codex-proxy-ui-state-v3";
const webClientId = readWebClientId();

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
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({
    model: null,
    modelReasoningEffort: null,
    contextWindowTokens: null
  });
  const [codexUsage, setCodexUsage] = useState<CodexUsageSnapshot | null>(null);
  const eventSources = useRef(new Map<string, EventSource>());

  const activeSession = useMemo(
    () => sessions.find((session) => session.instanceId === activeSessionId),
    [activeSessionId, sessions]
  );
  const activeCanSend = Boolean(activeSession?.input.trim()) && !activeSession?.running;

  useEffect(() => {
    void initialize();
    return () => {
      for (const source of eventSources.current.values()) source.close();
    };
  }, []);

  useEffect(() => {
    if (!initialized) return;
    localStorage.setItem(storageKey, JSON.stringify({ activeWorkspacePath, activeSessionId, lastFolderPath }));
  }, [activeWorkspacePath, activeSessionId, lastFolderPath, initialized]);

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
    setInstances(loadedInstances);
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
      body: JSON.stringify({ workingDirectory })
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
      body: JSON.stringify({ workingDirectory, threadId })
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
    const session: ChatSession = { ...instance, input: "", clientId };
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
        const messages = payload.message ? mergeMessage(session.messages, payload.message) : session.messages;
        return { ...session, ...payload.instance, messages };
      }));
      void refreshInstances();
    };
    source.addEventListener("instance", handle);
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

  const send = async (instanceId: string) => {
    const session = sessions.find((item) => item.instanceId === instanceId);
    if (!session || session.running) return;
    const input = session.input.trim();
    if (!input) return;
    setSessions((current) => current.map((item) => item.instanceId === instanceId ? { ...item, input: "" } : item));
    const response = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input, source: "web" })
    });
    if (!response.ok) {
      const text = await response.text();
      setSessions((current) => current.map((item) => item.instanceId === instanceId
        ? { ...item, messages: [...item.messages, { id: crypto.randomUUID(), role: "error", label: "error", text }] }
        : item));
    }
  };

  const updateSessionInput = (instanceId: string, input: string) => {
    setSessions((current) => current.map((session) => session.instanceId === instanceId ? { ...session, input } : session));
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
            <span>{formatModelStatus(systemStatus)}</span>
            <span>Context {formatContextUsage(activeSession, systemStatus.contextWindowTokens)}</span>
            <span title={formatResetTitle(codexUsage?.rateLimits?.primary)}>5h {formatRateLimitRemaining(codexUsage?.rateLimits?.primary)}</span>
            <span title={formatResetTitle(codexUsage?.rateLimits?.secondary)}>weekly {formatRateLimitRemaining(codexUsage?.rateLimits?.secondary)}</span>
          </div>
        </header>

        {activeSession ? (
          <>
            <Virtuoso
              key={activeSession.instanceId}
              className="messages"
              data={activeSession.messages}
              followOutput="smooth"
              initialTopMostItemIndex={Math.max(activeSession.messages.length - 1, 0)}
              increaseViewportBy={{ top: 360, bottom: 720 }}
              computeItemKey={(_, message) => message.id}
              components={{ EmptyPlaceholder: EmptyMessages }}
              itemContent={(_, message) => <MessageCard message={message} />}
            />

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send(activeSession.instanceId);
              }}
            >
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
              <div className="composerActions">
                <button type="submit" disabled={!activeCanSend}>{activeSession.running ? "Running" : "Send"}</button>
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
    </main>
  );
};

const MessageCard = ({ message }: { message: Message }) => (
  <article className={`message ${message.role}`}>
    <span className="messageHeader">
      <b>{message.label ?? message.role}{message.source ? ` · ${message.source}` : ""}</b>
      {message.status ? <em className={`messageStatus ${message.status}`}>{statusLabel(message.status)}</em> : null}
    </span>
    <pre>{message.text}</pre>
  </article>
);

const EmptyMessages = () => (
  <div className="empty">输入一个任务，让本地 Codex 代理开始工作。</div>
);

const apiJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
};

const shortId = (id: string) => id.slice(0, 8);

const formatModelStatus = (status: SystemStatus) => [
  status.model ?? "default model",
  status.modelReasoningEffort ?? "default"
].join(" ");

const formatContextUsage = (session: ChatSession | undefined, contextWindowTokens: number | null) => {
  const usage = session?.lastUsage;
  if (!usage) return "--";
  const used = usage.input_tokens + usage.output_tokens + usage.reasoning_output_tokens;
  if (!contextWindowTokens) return `${formatCompactNumber(used)} tokens`;
  return `${Math.min(100, Math.round((used / contextWindowTokens) * 100))}% used`;
};

const formatCompactNumber = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
};

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

const mergeMessage = (messages: Message[], incoming: Message) => {
  const existingIndex = messages.findIndex((message) => message.id === incoming.id);
  if (existingIndex === -1) return [...messages, incoming];
  return messages.map((message, index) => index === existingIndex ? { ...message, ...incoming } : message);
};

const statusLabel = (status: NonNullable<Message["status"]>) => {
  if (status === "pending") return "Waiting";
  if (status === "failed") return "Failed";
  return "Done";
};

const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const readStoredUiState = (): { activeWorkspacePath?: string; activeSessionId?: string; lastFolderPath?: string } | null => {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
};

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(<App />);
