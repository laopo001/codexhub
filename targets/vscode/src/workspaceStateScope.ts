import { createHash } from "node:crypto";
import {
  normalizeVscodeWorkspaceIdentity,
  type VscodeWorkspaceFileLike,
  type VscodeWorkspaceFolderLike
} from "../../../src/shared/surfaceTypes.js";

export const vscodeWorkspaceStateScope = (
  folders?: readonly VscodeWorkspaceFolderLike[] | null,
  workspaceFile?: VscodeWorkspaceFileLike | string | null
): string => {
  const identity = normalizeVscodeWorkspaceIdentity(workspaceFile, folders);
  return createHash("sha256").update(identity).digest("hex").slice(0, 24);
};
