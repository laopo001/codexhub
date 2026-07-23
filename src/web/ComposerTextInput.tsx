import React from "react";
import { Command as CommandIcon, Package, Sparkles } from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { isVscodeSurface } from "./appConfig.js";
import {
  commandPaletteCacheKey,
  dataTransferHasPathPayload,
  droppedPathsFromDataTransfer,
  textareaCaretIndexFromPoint,
  type ComposerDraftStore
} from "./appHelpers.js";
import type { CommandPalette, CommandPaletteEntry, OpenThreadState } from "./types.js";
import { petCommandPaletteEntries } from "./pets/petCommands.js";

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

type ComposerTextInputProps = {
  activeUserMessageHistory: string[];
  commandPaletteByScope: Record<string, CommandPalette>;
  commandPaletteLoadingScopes: Record<string, boolean>;
  compactThread: (threadId: string) => void | Promise<void>;
  composerDraftStore: ComposerDraftStore;
  composerTextareaRef: React.RefObject<HTMLTextAreaElement | null>;
  handleComposerKeyDown: (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    threadId: string,
    history: string[],
    canSend: boolean
  ) => void;
  insertThreadPathText: (
    threadId: string,
    paths: string[],
    textarea: HTMLTextAreaElement | null,
    caretIndex?: number | null
  ) => void;
  loadCommandPalette: (machineId: string, cwd: string) => void | Promise<void>;
  pasteThreadImages: (threadId: string, clipboardData: DataTransfer) => boolean;
  resetComposerHistory: (threadId: string) => void;
  resizeComposerTextarea: (textarea: HTMLTextAreaElement | null) => void;
  reviewThread: (threadId: string) => void | Promise<void>;
  setComposerMode: (mode: "chat" | "plan" | "goal") => void;
  setThreadModelDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  thread: OpenThreadState;
  updateThreadInput: (threadId: string, input: string) => void;
};

type ComposerSubmitButtonProps = {
  attachmentCount: number;
  composerDraftStore: ComposerDraftStore;
  runtimeReady: boolean;
  title: string;
  threadId: string;
};

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
  const candidates = trigger.marker === "/"
    ? [...entries, ...petCommandPaletteEntries].filter((entry, index, all) =>
      all.findIndex((candidate) => `${candidate.kind}:${candidate.name}` === `${entry.kind}:${entry.name}`) === index)
    : entries;
  return candidates
    .filter((entry) => entry.enabled)
    .filter((entry) => {
      if (trigger.marker === "@") {
        return entry.kind === "plugin" || (entry.kind === "skill" && !commandPaletteEntryIsPluginSkill(entry));
      }
      return true;
    })
    .filter((entry) => !query || commandPaletteSearchText(entry).includes(query))
    .sort((left, right) => {
      const groupRank = commandPaletteGroupRank(left) - commandPaletteGroupRank(right);
      if (groupRank) return groupRank;
      return commandPaletteEntryRank(left, query) - commandPaletteEntryRank(right, query);
    });
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

const commandPaletteTriggerLabel = (marker: CommandPaletteTrigger["marker"] | undefined) =>
  marker === "@" ? "技能、插件" : "命令、技能、插件";

const commandPaletteTriggerAriaLabel = (marker: CommandPaletteTrigger["marker"] | undefined) =>
  marker === "@" ? "Skills and plugins" : "Commands";

const commandPaletteReplacementText = (entry: CommandPaletteEntry, trigger: CommandPaletteTrigger) => {
  const replacement = entry.insertText || `${trigger.marker}${entry.name}`;
  if (entry.kind !== "skill" && entry.kind !== "plugin") return replacement;
  return /\s$/.test(replacement) ? replacement : `${replacement} `;
};

const commandPaletteEntryLabel = (entry: CommandPaletteEntry) => {
  if (entry.kind === "builtin") return `/${entry.name}`;
  const insertText = entry.insertText?.trim();
  if (insertText && /^[$@]/.test(insertText)) return insertText;
  return `@${entry.name}`;
};

