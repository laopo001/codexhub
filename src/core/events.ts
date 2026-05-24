import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";

export type ProxyEvent =
  | { type: "thread"; threadId: string }
  | { type: "status"; text: string }
  | { type: "item"; phase: "started" | "updated" | "completed"; item: ThreadItem }
  | { type: "artifact"; text: string; path?: string; metadata?: unknown }
  | { type: "final"; text: string; usage: Usage | null }
  | { type: "error"; message: string };

export const toProxyEvent = (event: ThreadEvent, finalResponse = ""): ProxyEvent | null => {
  switch (event.type) {
    case "thread.started":
      return { type: "thread", threadId: event.thread_id };
    case "turn.started":
      return { type: "status", text: "turn.started" };
    case "item.started":
      return { type: "item", phase: "started", item: event.item };
    case "item.updated":
      return { type: "item", phase: "updated", item: event.item };
    case "item.completed":
      return { type: "item", phase: "completed", item: event.item };
    case "turn.completed":
      return { type: "final", text: finalResponse, usage: event.usage };
    case "turn.failed":
      return { type: "error", message: event.error.message };
    case "error":
      return { type: "error", message: event.message };
    default:
      return null;
  }
};

export const itemText = (item: ThreadItem): string | null => {
  switch (item.type) {
    case "agent_message":
      return item.text;
    case "reasoning":
      return item.text ? `reasoning: ${item.text}` : null;
    case "command_execution":
      return `$ ${item.command}\n${item.aggregated_output}`.trim();
    case "file_change":
      return item.changes.map((change) => `${change.kind}: ${change.path}`).join("\n");
    case "mcp_tool_call":
      return formatMcpToolCall(item);
    case "web_search":
      return `web search: ${item.query}`;
    case "todo_list":
      return item.items.map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`).join("\n");
    case "error":
      return item.message;
    default:
      return null;
  }
};

const formatMcpToolCall = (item: Extract<ThreadItem, { type: "mcp_tool_call" }>): string => {
  const label = `${item.server}.${item.tool}: ${item.status}`;
  if (item.error) return `${label}\n${item.error.message}`;

  const content = item.result?.content
    .map((block) => contentBlockText(block))
    .filter((text): text is string => Boolean(text))
    .join("\n");

  if (content) return `${label}\n${content}`;
  if (item.result?.structured_content != null) {
    return `${label}\n${JSON.stringify(item.result.structured_content, null, 2)}`;
  }

  return label;
};

const contentBlockText = (block: unknown): string | null => {
  if (!block || typeof block !== "object") return null;
  const record = block as Record<string, unknown>;

  if (record.type === "text" && typeof record.text === "string") return record.text;
  if (record.type === "image") return "[image result]";
  if (typeof record.content === "string") return record.content;
  if (typeof record.text === "string") return record.text;

  return null;
};
