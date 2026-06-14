import { asRecord, type CodexRecord } from "../../core/codexRecord.js";
import { recordsToViews, type CodexRecordView } from "../../core/codexRecordView.js";
import { defaultAppSettings, isVscodeSurface, legacyStorageKey, reasoningOptions, storageKey } from "../appConfig.js";
import type { AppSettings, MessageDisplayMode, ModelSelection, ReasoningSelection, TextAttachment } from "../types.js";
import { browserId, formatDate } from "./common.js";

export const clipboardImageFiles = (clipboardData: DataTransfer) => {
  const itemFiles = [...clipboardData.items]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  if (itemFiles.length) return itemFiles;
  return [...clipboardData.files].filter((file) => file.type.startsWith("image/"));
};

export const composeUserInputText = (typedText: string, textAttachments: TextAttachment[]) => [
  typedText.trim(),
  ...textAttachments.map((item) => normalizeSelectedText(item.text))
].filter(Boolean).join("\n\n");

export const normalizeSelectedText = (value: string) =>
  value.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();

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

export const isModelSelection = (value: unknown): value is ModelSelection =>
  typeof value === "string" && value.trim().length > 0;

export const isReasoningSelection = (value: unknown): value is ReasoningSelection =>
  typeof value === "string" && reasoningOptions.some((option) => option.value === value);

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
  selectedModel?: ModelSelection;
  selectedReasoning?: ReasoningSelection;
  messageDisplayMode?: MessageDisplayMode;
  settings?: AppSettings;
  sidebarCollapsed?: boolean;
  collapsedProjectMachineKeys?: string[];
} | null => {
  try {
    const fallback = isVscodeSurface ? null : localStorage.getItem(legacyStorageKey);
    const parsed = JSON.parse(localStorage.getItem(storageKey) ?? fallback ?? "null");
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
      selectedModel: isModelSelection(parsed.selectedModel) ? parsed.selectedModel : undefined,
      selectedReasoning: isReasoningSelection(parsed.selectedReasoning) ? parsed.selectedReasoning : undefined,
      messageDisplayMode: isMessageDisplayMode(parsed.messageDisplayMode)
        ? parsed.messageDisplayMode
        : isMessageDisplayMode(parsed.toolDisplayMode) ? parsed.toolDisplayMode : undefined,
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
