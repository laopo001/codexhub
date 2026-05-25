import path from "node:path";
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

export const itemText = (item: ThreadItem, options: { workingDirectory?: string } = {}): string | null => {
  switch (item.type) {
    case "agent_message":
      return item.text;
    case "reasoning":
      return item.text ? `reasoning: ${item.text}` : null;
    case "command_execution":
      return `$ ${item.command}\n${item.aggregated_output}`.trim();
    case "file_change":
      return formatFileChange(item, options.workingDirectory);
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

const formatFileChange = (
  item: Extract<ThreadItem, { type: "file_change" }>,
  workingDirectory?: string
) => {
  const counts = item.changes.reduce<Record<string, number>>((acc, change) => {
    acc[change.kind] = (acc[change.kind] ?? 0) + 1;
    return acc;
  }, {});
  const summary = ["add", "update", "delete"]
    .map((kind) => counts[kind] ? `${counts[kind]} ${kind}` : null)
    .filter(Boolean)
    .join(", ");
  return [
    item.status === "completed" ? "Patch applied successfully." : "Patch failed.",
    "",
    `Status: ${item.status}`,
    `Changed files: ${item.changes.length}${summary ? ` (${summary})` : ""}`,
    "",
    ...item.changes.map((change) => formatFileChangeLine(change, workingDirectory))
  ].join("\n");
};

const formatFileChangeLine = (
  change: Extract<ThreadItem, { type: "file_change" }>["changes"][number],
  workingDirectory?: string
) => {
  const displayPath = relativePath(change.path, workingDirectory);
  return displayPath === change.path
    ? `- ${change.kind}: ${displayPath}`
    : `- ${change.kind}: ${displayPath}\n  ${change.path}`;
};

const relativePath = (filePath: string, workingDirectory?: string) => {
  if (!workingDirectory || !path.isAbsolute(filePath)) return filePath;
  const relative = path.relative(workingDirectory, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
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
