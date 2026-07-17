import { recordsToViews } from "../../core/codexRecordView.js";
import type { CodexRecord, CodexRecordView } from "../../shared/recordTypes.js";
import { defaultAppSettings, storageKey } from "../appConfig.js";
import type { AppSettings, MessageDisplayMode, TextAttachment } from "../types.js";
import { browserId } from "./common.js";

export type ComposerDraftStore = {
  delete: (threadId: string) => void;
  get: (threadId: string) => string;
  set: (threadId: string, value: string) => void;
  subscribe: (threadId: string, listener: () => void) => () => void;
};

export const createComposerDraftStore = (): ComposerDraftStore => {
  const drafts = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (threadId: string) => {
    for (const listener of listeners.get(threadId) ?? []) listener();
  };
  return {
    delete: (threadId) => {
      drafts.delete(threadId);
      listeners.delete(threadId);
    },
    get: (threadId) => drafts.get(threadId) ?? "",
    set: (threadId, value) => {
      if (drafts.get(threadId) === value) return;
      drafts.set(threadId, value);
      notify(threadId);
    },
    subscribe: (threadId, listener) => {
      const threadListeners = listeners.get(threadId) ?? new Set<() => void>();
      threadListeners.add(listener);
      listeners.set(threadId, threadListeners);
      return () => {
        threadListeners.delete(listener);
        if (!threadListeners.size) listeners.delete(threadId);
      };
    }
  };
};

export const commandPaletteCacheKey = (sessionId: string, cwd: string) =>
  `${sessionId}\u0000${cwd}`;

export const clipboardImageFiles = (clipboardData: DataTransfer) => {
  const itemFiles = [...clipboardData.items]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (itemFiles.length) return itemFiles;
  return [...clipboardData.files].filter((file) => file.type.startsWith("image/"));
};

export const dataTransferHasPathPayload = (dataTransfer: DataTransfer) =>
  dataTransferTypes(dataTransfer).length === 0 || dataTransferTypes(dataTransfer).some((type) => {
    const normalized = type.toLowerCase();
    return normalized === "text/uri-list"
      || normalized === "text/plain"
      || normalized === "text"
      || normalized === "url"
      || normalized === "files"
      || normalized.includes("uri-list")
      || normalized.includes("vscode")
      || normalized.includes("code.tree")
      || normalized.includes("resource");
  });

export const droppedPathsFromDataTransfer = (dataTransfer: DataTransfer) => {
  const candidates = preferredDropTypes(dataTransfer)
    .map((type, priority) => ({
      paths: uniquePaths(pathsFromDropPayload(safeDataTransferText(dataTransfer, type))),
      priority
    }))
    .filter((item) => item.paths.length > 0)
    .sort((left, right) => right.paths.length - left.paths.length || left.priority - right.priority);
  return candidates[0]?.paths ?? [];
};

export const composeUserInputText = (typedText: string, textAttachments: TextAttachment[]) => [
  typedText.trim(),
  ...formatTextAttachmentReferences(textAttachments)
].filter(Boolean).join("\n\n");

export const formatTextAttachmentReferences = (textAttachments: TextAttachment[]) =>
  textAttachments
    .map((item) => normalizeSelectedText(item.text))
    .filter(Boolean)
    .map((text, index) => formatTextAttachmentReference(index + 1, text));

export const formatTextAttachmentReference = (index: number, text: string) => {
  const fence = codeFenceFor(text);
  return [`## Reference ${index}`, fence, text, fence].join("\n");
};

const codeFenceFor = (text: string) => {
  const longestBacktickRun = text.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
};

export const normalizeSelectedText = (value: string) =>
  value.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();

