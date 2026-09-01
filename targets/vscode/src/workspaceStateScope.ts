import { createHash } from "node:crypto";
import {
  normalizeVscodeWorkspaceIdentity,
  type VscodeWorkspaceFileLike,
  type VscodeWorkspaceFolderLike
} from "../../../src/shared/surfaceTypes.js";
import {
  pathIdentityKey,
  type WorkspaceTarget
} from "../../../src/shared/petActivityRouting.js";
import {
  parseWorkspaceFileLaunchReference,
  type VscodeChannel
} from "../../../src/shared/surfaceTypes.js";

export const vscodeWorkspaceStateScope = (
  folders?: readonly VscodeWorkspaceFolderLike[] | null,
  workspaceFile?: VscodeWorkspaceFileLike | string | null
): string => {
  const identity = normalizeVscodeWorkspaceIdentity(workspaceFile, folders);
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
};

export const workspaceTargetMatchesCurrentWindow = (
  target: WorkspaceTarget,
  currentWorkspaceFile: string | undefined,
  currentWorkspacePaths: readonly string[],
  currentChannel: VscodeChannel | undefined
) => {
  if (target.kind !== "vscode" || target.vscodeChannel !== currentChannel) return false;
  if (target.workspaceFile !== undefined || currentWorkspaceFile !== undefined) {
    if (target.workspaceFile === undefined || currentWorkspaceFile === undefined) return false;
    const targetFile = parseWorkspaceFileLaunchReference(target.workspaceFile);
    const currentFile = parseWorkspaceFileLaunchReference(currentWorkspaceFile);
    if (!targetFile || !currentFile) return false;
    const fileKey = (file: { path: string; remote?: string }) =>
      `${file.remote ?? ""}\0${pathIdentityKey(file.path)}`;
    return fileKey(targetFile) === fileKey(currentFile);
  }
  const currentPaths = new Set(currentWorkspacePaths.map(pathIdentityKey));
  const targetPaths = new Set(target.workspacePaths.map(pathIdentityKey));
  return currentPaths.size === targetPaths.size
    && [...currentPaths].every((folder) => targetPaths.has(folder));
};
