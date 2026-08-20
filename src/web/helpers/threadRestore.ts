import { CodexHubApiError } from "../../shared/apiClient.js";

export type PersistedThreadRestoreResult = {
  threadIds: string[];
  activeThreadId: string;
  pendingThreadIds: string[];
};

type PersistedThreadRestoreOptions = {
  threadIds: string[];
  activeThreadId: string;
  /**
   * A fixed workspace may keep foreign global tabs open without activating
   * the first one when its persisted active tab belongs to another path.
   */
  activateFirstThreadWhenNoPreferred?: boolean;
  openThread: (threadId: string, options?: {
    activate?: boolean;
    deferActivationUntilLoaded?: boolean;
  }) => Promise<void>;
  clearActiveThreadIfLatest: (threadId: string) => void;
  retryDelaysMs?: readonly number[];
};

// The initial restore must not block a successfully opened active tab on stale
// persisted IDs. Transient failures are retried by the initialized app effect.
const defaultRetryDelaysMs = [0] as const;

const isRetryableThreadRestoreError = (error: unknown) => {
  if (error instanceof CodexHubApiError) {
    return error.status === 404
      || error.status === 408
      || error.status === 409
      || error.status === 425
      || error.status === 429
      || error.status >= 500;
  }
  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
};

const delay = async (durationMs: number) => {
  if (durationMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
};

const openThreadWithRetry = async (
  threadId: string,
  openThread: (threadId: string) => Promise<void>,
  retryDelaysMs: readonly number[]
) => {
  const delays = retryDelaysMs.length ? retryDelaysMs : [0];
  let lastError: unknown;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    await delay(delays[attempt] ?? 0);
    try {
      await openThread(threadId);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableThreadRestoreError(error) || attempt + 1 >= delays.length) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Thread restore failed"));
};

export const preferredPersistedThreadId = (
  threadIds: readonly string[],
  persistedActiveThreadId: string,
  workspaceThreadIds?: ReadonlySet<string>
) => {
  if (workspaceThreadIds) {
    if (threadIds.includes(persistedActiveThreadId) && workspaceThreadIds.has(persistedActiveThreadId)) {
      return persistedActiveThreadId;
    }
    return threadIds.find((threadId) => workspaceThreadIds.has(threadId)) ?? "";
  }
  return threadIds.includes(persistedActiveThreadId)
    ? persistedActiveThreadId
    : threadIds[0] ?? "";
};

export const restorePersistedThreadTabs = async (
  options: PersistedThreadRestoreOptions
): Promise<PersistedThreadRestoreResult> => {
  const preferredActiveThreadId = options.threadIds.includes(options.activeThreadId)
    ? options.activeThreadId
    : "";
  const openOrder = preferredActiveThreadId
    ? [
      preferredActiveThreadId,
      ...options.threadIds.filter((threadId) => threadId !== preferredActiveThreadId)
    ]
    : options.threadIds;
  const activationTarget = preferredActiveThreadId
    || (options.activateFirstThreadWhenNoPreferred === false ? "" : options.threadIds[0] || "");
  const openedThreadIds = new Set<string>();
  const pendingThreadIds = new Set<string>();
  const retryDelaysMs = options.retryDelaysMs ?? defaultRetryDelaysMs;

  for (const threadId of openOrder) {
    const activate = threadId === activationTarget;
    try {
      await openThreadWithRetry(
        threadId,
        (id) => options.openThread(id, activate
          ? { activate: true, deferActivationUntilLoaded: true }
          : { activate: false }),
        retryDelaysMs
      );
      openedThreadIds.add(threadId);
    } catch (error) {
      if (isRetryableThreadRestoreError(error)) pendingThreadIds.add(threadId);
      options.clearActiveThreadIfLatest(threadId);
    }
  }

  const threadIds = options.threadIds.filter((threadId) => openedThreadIds.has(threadId));
  const pendingIds = options.threadIds.filter((threadId) => pendingThreadIds.has(threadId));
  return {
    threadIds,
    activeThreadId: activationTarget
      ? (preferredActiveThreadId && openedThreadIds.has(preferredActiveThreadId)
        ? preferredActiveThreadId
        : threadIds[0] ?? "")
      : "",
    pendingThreadIds: pendingIds
  };
};
