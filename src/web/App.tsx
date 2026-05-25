import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { itemText } from "../core/events.js";
import "./style.css";

type Role = "user" | "codex" | "event" | "error" | "tool" | "thinking";

type Message = {
  role: Role;
  source?: "codex" | "proxy-runtime";
  id?: string;
  label?: string;
  text: string;
};

type WorkspaceEntry = {
  path: string;
  name: string;
  lastOpenedAt: string;
};

type ConversationSummary = {
  threadId: string;
  updatedAt: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
  artifactCount: number;
  messageCount: number;
};

type ChatSession = {
  id: string;
  workspacePath: string;
  threadId?: string;
  status?: string;
  title: string;
  input: string;
  messages: Message[];
  busy: boolean;
};

type DirectoryListing = {
  path: string;
  parent: string | null;
  shortcuts: WorkspaceEntry[];
  children: Array<{ name: string; path: string; hasChildren: boolean }>;
};

const storageKey = "codex-proxy-ui-state-v1";

const eventMessage = (event: any): Message | null => {
  if (event.type === "artifact") return { role: "event", label: "artifact", text: event.text };
  if (event.type === "error") return { role: "error", label: "error", text: event.message };
  if (event.type !== "item") return null;

  const text = itemText(event.item) ?? fallbackItemText(event.item);
  if (!text) return null;

  return {
    role: itemRole(event.item),
    id: typeof event.item.id === "string" ? `item:${event.item.id}` : undefined,
    label: itemLabel(event.item, event.phase),
    text
  };
};

const itemRole = (item: any): Role => {
  if (item.type === "agent_message") return "codex";
  if (item.type === "reasoning") return "thinking";
  if (item.type === "command_execution" || item.type === "mcp_tool_call" || item.type === "web_search") return "tool";
  if (item.type === "error") return "error";
  return "event";
};

const itemLabel = (item: any, phase?: string): string => {
  const state = item.status ?? phase;
  if (item.type === "command_execution") return state ? `command: ${state}` : "command";
  if (item.type === "mcp_tool_call") return state ? `${item.server}.${item.tool}: ${state}` : `${item.server}.${item.tool}`;
  if (item.type === "web_search") return "web search";
  if (item.type === "reasoning") return "thinking";
  if (item.type === "todo_list") return "plan";
  if (item.type === "file_change") return state ? `file change: ${state}` : "file change";
  if (item.type === "agent_message") return "codex";
  return item.type ?? "event";
};

const fallbackItemText = (item: any): string | null => {
  if (item.type === "reasoning") return "Thinking...";
  if (item.type === "mcp_tool_call") return JSON.stringify(item.arguments ?? {}, null, 2);
  return null;
};

// codex-proxy UI/runtime events. These are generated from the live SSE stream and
// should stay out of the Codex transcript message list.
const isProxyRuntimeEventMessage = (message: Message) =>
  message.source === "proxy-runtime";

