import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { itemText } from "../core/events.js";
import "./style.css";

type Role = "user" | "codex" | "event" | "error";

type Message = {
  role: Role;
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

const formatEvent = (event: any): string | null => {
  if (event.type === "thread") return `thread: ${event.threadId}`;
  if (event.type === "status") return event.text;
  if (event.type === "artifact") return event.text;
  if (event.type === "error") return event.message;
  if (event.type !== "item") return null;
  if (event.item.type === "agent_message") return null;
  return itemText(event.item);
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
          if (event.type === "final") append({ role: "codex", text: event.text });
          else {
            const text = formatEvent(event);
            if (text) append({ role: event.type === "error" ? "error" : "event", text });
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
                <span>{message.role}</span>
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
