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

const subscribe = (listener: () => void) => {
  nowMs = Date.now();
  listeners.add(listener);
  if (timer === null) timer = window.setInterval(tick, 1000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
};

const subscribeNever = () => () => undefined;
const getSnapshot = () => nowMs;

const useLiveDurationMs = (active: boolean, startedAt: string | undefined) => {
  const currentNowMs = React.useSyncExternalStore(
    active ? subscribe : subscribeNever,
    getSnapshot,
    getSnapshot
  );
  if (!active || !startedAt) return undefined;
  const startedMs = Date.parse(startedAt);
  return Number.isFinite(startedMs) ? Math.max(0, currentNowMs - startedMs) : undefined;
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
  const liveDurationMs = useLiveDurationMs(executionMeta.status === "running", executionMeta.startedAt);
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
