export type PersistedThreadRestoreResult = {
  threadIds: string[];
  activeThreadId: string;
};

type PersistedThreadRestoreOptions = {
  threadIds: string[];
  activeThreadId: string;
  openThread: (threadId: string) => Promise<void>;
  clearActiveThreadIfLatest: (threadId: string) => void;
};

export const restorePersistedThreadTabs = async (
  options: PersistedThreadRestoreOptions
): Promise<PersistedThreadRestoreResult> => {
  const preferredActiveThreadId = options.threadIds.includes(options.activeThreadId)
    ? options.activeThreadId
    : "";
  const openOrder = preferredActiveThreadId
    ? [
      ...options.threadIds.filter((threadId) => threadId !== preferredActiveThreadId),
      preferredActiveThreadId
    ]
    : options.threadIds;
  const openedThreadIds = new Set<string>();

  for (const threadId of openOrder) {
    try {
      await options.openThread(threadId);
      openedThreadIds.add(threadId);
    } catch {
      options.clearActiveThreadIfLatest(threadId);
    }
  }

  const threadIds = options.threadIds.filter((threadId) => openedThreadIds.has(threadId));
  return {
    threadIds,
    activeThreadId: preferredActiveThreadId && openedThreadIds.has(preferredActiveThreadId)
      ? preferredActiveThreadId
      : threadIds[0] ?? ""
  };
};
