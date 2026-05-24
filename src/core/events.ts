import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";

export type ProxyEvent =
  | { type: "thread"; threadId: string }
  | { type: "status"; text: string }
  | { type: "item"; item: ThreadItem }
  | { type: "final"; text: string; usage: Usage | null }
  | { type: "error"; message: string };

export const toProxyEvent = (event: ThreadEvent, finalResponse = ""): ProxyEvent | null => {
  switch (event.type) {
    case "thread.started":
      return { type: "thread", threadId: event.thread_id };
    case "turn.started":
      return { type: "status", text: "turn.started" };
    case "item.started":
    case "item.updated":
    case "item.completed":
      return { type: "item", item: event.item };
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
      return `${item.server}.${item.tool}: ${item.status}`;
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
