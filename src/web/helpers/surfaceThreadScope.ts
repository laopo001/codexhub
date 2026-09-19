import type { ProjectTarget } from "../../shared/petActivityRouting.js";
import { findProjectSource, type ProjectSource } from "../../shared/projectTypes.js";

export type SurfaceProject = ProjectTarget & {
  source?: ProjectSource;
  sources?: ProjectSource[];
};

export type SurfaceThreadTarget = {
  machineId: string;
  workingDirectory?: string;
  lastOpenedAt?: string;
  projectTarget?: ProjectTarget;
};

export const threadMatchesProjectTarget = (
  target: ProjectTarget | undefined,
  project: ProjectTarget | undefined
) => Boolean(
  target
  && project
  && target.machineId === project.machineId
  && target.path === project.path
);

export const workspaceIncludesProjectTarget = (
  workspacePaths: ReadonlySet<string>,
  target: ProjectTarget | undefined,
  machineId?: string
) => Boolean(
  target
  && (!machineId || target.machineId === machineId)
  && workspacePaths.has(target.path)
);

export const projectsForSurface = <Project extends SurfaceProject>(
  projects: readonly Project[],
  surface: {
    kind: "vscode" | "electron";
    groupId: string;
    workspacePaths: readonly string[];
  }
) => {
  const workspacePaths = new Set(surface.workspacePaths);
  return projects.flatMap((project) => {
    const source = findProjectSource(project, surface.kind, surface.groupId);
    if (!source || (workspacePaths.size && !workspacePaths.has(project.path))) return [];
    return [{ ...project, source }];
  });
};
