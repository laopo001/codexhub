import type { OpenThreadState } from "../types.js";

type ActiveThreadSelectionInput = {
  activeMachineId: string;
  activeTabThreadId: string;
  activeWorkspacePath: string;
  openThreads: readonly OpenThreadState[];
  loadingThreadIds?: ReadonlySet<string>;
  selectedProjectMachineId?: string;
  selectedProjectPath?: string;
  restrictToWorkspacePath?: boolean;
};

/**
 * Keeps the visible thread selection stable while thread details are loading.
 *
 * A non-empty active tab is authoritative while it is open or while its
 * detail request is still in flight. A failed request must be recoverable
 * from the current project/workspace instead of pinning the UI to a dead ID.
 */
export const resolveActiveThreadId = ({
  activeMachineId,
  activeTabThreadId,
  activeWorkspacePath,
  openThreads,
  loadingThreadIds,
  selectedProjectMachineId,
  selectedProjectPath,
  restrictToWorkspacePath = false
}: ActiveThreadSelectionInput): string => {
  const activeThreadIsOpen = openThreads.some((thread) => thread.threadId === activeTabThreadId);
  if (activeTabThreadId && (activeThreadIsOpen || loadingThreadIds?.has(activeTabThreadId))) {
    return activeTabThreadId;
  }

  if (selectedProjectPath) {
    const selectedProjectThread = openThreads.find((thread) =>
      thread.runtime.machineId === selectedProjectMachineId
      && thread.workingDirectory === selectedProjectPath
    );
    if (selectedProjectThread) return selectedProjectThread.threadId;

    // Open tabs are global workspace state. A selected project path should
    // not hide every other legal thread on the same machine; only machine
    // identity remains a hard boundary here unless this is a fixed embedded
    // workspace recovering with no matching active thread.
    if (restrictToWorkspacePath) return "";
    return openThreads.find((thread) => thread.runtime.machineId === selectedProjectMachineId)?.threadId ?? "";
  }

  const workspaceThread = openThreads.find((thread) =>
    (!activeMachineId || thread.runtime.machineId === activeMachineId)
    && (!activeWorkspacePath || thread.workingDirectory === activeWorkspacePath)
  );
  if (workspaceThread) return workspaceThread.threadId;

  if (restrictToWorkspacePath && activeWorkspacePath) return "";

  return openThreads.find((thread) => !activeMachineId || thread.runtime.machineId === activeMachineId)?.threadId
    ?? openThreads[0]?.threadId
    ?? "";
};
