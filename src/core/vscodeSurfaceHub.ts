import type { ProjectSource } from "../shared/projectTypes.js";
import type { EmbeddedSurfaceKind } from "../shared/surfaceTypes.js";

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
  idleShutdownMs?: number;
  now?: () => number;
  currentBuildId?: string | null;
  onProjectsChange: (projects: EmbeddedSurfaceProject[]) => void;
  onIdle?: () => void;
  onReplacementBuild?: (buildId: string) => void;
};

const defaultLeaseTimeoutMs = 30_000;
const defaultIdleShutdownMs = 30_000;

/**
 * Embedded client window 只是 authority service 的临时 surface，不是 machine。
 * 这里维护窗口 lease，并把所有活动窗口的 workspace 合并成唯一 project catalog。
 */
export class EmbeddedSurfaceHub {
  private readonly surfaces = new Map<string, SurfaceState>();
  private readonly leaseTimeoutMs: number;
  private readonly idleShutdownMs: number;
  private readonly now: () => number;
  private readonly sweepTimer: NodeJS.Timeout;
  private idleTimer: NodeJS.Timeout | null = null;
  private projectSignature = "";
  private replacementBuildId = "";

  constructor(private readonly options: EmbeddedSurfaceHubOptions) {
    this.leaseTimeoutMs = positiveMilliseconds(options.leaseTimeoutMs, defaultLeaseTimeoutMs);
    this.idleShutdownMs = positiveMilliseconds(options.idleShutdownMs, defaultIdleShutdownMs);
    this.now = options.now ?? Date.now;
    this.sweepTimer = setInterval(
      () => this.expireStaleSurfaces(),
      Math.max(1_000, Math.min(5_000, Math.floor(this.leaseTimeoutMs / 3)))
    );
    this.sweepTimer.unref?.();
    this.scheduleIdleShutdown();
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
    this.cancelIdleShutdown();
    this.publishProjects();
    this.detectReplacementBuild();
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
    this.detectReplacementBuild();
    if (!this.surfaces.size) this.scheduleIdleShutdown();
    return true;
  }

  list() {
    return [...this.surfaces.values()]
      .sort((left, right) => left.surfaceId.localeCompare(right.surfaceId))
      .map((surface) => this.view(surface));
  }

  stop() {
    clearInterval(this.sweepTimer);
    this.cancelIdleShutdown();
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
    this.detectReplacementBuild();
    if (!this.surfaces.size) this.scheduleIdleShutdown();
  }

  private publishProjects() {
    const projectsByTarget = new Map<string, EmbeddedSurfaceProject>();
    const surfaces = [...this.surfaces.values()].sort((left, right) => left.surfaceId.localeCompare(right.surfaceId));
    for (const surface of surfaces) {
      for (const workspacePath of surface.workspacePaths) {
        const key = `${surface.machineId}\0${workspacePath}`;
        if (projectsByTarget.has(key)) continue;
        projectsByTarget.set(key, {
          machineId: surface.machineId,
          path: workspacePath,
          source: {
            kind: surface.surface,
            groupId: surface.surfaceId,
            label: surface.label
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
      updatedAt: new Date(surface.updatedAtMs).toISOString(),
      expiresAt: new Date(surface.updatedAtMs + this.leaseTimeoutMs).toISOString()
    };
  }

  private scheduleIdleShutdown() {
    if (!this.options.onIdle || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.surfaces.size) this.options.onIdle?.();
    }, this.idleShutdownMs);
    this.idleTimer.unref?.();
  }

  private detectReplacementBuild() {
    const currentBuildId = this.options.currentBuildId?.trim();
    if (!currentBuildId || !this.options.onReplacementBuild || !this.surfaces.size) return;
    const builds = new Set([...this.surfaces.values()].map((surface) => surface.buildId?.trim() ?? ""));
    if (builds.size !== 1) return;
    const [buildId] = builds;
    if (!buildId || buildId === currentBuildId || buildId === this.replacementBuildId) return;
    this.replacementBuildId = buildId;
    this.options.onReplacementBuild(buildId);
  }

  private cancelIdleShutdown() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

const uniquePaths = (paths: string[]) => [...new Set(paths.map((value) => value.trim()).filter(Boolean))];

const positiveMilliseconds = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

export type {
  EmbeddedSurfaceProject as VscodeSurfaceProject,
  EmbeddedSurfaceRegistration as VscodeSurfaceRegistration,
  EmbeddedSurfaceView as VscodeSurfaceView,
  EmbeddedSurfaceHubOptions as VscodeSurfaceHubOptions
};
export { EmbeddedSurfaceHub as VscodeSurfaceHub };
