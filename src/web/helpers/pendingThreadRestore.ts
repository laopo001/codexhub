import type { SurfaceThreadTarget } from "./surfaceThreadScope.js";

export type PendingThreadRestoreTargets = Record<string, SurfaceThreadTarget>;
export type PendingThreadRestoreAttemptCounts = Record<string, number>;

export const mergeThreadRestoreTarget = (
  loaded: SurfaceThreadTarget | undefined,
  saved: SurfaceThreadTarget | undefined
) => {
  if (!loaded) return saved;
  return saved?.projectTarget?.machineId === loaded.machineId
    ? { ...loaded, projectTarget: saved.projectTarget }
    : loaded;
};

export const selectPendingThreadRestoreTargets = (
  threadIds: readonly string[],
  threadTargets: Readonly<Record<string, SurfaceThreadTarget | undefined>>
): PendingThreadRestoreTargets => Object.fromEntries(
  threadIds.flatMap((threadId) => {
    const target = threadTargets[threadId];
    return target ? [[threadId, target]] : [];
  })
);

export const pendingThreadRestoreOpenOptions = (input: {
  threadId: string;
  activeThreadId: string;
  hasActiveThread: boolean;
  targets: Readonly<PendingThreadRestoreTargets>;
}) => {
  const target = input.targets[input.threadId];
  const activate = input.threadId === input.activeThreadId && !input.hasActiveThread;
  const projectTarget = target?.projectTarget?.machineId === target?.machineId
    ? target.projectTarget
    : undefined;
  return {
    ...(activate ? { deferActivationUntilLoaded: true } : { activate: false as const }),
    ...(target?.machineId ? { expectedMachineId: target.machineId } : {}),
    ...(target?.workingDirectory ? { preferredWorkingDirectory: target.workingDirectory } : {}),
    ...(projectTarget ? { projectTarget } : {})
  };
};

export const removePendingThreadRestoreTarget = (
  targets: Readonly<PendingThreadRestoreTargets>,
  threadId: string
): PendingThreadRestoreTargets => {
  if (!targets[threadId]) return targets;
  const next = { ...targets };
  delete next[threadId];
  return next;
};

export const claimPendingThreadRestoreAttempt = (
  attempts: Readonly<PendingThreadRestoreAttemptCounts>,
  threadId: string,
  maxAttempts: number
): PendingThreadRestoreAttemptCounts | undefined => {
  const current = attempts[threadId] ?? 0;
  if (current >= maxAttempts) return undefined;
  return { ...attempts, [threadId]: current + 1 };
};
