import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { itemText } from "../core/events.js";
import "./style.css";

type Role = "user" | "codex" | "event" | "error" | "tool" | "thinking";

type Message = {
  role: Role;
  id?: string;
  label?: string;
  text: string;
};

type ConversationSummary = {
  threadId: string;
  updatedAt: string;
  firstUserMessage: string;
  lastAssistantMessage: string;
  artifactCount: number;
  messageCount: number;
};

const eventMessage = (event: any): Message | null => {
  if (event.type === "thread") return { role: "event", label: "thread", text: event.threadId };
  if (event.type === "status") return { role: "event", label: "status", text: event.text };
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

const App = () => {
  const [input, setInput] = useState("");
  const [workingDirectory, setWorkingDirectory] = useState("/home/laop/projects/codex-proxy");
  const [threadId, setThreadId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadModalOpen, setLoadModalOpen] = useState(false);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadSearch, setThreadSearch] = useState("");
  const [threads, setThreads] = useState<ConversationSummary[]>([]);

  const canSend = useMemo(() => input.trim().length > 0 && !busy, [busy, input]);
  const filteredThreads = useMemo(() => {
    const query = threadSearch.trim().toLowerCase();
    if (!query) return threads;
    return threads.filter((thread) => [
      thread.threadId,
      thread.firstUserMessage,
      thread.lastAssistantMessage
    ].some((value) => value.toLowerCase().includes(query)));
  }, [threadSearch, threads]);

  const append = (message: Message) => setMessages((current) => [...current, message]);
  const appendOrUpdate = (message: Message) => {
    setMessages((current) => {
      if (!message.id) return [...current, message];
      const index = current.findIndex((entry) => entry.id === message.id);
      if (index === -1) return [...current, message];
      return current.map((entry, entryIndex) => entryIndex === index ? message : entry);
    });
  };
  const appendFinal = (text: string) => {
    setMessages((current) => {
      const last = current.at(-1);
      if (last?.role === "codex" && last.text === text) return current;
      return [...current, { role: "codex", label: "final", text }];
    });
  };

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || busy) return;

    setInput("");
    setBusy(true);
    append({ role: "user", text: prompt });

    try {
      const response = await fetch("/api/turn/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: prompt,
          threadId,
          workingDirectory,
          skipGitRepoCheck: true
        })
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

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
          if (event.type === "thread") setThreadId(event.threadId);
          if (event.type === "final") {
            appendFinal(event.text);
          } else {
            const message = eventMessage(event);
            if (message) appendOrUpdate(message);
          }
        }
      }
    } catch (error) {
      append({ role: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const newThread = () => {
    setThreadId(undefined);
    append({ role: "event", text: "started a new local thread slot" });
  };

  const openLoadModal = async () => {
    if (busy) return;
    setLoadModalOpen(true);
    setLoadingThreads(true);
    setThreadSearch("");
    try {
      const params = new URLSearchParams({ workingDirectory });
      const response = await fetch(`/api/threads?${params.toString()}`);
      if (!response.ok) throw new Error(`Failed to list threads: HTTP ${response.status}`);
      const data = await response.json();
      setThreads(Array.isArray(data.threads) ? data.threads : []);
    } catch (error) {
      append({ role: "error", text: error instanceof Error ? error.message : String(error) });
      setThreads([]);
    } finally {
      setLoadingThreads(false);
    }
  };

  const loadThreadById = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const params = new URLSearchParams({ workingDirectory });
      const response = await fetch(`/api/threads/${encodeURIComponent(id)}?${params.toString()}`);
      if (!response.ok) throw new Error(`Thread not found: ${id}`);
      const data = await response.json();
      setThreadId(data.threadId);
      setMessages(
        data.messages.map((message: any) => ({
          role: message.role === "assistant" ? "codex" : message.role,
          id: message.id,
          label: message.label,
          text: message.text
        }))
      );
      setLoadModalOpen(false);
    } catch (error) {
      append({ role: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="app">
      <aside className="sidebar">
        <div>
          <h1>Codex Proxy</h1>
          <p>Local agent surface</p>
        </div>

        <label>
          Working directory
          <input value={workingDirectory} onChange={(event) => setWorkingDirectory(event.target.value)} />
        </label>

        {threadId ? (
          <div className="threadCurrent">
            <span>Current thread</span>
            <code>{threadId}</code>
          </div>
        ) : null}

        <button type="button" onClick={openLoadModal} disabled={busy}>Load conversation</button>
        <button type="button" onClick={newThread}>New thread</button>
      </aside>

      <section className="workspace">
        <div className="messages">
          {messages.length === 0 ? (
            <div className="empty">输入一个任务，让本地 Codex 代理开始工作。</div>
          ) : (
            messages.map((message, index) => (
              <article className={`message ${message.role}`} key={index}>
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
            void send();
          }}
        >
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="例如：检查这个 repo 的结构并给我下一步建议"
            rows={4}
          />
          <button type="submit" disabled={!canSend}>{busy ? "Running" : "Send"}</button>
        </form>
      </section>

      {loadModalOpen ? (
        <div className="modalOverlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setLoadModalOpen(false);
        }}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="loadThreadTitle">
            <header className="modalHeader">
              <div>
                <h2 id="loadThreadTitle">Load conversation</h2>
                <p>{workingDirectory}</p>
              </div>
              <button type="button" className="iconButton" onClick={() => setLoadModalOpen(false)} aria-label="Close">
                ×
              </button>
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
                  <button
                    type="button"
                    className="threadRow"
                    key={thread.threadId}
                    onClick={() => void loadThreadById(thread.threadId)}
                  >
                    <span className="threadTitle">{thread.firstUserMessage || thread.threadId}</span>
                    <span className="threadMeta">
                      {formatDate(thread.updatedAt)} · {thread.messageCount} messages
                      {thread.artifactCount ? ` · ${thread.artifactCount} files` : ""}
                    </span>
                    {thread.lastAssistantMessage ? (
                      <span className="threadPreview">{thread.lastAssistantMessage}</span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
};

const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(<App />);
