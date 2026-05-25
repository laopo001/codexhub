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

type WorkspaceEntry = {
  path: string;
  name: string;
  lastOpenedAt: string;
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
  shortcuts: WorkspaceEntry[];
  children: Array<{ name: string; path: string; hasChildren: boolean }>;
};

type StreamEvent = {
  seq: number;
  kind: "instance" | "message" | "event" | "done";
  instance: InstanceSummary;
  message?: Message;
};

const storageKey = "codex-proxy-ui-state-v2";
const webClientPrefix = `web-${crypto.randomUUID()}`;

const App = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [activeWorkspacePath, setActiveWorkspacePath] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderPath, setFolderPath] = useState("/home/laop/projects");
  const [folderListing, setFolderListing] = useState<DirectoryListing | null>(null);
  const [folderError, setFolderError] = useState("");
  const eventSources = useRef(new Map<string, EventSource>());

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.path === activeWorkspacePath),
    [activeWorkspacePath, workspaces]
  );
  const activeSession = useMemo(
    () => sessions.find((session) => session.instanceId === activeSessionId),
    [activeSessionId, sessions]
  );
  const workspaceSessions = useMemo(
    () => sessions.filter((session) => session.workingDirectory === activeWorkspacePath),
    [activeWorkspacePath, sessions]
  );
  const workspaceInstances = useMemo(
    () => instances.filter((instance) => instance.workingDirectory === activeWorkspacePath),
    [activeWorkspacePath, instances]
  );
  const activeCanSend = Boolean(activeSession?.input.trim()) && !activeSession?.running;

  useEffect(() => {
    void initialize();
    return () => {
      for (const source of eventSources.current.values()) source.close();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify({ activeWorkspacePath, activeSessionId }));
  }, [activeWorkspacePath, activeSessionId]);

  useEffect(() => {
    const interval = window.setInterval(() => void refreshInstances(), 3000);
    return () => window.clearInterval(interval);
  }, []);

  const initialize = async () => {
    const [workspaceData, instanceData] = await Promise.all([
      apiJson<{ workspaces?: WorkspaceEntry[] }>("/api/workspaces"),
      apiJson<{ instances?: InstanceSummary[] }>("/api/instances")
    ]);
    const loadedWorkspaces = Array.isArray(workspaceData.workspaces) ? workspaceData.workspaces : [];
    const loadedInstances = Array.isArray(instanceData.instances) ? instanceData.instances : [];
    const saved = readStoredUiState();
    const firstWorkspace = saved?.activeWorkspacePath && loadedWorkspaces.some((workspace) => workspace.path === saved.activeWorkspacePath)
      ? saved.activeWorkspacePath
      : loadedWorkspaces[0]?.path ?? "/home/laop/projects/codex-proxy";

    setWorkspaces(loadedWorkspaces);
    setInstances(loadedInstances);
    setActiveWorkspacePath(firstWorkspace);
  };

  const refreshInstances = async () => {
    const data = await apiJson<{ instances?: InstanceSummary[] }>("/api/instances");
    setInstances(Array.isArray(data.instances) ? data.instances : []);
  };

  const selectWorkspace = (workspacePath: string) => {
    setActiveWorkspacePath(workspacePath);
    const existing = sessions.find((session) => session.workingDirectory === workspacePath);
    setActiveSessionId(existing?.instanceId ?? "");
  };

  const openNewSession = async (workspacePath = activeWorkspacePath) => {
    const instance = await apiJson<InstanceDetail>("/api/instances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workingDirectory: workspacePath })
    });
    await openInstance(instance.instanceId);
    setActiveWorkspacePath(instance.workingDirectory);
    await refreshInstances();
  };

  const openInstance = async (instanceId: string) => {
    const clientId = `${webClientPrefix}-${instanceId}`;
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
    await refreshInstances();
  };

  const subscribeInstance = (instanceId: string, after: number) => {
    eventSources.current.get(instanceId)?.close();
    const source = new EventSource(`/api/instances/${encodeURIComponent(instanceId)}/events?after=${after}`);
    const handle = (event: MessageEvent) => {
      const payload = JSON.parse(event.data) as StreamEvent;
      setSessions((current) => current.map((session) => {
        if (session.instanceId !== payload.instance.instanceId) return session;
        const messages = payload.message
          ? mergeMessage(session.messages, payload.message)
          : session.messages;
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
    if (session) {
      await fetch(`/api/instances/${encodeURIComponent(instanceId)}?clientId=${encodeURIComponent(session.clientId)}`, { method: "DELETE" });
    }
    setSessions((current) => {
      const next = current.filter((session) => session.instanceId !== instanceId);
      if (activeSessionId !== instanceId) return next;
      const replacement = next.find((session) => session.workingDirectory === activeWorkspacePath) ?? next[0];
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

  const openFolderModal = async () => {
    setFolderModalOpen(true);
    await loadDirectory(activeWorkspacePath || "/home/laop/projects");
  };

  const loadDirectory = async (targetPath: string) => {
    setFolderError("");
    setFolderPath(targetPath);
    try {
      const params = new URLSearchParams({ path: targetPath });
      setFolderListing(await apiJson<DirectoryListing>(`/api/fs/children?${params.toString()}`));
    } catch (error) {
      setFolderListing(null);
      setFolderError(error instanceof Error ? error.message : String(error));
    }
  };

  const addFolder = async (workspacePath: string) => {
    const data = await apiJson<{ workspaces?: WorkspaceEntry[] }>("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: workspacePath })
    });
    const nextWorkspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
    const selectedPath = nextWorkspaces[0]?.path ?? workspacePath;
    setWorkspaces(nextWorkspaces);
    setFolderModalOpen(false);
    selectWorkspace(selectedPath);
  };

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>Codex Proxy</h1>
          <p>Local agent workbench</p>
        </div>

        <div className="sidebarActions">
          <button type="button" onClick={() => void openFolderModal()}>Add Folder</button>
          <button type="button" onClick={() => void openNewSession()} disabled={!activeWorkspacePath}>New Thread</button>
        </div>

        <section className="sideSection">
          <h2>Folders</h2>
          <div className="workspaceList">
            {workspaces.map((workspace) => (
              <button
                type="button"
                className={`workspaceRow ${workspace.path === activeWorkspacePath ? "active" : ""}`}
                key={workspace.path}
                onClick={() => selectWorkspace(workspace.path)}
              >
                <span>{workspace.name}</span>
                <code>{workspace.path}</code>
              </button>
            ))}
          </div>
        </section>

        <section className="proxyInstances">
          <h2>Codex Instances</h2>
          {workspaceInstances.length === 0 ? (
            <div className="proxyInstanceEmpty">No active instances</div>
          ) : (
            <div className="proxyInstanceList">
              {workspaceInstances.map((instance) => (
                <button
                  type="button"
                  className="proxyInstanceRow"
                  key={instance.instanceId}
                  onClick={() => void openInstance(instance.instanceId)}
                >
                  <span>{instance.threadId ? shortId(instance.threadId) : shortId(instance.instanceId)}</span>
                  <strong>{instance.running ? "running" : "idle"}</strong>
                  <code>{instance.title}</code>
                  <em>{instance.attachCount} attached</em>
                </button>
              ))}
            </div>
          )}
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="workspaceTitle">
            <span>{activeWorkspace?.name ?? "No folder"}</span>
            <code>{activeWorkspacePath}</code>
          </div>
        </header>

        <div className="tabbar">
          {workspaceSessions.map((session) => (
            <button
              type="button"
              className={`tab ${session.instanceId === activeSessionId ? "active" : ""}`}
              key={session.instanceId}
              onClick={() => setActiveSessionId(session.instanceId)}
              title={[session.title, session.threadId, session.instanceId].filter(Boolean).join("\n")}
            >
              <span className="tabTitle">{session.title}</span>
              <span className="tabMeta">{session.threadId ? shortId(session.threadId) : shortId(session.instanceId)}</span>
              {session.running ? <strong>Running</strong> : null}
              <i
                role="button"
                tabIndex={0}
                aria-label="Close tab"
                onClick={(event) => {
                  event.stopPropagation();
                  void closeSession(session.instanceId);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") void closeSession(session.instanceId);
                }}
              >
                x
              </i>
            </button>
          ))}
        </div>

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
          <div className="empty">选择一个实例或新建会话。</div>
        )}
      </section>

      {folderModalOpen ? (
        <div className="modalOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setFolderModalOpen(false);
        }}>
          <section className="modal folderModal" role="dialog" aria-modal="true" aria-labelledby="folderTitle">
            <header className="modalHeader">
              <div>
                <h2 id="folderTitle">Add folder</h2>
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
              <button type="button" onClick={() => void addFolder(folderListing?.path ?? folderPath)}>Select</button>
            </form>
            {folderError ? <div className="threadEmpty">{folderError}</div> : null}
            {folderListing ? (
              <div className="folderBrowser">
                <div className="shortcutList">
                  {folderListing.shortcuts.map((shortcut) => (
                    <button type="button" key={shortcut.path} onClick={() => void loadDirectory(shortcut.path)}>
                      {shortcut.name}
                    </button>
                  ))}
                  {folderListing.parent ? (
                    <button type="button" onClick={() => void loadDirectory(folderListing.parent!)}>Parent</button>
                  ) : null}
                </div>
                <div className="folderList">
                  {folderListing.children.map((child) => (
                    <button type="button" className="folderRow" key={child.path} onClick={() => void loadDirectory(child.path)}>
                      <span>{child.name}</span>
                      <code>{child.path}</code>
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

const readStoredUiState = (): { activeWorkspacePath?: string; activeSessionId?: string } | null => {
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
