import React from "react";
import type { CodexRecordView } from "../../shared/recordTypes.js";
import type { ThreadExecutionMeta } from "../types.js";
import { statusLabel } from "./common.js";

const listeners = new Set<() => void>();
let nowMs = Date.now();
let timer: number | null = null;

const tick = () => {
  nowMs = Date.now();
  for (const listener of listeners) listener();
};

const refreshForVisiblePage = () => {
  if (document.visibilityState === "visible") tick();
};

const startClock = () => {
  timer = window.setInterval(tick, 1000);
  window.addEventListener("pageshow", tick);
  document.addEventListener("visibilitychange", refreshForVisiblePage);
  document.addEventListener("resume", refreshForVisiblePage);
};

const stopClock = () => {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  window.removeEventListener("pageshow", tick);
  document.removeEventListener("visibilitychange", refreshForVisiblePage);
  document.removeEventListener("resume", refreshForVisiblePage);
};

const subscribe = (listener: () => void) => {
  nowMs = Date.now();
  listeners.add(listener);
  if (timer === null) startClock();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stopClock();
  };
};

const subscribeNever = () => () => undefined;
const getSnapshot = () => nowMs;

export const liveDurationMsFromAnchor = ({
  startedAt,
  observedAt,
  observedClientAtMs,
  currentClientNowMs
}: {
  startedAt: string | undefined;
  observedAt?: string;
  observedClientAtMs: number;
  currentClientNowMs: number;
}) => {
  if (!startedAt) return undefined;
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return undefined;
  const observedMs = observedAt ? Date.parse(observedAt) : Number.NaN;
  if (Number.isFinite(observedMs)) {
    const backendElapsedMs = Math.max(0, observedMs - startedMs);
    const clientElapsedMs = Math.max(0, currentClientNowMs - observedClientAtMs);
    return backendElapsedMs + clientElapsedMs;
  }
  return Math.max(0, currentClientNowMs - startedMs);
};

const useLiveDurationMs = (
  active: boolean,
  startedAt: string | undefined,
  observedAt?: string
) => {
  const observedClientAtMs = React.useMemo(() => Date.now(), [startedAt, observedAt]);
  const currentNowMs = React.useSyncExternalStore(
    active ? subscribe : subscribeNever,
    getSnapshot,
    getSnapshot
  );
  if (!active) return undefined;
  return liveDurationMsFromAnchor({
    startedAt,
    observedAt,
    observedClientAtMs,
    currentClientNowMs: currentNowMs
  });
};

export const StatusStartedAtContext = React.createContext<string | undefined>(undefined);

export const LiveStatusLabel = ({
  status,
  statusText,
  statusDurationMs,
  startedAt
}: {
  status: NonNullable<CodexRecordView["status"]>;
  statusText?: string;
  statusDurationMs?: number;
  startedAt?: string;
}) => {
  const liveDurationMs = useLiveDurationMs(status === "pending" || status === "in_progress", startedAt);
  return <>{statusLabel(status, statusText, liveDurationMs ?? statusDurationMs)}</>;
};

export const LiveThreadExecutionText = ({
  executionMeta,
  includeLabel = true
}: {
  executionMeta: ThreadExecutionMeta;
  includeLabel?: boolean;
}) => {
  const liveDurationMs = useLiveDurationMs(
    executionMeta.status === "running",
    executionMeta.startedAt,
    executionMeta.observedAt
  );
  const duration = liveDurationMs === undefined ? executionMeta.duration : formatThreadDuration(liveDurationMs);
  return <>{[includeLabel ? executionMeta.label : "", duration].filter(Boolean).join(" · ")}</>;
};

export const formatThreadDuration = (durationMs: number) => {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h${minutes}m${remainder}s`;
  if (minutes) return `${minutes}m${remainder}s`;
  return `${remainder}s`;
};