export const textareaCaretIndexFromPoint = (
  textarea: HTMLTextAreaElement,
  clientX: number,
  clientY: number
) => {
  const value = textarea.value;
  if (!value) return 0;

  const style = window.getComputedStyle(textarea);
  const fontSize = cssPixelValue(style.fontSize, 14);
  const lineHeight = cssPixelValue(style.lineHeight, fontSize * 1.4);
  const paddingLeft = cssPixelValue(style.paddingLeft, 0);
  const paddingRight = cssPixelValue(style.paddingRight, 0);
  const paddingTop = cssPixelValue(style.paddingTop, 0);
  const rect = textarea.getBoundingClientRect();
  const x = Math.max(0, clientX - rect.left - textarea.clientLeft - paddingLeft + textarea.scrollLeft);
  const y = Math.max(0, clientY - rect.top - textarea.clientTop - paddingTop + textarea.scrollTop);
  const measure = textMeasurer(style, fontSize);
  const rows = textareaVisualRows(
    value,
    Math.max(1, textarea.clientWidth - paddingLeft - paddingRight),
    measure
  );
  const row = rows[clampNumber(Math.floor(y / Math.max(1, lineHeight)), 0, rows.length - 1)];
  if (!row) return value.length;
  return clampNumber(row.start + caretOffsetInRow(row.text, x, measure), 0, value.length);
};

const dataTransferTypes = (dataTransfer: DataTransfer) => [...dataTransfer.types];

const safeDataTransferText = (dataTransfer: DataTransfer, type: string) => {
  try {
    return dataTransfer.getData(type);
  } catch {
    return "";
  }
};

const preferredDropTypes = (dataTransfer: DataTransfer) => {
  const types = dataTransferTypes(dataTransfer);
  const ordered = [
    "text/uri-list",
    ...types.filter((type) => {
      const normalized = type.toLowerCase();
      return normalized !== "text/uri-list" && (
        normalized.includes("uri")
        || normalized.includes("vscode")
        || normalized.includes("code.tree")
        || normalized.includes("resource")
        || normalized.includes("file")
      );
    }),
    "text/plain"
  ];
  return [...new Set(ordered)];
};

const uniquePaths = (paths: string[]) => {
  const candidates = new Map<string, string>();
  for (const path of paths) {
    const normalized = normalizePathForDisplay(path);
    const key = canonicalPathKey(normalized);
    if (!candidates.has(key)) candidates.set(key, normalized);
  }
  return [...candidates.values()];
};

const pathsFromDropPayload = (payload: string): string[] => {
  const normalized = payload.trim();
  if (!normalized) return [];
  return [
    ...pathsFromJsonPayload(normalized),
    ...normalized.split(/\r?\n/).flatMap((line) => pathsFromDropLine(line))
  ];
};

const pathsFromJsonPayload = (payload: string): string[] => {
  if (!payload.startsWith("{") && !payload.startsWith("[")) return [];
  try {
    return pathsFromJsonValue(JSON.parse(payload));
  } catch {
    return [];
  }
};

const pathsFromJsonValue = (value: unknown): string[] => {
  if (typeof value === "string") {
    const path = pathFromDroppedString(value);
    return path ? [path] : [];
  }
  if (Array.isArray(value)) return value.flatMap(pathsFromJsonValue);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    if (
      key === "fsPath"
      || key === "path"
      || key === "uri"
      || key === "resource"
      || key === "resources"
      || key === "resourceUri"
    ) return pathsFromJsonValue(item);
    return [];
  });
};

const pathsFromDropLine = (line: string): string[] => {
  const text = line.trim();
  if (!text || text.startsWith("#")) return [];
  const path = pathFromDroppedString(stripDropQuotes(text));
  return path ? [path] : [];
};

