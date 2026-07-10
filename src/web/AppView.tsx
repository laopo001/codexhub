import React from "react";
import { Tabs } from "antd";
import {
  FileText,
  Gauge,
  Image as ImageIcon,
  ListChecks,
  MessageCircle,
  Package,
  Paperclip,
  Command as CommandIcon,
  Sparkles,
  Target,
  X,
  type LucideIcon
} from "lucide-react";
import { Virtuoso, type Components } from "react-virtuoso";
import { approvalPolicyOptions, composerModeOptions, isVscodeSurface, sandboxPolicyOptions } from "./appConfig.js";
import { AppDialogs } from "./AppDialogs.js";
import { AppSidebar } from "./AppSidebar.js";
import type { AppViewModel } from "./viewModel.js";
import {
  ActivityStatusBar,
  canForkAtMessage,
  canRenderMarkdown,
  commandPaletteCacheKey,
  EmptyMessages,
  formatGoalAge,
  goalStatusClass,
  goalStatusLabel,
  MessageCard,
  dataTransferHasPathPayload,
  droppedPathsFromDataTransfer,
  textareaCaretIndexFromPoint,
} from "./appHelpers.js";
import type { CommandPaletteEntry } from "./types.js";

type AppViewProps = {
  viewModel: AppViewModel;
};

const composerModeIconByValue: Record<(typeof composerModeOptions)[number]["value"], LucideIcon> = {
  chat: MessageCircle,
  plan: ListChecks,
  goal: Target
};

const weeklyGoalPolicyLabel = (targetRemainingPercent: number) =>
  `weekly ≤ ${formatGoalPolicyPercent(targetRemainingPercent)}`;

const formatGoalPolicyPercent = (value: number) =>
  `${Number.isInteger(value) ? value : value.toFixed(1)}%`;

const firstContentLine = (text: string) =>
  text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";

const clippedText = (text: string, maxLength: number) =>
  text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;

const textAttachmentTitle = (text: string) => {
  const firstLine = firstContentLine(text);
  const fileMatch = /^File:\s*(.+)$/i.exec(firstLine);
  const pathMatch = /^Path:\s*(.+)$/i.exec(firstLine);
  return clippedText(fileMatch?.[1] || pathMatch?.[1] || "Text selection", 80);
};

const textAttachmentPreview = (text: string) => {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const previewLines = /^(File|Path):/i.test(lines[0] ?? "") ? lines.slice(1) : lines;
  return clippedText((previewLines.join(" ") || lines[0] || "Text").replace(/\s+/g, " "), 160);
};

const textAttachmentTooltip = (text: string) => {
  const title = textAttachmentTitle(text);
  const preview = textAttachmentPreview(text);
  return title === preview ? title : `${title}\n${preview}`;
};

const attachmentCountLabel = (count: number) =>
  `${count} attachment${count === 1 ? "" : "s"}`;

const messagesBottomThreshold = 48;
const messagesScrollbarHitArea = 20;
const messagesUserScrollIntentMs = 900;
const messagesScrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

type CommandPaletteTrigger = {
  marker: "/" | "@";
  query: string;
  start: number;
  end: number;
  key: string;
};

type CommandPaletteGroupId = "commands" | "skills" | "plugins";

type CommandPaletteRow =
  | { type: "group"; group: CommandPaletteGroupId; label: string }
  | { type: "entry"; entry: CommandPaletteEntry; index: number };

const commandPaletteTriggerForInput = (input: string, caretIndex: number): CommandPaletteTrigger | null => {
  const end = Math.max(0, Math.min(caretIndex, input.length));
  const beforeCaret = input.slice(0, end);
  if (!beforeCaret || /\s$/.test(beforeCaret)) return null;
  const match = /(^|\s)([/@])([^\s]*)$/.exec(beforeCaret);
  if (!match) return null;
  const marker = match[2] as "/" | "@";
  const query = match[3] ?? "";
  const start = match.index + (match[1]?.length ?? 0);
  return {
    marker,
    query,
    start,
    end,
    key: `${marker}${query}`
  };
};

const commandPaletteSearchText = (entry: CommandPaletteEntry) => [
  entry.name,
  entry.title,
  entry.shortDescription,
  entry.description,
  entry.detail,
  entry.source,
  entry.scope
].filter(Boolean).join(" ").toLowerCase();

const commandPaletteEntriesForTrigger = (
  entries: CommandPaletteEntry[],
  trigger: CommandPaletteTrigger | null
) => {
  if (!trigger) return [];
  const query = trigger.query.toLowerCase();
  const filtered = entries
    .filter((entry) => entry.enabled)
    .filter((entry) => {
      if (trigger.marker === "@") {
        return entry.kind === "plugin" || (entry.kind === "skill" && !commandPaletteEntryIsPluginSkill(entry));
      }
      return true;
    })
    .filter((entry) => !query || commandPaletteSearchText(entry).includes(query))
    .sort((left, right) => {
      if (trigger.marker === "/" || trigger.marker === "@") {
        const groupRank = commandPaletteGroupRank(left) - commandPaletteGroupRank(right);
        if (groupRank) return groupRank;
      }
      return commandPaletteEntryRank(left, query) - commandPaletteEntryRank(right, query);
    });
  return filtered;
};

const commandPaletteEntryIsPluginSkill = (entry: CommandPaletteEntry) =>
  entry.kind === "skill" && entry.name.includes(":");

const commandPaletteEntryGroup = (entry: CommandPaletteEntry): CommandPaletteGroupId => {
  if (entry.kind === "builtin") return "commands";
  if (entry.kind === "skill" && !commandPaletteEntryIsPluginSkill(entry)) return "skills";
  return "plugins";
};

const commandPaletteGroupRank = (entry: CommandPaletteEntry) => {
  const group = commandPaletteEntryGroup(entry);
  if (group === "commands") return 0;
  if (group === "skills") return 1;
  return 2;
};

const commandPaletteGroupLabel = (group: CommandPaletteGroupId) => {
  if (group === "commands") return "命令";
  if (group === "skills") return "技能";
  return "插件 + 插件技能";
};

