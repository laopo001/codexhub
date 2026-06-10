// @ts-nocheck
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

export const createComposerActions = (ctx, actions) => {
  const updateSessionInput = (threadId, input) => {
    ctx.setSessions((current) => current.map((session) => session.threadId === threadId ? { ...session, input } : session));
  };

  const resetComposerHistory = (threadId) => {
    if (ctx.composerHistoryRef.current?.threadId === threadId) ctx.composerHistoryRef.current = null;
  };

  const setComposerHistoryInput = (threadId, textarea, input) => {
    updateSessionInput(threadId, input);
    window.requestAnimationFrame(() => {
      ctx.resizeComposerTextarea(textarea);
      textarea.focus();
      textarea.setSelectionRange(input.length, input.length);
    });
  };

  const navigateComposerHistory = (
    threadId,
    textarea,
    history,
    direction
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
    event,
    threadId,
    history
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
    if (ctx.activeCanSend) void actions.send(threadId);
  };

  const addSessionTextAttachment = (threadId, text) => {
    const normalizedText = normalizeSelectedText(text);
    if (!normalizedText) return;
    ctx.setSessions((current) => current.map((session) => session.threadId === threadId
      ? { ...session, textAttachments: [...session.textAttachments, { id: browserId(), text: normalizedText }] }
      : session));
  };

  const addSessionImageFiles = (threadId, files) => {
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
    ctx.setSessions((current) => current.map((session) => session.threadId === threadId
      ? { ...session, imageAttachments: [...session.imageAttachments, ...images] }
      : session));
  };

  const addSessionImages = (threadId, files) => {
    if (!files?.length) return;
    addSessionImageFiles(threadId, [...files]);
  };

  const pasteSessionImages = (threadId, clipboardData) => {
    const images = clipboardImageFiles(clipboardData);
    if (!images.length) return false;
    addSessionImageFiles(threadId, images);
    return true;
  };

  const updateMessageRenderMode = (messageId, mode) => {
    ctx.setMessageRenderModes((current) => current[messageId] === mode ? current : { ...current, [messageId]: mode });
  };

  const removeSessionImage = (threadId, imageId) => {
    ctx.setSessions((current) => current.map((session) => {
      if (session.threadId !== threadId) return session;
      const image = session.imageAttachments.find((item) => item.id === imageId);
      if (image) URL.revokeObjectURL(image.previewUrl);
      return { ...session, imageAttachments: session.imageAttachments.filter((item) => item.id !== imageId) };
    }));
  };

  const removeSessionTextAttachment = (threadId, textId) => {
    ctx.setSessions((current) => current.map((session) => session.threadId === threadId
      ? { ...session, textAttachments: session.textAttachments.filter((item) => item.id !== textId) }
      : session));
  };

  const openMessageContextMenu = (
    event,
    threadId,
    message,
    canInspect
  ) => {
    const selectedText = selectedTextWithin(event.currentTarget);
    if (!canInspect && !selectedText) return;
    event.preventDefault();
    event.stopPropagation();
    ctx.setComposerMenuOpen(false);
    ctx.setSessionMenuOpen(false);
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
    addSessionTextAttachment(ctx.messageContextMenu.threadId, ctx.messageContextMenu.selectedText);
    ctx.setMessageContextMenu(null);
    window.getSelection()?.removeAllRanges();
  };

  const copyContextSelection = async () => {
    if (!ctx.messageContextMenu?.selectedText) return;
    await writeTextToClipboard(ctx.messageContextMenu.selectedText);
    ctx.setMessageContextMenu(null);
  };

  return {
    updateSessionInput,
    resetComposerHistory,
    setComposerHistoryInput,
    navigateComposerHistory,
    handleComposerKeyDown,
    addSessionTextAttachment,
    addSessionImageFiles,
    addSessionImages,
    pasteSessionImages,
    updateMessageRenderMode,
    removeSessionImage,
    removeSessionTextAttachment,
    openMessageContextMenu,
    inspectContextMessage,
    addContextSelectionToConversation,
    copyContextSelection
  };
};