const stripDropQuotes = (value: string) =>
  value.replace(/^['"]|['"]$/g, "");

const pathFromDroppedString = (value: string) =>
  pathFromUriString(value) || (isAbsolutePathLike(value) ? value : "");

const pathFromUriString = (value: string) => {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return pathFromFileUrl(url);
    if (url.protocol === "vscode-remote:") return decodeURIComponent(url.pathname);
    return "";
  } catch {
    return "";
  }
};

const pathFromFileUrl = (url: URL) => {
  const pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:\//.test(pathname)) return normalizePathForDisplay(pathname.slice(1).replace(/\//g, "\\"));
  if (url.hostname) return `\\\\${url.hostname}${pathname.replace(/\//g, "\\")}`;
  return pathname;
};

const isAbsolutePathLike = (value: string) =>
  value.startsWith("/")
  || /^[A-Za-z]:[\\/]/.test(value)
  || /^\\\\[^\\]+\\[^\\]+/.test(value);

const canonicalPathKey = (path: string) => {
  const normalized = path.trim().replace(/\//g, "\\");
  if (/^[A-Za-z]:\\/.test(normalized) || /^\\\\[^\\]+\\[^\\]+/.test(normalized)) return normalized.toLowerCase();
  return path.trim();
};

const normalizePathForDisplay = (path: string) =>
  path.replace(/^([a-z]):([\\/])/, (_, drive: string, slash: string) => `${drive.toUpperCase()}:${slash}`);

const cssPixelValue = (value: string, fallback: number) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const textMeasurer = (style: CSSStyleDeclaration, fontSize: number) => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return (text: string) => text.length * fontSize * 0.6;
  context.font = style.font || [
    style.fontStyle,
    style.fontVariant,
    style.fontWeight,
    style.fontSize,
    style.fontFamily
  ].filter(Boolean).join(" ");
  return (text: string) => context.measureText(text).width;
};

type TextareaVisualRow = {
  start: number;
  text: string;
};

const textareaVisualRows = (
  value: string,
  maxWidth: number,
  measure: (text: string) => number
): TextareaVisualRow[] => {
  const rows: TextareaVisualRow[] = [];
  let absoluteStart = 0;
  for (const line of value.split("\n")) {
    rows.push(...wrapTextareaLine(line, absoluteStart, maxWidth, measure));
    absoluteStart += line.length + 1;
  }
  return rows.length ? rows : [{ start: 0, text: "" }];
};

const wrapTextareaLine = (
  line: string,
  absoluteStart: number,
  maxWidth: number,
  measure: (text: string) => number
): TextareaVisualRow[] => {
  if (!line) return [{ start: absoluteStart, text: "" }];
  const rows: TextareaVisualRow[] = [];
  let segment = "";
  let segmentStart = 0;
  for (let index = 0; index < line.length; index += 1) {
    const nextSegment = `${segment}${line[index]}`;
    if (segment && measure(nextSegment) > maxWidth) {
      rows.push({ start: absoluteStart + segmentStart, text: segment });
      segment = line[index] ?? "";
      segmentStart = index;
    } else {
      segment = nextSegment;
    }
  }
  rows.push({ start: absoluteStart + segmentStart, text: segment });
  return rows;
};

const caretOffsetInRow = (
  text: string,
  x: number,
  measure: (text: string) => number
) => {
  if (x <= 0 || !text) return 0;
  let previousWidth = 0;
  for (let offset = 1; offset <= text.length; offset += 1) {
    const width = measure(text.slice(0, offset));
    if (width >= x) return x - previousWidth < width - x ? offset - 1 : offset;
    previousWidth = width;
  }
  return text.length;
};

const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, max));

export const userMessageHistoryFromRecords = (records: CodexRecord[]) => {
  const history: string[] = [];
  for (const view of recordsToViews(records)) {
    if (view.role !== "user") continue;
    const text = normalizeHistoryMessageText(view);
    if (!text || history.at(-1) === text) continue;
    history.push(text);
  }
  return history;
};

export const normalizeHistoryMessageText = (view: CodexRecordView) => {
  const text = normalizeSelectedText(view.text);
  if (text === "[image]" && view.attachments?.length) return "";
  return text;
};

export const composerCursorOnFirstLine = (textarea: HTMLTextAreaElement) =>
  !textarea.value.slice(0, textarea.selectionStart).includes("\n");

export const composerCursorOnLastLine = (textarea: HTMLTextAreaElement) =>
  !textarea.value.slice(textarea.selectionEnd).includes("\n");

