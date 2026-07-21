import type { PetSpriteVersion } from "../../shared/petTypes.js";

export type PetAnimationState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

export type { PetSpriteVersion } from "../../shared/petTypes.js";

export type PetLookCell = {
  angle: number;
  column: number;
  row: 9 | 10;
};

export type PetAnimationRow = {
  row: number;
  durationsMs: readonly number[];
};

const petAtlasBase = {
  columns: 8,
  cellWidth: 192,
  cellHeight: 208,
  width: 1536,
  maxBytes: 20 * 1024 * 1024,
} as const;

const petAtlasV1 = {
  ...petAtlasBase,
  rows: 9,
  height: 1872,
} as const;

const petAtlasV2 = {
  ...petAtlasBase,
  rows: 11,
  height: 2288,
} as const;

export const petAtlasForVersion = (version: PetSpriteVersion) => version === 2 ? petAtlasV2 : petAtlasV1;

// Kept as the V1 contract for callers that only need the shared legacy dimensions.
export const petAtlas = petAtlasV1;

export const petAnimationRows: Record<PetAnimationState, PetAnimationRow> = {
  idle: { row: 0, durationsMs: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, durationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, durationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durationsMs: [140, 140, 140, 280] },
  jumping: { row: 4, durationsMs: [140, 140, 140, 140, 280] },
  failed: { row: 5, durationsMs: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durationsMs: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durationsMs: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durationsMs: [150, 150, 150, 150, 150, 280] },
};

export const petAtlasCellBackgroundPosition = (
  row: number,
  column: number,
  version: PetSpriteVersion = 1
) => {
  const atlas = petAtlasForVersion(version);
  const safeColumn = Math.max(0, Math.min(column, atlas.columns - 1));
  const safeRow = Math.max(0, Math.min(row, atlas.rows - 1));
  return {
    x: `${(safeColumn / (atlas.columns - 1)) * 100}%`,
    y: `${(safeRow / (atlas.rows - 1)) * 100}%`,
  };
};

export const petAtlasBackgroundPosition = (
  animation: PetAnimationState,
  frame: number,
  version: PetSpriteVersion = 1
) => {
  const row = petAnimationRows[animation];
  const column = Math.max(0, Math.min(frame, row.durationsMs.length - 1));
  return petAtlasCellBackgroundPosition(row.row, column, version);
};

export const petLookCellForVector = (x: number, y: number, deadzone = 28): PetLookCell | null => {
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) <= deadzone) return null;
  const rawAngle = Math.atan2(x, -y) * (180 / Math.PI);
  const angle = (Math.round(((rawAngle + 360) % 360) / 22.5) % 16) * 22.5;
  const index = Math.round(angle / 22.5) % 16;
  return {
    angle,
    column: index % 8,
    row: index < 8 ? 9 : 10,
  };
};