const commandPaletteRowsForTrigger = (
  entries: CommandPaletteEntry[],
  trigger: CommandPaletteTrigger | null
): CommandPaletteRow[] => {
  if (trigger?.marker !== "/") {
    return entries.map((entry, index) => ({ type: "entry", entry, index }));
  }
  const rows: CommandPaletteRow[] = [];
  let previousGroup: CommandPaletteGroupId | null = null;
  entries.forEach((entry, index) => {
    const group = commandPaletteEntryGroup(entry);
    if (group !== previousGroup) {
      rows.push({ type: "group", group, label: commandPaletteGroupLabel(group) });
      previousGroup = group;
    }
    rows.push({ type: "entry", entry, index });
  });
  return rows;
};

const commandPaletteEntryRank = (entry: CommandPaletteEntry, query: string) => {
  if (!query) return entry.kind === "builtin" ? 0 : 20;
  const name = entry.name.toLowerCase();
  const title = entry.title.toLowerCase();
  if (name === query || title === query) return 0;
  if (name.startsWith(query)) return 1;
  if (title.startsWith(query)) return 2;
  if (entry.kind === "plugin") return 8;
  return entry.kind === "builtin" ? 10 : 20;
};

const commandPaletteEntryDescription = (entry: CommandPaletteEntry) =>
  entry.shortDescription || entry.description;

const commandPaletteEntryIcon = (entry: CommandPaletteEntry) =>
  entry.kind === "plugin" ? Package : entry.kind === "skill" ? Sparkles : CommandIcon;

const commandPaletteTriggerLabel = (marker: CommandPaletteTrigger["marker"] | undefined) => {
  if (marker === "@") return "技能、插件";
  return "命令、技能、插件";
};

const commandPaletteTriggerAriaLabel = (marker: CommandPaletteTrigger["marker"] | undefined) => {
  if (marker === "@") return "Skills and plugins";
  return "Commands";
};

const commandPaletteReplacementText = (entry: CommandPaletteEntry, trigger: CommandPaletteTrigger) => {
  const replacement = entry.insertText || `${trigger.marker}${entry.name}`;
  if (entry.kind !== "skill" && entry.kind !== "plugin") {
    return replacement;
  }
  return /\s$/.test(replacement) ? replacement : `${replacement} `;
};

const commandPaletteEntryLabel = (entry: CommandPaletteEntry) => {
  if (entry.kind === "builtin") return `/${entry.name}`;
  const insertText = entry.insertText?.trim();
  if (insertText && /^[$@]/.test(insertText)) return insertText;
  return `@${entry.name}`;
};

type MessagesVirtuosoContext = {
  turnLoadingDuration: string;
};

const MessagesTurnLoadingFooter = ({ context }: { context?: MessagesVirtuosoContext }) => {
  const duration = context?.turnLoadingDuration;
  return (
    <div
      className="turnLoadingMessage"
      role="status"
      aria-live="polite"
      aria-label={duration ? `Running ${duration}` : "Running"}
    >
      <span className="turnLoadingText">Running</span>
      {duration ? <span className="turnLoadingDuration">· {duration}</span> : null}
    </div>
  );
};

