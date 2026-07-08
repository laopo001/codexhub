import type React from "react";
import {
  browserId,
  clipboardImageFiles,
  composerCursorOnFirstLine,
  composerCursorOnLastLine,
  contextMenuPosition,
  normalizeSelectedText,
  selectedTextWithin,
  writeTextToClipboard
} from "../appHelpers.js";
import type { OpenThreadState, ComposerHistoryState, MessageContextMenuState, MessageRenderMode, WebRecordView } from "../types.js";

type ComposerActionsContext = {
  activeCanSend: boolean;
  composerHistoryRef: React.MutableRefObject<ComposerHistoryState | null>;
  messageContextMenu: MessageContextMenuState | null;
  resizeComposerTextarea: (textarea: HTMLTextAreaElement | null) => void;
  setComposerMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setInspectMessage: React.Dispatch<React.SetStateAction<WebRecordView | null>>;
  setMessageContextMenu: React.Dispatch<React.SetStateAction<MessageContextMenuState | null>>;
  setMessageRenderModes: React.Dispatch<React.SetStateAction<Record<string, MessageRenderMode>>>;
  setThreadControlsMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setOpenThreads: React.Dispatch<React.SetStateAction<OpenThreadState[]>>;
};

export type ComposerActionsDependencies = {
  send: (threadId: string) => Promise<void>;
};

type ComposerHistoryDirection = "previous" | "next";

const insertTextBlock = (value: string, text: string, start = value.length, end = start) => {
  const safeStart = Math.max(0, Math.min(start, value.length));
  const safeEnd = Math.max(safeStart, Math.min(end, value.length));
  const before = value.slice(0, safeStart);
  const after = value.slice(safeEnd);
  const leading = before && !before.endsWith("\n") ? "\n" : "";
  const trailing = after && !after.startsWith("\n") ? "\n" : "";
  const inserted = `${leading}${text}${trailing}`;
  return {
    value: `${before}${inserted}${after}`,
    cursor: before.length + leading.length + text.length
  };
};

export type ComposerActions = {
  updateThreadInput: (threadId: string, input: string) => void;
  resetComposerHistory: (threadId: string) => void;
  setComposerHistoryInput: (threadId: string, textarea: HTMLTextAreaElement, input: string) => void;
  navigateComposerHistory: (
    threadId: string,
    textarea: HTMLTextAreaElement,
    history: string[],
    direction: ComposerHistoryDirection
  ) => void;
  handleComposerKeyDown: (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    threadId: string,
    history: string[]
  ) => void;
  addThreadTextAttachment: (threadId: string, text: string) => void;
  insertThreadPathText: (
    threadId: string,
    paths: string[],
    textarea: HTMLTextAreaElement | null,
    caretIndex?: number | null
  ) => void;
  addThreadImageFiles: (threadId: string, files: File[]) => void;
  addThreadImages: (threadId: string, files: FileList | null) => void;
  addThreadFiles: (threadId: string, files: FileList | null) => Promise<void>;
  pasteThreadImages: (threadId: string, clipboardData: DataTransfer) => boolean;
  updateMessageRenderMode: (messageId: string, mode: MessageRenderMode) => void;
  clearThreadAttachments: (threadId: string) => void;
  removeThreadImage: (threadId: string, imageId: string) => void;
  removeThreadTextAttachment: (threadId: string, textId: string) => void;
  openMessageContextMenu: (
    event: React.MouseEvent,
    threadId: string,
    message: WebRecordView,
    canInspect: boolean
  ) => void;
  inspectContextMessage: () => void;
  addContextSelectionToConversation: () => void;
  copyContextSelection: () => Promise<void>;
};