const useComposerDraft = (store: ComposerDraftStore, threadId: string) => {
  const subscribe = React.useCallback(
    (listener: () => void) => store.subscribe(threadId, listener),
    [store, threadId]
  );
  const getSnapshot = React.useCallback(() => store.get(threadId), [store, threadId]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

const composerCanSend = (thread: OpenThreadState, input: string) => Boolean(
  thread.runtime.online
  && thread.runtime.runnable !== false
  && (input.trim() || thread.imageAttachments.length || thread.textAttachments.length)
);

export const ComposerTextInput = ({
  activeUserMessageHistory,
  commandPaletteByScope,
  commandPaletteLoadingScopes,
  compactThread,
  composerDraftStore,
  composerTextareaRef,
  handleComposerKeyDown,
  insertThreadPathText,
  loadCommandPalette,
  pasteThreadImages,
  resetComposerHistory,
  resizeComposerTextarea,
  reviewThread,
  setComposerMode,
  setThreadModelDialogOpen,
  thread,
  updateThreadInput
}: ComposerTextInputProps) => {
  const input = useComposerDraft(composerDraftStore, thread.threadId);
  const commandPaletteListRef = React.useRef<VirtuosoHandle | null>(null);
  const dropCaretRef = React.useRef<number | null>(null);
  const [commandPaletteActiveIndex, setCommandPaletteActiveIndex] = React.useState(0);
  const [commandPaletteKeyboardNavigation, setCommandPaletteKeyboardNavigation] = React.useState(false);
  const [dismissedCommandPaletteKey, setDismissedCommandPaletteKey] = React.useState("");
  const [caretIndex, setCaretIndex] = React.useState(input.length);

  React.useLayoutEffect(() => {
    resizeComposerTextarea(composerTextareaRef.current);
  }, [composerTextareaRef, input, resizeComposerTextarea]);

  const safeCaretIndex = Math.min(caretIndex, input.length);
  const commandPaletteTrigger = React.useMemo(
    () => commandPaletteTriggerForInput(input, safeCaretIndex),
    [input, safeCaretIndex]
  );
  const machineId = thread.runtime.machineId ?? "";
  const commandPaletteScopeKey = commandPaletteCacheKey(machineId, thread.workingDirectory);
  const commandPalette = commandPaletteByScope[commandPaletteScopeKey];
  const commandPaletteLoading = Boolean(commandPaletteLoadingScopes[commandPaletteScopeKey]);
  const commandPaletteEntries = React.useMemo(
    () => commandPaletteEntriesForTrigger(commandPalette?.entries ?? [], commandPaletteTrigger),
    [commandPalette?.entries, commandPaletteTrigger]
  );
  const commandPaletteRows = React.useMemo(
    () => commandPaletteRowsForTrigger(commandPaletteEntries, commandPaletteTrigger),
    [commandPaletteEntries, commandPaletteTrigger]
  );
  const commandPaletteListHeight = React.useMemo(
    () => Math.min(376, Math.max(36, commandPaletteRows.reduce(
      (height, row) => height + (row.type === "group" ? 26 : 46),
      0
    ))),
    [commandPaletteRows]
  );
  const commandPaletteDismissKey = commandPaletteTrigger
    ? `${thread.threadId}:${commandPaletteTrigger.key}`
    : "";
  const commandPaletteOpen = Boolean(
    commandPaletteTrigger
    && commandPaletteDismissKey !== dismissedCommandPaletteKey
    && (commandPaletteEntries.length || commandPaletteLoading)
  );
  const activeCommandPaletteEntry = commandPaletteOpen
    ? commandPaletteEntries[Math.min(commandPaletteActiveIndex, Math.max(commandPaletteEntries.length - 1, 0))]
    : undefined;
  const canSend = composerCanSend(thread, input);

  React.useEffect(() => {
    if (!machineId) return;
    if (commandPalette || commandPaletteLoading) return;
    void loadCommandPalette(machineId, thread.workingDirectory);
  }, [commandPalette, commandPaletteLoading, loadCommandPalette, machineId, thread.workingDirectory]);
  React.useEffect(() => {
    setCommandPaletteActiveIndex(0);
    setCommandPaletteKeyboardNavigation(false);
  }, [commandPaletteTrigger?.key, thread.threadId]);
  React.useEffect(() => {
    if (!commandPaletteTrigger) setDismissedCommandPaletteKey("");
  }, [commandPaletteTrigger]);
  React.useEffect(() => {
    setCommandPaletteActiveIndex((current) =>
      commandPaletteEntries.length ? Math.min(current, commandPaletteEntries.length - 1) : 0
    );
  }, [commandPaletteEntries.length]);
  React.useEffect(() => {
    if (!commandPaletteOpen || !commandPaletteKeyboardNavigation) return;
    const rowIndex = commandPaletteRows.findIndex((row) =>
      row.type === "entry" && row.index === commandPaletteActiveIndex
    );
    if (rowIndex >= 0) commandPaletteListRef.current?.scrollIntoView({ index: rowIndex });
  }, [commandPaletteActiveIndex, commandPaletteKeyboardNavigation, commandPaletteOpen, commandPaletteRows]);

  const rememberCaret = React.useCallback((textarea: HTMLTextAreaElement | null) => {
    if (textarea) setCaretIndex(textarea.selectionStart);
  }, []);
  const replaceCommandPaletteTrigger = React.useCallback((replacement: string) => {
    if (!commandPaletteTrigger) return;
    const nextInput = [
      input.slice(0, commandPaletteTrigger.start),
      replacement,
      input.slice(commandPaletteTrigger.end)
    ].join("");
    const cursor = commandPaletteTrigger.start + replacement.length;
    resetComposerHistory(thread.threadId);
    updateThreadInput(thread.threadId, nextInput);
    setCaretIndex(cursor);
    window.requestAnimationFrame(() => {
      const textarea = composerTextareaRef.current;
      if (!textarea) return;
      resizeComposerTextarea(textarea);
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
  }, [commandPaletteTrigger, composerTextareaRef, input, resetComposerHistory, resizeComposerTextarea, thread.threadId, updateThreadInput]);
  const selectCommandPaletteEntry = React.useCallback((entry: CommandPaletteEntry | undefined) => {
    if (!entry || !commandPaletteTrigger) return;
    const action = entry.action ?? "insert";
    if (thread.running && (action === "review_changes" || action === "compact_thread")) return;
    if (action === "open_model") {
      setDismissedCommandPaletteKey(commandPaletteDismissKey);
      replaceCommandPaletteTrigger("");
      setThreadModelDialogOpen(true);
      return;
    }
    if (action === "set_plan_mode" || action === "set_goal_mode") {
      setDismissedCommandPaletteKey(commandPaletteDismissKey);
      replaceCommandPaletteTrigger("");
      setComposerMode(action === "set_plan_mode" ? "plan" : "goal");
      return;
    }
    if (action === "review_changes" || action === "compact_thread") {
      setDismissedCommandPaletteKey(commandPaletteDismissKey);
      replaceCommandPaletteTrigger("");
      if (!thread.running) {
        if (action === "review_changes") void reviewThread(thread.threadId);
        else void compactThread(thread.threadId);
      }
      return;
    }
    const replacement = commandPaletteReplacementText(entry, commandPaletteTrigger);
    setDismissedCommandPaletteKey(`${thread.threadId}:${replacement}`);
    replaceCommandPaletteTrigger(replacement);
  }, [commandPaletteDismissKey, commandPaletteTrigger, compactThread, replaceCommandPaletteTrigger, reviewThread, setComposerMode, setThreadModelDialogOpen, thread.running, thread.threadId]);
  const renderCommandPaletteRow = React.useCallback((_rowIndex: number, row: CommandPaletteRow) => {
    if (row.type === "group") return <div className="commandPaletteGroup">{row.label}</div>;
    const { entry, index } = row;
    const EntryIcon = commandPaletteEntryIcon(entry);
    const blocked = thread.running && (entry.action === "review_changes" || entry.action === "compact_thread");
    return (
      <button
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
        <span className={`commandPaletteIcon ${entry.kind}`} aria-hidden="true"><EntryIcon /></span>
        <span className="commandPaletteText">
          <span className="commandPaletteTitle">{commandPaletteEntryLabel(entry)}</span>
          <span className="commandPaletteDescription">{commandPaletteEntryDescription(entry)}</span>
        </span>
        {entry.detail ? <span className="commandPaletteDetail">{entry.detail}</span> : null}
      </button>
    );
  }, [commandPaletteActiveIndex, selectCommandPaletteEntry, thread.running]);
  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (commandPaletteOpen && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setCommandPaletteKeyboardNavigation(true);
        setCommandPaletteActiveIndex((current) => commandPaletteEntries.length
          ? event.key === "ArrowDown"
            ? (current + 1) % commandPaletteEntries.length
            : (current - 1 + commandPaletteEntries.length) % commandPaletteEntries.length
          : 0);
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
    handleComposerKeyDown(event, thread.threadId, activeUserMessageHistory, canSend);
  }, [activeCommandPaletteEntry, activeUserMessageHistory, canSend, commandPaletteDismissKey, commandPaletteEntries.length, commandPaletteOpen, handleComposerKeyDown, selectCommandPaletteEntry, thread.threadId]);

  return (
    <>
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
          {commandPaletteRows.length ? (
            <Virtuoso
              ref={commandPaletteListRef}
              className="commandPaletteList"
              data={commandPaletteRows}
              style={{ height: `min(${commandPaletteListHeight}px, calc(52vh - 38px))` }}
              overscan={80}
              computeItemKey={(_index, row) => row.type === "group" ? `group:${row.group}` : row.entry.id}
              itemContent={renderCommandPaletteRow}
            />
          ) : null}
          {commandPaletteLoading && !commandPaletteEntries.length ? (
            <div className="commandPaletteEmpty">Loading app-server commands</div>
          ) : null}
        </div>
      ) : null}
      <textarea
        ref={composerTextareaRef}
        value={input}
        onChange={(event) => {
          resetComposerHistory(thread.threadId);
          rememberCaret(event.currentTarget);
          resizeComposerTextarea(event.currentTarget);
          updateThreadInput(thread.threadId, event.target.value);
        }}
        onSelect={(event) => rememberCaret(event.currentTarget)}
        onKeyUp={(event) => rememberCaret(event.currentTarget)}
        onMouseUp={(event) => rememberCaret(event.currentTarget)}
        onPaste={(event) => {
          if (!pasteThreadImages(thread.threadId, event.clipboardData)) return;
          event.preventDefault();
        }}
        onDragOver={(event) => {
          if (!isVscodeSurface || !dataTransferHasPathPayload(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          const nextCaretIndex = textareaCaretIndexFromPoint(event.currentTarget, event.clientX, event.clientY);
          dropCaretRef.current = nextCaretIndex;
          event.currentTarget.focus();
          event.currentTarget.setSelectionRange(nextCaretIndex, nextCaretIndex);
        }}
        onDrop={(event) => {
          if (!isVscodeSurface) return;
          const paths = droppedPathsFromDataTransfer(event.dataTransfer);
          if (!paths.length) return;
          event.preventDefault();
          const nextCaretIndex = dropCaretRef.current
            ?? textareaCaretIndexFromPoint(event.currentTarget, event.clientX, event.clientY);
          dropCaretRef.current = null;
          insertThreadPathText(thread.threadId, paths, event.currentTarget, nextCaretIndex);
        }}
        onKeyDown={handleKeyDown}
        placeholder="例如：检查这个 repo 的结构并给我下一步建议"
        rows={2}
      />
    </>
  );
};

export const ComposerSubmitButton = ({
  attachmentCount,
  composerDraftStore,
  runtimeReady,
  threadId,
  title
}: ComposerSubmitButtonProps) => {
  const input = useComposerDraft(composerDraftStore, threadId);
  const canSubmit = runtimeReady && Boolean(input.trim() || attachmentCount);
  return (
    <button
      type="submit"
      className="composerSendButton composerActionButton"
      disabled={!canSubmit}
      aria-label="Send message"
      title={title}
    >
      ↑
    </button>
  );
};
