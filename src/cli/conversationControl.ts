import type { ThreadDetail } from "../shared/threadTypes.js";
import { loadQueuedSubmissionIds, requestJson } from "./conversation.js";

export type ConversationControlOperation = "stop" | "end";

export type ConversationControlOptions = {
  baseUrl: string;
  authToken?: string;
  operation: ConversationControlOperation;
  threadId: string;
  timeoutSeconds?: number;
};

export type ConversationControlResult = {
  operation: ConversationControlOperation;
  threadId: string;
  stopped: boolean;
  running: false;
  idle: true;
  cancelledSubmissionIds: string[];
  queueRemaining: number | undefined;
  historyRetained: true;
  resumable: true;
};

const DEFAULT_CONTROL_TIMEOUT_SECONDS = 600;
const POLL_INTERVAL_MS = 100;

export const runConversationControl = async (
  options: ConversationControlOptions
): Promise<ConversationControlResult> => {
  const timeoutSeconds = parseTimeoutSeconds(options.timeoutSeconds ?? DEFAULT_CONTROL_TIMEOUT_SECONDS);
  const timeoutMs = timeoutSeconds * 1000;
  const controller = new AbortController();
  let timedOut = false;
  const deadline = Date.now() + timeoutMs;
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const threadId = options.threadId.trim();
    if (!threadId) throw new Error(`${options.operation} requires a threadId.`);

    await readThread(options, threadId, controller.signal, remainingMs(deadline));
    const cancelledSubmissionIds = options.operation === "end"
      ? await cancelQueuedMessages(options, threadId, controller.signal, deadline)
      : [];

    const beforeStop = await readThread(options, threadId, controller.signal, remainingMs(deadline));
    let stopped = false;
    if (beforeStop.running) {
      const response = await requestJson<{ stopped?: boolean }>(
        options.baseUrl,
        `/api/threads/${encodeURIComponent(threadId)}/stop`,
        { method: "POST", signal: controller.signal },
        remainingMs(deadline),
        options.authToken
      );
      stopped = response.stopped === true;
    }

    await waitForIdle(options, threadId, controller.signal, deadline);

    let queueRemaining: number | undefined;
    if (options.operation === "end") {
      const remaining = await loadQueuedSubmissionIds(
        options.baseUrl,
        options.authToken,
        threadId,
        remainingMs(deadline),
        controller.signal
      );
      queueRemaining = remaining.length;
      if (queueRemaining !== 0) {
        throw new Error(`CodexHub end could not cancel ${queueRemaining} queued message(s).`);
      }
      // The queue snapshot is a separate realtime read. A queued turn could
      // have become active while that read was closing, so re-check canonical
      // HTTP state before reporting end success.
      await waitForIdle(options, threadId, controller.signal, deadline);
    }

    return {
      operation: options.operation,
      threadId,
      stopped,
      running: false,
      idle: true,
      cancelledSubmissionIds,
      queueRemaining,
      historyRetained: true,
      resumable: true
    };
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `CodexHub ${options.operation} timed out after ${timeoutSeconds}s; thread idle state was not confirmed.`
      );
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(deadlineTimer);
    controller.abort();
  }
};

const readThread = async (
  options: ConversationControlOptions,
  threadId: string,
  signal: AbortSignal,
  timeoutMs: number
) => {
  const detail = await requestJson<ThreadDetail>(
    options.baseUrl,
    `/api/threads/${encodeURIComponent(threadId)}`,
    { signal },
    timeoutMs,
    options.authToken
  );
  if (typeof detail.running !== "boolean") {
    throw new Error("CodexHub thread detail did not include canonical running state.");
  }
  return detail;
};

const cancelQueuedMessages = async (
  options: ConversationControlOptions,
  threadId: string,
  signal: AbortSignal,
  deadline: number
) => {
  const cancelledSubmissionIds: string[] = [];
  for (;;) {
    const queued = await loadQueuedSubmissionIds(
      options.baseUrl,
      options.authToken,
      threadId,
      remainingMs(deadline),
      signal
    );
    if (!queued.length) return cancelledSubmissionIds;

    const queuedBeforeCancellation = new Set(queued);
    for (const submissionId of queued) {
      const response = await requestJson<{ cancelled?: boolean }>(
        options.baseUrl,
        `/api/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(submissionId)}`,
        { method: "DELETE", signal },
        remainingMs(deadline),
        options.authToken
      );
      if (response.cancelled !== true) {
        throw new Error(`CodexHub did not confirm cancellation of queued message ${submissionId}.`);
      }
      if (!cancelledSubmissionIds.includes(submissionId)) cancelledSubmissionIds.push(submissionId);
    }

    const remaining = await loadQueuedSubmissionIds(
      options.baseUrl,
      options.authToken,
      threadId,
      remainingMs(deadline),
      signal
    );
    if (!remaining.length) return cancelledSubmissionIds;
    if (remaining.every((submissionId) => queuedBeforeCancellation.has(submissionId))) {
      throw new Error("CodexHub end could not confirm cancellation of the queued messages.");
    }
  }
};

const waitForIdle = async (
  options: ConversationControlOptions,
  threadId: string,
  signal: AbortSignal,
  deadline: number
) => {
  for (;;) {
    const detail = await readThread(options, threadId, signal, remainingMs(deadline));
    if (detail.running === false) return detail;
    await waitForPoll(signal, Math.min(POLL_INTERVAL_MS, remainingMs(deadline)));
  }
};

const waitForPoll = (signal: AbortSignal, timeoutMs: number) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, timeoutMs);
  const onAbort = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    reject(new Error("CodexHub control wait was interrupted."));
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
});

const remainingMs = (deadline: number) => {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("CodexHub control timeout expired.");
  return remaining;
};

const parseTimeoutSeconds = (value: number) => {
  if (!Number.isFinite(value) || value <= 0 || value > 86_400) {
    throw new Error("--timeout must be greater than 0 and no more than 86400 seconds.");
  }
  return value;
};
