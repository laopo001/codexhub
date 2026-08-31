import type { ProjectSource } from "../shared/projectTypes.js";
import type { EmbeddedSurfaceKind, VscodeChannel } from "../shared/surfaceTypes.js";

export type EmbeddedSurfaceProject = {
  machineId: string;
  path: string;
  source: ProjectSource;
};

export type EmbeddedSurfaceRegistration = {
  surface: EmbeddedSurfaceKind;
  surfaceId: string;
  leaseId: string;
  machineId: string;
  workspacePaths: string[];
  activeWorkspacePath?: string;
  label: string;
  buildId?: string;
  vscodeChannel?: VscodeChannel;
  workspaceFile?: string;
};

export type EmbeddedSurfaceView = EmbeddedSurfaceRegistration & {
  updatedAt: string;
  expiresAt: string;
};

type SurfaceState = EmbeddedSurfaceRegistration & {
  updatedAtMs: number;
};

export type EmbeddedSurfaceHubOptions = {
  leaseTimeoutMs?: number;
  now?: () => number;
  currentBuildId?: string | null;
  onProjectsChange: (projects: EmbeddedSurfaceProject[]) => void;
  onReplacementBuildAvailable?: (buildId: string) => void;
};

const defaultLeaseTimeoutMs = 30_000;

/**
 * Embedded client window 只是 authority service 的临时 surface，不是 machine。
 * 这里维护窗口 lease，并把所有活动窗口的 workspace 合并成唯一 project catalog。
 */
export class EmbeddedSurfaceHub {
  private readonly surfaces = new Map<string, SurfaceState>();
  private readonly leaseTimeoutMs: number;
  private readonly now: () => number;
  private readonly sweepTimer: NodeJS.Timeout;
  private projectSignature = "";
  private availableBuildId = "";

  constructor(private readonly options: EmbeddedSurfaceHubOptions) {
    this.leaseTimeoutMs = positiveMilliseconds(options.leaseTimeoutMs, defaultLeaseTimeoutMs);
    this.now = options.now ?? Date.now;
    this.sweepTimer = setInterval(
      () => this.expireStaleSurfaces(),
      Math.max(1_000, Math.min(5_000, Math.floor(this.leaseTimeoutMs / 3)))
    );
    this.sweepTimer.unref?.();
  }

  upsert(input: EmbeddedSurfaceRegistration): EmbeddedSurfaceView {
    const workspacePaths = uniquePaths(input.workspacePaths);
    const activeWorkspacePath = input.activeWorkspacePath && workspacePaths.includes(input.activeWorkspacePath)
      ? input.activeWorkspacePath
      : workspacePaths[0];
    const state: SurfaceState = {
      ...input,
      workspacePaths,
      activeWorkspacePath,
      updatedAtMs: this.now()
    };
    this.surfaces.set(input.surfaceId, state);
    this.publishProjects();
    this.detectAvailableBuild();
    return this.view(state);
  }

  touch(surfaceId: string, leaseId: string): EmbeddedSurfaceView | null {
    const state = this.surfaces.get(surfaceId);
    if (!state || state.leaseId !== leaseId) return null;
    state.updatedAtMs = this.now();
    return this.view(state);
  }

  get(surfaceId: string, leaseId?: string): EmbeddedSurfaceView | null {
    const state = this.surfaces.get(surfaceId);
    if (!state || (leaseId && state.leaseId !== leaseId)) return null;
    return this.view(state);
  }

  remove(surfaceId: string, leaseId: string) {
    const state = this.surfaces.get(surfaceId);
    if (!state || state.leaseId !== leaseId) return false;
    this.surfaces.delete(surfaceId);
    this.publishProjects();
    this.detectAvailableBuild();
    return true;
  }

  list() {
    return [...this.surfaces.values()]
      .sort((left, right) => left.surfaceId.localeCompare(right.surfaceId))
      .map((surface) => this.view(surface));
  }

  stop() {
    clearInterval(this.sweepTimer);
    this.surfaces.clear();
  }

  private expireStaleSurfaces() {
    const deadline = this.now() - this.leaseTimeoutMs;
    let changed = false;
    for (const [surfaceId, surface] of this.surfaces) {
      if (surface.updatedAtMs >= deadline) continue;
      this.surfaces.delete(surfaceId);
      changed = true;
    }
    if (!changed) return;
    this.publishProjects();
    this.detectAvailableBuild();
  }

  private publishProjects() {
    const projectsByTarget = new Map<string, EmbeddedSurfaceProject>();
    const surfaces = [...this.surfaces.values()].sort((left, right) => left.surfaceId.localeCompare(right.surfaceId));
    for (const surface of surfaces) {
      for (const workspacePath of surface.workspacePaths) {
        const key = `${surface.machineId}\0${workspacePath}`;
        const existing = projectsByTarget.get(key);
        if (existing) {
          if (existing.source.workspaceFile !== surface.workspaceFile) {
            delete existing.source.workspaceFile;
          }
          continue;
        }
        projectsByTarget.set(key, {
          machineId: surface.machineId,
          path: workspacePath,
          source: {
            kind: surface.surface,
            groupId: surface.surfaceId,
            label: surface.label,
            ...(surface.vscodeChannel ? { vscodeChannel: surface.vscodeChannel } : {}),
            ...(surface.workspaceFile ? { workspaceFile: surface.workspaceFile } : {})
          }
        });
      }
    }
    const projects = [...projectsByTarget.values()].sort((left, right) =>
      left.machineId.localeCompare(right.machineId) || left.path.localeCompare(right.path)
    );
    const signature = JSON.stringify(projects);
    if (signature === this.projectSignature) return;
    this.projectSignature = signature;
    this.options.onProjectsChange(projects);
  }

  private view(surface: SurfaceState): EmbeddedSurfaceView {
    return {
      surface: surface.surface,
      surfaceId: surface.surfaceId,
      leaseId: surface.leaseId,
      machineId: surface.machineId,
      workspacePaths: [...surface.workspacePaths],
      activeWorkspacePath: surface.activeWorkspacePath,
      label: surface.label,
      buildId: surface.buildId,
      ...(surface.vscodeChannel ? { vscodeChannel: surface.vscodeChannel } : {}),
      ...(surface.workspaceFile ? { workspaceFile: surface.workspaceFile } : {}),
      updatedAt: new Date(surface.updatedAtMs).toISOString(),
      expiresAt: new Date(surface.updatedAtMs + this.leaseTimeoutMs).toISOString()
    };
  }

  private detectAvailableBuild() {
    const currentBuildId = this.options.currentBuildId?.trim();
    if (!currentBuildId || !this.options.onReplacementBuildAvailable || !this.surfaces.size) return;
    const [buildId] = [...new Set(
      [...this.surfaces.values()]
        .map((surface) => surface.buildId?.trim() ?? "")
        .filter((candidate) => candidate && candidate !== currentBuildId)
    )].sort();
    if (!buildId || buildId === this.availableBuildId) return;
    this.availableBuildId = buildId;
    this.options.onReplacementBuildAvailable(buildId);
  }

}

const uniquePaths = (paths: string[]) => [...new Set(paths.map((value) => value.trim()).filter(Boolean))];

const positiveMilliseconds = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
