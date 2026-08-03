import type { OpenThreadState, StreamEvent, SubagentThreadDialogState } from "../types.js";
import { reduceConversationThreadState } from "../openThreadReducer.js";

export const subagentThreadSubscriptionIds = (
  openThreadIds: readonly string[],
  dialog: SubagentThreadDialogState | null
) => {
  const ids = new Set(openThreadIds);
  if (dialog?.status === "ready") ids.add(dialog.threadId);
  return [...ids];
};

export const releaseDialogOnlyThreadAttachments = (
  dialog: SubagentThreadDialogState | null,
  workspaceThreadIds: readonly string[]
) => {
  const workspaceIds = new Set(workspaceThreadIds);
  const releasedThreadIds = new Set<string>();
  for (const thread of subagentDialogConversationThreads(dialog)) {
    if (workspaceIds.has(thread.threadId) || releasedThreadIds.has(thread.threadId)) continue;
    releasedThreadIds.add(thread.threadId);
    for (const image of thread.imageAttachments) {
      URL.revokeObjectURL(image.previewUrl);
    }
  }
};

export const subagentDialogConversationThreads = (
  dialog: SubagentThreadDialogState | null
): OpenThreadState[] => {
  const threads: OpenThreadState[] = [];
  const visitedDialogs = new Set<SubagentThreadDialogState>();
  let current = dialog;
  while (current && !visitedDialogs.has(current)) {
    visitedDialogs.add(current);
    if (current.thread) threads.push(current.thread);
    current = current.parentDialog ?? null;
  }
  return threads;
};

export const mergeSubagentThreadDialogStream = (
  dialog: SubagentThreadDialogState | null,
  event: StreamEvent
): SubagentThreadDialogState | null => {
  if (dialog?.status !== "ready" || !dialog.thread || dialog.threadId !== event.thread.threadId) {
    return dialog;
  }
  return {
    ...dialog,
    machineId: event.thread.runtime.machineId ?? dialog.machineId,
    workingDirectory: event.thread.workingDirectory || dialog.workingDirectory,
    thread: reduceConversationThreadState(dialog.thread, {
      type: "merge-stream",
      threadId: event.thread.threadId,
      thread: event.thread,
      record: event.record,
      records: event.records,
      delta: event.delta,
      snapshot: event.snapshot
    })
  };
};
