export type PetHitRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PetPointerPosition = {
  x: number;
  y: number;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPetHitRegion = (value: unknown): value is PetHitRegion => {
  if (!value || typeof value !== "object") return false;
  const region = value as Partial<PetHitRegion>;
  return isFiniteNumber(region.x)
    && isFiniteNumber(region.y)
    && isFiniteNumber(region.width)
    && isFiniteNumber(region.height)
    && region.width >= 0
    && region.height >= 0;
};

/** Parse renderer-provided hit regions before they cross the Electron IPC boundary. */
export const parsePetHitRegions = (value: unknown): PetHitRegion[] | null => {
  if (!Array.isArray(value) || value.length > 8) return null;
  return value.every(isPetHitRegion) ? value.map((region) => ({ ...region })) : null;
};

export const petHitRegionContainsPoint = (
  point: PetPointerPosition,
  region: PetHitRegion,
  padding = 0
) => point.x >= region.x - padding
  && point.x <= region.x + region.width + padding
  && point.y >= region.y - padding
  && point.y <= region.y + region.height + padding;

export const petHitRegionsContainPoint = (
  point: PetPointerPosition,
  regions: ReadonlyArray<PetHitRegion>,
  padding = 0
) => regions.some((region) => petHitRegionContainsPoint(point, region, padding));
