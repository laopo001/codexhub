export type SurfaceProjectTarget = {
  machineId: string;
  path: string;
};

export type SurfaceProject = SurfaceProjectTarget & {
  source?: {
    kind: "vscode" | "electron";
    groupId: string;
  };
};

export type SurfaceThreadTarget = {
  machineId: string;
  workingDirectory?: string;
};

const surfaceTargetKey = (machineId: string, workingDirectory: string) =>
  `${machineId}\0${workingDirectory}`;

export const projectsForSurface = <Project extends SurfaceProject>(
  projects: readonly Project[],
  surface: {
    kind: "vscode" | "electron";
    groupId: string;
    workspacePaths: readonly string[];
  }
) => {
  const workspacePaths = new Set(surface.workspacePaths);
  return projects.filter((project) =>
    project.source?.kind === surface.kind
    && project.source.groupId === surface.groupId
    && (!workspacePaths.size || workspacePaths.has(project.path))
  );
};

/**
 * Restrict thread tabs to the projects contributed by one embedded surface.
 * A surface may contribute several workspace folders, so active path is not a
 * membership boundary; machine + project path is.
 */
export const threadIdsForSurfaceProjects = (
  threadIds: readonly string[],
  threadTargets: Readonly<Record<string, SurfaceThreadTarget | undefined>>,
  surfaceProjects: readonly SurfaceProjectTarget[]
) => {
  const allowedTargets = new Set(
    surfaceProjects.map((project) => surfaceTargetKey(project.machineId, project.path))
  );
  return threadIds.filter((threadId) => {
    const target = threadTargets[threadId];
    return Boolean(
      target?.workingDirectory
      && allowedTargets.has(surfaceTargetKey(target.machineId, target.workingDirectory))
    );
  });
};
