import type { MemoryCitationEntry, MemoryCitationView, WebRecordView } from "../types.js";

export const memoryCitationBlockPattern = /<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g;

export const emptyMemoryCitation = (text: string): MemoryCitationView => ({ text, entries: [], rolloutIds: [] });

export const shouldExtractMemoryCitation = (message: WebRecordView) =>
  message.role === "codex" && message.label === "final_answer";

export const parseMemoryCitationText = (text: string): MemoryCitationView => {
  const blocks = text.match(memoryCitationBlockPattern) ?? [];
  if (!blocks.length) return { text, entries: [], rolloutIds: [] };
  const entries = blocks.flatMap(parseMemoryCitationEntries);
  const rolloutIds = [...new Set(blocks.flatMap(parseMemoryCitationRolloutIds))];
  return {
    text: text.replace(memoryCitationBlockPattern, "").trimEnd(),
    entries,
    rolloutIds
  };
};

export const parseMemoryCitationEntries = (block: string): MemoryCitationEntry[] =>
  xmlSectionLines(block, "citation_entries").flatMap((line) => {
    const parsed = parseMemoryCitationEntry(line);
    return parsed ? [parsed] : [];
  });

export const parseMemoryCitationRolloutIds = (block: string) =>
  xmlSectionLines(block, "rollout_ids").filter((line) => line.trim().length > 0);

export const parseMemoryCitationEntry = (line: string): MemoryCitationEntry | null => {
  const raw = line.trim();
  if (!raw) return null;
  const [location, notePart] = splitMemoryCitationNote(raw);
  const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(location.trim());
  if (!match) return { source: location.trim() || raw, note: notePart, raw };
  const source = match[1]?.trim() || raw;
  const lineStart = match[2] ? Number(match[2]) : undefined;
  const lineEnd = match[3] ? Number(match[3]) : lineStart;
  return {
    source,
    lineStart,
    lineEnd,
    note: notePart,
    raw
  };
};

export const splitMemoryCitationNote = (line: string): [string, string | undefined] => {
  const marker = "|note=";
  const index = line.indexOf(marker);
  if (index === -1) return [line, undefined];
  const note = line.slice(index + marker.length).trim();
  return [
    line.slice(0, index),
    note.startsWith("[") && note.endsWith("]") ? note.slice(1, -1) : note
  ];
};

export const xmlSectionLines = (block: string, tag: string) => {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(block);
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => decodeXmlText(line.trim()))
    .filter(Boolean);
};

export const decodeXmlText = (text: string) => text
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'");

export const formatMemoryCitationCount = (count: number) => `${count} 条记忆引用`;

export const formatMemoryCitationLines = (entry: MemoryCitationEntry) => {
  if (!entry.lineStart) return "";
  if (!entry.lineEnd || entry.lineEnd === entry.lineStart) return `${entry.lineStart} 行`;
  return `${entry.lineStart}-${entry.lineEnd} 行`;
};
