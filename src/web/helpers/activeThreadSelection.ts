import type { OpenThreadState } from "../types.js";

type ActiveThreadSelectionInput = {
  activeMachineId: string;
  activeTabThreadId: string;
  activeWorkspacePath: string;
  openThreads: readonly OpenThreadState[];
  selectedProjectMachineId?: string;
  selectedProjectPath?: string;
};

/**
 * Keeps the visible thread selection stable while thread details are loading.
 *
 * A non-empty active tab is authoritative even before its thread reaches
 * openThreads. Only an empty active tab may be recovered from workspace state.
 */
export const resolveActiveThreadId = ({
  activeMachineId,
  activeTabThreadId,
  activeWorkspacePath,
  openThreads,
  selectedProjectMachineId,
  selectedProjectPath
}: ActiveThreadSelectionInput): string => {
  if (activeTabThreadId) {
    return activeTabThreadId;
  }

  if (selectedProjectPath) {
    return openThreads.find((thread) =>
      thread.runtime.machineId === selectedProjectMachineId
      && thread.workingDirectory === selectedProjectPath
    )?.threadId ?? "";
  }

  const workspaceThread = openThreads.find((thread) =>
    (!activeMachineId || thread.runtime.machineId === activeMachineId)
    && (!activeWorkspacePath || thread.workingDirectory === activeWorkspacePath)
  );
  if (workspaceThread) return workspaceThread.threadId;

  return openThreads.find((thread) => !activeMachineId || thread.runtime.machineId === activeMachineId)?.threadId
    ?? openThreads[0]?.threadId
    ?? "";
};
