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

export type PetAnimationRow = {
  row: number;
  durationsMs: readonly number[];
};

export const petAtlas = {
  columns: 8,
  rows: 9,
  cellWidth: 192,
  cellHeight: 208,
  width: 1536,
  height: 1872,
  maxBytes: 20 * 1024 * 1024,
} as const;

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

export const petAtlasBackgroundPosition = (animation: PetAnimationState, frame: number) => {
  const row = petAnimationRows[animation];
  const column = Math.max(0, Math.min(frame, row.durationsMs.length - 1));
  return {
    x: `${(column / (petAtlas.columns - 1)) * 100}%`,
    y: `${(row.row / (petAtlas.rows - 1)) * 100}%`,
  };
};