export const selectedTextWithin = (element: HTMLElement) => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const selectedText = normalizeSelectedText(selection.toString());
  if (!selectedText) return "";
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (rangeIntersectsElement(selection.getRangeAt(index), element)) return selectedText;
  }
  return "";
};

export const rangeIntersectsElement = (range: Range, element: HTMLElement) => {
  try {
    return range.intersectsNode(element);
  } catch {
    const container = range.commonAncestorContainer;
    return element.contains(container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement);
  }
};

export const writeTextToClipboard = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy textarea copy path.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
};

export const contextMenuPosition = (clientX: number, clientY: number) => {
  const padding = 8;
  const estimatedWidth = 190;
  const estimatedHeight = 128;
  return {
    x: Math.max(padding, Math.min(clientX, window.innerWidth - estimatedWidth - padding)),
    y: Math.max(padding, Math.min(clientY, window.innerHeight - estimatedHeight - padding))
  };
};

export const errorRecord = (label: string, error: unknown): CodexRecord => ({
  id: `web:${browserId()}`,
  timestamp: new Date().toISOString(),
  type: "error",
  payload: {
    type: label,
    message: error instanceof Error ? error.message : String(error)
  }
});

export const isMessageDisplayMode = (value: unknown): value is MessageDisplayMode =>
  value === "compact" || value === "detailed";

const storedAppSettings = (value: unknown): AppSettings | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...defaultAppSettings(),
    taskCompleteSystemNotifications: typeof record.taskCompleteSystemNotifications === "boolean"
      ? record.taskCompleteSystemNotifications
      : defaultAppSettings().taskCompleteSystemNotifications
  };
};

const storedStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined;

const storedStringRecord = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);
  return entries.length ? Object.fromEntries(entries) : undefined;
};

const storedStringArrayRecord = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value)
    .flatMap(([key, item]) => {
      const ids = storedStringArray(item);
      return ids?.length ? [[key, ids] as const] : [];
    });
  return entries.length ? Object.fromEntries(entries) : undefined;
};

export const readStoredUiState = (): {
  activeWorkspacePath?: string;
  activeSessionId?: string;
  activeTabThreadId?: string;
  activeTabThreadBySession?: Record<string, string>;
  openThreadIds?: string[];
  threadOrderBySession?: Record<string, string[]>;
  selectedProjectKey?: string;
  projectSearch?: string;
  messageDisplayMode?: MessageDisplayMode;
  settings?: AppSettings;
  sidebarCollapsed?: boolean;
  collapsedProjectMachineKeys?: string[];
} | null => {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    return {
      activeWorkspacePath: typeof parsed.activeWorkspacePath === "string" ? parsed.activeWorkspacePath : undefined,
      activeSessionId: typeof parsed.activeSessionId === "string" ? parsed.activeSessionId : undefined,
      activeTabThreadId: typeof parsed.activeTabThreadId === "string" ? parsed.activeTabThreadId : undefined,
      activeTabThreadBySession: storedStringRecord(parsed.activeTabThreadBySession),
      openThreadIds: Array.isArray(parsed.openThreadIds) ? storedStringArray(parsed.openThreadIds) ?? [] : undefined,
      threadOrderBySession: storedStringArrayRecord(parsed.threadOrderBySession),
      selectedProjectKey: typeof parsed.selectedProjectKey === "string" ? parsed.selectedProjectKey : undefined,
      projectSearch: typeof parsed.projectSearch === "string" ? parsed.projectSearch : undefined,
      messageDisplayMode: isMessageDisplayMode(parsed.messageDisplayMode) ? parsed.messageDisplayMode : undefined,
      settings: storedAppSettings(parsed.settings),
      sidebarCollapsed: typeof parsed.sidebarCollapsed === "boolean" ? parsed.sidebarCollapsed : undefined,
      collapsedProjectMachineKeys: Array.isArray(parsed.collapsedProjectMachineKeys)
        ? parsed.collapsedProjectMachineKeys.filter((key: unknown): key is string => typeof key === "string" && key.trim().length > 0)
        : undefined
    };
  } catch {
    return null;
  }
};
