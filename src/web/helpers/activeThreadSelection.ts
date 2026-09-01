import type { OpenThreadState } from "../types.js";
import {
  threadMatchesProjectTarget,
  type SurfaceProjectTarget
} from "./surfaceThreadScope.js";

type ActiveThreadSelectionInput = {
  activeMachineId: string;
  activeTabThreadId: string;
  activeWorkspacePath: string;
  openThreads: readonly OpenThreadState[];
  loadingThreadIds?: ReadonlySet<string>;
  selectedProjectMachineId?: string;
  selectedProjectPath?: string;
  selectedProjectThreadId?: string;
  restrictToWorkspacePath?: boolean;
};

export const selectActiveThread = (input: {
  activeTabThreadId: string;
  activeMachineId: string;
  openThreads: readonly OpenThreadState[];
  selectedProjectTarget?: SurfaceProjectTarget;
  projectSelectionActive: boolean;
  threadProjectTargets: Readonly<Record<string, SurfaceProjectTarget | undefined>>;
  fixedSurface: boolean;
}) => {
  const active = input.openThreads.find((thread) => thread.threadId === input.activeTabThreadId);
  // An explicitly open/active surface tab is authoritative. Project selection
  // only supplies a target for project-scoped actions; it must not invalidate a
  // restored tab whose older snapshot has no optional projectTarget metadata.
  if (active) return active;
  if (input.selectedProjectTarget) {
    return input.openThreads.find((thread) => threadMatchesProjectTarget(
      input.threadProjectTargets[thread.threadId],
      input.selectedProjectTarget
    ));
  }
  if (input.projectSelectionActive) return undefined;
  if (input.fixedSurface) return undefined;
  return input.openThreads.find((thread) =>
    !input.activeMachineId || thread.runtime.machineId === input.activeMachineId
  ) ?? input.openThreads[0];
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
  selectedProjectThreadId,
  restrictToWorkspacePath = false
}: ActiveThreadSelectionInput): string => {
  const activeThreadIsOpen = openThreads.some((thread) => thread.threadId === activeTabThreadId);
  if (activeTabThreadId && (activeThreadIsOpen || loadingThreadIds?.has(activeTabThreadId))) {
    return activeTabThreadId;
  }

  if (selectedProjectPath) {
    if (selectedProjectThreadId
      && openThreads.some((thread) => thread.threadId === selectedProjectThreadId)) {
      return selectedProjectThreadId;
    }
    if (restrictToWorkspacePath) return "";
    // Open tabs are global workspace state. A selected project path should
    // not be matched through workingDirectory. Explicit tab/project routing
    // is owned by the caller; this fallback only preserves machine scope.
    return openThreads.find((thread) => thread.runtime.machineId === selectedProjectMachineId)?.threadId ?? "";
  }

  if (restrictToWorkspacePath && activeWorkspacePath) return "";

  return openThreads.find((thread) => !activeMachineId || thread.runtime.machineId === activeMachineId)?.threadId
    ?? openThreads[0]?.threadId
    ?? "";
};