const App = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [activeWorkspacePath, setActiveWorkspacePath] = useState("");
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [loadModalOpen, setLoadModalOpen] = useState(false);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadSearch, setThreadSearch] = useState("");
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [folderPath, setFolderPath] = useState("/home/laop/projects");
  const [folderListing, setFolderListing] = useState<DirectoryListing | null>(null);
  const [folderError, setFolderError] = useState("");
  const controllers = useRef(new Map<string, AbortController>());
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottom = useRef(true);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.path === activeWorkspacePath),
    [activeWorkspacePath, workspaces]
  );
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions]
  );
  const workspaceSessions = useMemo(
    () => sessions.filter((session) => session.workspacePath === activeWorkspacePath),
    [activeWorkspacePath, sessions]
  );
  const filteredThreads = useMemo(() => {
    const query = threadSearch.trim().toLowerCase();
    if (!query) return threads;
    return threads.filter((thread) => [
      thread.threadId,
      thread.firstUserMessage,
      thread.lastAssistantMessage
    ].some((value) => value.toLowerCase().includes(query)));
  }, [threadSearch, threads]);

  useEffect(() => {
    void initialize();
  }, []);

  useEffect(() => {
    if (!sessions.length && !activeWorkspacePath) return;
    localStorage.setItem(storageKey, JSON.stringify({
      activeWorkspacePath,
      activeSessionId,
      sessions: sessions.map((session) => ({
        ...session,
        busy: false,
        messages: session.messages.slice(-80)
      }))
    }));
  }, [activeSessionId, activeWorkspacePath, sessions]);

  useEffect(() => {
    shouldStickToBottom.current = true;
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSession || !shouldStickToBottom.current) return;
    const frame = requestAnimationFrame(() => {
      const messages = messagesRef.current;
      if (!messages) return;
      messages.scrollTo({ top: messages.scrollHeight });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeSession, activeSessionId]);

  const initialize = async () => {
    const response = await fetch("/api/workspaces");
    const data = await response.json();
    const loadedWorkspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
    const saved = readStoredUiState();
    const savedWorkspacePath = loadedWorkspaces.some((workspace: WorkspaceEntry) => workspace.path === saved?.activeWorkspacePath)
      ? saved?.activeWorkspacePath
      : undefined;
    const firstWorkspace = savedWorkspacePath
      ?? loadedWorkspaces[0]?.path
      ?? "/home/laop/projects/codex-proxy";

    setWorkspaces(loadedWorkspaces);
    setActiveWorkspacePath(firstWorkspace);

    const restoredSessions = saved?.sessions?.length
      ? saved.sessions.map((session) => ({
        ...session,
        busy: false,
        messages: session.messages.filter((message) => !isProxyRuntimeEventMessage(message))
      }))
      : [newSession(firstWorkspace)];
    setSessions(restoredSessions);
    setActiveSessionId(saved?.activeSessionId && restoredSessions.some((session) => session.id === saved.activeSessionId)
      ? saved.activeSessionId
      : restoredSessions[0]?.id ?? "");
  };

  const updateSession = (sessionId: string, updater: (session: ChatSession) => ChatSession) => {
    setSessions((current) => current.map((session) => session.id === sessionId ? updater(session) : session));
  };

  const appendMessage = (sessionId: string, message: Message) => {
    updateSession(sessionId, (session) => ({ ...session, messages: [...session.messages, message] }));
  };

  const appendOrUpdateMessage = (sessionId: string, message: Message) => {
    updateSession(sessionId, (session) => {
      if (!message.id) return { ...session, messages: [...session.messages, message] };
      const index = session.messages.findIndex((entry) => entry.id === message.id);
      if (index === -1) return { ...session, messages: [...session.messages, message] };
      return {
        ...session,
        messages: session.messages.map((entry, entryIndex) => entryIndex === index ? message : entry)
      };
    });
  };

  const appendFinal = (sessionId: string, text: string) => {
    updateSession(sessionId, (session) => {
      const last = session.messages.at(-1);
      if (last?.role === "codex" && last.text === text) return session;
      return { ...session, messages: [...session.messages, { role: "codex", label: "final", text }] };
    });
  };

  const selectWorkspace = (workspacePath: string) => {
    setActiveWorkspacePath(workspacePath);
    const existing = sessions.find((session) => session.workspacePath === workspacePath);
    if (existing) {
      setActiveSessionId(existing.id);
      return;
    }
    const session = newSession(workspacePath);
    setSessions((current) => [...current, session]);
    setActiveSessionId(session.id);
  };

  const openNewSession = (workspacePath = activeWorkspacePath) => {
    const session = newSession(workspacePath);
    setSessions((current) => [...current, session]);
    setActiveWorkspacePath(workspacePath);
    setActiveSessionId(session.id);
  };

  const closeSession = (sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    controllers.current.get(sessionId)?.abort();
    controllers.current.delete(sessionId);
    if (session?.threadId) void releaseThreadCache(session.threadId, session.workspacePath);
    setSessions((current) => {
      const next = current.filter((session) => session.id !== sessionId);
      if (activeSessionId !== sessionId) return next;
      const replacement = next.find((session) => session.workspacePath === activeWorkspacePath) ?? next[0];
      setActiveSessionId(replacement?.id ?? "");
      if (replacement) setActiveWorkspacePath(replacement.workspacePath);
      return next;
    });
  };

  const releaseThreadCache = async (threadId: string, workspacePath: string) => {
    try {
      const params = new URLSearchParams({ workingDirectory: workspacePath });
      const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/cache?${params.toString()}`, {
        method: "DELETE"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.warn("Failed to release Codex thread cache", error);
    }
  };

  const send = async (sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session || session.busy) return;
    const prompt = session.input.trim();
    if (!prompt) return;

    const controller = new AbortController();
    controllers.current.set(sessionId, controller);
    updateSession(sessionId, (current) => ({
      ...current,
      busy: true,
      input: "",
      title: current.threadId ? current.title : prompt.slice(0, 80),
      messages: [...current.messages, { role: "user", text: prompt }]
    }));

    try {
      const response = await fetch("/api/turn/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          input: prompt,
          threadId: session.threadId,
          workingDirectory: session.workspacePath,
          skipGitRepoCheck: true
        })
      });

      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          const event = JSON.parse(dataLine.slice(6));

          if (event.type === "thread") {
            updateSession(sessionId, (current) => ({ ...current, threadId: event.threadId }));
          }
          if (event.type === "status") {
            updateSession(sessionId, (current) => ({ ...current, status: event.text }));
          }
          if (event.type === "final") {
            appendFinal(sessionId, event.text);
            updateSession(sessionId, (current) => ({ ...current, status: undefined }));
          } else {
            const message = eventMessage(event);
            if (message) appendOrUpdateMessage(sessionId, message);
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        appendMessage(sessionId, { role: "error", label: "error", text: error instanceof Error ? error.message : String(error) });
      } else {
        appendMessage(sessionId, { role: "event", label: "stopped", text: "Turn stopped by user." });
      }
    } finally {
      controllers.current.delete(sessionId);
      updateSession(sessionId, (current) => ({ ...current, busy: false, status: undefined }));
    }
  };

  const stopSession = (sessionId: string) => {
    controllers.current.get(sessionId)?.abort();
  };

  const updateScrollStickiness = () => {
    const messages = messagesRef.current;
    if (!messages) return;
    const distanceFromBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
    shouldStickToBottom.current = distanceFromBottom < 120;
  };

  const openLoadModal = async () => {
    if (!activeWorkspacePath) return;
    setLoadModalOpen(true);
    setLoadingThreads(true);
    setThreadSearch("");
    try {
      const params = new URLSearchParams({ workingDirectory: activeWorkspacePath });
      const response = await fetch(`/api/threads?${params.toString()}`);
      if (!response.ok) throw new Error(`Failed to list threads: HTTP ${response.status}`);
      const data = await response.json();
      setThreads(Array.isArray(data.threads) ? data.threads : []);
    } catch (error) {
      setThreads([]);
      if (activeSessionId) appendMessage(activeSessionId, { role: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoadingThreads(false);
    }
  };

  const loadThreadById = async (thread: ConversationSummary) => {
    const workspacePath = activeWorkspacePath;
    if (!workspacePath) return;
    try {
      const params = new URLSearchParams({ workingDirectory: workspacePath });
      const response = await fetch(`/api/threads/${encodeURIComponent(thread.threadId)}?${params.toString()}`);
      if (!response.ok) throw new Error(`Thread not found: ${thread.threadId}`);
      const data = await response.json();
      const session: ChatSession = {
        id: createSessionId(),
        workspacePath,
        threadId: data.threadId,
        title: thread.firstUserMessage || thread.threadId,
        input: "",
        busy: false,
        messages: data.messages
          .map((message: any) => ({
            role: message.role === "assistant" ? "codex" : message.role,
            id: message.id,
            label: message.label,
            text: message.text
          }))
          .filter((message: Message) => !isProxyRuntimeEventMessage(message))
      };
      setSessions((current) => [...current, session]);
      setActiveSessionId(session.id);
      setLoadModalOpen(false);
    } catch (error) {
      if (activeSessionId) appendMessage(activeSessionId, { role: "error", text: error instanceof Error ? error.message : String(error) });
    }
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
      const response = await fetch(`/api/fs/children?${params.toString()}`);
      if (!response.ok) throw new Error(`Failed to read directory: HTTP ${response.status}`);
      setFolderListing(await response.json());
    } catch (error) {
      setFolderListing(null);
      setFolderError(error instanceof Error ? error.message : String(error));
    }
  };

  const addFolder = async (workspacePath: string) => {
    const response = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: workspacePath })
    });
    if (!response.ok) throw new Error(`Failed to add folder: HTTP ${response.status}`);
    const data = await response.json();
    const nextWorkspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
    const selectedPath = nextWorkspaces[0]?.path ?? workspacePath;
    setWorkspaces(nextWorkspaces);
    setFolderModalOpen(false);
    selectWorkspace(selectedPath);
  };

  const activeCanSend = Boolean(activeSession?.input.trim()) && !activeSession?.busy;

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>Codex Proxy</h1>
          <p>Local agent workbench</p>
        </div>

        <div className="sidebarActions">
          <button type="button" onClick={() => void openFolderModal()}>Add Folder</button>
          <button type="button" onClick={() => openNewSession()} disabled={!activeWorkspacePath}>New Thread</button>
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
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="workspaceTitle">
            <span>{activeWorkspace?.name ?? "No folder"}</span>
            <code>{activeWorkspacePath}</code>
          </div>
          <button type="button" onClick={openLoadModal} disabled={!activeWorkspacePath}>Load Conversation</button>
        </header>

        <div className="tabbar">
          {workspaceSessions.map((session) => (
            <button
              type="button"
              className={`tab ${session.id === activeSessionId ? "active" : ""}`}
              key={session.id}
              onClick={() => setActiveSessionId(session.id)}
              title={[session.title, session.threadId, session.status].filter(Boolean).join("\n")}
            >
              <span className="tabTitle">{session.title}</span>
              <span className="tabMeta">
                {session.status ?? (session.threadId ? shortThreadId(session.threadId) : "draft")}
              </span>
              {session.busy ? <strong>Running</strong> : null}
              <i
                role="button"
                tabIndex={0}
                aria-label="Close tab"
                onClick={(event) => {
                  event.stopPropagation();
                  closeSession(session.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") closeSession(session.id);
                }}
              >
                x
              </i>
            </button>
          ))}
        </div>

        {activeSession ? (
          <>
            <div className="messages" ref={messagesRef} onScroll={updateScrollStickiness}>
              {activeSession.messages.length === 0 ? (
                <div className="empty">输入一个任务，让本地 Codex 代理开始工作。</div>
              ) : (
                activeSession.messages.map((message, index) => (
                  <article className={`message ${message.role}`} key={`${message.id ?? index}-${index}`}>
                    <span>{message.label ?? message.role}</span>
                    <pre>{message.text}</pre>
                  </article>
                ))
              )}
            </div>

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send(activeSession.id);
              }}
            >
              <textarea
                value={activeSession.input}
                onChange={(event) => updateSession(activeSession.id, (session) => ({ ...session, input: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (activeCanSend) void send(activeSession.id);
                }}
                placeholder="例如：检查这个 repo 的结构并给我下一步建议"
                rows={4}
              />
              <div className="composerActions">
                {activeSession.busy ? (
                  <button type="button" className="secondaryButton" onClick={() => stopSession(activeSession.id)}>Stop</button>
                ) : null}
                <button type="submit" disabled={!activeCanSend}>{activeSession.busy ? "Running" : "Send"}</button>
              </div>
            </form>
          </>
        ) : (
          <div className="empty">选择一个文件夹或新建会话。</div>
        )}
      </section>

      {loadModalOpen ? (
        <div className="modalOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setLoadModalOpen(false);
        }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="loadThreadTitle">
            <header className="modalHeader">
              <div>
                <h2 id="loadThreadTitle">Load conversation</h2>
                <p>{activeWorkspacePath}</p>
              </div>
              <button type="button" className="iconButton" onClick={() => setLoadModalOpen(false)} aria-label="Close">x</button>
            </header>
            <input
              className="threadSearch"
              value={threadSearch}
              onChange={(event) => setThreadSearch(event.target.value)}
              placeholder="Search by prompt, answer, or thread id"
              autoFocus
            />
            <div className="threadList">
              {loadingThreads ? (
                <div className="threadEmpty">Loading conversations...</div>
              ) : filteredThreads.length === 0 ? (
                <div className="threadEmpty">No Codex conversations found for this folder.</div>
              ) : (
                filteredThreads.map((thread) => (
                  <button type="button" className="threadRow" key={thread.threadId} onClick={() => void loadThreadById(thread)}>
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
          </section>
        </div>
      ) : null}

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

const newSession = (workspacePath: string): ChatSession => ({
  id: createSessionId(),
  workspacePath,
  title: "New thread",
  input: "",
  messages: [],
  busy: false
});

const createSessionId = () => `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const shortThreadId = (threadId: string) => threadId.slice(0, 8);

const readStoredUiState = (): { activeWorkspacePath?: string; activeSessionId?: string; sessions?: ChatSession[] } | null => {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
};

const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(<App />);