export const AppView = ({ viewModel }: AppViewProps) => {
  const {
    activeCanSend,
    activeCanStop,
    activeCanSubmit,
    activeExpandedStatusKeys,
    activeGoal,
    activeProjectKey,
    activeRuntimeSession,
    activeRunningExecutionDuration,
    activeThread,
    activeThreadIsOpen,
    activeThreadExecutionMeta,
    activeThreadApprovalPolicySelection,
    activeThreadSandboxPolicySelection,
    activeUserMessageHistory,
    activeViews,
    authError,
    authRequired,
    authTokenDraft,
    addContextSelectionToConversation,
    addThreadFiles,
    addThreadImages,
    addSshHost,
    changeProjectPickerMachine,
    chooseThreadCandidate,
    clearThreadAttachments,
    clearThreadGoal,
    closeThread,
    collapsedProjectMachineKeys,
    compactThread,
    commandPaletteByScope,
    commandPaletteLoadingScopes,
    composerMenuOpen,
    composerMode,
    composerTextareaRef,
    confirmProjectPicker,
    connectionMode,
    connectSshHost,
    copyContextSelection,
    copyRegisteredCommand,
    createSessionThread,
    createTask,
    deleteProject,
    deleteTask,
    deletingProjectId,
    effectiveModelSelection,
    effectiveReasoningSelection,
    focusTaskDraftProject,
    forkMessage,
    goalDialog,
    handleComposerKeyDown,
    imageFileInputRef,
    insertThreadPathText,
    inspectContextMessage,
    inspectMessage,
    latestTurnStatusScope,
    loadCommandPalette,
    loadProjectPickerDirectory,
    localMachines,
    messageContextMenu,
    messageDisplayMode,
    messageRenderModes,
    messagesRef,
    messagesShouldFollowRef,
    modelOptions,
    offlineProjectsCollapsed,
    onlineMachines,
    openingProjectKey,
    openMessageContextMenu,
    showProjectPicker,
    openSelectedProjectThreadPicker,
    pasteThreadImages,
    patchTask,
    projectGroups,
    projectList,
    projectActionError,
    projectPicker,
    registeredCommand,
    registeredCommandCopied,
    registeredMachines,
    removeThreadImage,
    removeThreadTextAttachment,
    removeSshHost,
    renderComposerThreadControls,
    resetComposerHistory,
    respondToApproval,
    respondToUserInput,
    reviewThread,
    resizeComposerTextarea,
    rollbackMessage,
    runTaskNow,
    saveGoalDialog,
    selectProject,
    selectedProject,
    send,
    sessionList,
    threadControlsMenuOpen,
    setComposerMenuOpen,
    setComposerMode,
    setConnectionMode,
    setExpandedStatusKeys,
    setExpandedToolBatchKeys,
    setGoalDialog,
    setExpandedStatusTurns,
    setImagePreview,
    setInspectMessage,
    setMessageContextMenu,
    setMessageDisplayMode,
    setActiveThreadApprovalPolicyDraft,
    setActiveThreadSandboxPolicyDraft,
    setOfflineProjectsCollapsed,
    setProjectPicker,
    setAuthTokenDraft,
    setThreadControlsMenuOpen,
    setThreadModelDialogOpen,
    setSidebarCollapsed,
    setSshHostDraft,
    setTaskDraft,
    setTaskFormOpen,
    setThreadPicker,
    showComposerSendButton,
    statusPanelAvailable,
    statusPanelExpanded,
    sidebarCollapsed,
    sshConfigHostOptions,
    sshConfigHosts,
    sshConnectingHost,
    sshConnections,
    sshError,
    sshHostBusy,
    sshHostDraft,
    sshHosts,
    statusScopeKey,
    turnStatusItems,
    stopTurn,
    submitAuthToken,
    submitProjectPickerPath,
    switchSessionThread,
    taskBusyId,
    taskDraft,
    taskError,
    taskFormOpen,
    tasks,
    threadOrderBySession,
    threadPicker,
    toggleProjectMachineGroup,
    updateMessageRenderMode,
    updateThreadInput,
    updateTaskDraftMachine,
    updateTaskDraftProject,
    updateThreadGoal,
    openThreadEmptyMessage,
    openThreadTabs
  } = viewModel;
  const canAddThreadForProject = Boolean(activeRuntimeSession?.online || selectedProject?.machineOnline);
  const activeThreadKey = activeThread && activeThreadIsOpen ? activeThread.threadId : "";
  const activeAttachmentCount = activeThread
    ? activeThread.textAttachments.length + activeThread.imageAttachments.length
    : 0;
  const showThreadTabs = Boolean(activeThreadKey || canAddThreadForProject);
  const executionStatus = activeThreadExecutionMeta?.status ?? "idle";
  const executionLabel = activeThreadExecutionMeta?.label ?? "Idle";
  const executionText = activeThreadExecutionMeta?.text ?? executionLabel;
  const showTurnLoadingMessage = executionStatus === "running";
  const messagesVirtuosoContext = React.useMemo(
    () => ({ turnLoadingDuration: activeRunningExecutionDuration }),
    [activeRunningExecutionDuration]
  );
  const messagesVirtuosoComponents = React.useMemo<Components<(typeof activeViews)[number], MessagesVirtuosoContext>>(() => ({
    EmptyPlaceholder: EmptyMessages,
    Footer: showTurnLoadingMessage ? MessagesTurnLoadingFooter : undefined
  }), [showTurnLoadingMessage]);
  const messagesUserScrollIntentRef = React.useRef(false);
  const messagesUserScrollIntentTimerRef = React.useRef<number | null>(null);
  const messagesStickScrollFrameRef = React.useRef<number | null>(null);
  const composerDropCaretRef = React.useRef<Record<string, number>>({});
  const commandPaletteItemRefs = React.useRef<Record<number, HTMLButtonElement | null>>({});
  const [commandPaletteActiveIndex, setCommandPaletteActiveIndex] = React.useState(0);
  const [commandPaletteKeyboardNavigation, setCommandPaletteKeyboardNavigation] = React.useState(false);
  const [dismissedCommandPaletteKey, setDismissedCommandPaletteKey] = React.useState("");
  const [composerCaret, setComposerCaret] = React.useState<{ threadId: string; index: number } | null>(null);
  const activeComposerCaretIndex = activeThread && composerCaret?.threadId === activeThread.threadId
    ? Math.min(composerCaret.index, activeThread.input.length)
    : activeThread?.input.length ?? 0;
  const commandPaletteTrigger = React.useMemo(
    () => commandPaletteTriggerForInput(activeThread?.input ?? "", activeComposerCaretIndex),
    [activeComposerCaretIndex, activeThread?.input]
  );
  const commandPaletteScopeKey = activeThread?.session.sessionId
    ? commandPaletteCacheKey(activeThread.session.sessionId, activeThread.workingDirectory)
    : "";
  const commandPalette = commandPaletteScopeKey ? commandPaletteByScope[commandPaletteScopeKey] : undefined;
  const commandPaletteLoading = commandPaletteScopeKey ? Boolean(commandPaletteLoadingScopes[commandPaletteScopeKey]) : false;
  const commandPaletteEntries = React.useMemo(
    () => commandPaletteEntriesForTrigger(commandPalette?.entries ?? [], commandPaletteTrigger),
    [commandPalette?.entries, commandPaletteTrigger]
  );
  const commandPaletteRows = React.useMemo(
    () => commandPaletteRowsForTrigger(commandPaletteEntries, commandPaletteTrigger),
    [commandPaletteEntries, commandPaletteTrigger]
  );
  const commandPaletteDismissKey = activeThread && commandPaletteTrigger
    ? `${activeThread.threadId}:${commandPaletteTrigger.key}`
    : "";
  const commandPaletteOpen = Boolean(
    commandPaletteTrigger
    && commandPaletteDismissKey !== dismissedCommandPaletteKey
    && (commandPaletteEntries.length || commandPaletteLoading)
  );
  const activeCommandPaletteEntry = commandPaletteOpen
    ? commandPaletteEntries[Math.min(commandPaletteActiveIndex, Math.max(commandPaletteEntries.length - 1, 0))]
    : undefined;
  React.useEffect(() => {
    if (!activeThread?.session.sessionId) return;
    if (commandPalette || commandPaletteLoading) return;
    void loadCommandPalette(activeThread.session.sessionId, activeThread.workingDirectory);
  }, [
    activeThread?.session.sessionId,
    activeThread?.workingDirectory,
    commandPalette,
    commandPaletteLoading,
    loadCommandPalette
  ]);
  React.useEffect(() => {
    setCommandPaletteActiveIndex(0);
    setCommandPaletteKeyboardNavigation(false);
  }, [commandPaletteTrigger?.key, activeThread?.threadId]);
  React.useEffect(() => {
    if (!commandPaletteTrigger) setDismissedCommandPaletteKey("");
  }, [commandPaletteTrigger]);
  React.useEffect(() => {
    setCommandPaletteActiveIndex((current) =>
      commandPaletteEntries.length ? Math.min(current, commandPaletteEntries.length - 1) : 0
    );
  }, [commandPaletteEntries.length]);
  React.useEffect(() => {
    if (!commandPaletteOpen) return;
    if (!commandPaletteKeyboardNavigation) return;
    commandPaletteItemRefs.current[commandPaletteActiveIndex]?.scrollIntoView({ block: "nearest" });
  }, [commandPaletteActiveIndex, commandPaletteKeyboardNavigation, commandPaletteOpen]);
  const rememberComposerCaret = React.useCallback((threadId: string, textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    setComposerCaret({ threadId, index: textarea.selectionStart });
  }, []);
  const replaceCommandPaletteTrigger = React.useCallback((replacement: string) => {
    if (!activeThread || !commandPaletteTrigger) return;
    const nextInput = [
      activeThread.input.slice(0, commandPaletteTrigger.start),
      replacement,
      activeThread.input.slice(commandPaletteTrigger.end)
    ].join("");
    const cursor = commandPaletteTrigger.start + replacement.length;
    resetComposerHistory(activeThread.threadId);
    updateThreadInput(activeThread.threadId, nextInput);
    setComposerCaret({ threadId: activeThread.threadId, index: cursor });
    window.requestAnimationFrame(() => {
      const textarea = composerTextareaRef.current;
      if (!textarea) return;
      resizeComposerTextarea(textarea);
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
  }, [
    activeThread,
    commandPaletteTrigger,
    composerTextareaRef,
    setComposerCaret,
    resetComposerHistory,
    resizeComposerTextarea,
    updateThreadInput
  ]);
  const selectCommandPaletteEntry = React.useCallback((entry: CommandPaletteEntry | undefined) => {
    if (!entry || !activeThread || !commandPaletteTrigger) return;
    const action = entry.action ?? "insert";
    if (activeThread.running && (action === "review_changes" || action === "compact_thread")) return;
    if (action === "open_model") {
      setDismissedCommandPaletteKey(commandPaletteDismissKey);
      replaceCommandPaletteTrigger("");
      setThreadModelDialogOpen(true);
      return;
    }
    if (action === "set_plan_mode") {
      setDismissedCommandPaletteKey(commandPaletteDismissKey);
      replaceCommandPaletteTrigger("");
      setComposerMode("plan");
      return;
    }
    if (action === "set_goal_mode") {
      setDismissedCommandPaletteKey(commandPaletteDismissKey);
      replaceCommandPaletteTrigger("");
      setComposerMode("goal");
      return;
    }
    if (action === "review_changes") {
      setDismissedCommandPaletteKey(commandPaletteDismissKey);
      replaceCommandPaletteTrigger("");
      if (!activeThread.running) void reviewThread(activeThread.threadId);
      return;
    }
    if (action === "compact_thread") {
      setDismissedCommandPaletteKey(commandPaletteDismissKey);
      replaceCommandPaletteTrigger("");
      if (!activeThread.running) void compactThread(activeThread.threadId);
      return;
    }
    const replacement = commandPaletteReplacementText(entry, commandPaletteTrigger);
    setDismissedCommandPaletteKey(`${activeThread.threadId}:${replacement}`);
    replaceCommandPaletteTrigger(replacement);
  }, [
    activeThread,
    commandPaletteDismissKey,
    commandPaletteTrigger,
    compactThread,
    replaceCommandPaletteTrigger,
    reviewThread,
    setComposerMode,
    setThreadModelDialogOpen
  ]);
  const handleComposerTextareaKeyDown = React.useCallback((
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    threadId: string,
    history: string[]
  ) => {
    if (commandPaletteOpen && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCommandPaletteKeyboardNavigation(true);
        setCommandPaletteActiveIndex((current) =>
          commandPaletteEntries.length ? (current + 1) % commandPaletteEntries.length : 0
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCommandPaletteKeyboardNavigation(true);
        setCommandPaletteActiveIndex((current) =>
          commandPaletteEntries.length ? (current - 1 + commandPaletteEntries.length) % commandPaletteEntries.length : 0
        );
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && activeCommandPaletteEntry) {
        event.preventDefault();
        selectCommandPaletteEntry(activeCommandPaletteEntry);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (commandPaletteDismissKey) setDismissedCommandPaletteKey(commandPaletteDismissKey);
        return;
      }
    }
    handleComposerKeyDown(event, threadId, history);
  }, [
    activeCommandPaletteEntry,
    commandPaletteDismissKey,
    commandPaletteEntries.length,
    commandPaletteOpen,
    handleComposerKeyDown,
    selectCommandPaletteEntry
  ]);
  const openGoalRunPolicyDialog = () => {
    if (!activeThread) return;
    const goalRunPolicy = activeThread.goalRunPolicy?.type === "consumeUntilWeeklyRemainingAtOrBelow"
      ? activeThread.goalRunPolicy
      : null;
    setGoalDialog({
      threadId: activeThread.threadId,
      objective: activeGoal?.objective ?? activeThread.input,
      targetRemainingPercent: goalRunPolicy
        ? String(goalRunPolicy.targetRemainingPercent)
        : "",
      saving: false,
      error: ""
    });
  };
  React.useEffect(() => () => {
    if (messagesUserScrollIntentTimerRef.current !== null) {
      window.clearTimeout(messagesUserScrollIntentTimerRef.current);
      messagesUserScrollIntentTimerRef.current = null;
    }
    if (messagesStickScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(messagesStickScrollFrameRef.current);
      messagesStickScrollFrameRef.current = null;
    }
  }, []);
  React.useEffect(() => {
    messagesUserScrollIntentRef.current = false;
    if (messagesUserScrollIntentTimerRef.current !== null) {
      window.clearTimeout(messagesUserScrollIntentTimerRef.current);
      messagesUserScrollIntentTimerRef.current = null;
    }
    if (messagesStickScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(messagesStickScrollFrameRef.current);
      messagesStickScrollFrameRef.current = null;
    }
  }, [activeThread?.threadId]);
  const scrollMessagesToBottom = React.useCallback(() => {
    if (messagesStickScrollFrameRef.current !== null) return;
    messagesStickScrollFrameRef.current = window.requestAnimationFrame(() => {
      messagesStickScrollFrameRef.current = null;
      if (!messagesShouldFollowRef.current) return;
      messagesRef.current?.scrollTo({
        top: Number.MAX_SAFE_INTEGER,
        behavior: "auto"
      });
    });
  }, [messagesRef, messagesShouldFollowRef]);
  React.useEffect(() => {
    if (showTurnLoadingMessage && messagesShouldFollowRef.current) scrollMessagesToBottom();
  }, [messagesShouldFollowRef, scrollMessagesToBottom, showTurnLoadingMessage]);
  const updateMessagesFollowFromUserScroll = React.useCallback((scroller: HTMLElement) => {
    const distanceFromBottom = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    if (distanceFromBottom > messagesBottomThreshold) {
      messagesShouldFollowRef.current = false;
    } else {
      messagesShouldFollowRef.current = true;
    }
  }, [messagesShouldFollowRef]);
  const markMessagesUserScrollIntent = React.useCallback((scroller: HTMLElement, shouldLeaveBottom = true) => {
    messagesUserScrollIntentRef.current = true;
    if (shouldLeaveBottom) messagesShouldFollowRef.current = false;
    if (messagesUserScrollIntentTimerRef.current !== null) {
      window.clearTimeout(messagesUserScrollIntentTimerRef.current);
    }
    messagesUserScrollIntentTimerRef.current = window.setTimeout(() => {
      messagesUserScrollIntentRef.current = false;
      messagesUserScrollIntentTimerRef.current = null;
    }, messagesUserScrollIntentMs);
    window.requestAnimationFrame(() => updateMessagesFollowFromUserScroll(scroller));
  }, [messagesShouldFollowRef, updateMessagesFollowFromUserScroll]);
  const handleMessagesScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (!messagesUserScrollIntentRef.current) return;
    updateMessagesFollowFromUserScroll(event.currentTarget);
  }, [updateMessagesFollowFromUserScroll]);
  const handleMessagesWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    markMessagesUserScrollIntent(event.currentTarget, event.deltaY < 0);
  }, [markMessagesUserScrollIntent]);
  const handleMessagesTouchMove = React.useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    markMessagesUserScrollIntent(event.currentTarget);
  }, [markMessagesUserScrollIntent]);
  const handleMessagesPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.right - messagesScrollbarHitArea) return;
    markMessagesUserScrollIntent(event.currentTarget);
  }, [markMessagesUserScrollIntent]);
  const handleMessagesKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || !messagesScrollKeys.has(event.key)) return;
    markMessagesUserScrollIntent(event.currentTarget);
  }, [markMessagesUserScrollIntent]);
  if (authRequired) {
    return (
      <main className="authShell">
        <form className="authPanel" onSubmit={submitAuthToken}>
          <div className="authPanelHeader">
            <h1>Codex Hub</h1>
            <span>Access token required</span>
          </div>
          <label>
            <span>Token</span>
            <input
              type="password"
              value={authTokenDraft}
              onChange={(event) => setAuthTokenDraft(event.target.value)}
              autoFocus
              autoComplete="current-password"
            />
          </label>
          {authError ? <div className="authError">{authError}</div> : null}
          <button type="submit">Unlock</button>
        </form>
      </main>
    );
  }
  const sidebarToggle = (
    <button
      type="button"
      className="sidebarPanelToggle"
      onClick={() => setSidebarCollapsed((current) => !current)}
      aria-label={sidebarCollapsed ? "Show menu" : "Hide menu"}
      title={sidebarCollapsed ? "Show menu" : "Hide menu"}
    >
      {sidebarCollapsed ? "Menu" : "Hide"}
    </button>
  );
  return (
    <main className={`app ${sidebarCollapsed ? "sidebarCollapsed" : ""}`}>
      {!sidebarCollapsed ? (
        <button
          type="button"
          className="sidebarScrim"
          onClick={() => setSidebarCollapsed(true)}
          aria-label="Hide menu"
        />
      ) : null}
      <AppSidebar viewModel={viewModel} />

      <section className="workspace">
        {showThreadTabs ? (
          <Tabs
            className="openThreadTabs"
            tabBarExtraContent={{
              left: sidebarToggle,
              right: (
                <div className="threadTabActions">
                  <label className="switchControl">
                    <span>View</span>
                    <button
                      type="button"
                      className={`switchButton ${messageDisplayMode === "compact" ? "active" : ""}`}
                      aria-pressed={messageDisplayMode === "compact"}
                      onClick={() => setMessageDisplayMode((current) => current === "compact" ? "detailed" : "compact")}
                    >
                      {messageDisplayMode === "compact" ? "Simple" : "Detailed"}
                    </button>
                  </label>
                </div>
              )
            }}
            size="small"
            type="editable-card"
            activeKey={activeThreadKey || undefined}
            items={openThreadTabs.map((item) => ({
              ...item,
              closable: true,
              children: activeThread && item.key === activeThreadKey ? (
                <div className="threadWorkspacePane">
                  <Virtuoso
                    key={activeThread.threadId}
                    ref={messagesRef}
                    className="messages"
                    data={activeViews}
                    onKeyDown={handleMessagesKeyDown}
                    onPointerDown={handleMessagesPointerDown}
                    onScroll={handleMessagesScroll}
                    onTouchMove={handleMessagesTouchMove}
                    onWheel={handleMessagesWheel}
                    atBottomStateChange={(atBottom) => {
                      if (atBottom) {
                        messagesShouldFollowRef.current = true;
                      } else if (messagesShouldFollowRef.current && !messagesUserScrollIntentRef.current) {
                        scrollMessagesToBottom();
                      }
                    }}
                    atBottomThreshold={messagesBottomThreshold}
                    followOutput={(isAtBottom) => {
                      if (isAtBottom) {
                        messagesShouldFollowRef.current = true;
                      }
                      return messagesShouldFollowRef.current ? "auto" : false;
                    }}
                    initialTopMostItemIndex={Math.max(activeViews.length - 1, 0)}
                    increaseViewportBy={{ top: 360, bottom: 720 }}
                    computeItemKey={(_, message) => message.id}
                    components={messagesVirtuosoComponents}
                    context={messagesVirtuosoContext}
                    itemContent={(_, message) => {
                      const markdownEnabled = canRenderMarkdown(message);
                      const renderMode = markdownEnabled ? messageRenderModes[message.id] ?? "markdown" : "raw";
                      const toolBatchKey = message.toolBatch?.key;
                      const inspectable = messageDisplayMode === "compact" && message.role === "tool" && !toolBatchKey;
                      return (
                        <MessageCard
                          message={message}
                          showStatus={messageDisplayMode === "compact" || message.role !== "tool"}
                          showTimestamp={!(messageDisplayMode === "compact" && message.role === "tool")}
                          renderToolPreview={messageDisplayMode === "compact"}
                          renderMode={renderMode}
                          markdownEnabled={markdownEnabled}
                          threadWorkingDirectory={activeThread.workingDirectory}
                          onRenderModeChange={markdownEnabled ? (mode) => updateMessageRenderMode(message.id, mode) : undefined}
                          onContextMenu={(event) => openMessageContextMenu(event, activeThread.threadId, message, inspectable)}
                          onInspect={inspectable && message.role === "tool" ? () => setInspectMessage(message) : undefined}
                          onOpenImage={setImagePreview}
                          onToggleToolBatch={toolBatchKey ? () => {
                            setExpandedToolBatchKeys((current) => {
                              const keys = new Set(current[activeThread.threadId] ?? []);
                              if (message.toolBatch?.expanded) keys.delete(toolBatchKey);
                              else keys.add(toolBatchKey);
                              return {
                                ...current,
                                [activeThread.threadId]: [...keys]
                              };
                            });
                          } : undefined}
                          onApprovalDecision={(approvalId, decision) => void respondToApproval(activeThread.threadId, approvalId, decision)}
                          onUserInputResponse={(userInputId, answers) => void respondToUserInput(activeThread.threadId, userInputId, answers)}
                          onFork={canForkAtMessage(activeThread.threadId, message) ? () => void forkMessage(activeThread.threadId, message.record.id) : undefined}
                          onRollback={canForkAtMessage(activeThread.threadId, message) ? () => void rollbackMessage(activeThread.threadId, message.record.id) : undefined}
                        />
                      );
                    }}
                  />
                  <form
                    className="composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (activeCanSend) void send(activeThread.threadId);
                    }}
                  >
                    <div className="composerLayout">
                      {statusPanelAvailable && activeThreadExecutionMeta ? (
                        <ActivityStatusBar
                          statuses={turnStatusItems}
                          executionMeta={activeThreadExecutionMeta}
                          expanded={statusPanelExpanded}
                          expandedKeys={activeExpandedStatusKeys}
                          onToggleExpanded={() => {
                            if (!activeThread?.threadId || !latestTurnStatusScope.key) return;
                            setExpandedStatusTurns((current) => {
                              if (current[activeThread.threadId] === latestTurnStatusScope.key) {
                                const next = { ...current };
                                delete next[activeThread.threadId];
                                return next;
                              }
                              return {
                                ...current,
                                [activeThread.threadId]: latestTurnStatusScope.key
                              };
                            });
                          }}
                          onToggle={(key) => {
                            if (!statusScopeKey) return;
                            setExpandedStatusKeys((current) => {
                              const keys = new Set(current[statusScopeKey] ?? []);
                              if (keys.has(key)) keys.delete(key);
                              else keys.add(key);
                              return { ...current, [statusScopeKey]: [...keys] };
                            });
                          }}
                        />
                      ) : null}
                      <div className="composerSurface">
                        {activeGoal && activeThread ? (
                          <div
                            className={`goalStrip ${goalStatusClass(activeGoal.status)}`}
                            title={`${goalStatusLabel(activeGoal.status)} · ${activeGoal.objective}`}
                            aria-label={`${goalStatusLabel(activeGoal.status)}: ${activeGoal.objective}`}
                          >
                            <div className="goalStripMain">
                              <Target className="goalStripIcon" aria-hidden="true" />
                              <span className="goalStripLabel">{goalStatusLabel(activeGoal.status)}</span>
                              <span className="goalStripObjective" title={activeGoal.objective}>{activeGoal.objective}</span>
                              {activeThread.goalRunPolicy?.type === "consumeUntilWeeklyRemainingAtOrBelow" ? (
                                <span className="goalStripPolicy">
                                  {weeklyGoalPolicyLabel(activeThread.goalRunPolicy.targetRemainingPercent)}
                                </span>
                              ) : null}
                              {activeGoal.updatedAt ? <span className="goalStripAge">{formatGoalAge(activeGoal.updatedAt)}</span> : null}
                            </div>
                            <div className="goalStripActions">
                              <button
                                type="button"
                                className="goalIconButton"
                                title="编辑目标"
                                aria-label="编辑目标"
                                onClick={() => {
                                  const goalRunPolicy = activeThread.goalRunPolicy?.type === "consumeUntilWeeklyRemainingAtOrBelow"
                                    ? activeThread.goalRunPolicy
                                    : null;
                                  setGoalDialog({
                                    threadId: activeThread.threadId,
                                    objective: activeGoal.objective,
                                    targetRemainingPercent: goalRunPolicy
                                      ? String(goalRunPolicy.targetRemainingPercent)
                                      : "",
                                    saving: false,
                                    error: ""
                                  });
                                }}
                              >
                                ✎
                              </button>
                              {activeGoal.status !== "complete" ? (
                                <button
                                  type="button"
                                  className="goalIconButton"
                                  title={activeGoal.status === "paused" ? "继续目标" : "暂停目标"}
                                  aria-label={activeGoal.status === "paused" ? "继续目标" : "暂停目标"}
                                  onClick={() => void updateThreadGoal(activeThread.threadId, {
                                    status: activeGoal.status === "paused" ? "active" : "paused"
                                  })}
                                >
                                  {activeGoal.status === "paused" ? "▶" : "Ⅱ"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="goalIconButton danger"
                                title="清除目标"
                                aria-label="清除目标"
                                onClick={() => void clearThreadGoal(activeThread.threadId)}
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        ) : null}
                        <div className="composerInput">
                          {activeAttachmentCount ? (
                            <div
                              className="composerAttachmentStrip"
                              aria-label={`${attachmentCountLabel(activeAttachmentCount)} selected`}
                            >
                              <div className="composerAttachmentCount" title={`${attachmentCountLabel(activeAttachmentCount)} selected`}>
                                <Paperclip aria-hidden="true" />
                                <span>{activeAttachmentCount}</span>
                              </div>
                              <div className="composerAttachmentScroller">
                                {activeThread.textAttachments.map((item) => (
                                  <div className="composerAttachmentChip text" key={item.id} title={textAttachmentTooltip(item.text)}>
                                    <span className="composerAttachmentIcon" aria-hidden="true">
                                      <FileText />
                                    </span>
                                    <span className="composerAttachmentText">
                                      <span className="composerAttachmentName">{textAttachmentTitle(item.text)}</span>
                                      <span className="composerAttachmentPreview">{textAttachmentPreview(item.text)}</span>
                                    </span>
                                    <button
                                      type="button"
                                      className="composerAttachmentRemoveButton"
                                      onClick={() => removeThreadTextAttachment(activeThread.threadId, item.id)}
                                      aria-label={`Remove ${textAttachmentTitle(item.text)}`}
                                      title="Remove attachment"
                                    >
                                      <X aria-hidden="true" />
                                    </button>
                                  </div>
                                ))}
                                {activeThread.imageAttachments.map((image) => (
                                  <div className="composerAttachmentChip image" key={image.id} title={image.name || "Image attachment"}>
                                    {/* Local composer thumbnails use the same preview dialog as rendered transcript images. */}
                                    <button
                                      type="button"
                                      className="composerAttachmentThumb composerAttachmentThumbButton"
                                      onClick={() => setImagePreview({ url: image.previewUrl, title: image.name || "Image attachment" })}
                                      aria-label={`Preview ${image.name || "image attachment"}`}
                                      title="Preview image"
                                    >
                                      <img src={image.previewUrl} alt="" />
                                    </button>
                                    <span className="composerAttachmentText">
                                      <span className="composerAttachmentName">{image.name || "Image"}</span>
                                      <span className="composerAttachmentPreview">
                                        <ImageIcon aria-hidden="true" />
                                        Image
                                      </span>
                                    </span>
                                    <button
                                      type="button"
                                      className="composerAttachmentRemoveButton"
                                      onClick={() => removeThreadImage(activeThread.threadId, image.id)}
                                      aria-label={`Remove ${image.name || "image attachment"}`}
                                      title="Remove attachment"
                                    >
                                      <X aria-hidden="true" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                              {activeAttachmentCount > 1 ? (
                                <button
                                  type="button"
                                  className="composerAttachmentClearButton"
                                  onClick={() => clearThreadAttachments(activeThread.threadId)}
                                >
                                  Clear all
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                          {commandPaletteOpen ? (
                            <div
                              className={`commandPalette${commandPaletteKeyboardNavigation ? " keyboardNavigation" : ""}`}
                              role="listbox"
                              aria-label={commandPaletteTriggerAriaLabel(commandPaletteTrigger?.marker)}
                              onMouseDown={(event) => event.preventDefault()}
                            >
                              <div className="commandPaletteHeader">
                                <span>{commandPaletteTriggerLabel(commandPaletteTrigger?.marker)}</span>
                                {commandPaletteLoading ? <span>Loading</span> : null}
                              </div>
                              {commandPaletteRows.map((row) => {
                                if (row.type === "group") {
                                  return (
                                    <div className="commandPaletteGroup" key={`group:${row.group}`}>
                                      {row.label}
                                    </div>
                                  );
                                }
                                const { entry, index } = row;
                                const EntryIcon = commandPaletteEntryIcon(entry);
                                const blocked = activeThread.running && (
                                  entry.action === "review_changes"
                                  || entry.action === "compact_thread"
                                );
                                return (
                                  <button
                                    key={entry.id}
                                    ref={(node) => {
                                      commandPaletteItemRefs.current[index] = node;
                                    }}
                                    type="button"
                                    role="option"
                                    aria-selected={index === commandPaletteActiveIndex}
                                    aria-disabled={blocked}
                                    className={`commandPaletteItem${index === commandPaletteActiveIndex ? " active" : ""}${blocked ? " disabled" : ""}`}
                                    onMouseMove={() => {
                                      setCommandPaletteKeyboardNavigation(false);
                                      setCommandPaletteActiveIndex(index);
                                    }}
                                    onClick={() => selectCommandPaletteEntry(entry)}
                                    title={blocked ? "Stop the running turn before using this command" : entry.description}
                                  >
                                    <span className={`commandPaletteIcon ${entry.kind}`} aria-hidden="true">
                                      <EntryIcon />
                                    </span>
                                    <span className="commandPaletteText">
                                      <span className="commandPaletteTitle">
                                        {commandPaletteEntryLabel(entry)}
                                      </span>
                                      <span className="commandPaletteDescription">
                                        {commandPaletteEntryDescription(entry)}
                                      </span>
                                    </span>
                                    {entry.detail ? <span className="commandPaletteDetail">{entry.detail}</span> : null}
                                  </button>
                                );
                              })}
                              {commandPaletteLoading && !commandPaletteEntries.length ? (
                                <div className="commandPaletteEmpty">Loading app-server commands</div>
                              ) : null}
                            </div>
                          ) : null}
                          <textarea
                            ref={composerTextareaRef}
                            value={activeThread.input}
                            onChange={(event) => {
                              resetComposerHistory(activeThread.threadId);
                              rememberComposerCaret(activeThread.threadId, event.currentTarget);
                              resizeComposerTextarea(event.currentTarget);
                              updateThreadInput(activeThread.threadId, event.target.value);
                            }}
                            onSelect={(event) => rememberComposerCaret(activeThread.threadId, event.currentTarget)}
                            onKeyUp={(event) => rememberComposerCaret(activeThread.threadId, event.currentTarget)}
                            onMouseUp={(event) => rememberComposerCaret(activeThread.threadId, event.currentTarget)}
                            onPaste={(event) => {
                              if (!pasteThreadImages(activeThread.threadId, event.clipboardData)) return;
                              event.preventDefault();
                            }}
                            onDragOver={(event) => {
                              if (!isVscodeSurface || !dataTransferHasPathPayload(event.dataTransfer)) return;
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "copy";
                              const caretIndex = textareaCaretIndexFromPoint(
                                event.currentTarget,
                                event.clientX,
                                event.clientY
                              );
                              composerDropCaretRef.current[activeThread.threadId] = caretIndex;
                              event.currentTarget.focus();
                              event.currentTarget.setSelectionRange(caretIndex, caretIndex);
                            }}
                            onDrop={(event) => {
                              if (!isVscodeSurface) return;
                              const paths = droppedPathsFromDataTransfer(event.dataTransfer);
                              if (!paths.length) return;
                              event.preventDefault();
                              const caretIndex = composerDropCaretRef.current[activeThread.threadId]
                                ?? textareaCaretIndexFromPoint(event.currentTarget, event.clientX, event.clientY);
                              delete composerDropCaretRef.current[activeThread.threadId];
                              insertThreadPathText(activeThread.threadId, paths, event.currentTarget, caretIndex);
                            }}
                            onKeyDown={(event) => handleComposerTextareaKeyDown(event, activeThread.threadId, activeUserMessageHistory)}
                            placeholder="例如：检查这个 repo 的结构并给我下一步建议"
                            rows={2}
                          />
                        </div>
                        <div className="composerActions">
                          <div className="composerLeftActions">
                            <div className="composerMenuHost" onClick={(event) => event.stopPropagation()}>
                              <button
                                type="button"
                                className="composerIconButton"
                                aria-label="Open composer menu"
                                aria-expanded={composerMenuOpen}
                                onClick={() => setComposerMenuOpen((open) => !open)}
                              >
                                +
                              </button>
                              {composerMenuOpen ? (
                                <div className="composerMenu" role="menu">
                                  <button
                                    type="button"
                                    className="composerMenuItem"
                                    role="menuitem"
                                    onClick={() => {
                                      setComposerMenuOpen(false);
                                      imageFileInputRef.current?.click();
                                    }}
                                  >
                                    <span className="composerMenuIcon" aria-hidden="true">[]</span>
                                    <span>添加照片和文件</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="composerMenuItem"
                                    role="menuitem"
                                    disabled={activeThread.running}
                                    title={activeThread.running ? "Stop the running turn before starting a review" : "Review uncommitted changes in this thread"}
                                    onClick={() => {
                                      setComposerMenuOpen(false);
                                      void reviewThread(activeThread.threadId);
                                    }}
                                  >
                                    <span className="composerMenuIcon" aria-hidden="true">R</span>
                                    <span>Review changes</span>
                                  </button>
                                  <div className="composerMenuGroup" role="group" aria-label="Approval policy">
                                    <div className="composerMenuGroupLabel">Approval policy</div>
                                    <div className="composerMenuChoiceGrid">
                                      {approvalPolicyOptions.map((option) => (
                                        <button
                                          key={option.value}
                                          type="button"
                                          className={`composerMenuChoice${activeThreadApprovalPolicySelection === option.value ? " active" : ""}`}
                                          role="menuitemradio"
                                          aria-checked={activeThreadApprovalPolicySelection === option.value}
                                          onClick={() => setActiveThreadApprovalPolicyDraft(option.value)}
                                        >
                                          {option.label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                  <div className="composerMenuGroup" role="group" aria-label="Sandbox policy">
                                    <div className="composerMenuGroupLabel">Sandbox policy</div>
                                    <div className="composerMenuChoiceGrid">
                                      {sandboxPolicyOptions.map((option) => (
                                        <button
                                          key={option.value}
                                          type="button"
                                          className={`composerMenuChoice${activeThreadSandboxPolicySelection === option.value ? " active" : ""}`}
                                          role="menuitemradio"
                                          aria-checked={activeThreadSandboxPolicySelection === option.value}
                                          onClick={() => setActiveThreadSandboxPolicyDraft(option.value)}
                                        >
                                          {option.label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                            <div className="composerModeSegmented" role="radiogroup" aria-label="Composer mode">
                              {composerModeOptions.map((option) => {
                                const ModeIcon = composerModeIconByValue[option.value];
                                return (
                                  <button
                                    key={option.value}
                                    type="button"
                                    className={`composerModeOption${composerMode === option.value ? " active" : ""}`}
                                    role="radio"
                                    aria-checked={composerMode === option.value}
                                    aria-label={option.label}
                                    title={option.label}
                                    onClick={() => setComposerMode(option.value)}
                                  >
                                    <ModeIcon className="composerModeIcon" aria-hidden="true" />
                                  </button>
                                );
                              })}
                            </div>
                            <button
                              type="button"
                              className="composerIconButton composerGoalRunPolicyButton"
                              aria-label="消耗到 weekly 剩余"
                              title="消耗到 weekly 剩余"
                              disabled={!activeThread}
                              onClick={openGoalRunPolicyDialog}
                            >
                              <Gauge aria-hidden="true" />
                            </button>
                          </div>
                          <div className="composerRightActions">
                            {renderComposerThreadControls("inline")}
                            <div className="composerSessionMenuHost" onClick={(event) => event.stopPropagation()}>
                              <button
                                type="button"
                                className="composerMoreButton"
                                aria-label="Show thread usage and model"
                                aria-expanded={threadControlsMenuOpen}
                                onClick={() => setThreadControlsMenuOpen((open) => !open)}
                              >
                                ...
                              </button>
                              {threadControlsMenuOpen ? (
                                <div className="composerSessionPopover">
                                  {renderComposerThreadControls("popover")}
                                </div>
                              ) : null}
                            </div>
                            <div
                              className={`composerActionButtons status-${executionStatus}`}
                              title={executionText}
                              aria-label={`Thread status: ${executionLabel}`}
                            >
                              {showComposerSendButton ? (
                                <button
                                  type="submit"
                                  className="composerSendButton composerActionButton"
                                  disabled={!activeCanSubmit}
                                  aria-label="Send message"
                                  title={`Send message · ${executionText}`}
                                >
                                  ↑
                                </button>
                              ) : null}
                              {activeThread.running ? (
                                <button
                                  type="button"
                                  className="composerStopButton composerActionButton"
                                  disabled={!activeCanStop}
                                  aria-label="Stop current turn"
                                  title={`Stop current turn · ${executionText}`}
                                  onClick={() => void stopTurn(activeThread.threadId)}
                                >
                                  ■
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                        <input
                          ref={imageFileInputRef}
                          className="imageUploadInput"
                          type="file"
                          accept="image/*,.css,.csv,.html,.js,.json,.jsx,.log,.md,.py,.sh,.sql,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml"
                          multiple
                          onChange={(event) => {
                            void addThreadFiles(activeThread.threadId, event.currentTarget.files);
                            event.currentTarget.value = "";
                          }}
                        />
                      </div>
                    </div>
                  </form>
                </div>
              ) : null
            }))}
            onChange={(threadId) => void switchSessionThread(threadId)}
            onEdit={(targetKey, action) => {
              if (action === "add") {
                if (canAddThreadForProject) void openSelectedProjectThreadPicker();
                return;
              }
              if (action === "remove" && typeof targetKey === "string") {
                void closeThread(targetKey);
              }
            }}
          />
        ) : (
          <div className="empty">
            <div className="emptySidebarToggle">{sidebarToggle}</div>
            <span>{openThreadEmptyMessage}</span>
          </div>
        )}
      </section>

      <AppDialogs viewModel={viewModel} />

    </main>
  );
};