export const createComposerActions = (ctx: ComposerActionsContext, deps: ComposerActionsDependencies): ComposerActions => {
  const updateThreadInput = (threadId: string, input: string) => {
    ctx.setOpenThreads((current) => current.map((thread) => thread.threadId === threadId ? { ...thread, input } : thread));
  };

  const resetComposerHistory = (threadId: string) => {
    if (ctx.composerHistoryRef.current?.threadId === threadId) ctx.composerHistoryRef.current = null;
  };

  const setComposerHistoryInput = (threadId: string, textarea: HTMLTextAreaElement, input: string) => {
    updateThreadInput(threadId, input);
    window.requestAnimationFrame(() => {
      ctx.resizeComposerTextarea(textarea);
      textarea.focus();
      textarea.setSelectionRange(input.length, input.length);
    });
  };

  const navigateComposerHistory = (
    threadId: string,
    textarea: HTMLTextAreaElement,
    history: string[],
    direction: ComposerHistoryDirection
  ) => {
    const current = ctx.composerHistoryRef.current?.threadId === threadId
      ? ctx.composerHistoryRef.current
      : { threadId, draft: textarea.value, offsetFromEnd: 0 };
    const offsetFromEnd = Math.min(current.offsetFromEnd, history.length);
    const nextOffset = direction === "previous"
      ? Math.min(history.length, offsetFromEnd + 1)
      : Math.max(0, offsetFromEnd - 1);
    if (nextOffset === offsetFromEnd) return;

    const input = nextOffset === 0
      ? current.draft
      : history[history.length - nextOffset] ?? current.draft;
    ctx.composerHistoryRef.current = { ...current, offsetFromEnd: nextOffset };
    setComposerHistoryInput(threadId, textarea, input);
  };

  const handleComposerKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    threadId: string,
    history: string[]
  ) => {
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown")
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey
      && !event.nativeEvent.isComposing
      && event.currentTarget.selectionStart === event.currentTarget.selectionEnd
    ) {
      const textarea = event.currentTarget;
      if (event.key === "ArrowUp" && history.length && composerCursorOnFirstLine(textarea)) {
        event.preventDefault();
        navigateComposerHistory(threadId, textarea, history, "previous");
        return;
      }
      if (
        event.key === "ArrowDown"
        && ctx.composerHistoryRef.current?.threadId === threadId
        && ctx.composerHistoryRef.current.offsetFromEnd > 0
        && composerCursorOnLastLine(textarea)
      ) {
        event.preventDefault();
        navigateComposerHistory(threadId, textarea, history, "next");
        return;
      }
    }

    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (ctx.activeCanSend) void deps.send(threadId);
  };

  const addThreadTextAttachment = (threadId: string, text: string) => {
    const normalizedText = normalizeSelectedText(text);
    if (!normalizedText) return;
    ctx.setOpenThreads((current) => current.map((thread) => thread.threadId === threadId
      ? { ...thread, textAttachments: [...thread.textAttachments, { id: browserId(), text: normalizedText }] }
      : thread));
  };

  const insertThreadPathText = (
    threadId: string,
    paths: string[],
    textarea: HTMLTextAreaElement | null,
    caretIndex?: number | null
  ) => {
    const text = paths.map((path) => normalizeSelectedText(path)).filter(Boolean).join("\n");
    if (!text) return;
    ctx.composerHistoryRef.current = null;
    const hasDropCaret = typeof caretIndex === "number";
    const selection = textarea
      ? {
          start: hasDropCaret ? caretIndex : textarea.selectionStart,
          end: hasDropCaret ? caretIndex : textarea.selectionEnd,
          value: textarea.value
        }
      : null;
    const inserted = selection ? insertTextBlock(selection.value, text, selection.start, selection.end) : null;
    ctx.setOpenThreads((current) => current.map((thread) => thread.threadId === threadId
      ? { ...thread, input: inserted?.value ?? insertTextBlock(thread.input, text).value }
      : thread));
    if (!textarea || !inserted) return;
    window.requestAnimationFrame(() => {
      ctx.resizeComposerTextarea(textarea);
      textarea.focus();
      textarea.setSelectionRange(inserted.cursor, inserted.cursor);
    });
  };

  const addThreadImageFiles = (threadId: string, files: File[]) => {
    if (!files.length) return;
    const images = files
      .filter((file) => file.type.startsWith("image/"))
      .map((file) => ({
        id: browserId(),
        file,
        name: file.name,
        previewUrl: URL.createObjectURL(file)
      }));
    if (!images.length) return;
    ctx.setOpenThreads((current) => current.map((thread) => thread.threadId === threadId
      ? { ...thread, imageAttachments: [...thread.imageAttachments, ...images] }
      : thread));
  };

  const addThreadImages = (threadId: string, files: FileList | null) => {
    if (!files?.length) return;
    addThreadImageFiles(threadId, [...files]);
  };

  const addThreadFiles = async (threadId: string, files: FileList | null) => {
    if (!files?.length) return;
    const fileList = [...files];
    addThreadImageFiles(threadId, fileList);
    const textFiles = fileList.filter((file) => !file.type.startsWith("image/") && isTextLikeFile(file));
    const skipped = fileList.filter((file) => !file.type.startsWith("image/") && !isTextLikeFile(file));
    const maxBytes = 512 * 1024;
    const tooLarge = textFiles.filter((file) => file.size > maxBytes);
    const readable = textFiles.filter((file) => file.size <= maxBytes);
    const textAttachments = await Promise.all(readable.map(async (file) => ({
      id: browserId(),
      text: normalizeSelectedText([
        `File: ${file.name}`,
        "",
        await file.text()
      ].join("\n"))
    })));
    const normalized = textAttachments.filter((item) => item.text);
    if (normalized.length) {
      ctx.setOpenThreads((current) => current.map((thread) => thread.threadId === threadId
        ? { ...thread, textAttachments: [...thread.textAttachments, ...normalized] }
        : thread));
    }
    const rejected = [
      ...tooLarge.map((file) => `${file.name} is larger than 512KB`),
      ...skipped.map((file) => `${file.name} is not a supported text or image file`)
    ];
    if (rejected.length) window.alert(rejected.join("\n"));
  };

  const pasteThreadImages = (threadId: string, clipboardData: DataTransfer) => {
    const images = clipboardImageFiles(clipboardData);
    if (!images.length) return false;
    addThreadImageFiles(threadId, images);
    return true;
  };

  const updateMessageRenderMode = (messageId: string, mode: MessageRenderMode) => {
    ctx.setMessageRenderModes((current) => current[messageId] === mode ? current : { ...current, [messageId]: mode });
  };

  const clearThreadAttachments = (threadId: string) => {
    ctx.setOpenThreads((current) => current.map((thread) => {
      if (thread.threadId !== threadId) return thread;
      for (const image of thread.imageAttachments) URL.revokeObjectURL(image.previewUrl);
      return { ...thread, imageAttachments: [], textAttachments: [] };
    }));
  };

  const removeThreadImage = (threadId: string, imageId: string) => {
    ctx.setOpenThreads((current) => current.map((thread) => {
      if (thread.threadId !== threadId) return thread;
      const image = thread.imageAttachments.find((item) => item.id === imageId);
      if (image) URL.revokeObjectURL(image.previewUrl);
      return { ...thread, imageAttachments: thread.imageAttachments.filter((item) => item.id !== imageId) };
    }));
  };

  const removeThreadTextAttachment = (threadId: string, textId: string) => {
    ctx.setOpenThreads((current) => current.map((thread) => thread.threadId === threadId
      ? { ...thread, textAttachments: thread.textAttachments.filter((item) => item.id !== textId) }
      : thread));
  };

  const openMessageContextMenu = (
    event: React.MouseEvent,
    threadId: string,
    message: WebRecordView,
    canInspect: boolean
  ) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const selectedText = selectedTextWithin(target);
    if (!canInspect && !selectedText) return;
    event.preventDefault();
    event.stopPropagation();
    ctx.setComposerMenuOpen(false);
    ctx.setThreadControlsMenuOpen(false);
    ctx.setMessageContextMenu({
      ...contextMenuPosition(event.clientX, event.clientY),
      threadId,
      message,
      selectedText,
      canInspect
    });
  };

  const inspectContextMessage = () => {
    if (!ctx.messageContextMenu?.canInspect) return;
    ctx.setInspectMessage(ctx.messageContextMenu.message);
    ctx.setMessageContextMenu(null);
  };

  const addContextSelectionToConversation = () => {
    if (!ctx.messageContextMenu?.selectedText) return;
    addThreadTextAttachment(ctx.messageContextMenu.threadId, ctx.messageContextMenu.selectedText);
    ctx.setMessageContextMenu(null);
    window.getSelection()?.removeAllRanges();
  };

  const copyContextSelection = async () => {
    if (!ctx.messageContextMenu?.selectedText) return;
    await writeTextToClipboard(ctx.messageContextMenu.selectedText);
    ctx.setMessageContextMenu(null);
  };

  return {
    updateThreadInput,
    resetComposerHistory,
    setComposerHistoryInput,
    navigateComposerHistory,
    handleComposerKeyDown,
    addThreadTextAttachment,
    insertThreadPathText,
    addThreadImageFiles,
    addThreadImages,
    addThreadFiles,
    pasteThreadImages,
    updateMessageRenderMode,
    clearThreadAttachments,
    removeThreadImage,
    removeThreadTextAttachment,
    openMessageContextMenu,
    inspectContextMessage,
    addContextSelectionToConversation,
    copyContextSelection
  };
};

const textFileExtensions = new Set([
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".py",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const isTextLikeFile = (file: File) => {
  if (file.type.startsWith("text/")) return true;
  if (file.type === "application/json" || file.type === "application/xml" || file.type === "application/yaml") return true;
  const lowerName = file.name.toLowerCase();
  return [...textFileExtensions].some((extension) => lowerName.endsWith(extension));
};
