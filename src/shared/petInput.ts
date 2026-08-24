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

export type ScreenDisplayBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 计算多显示器联合全屏覆盖边界，防止负坐标副屏或非标准布局丢失区域 */
export const calculateDesktopPetUnionBounds = (
  displays: ReadonlyArray<ScreenDisplayBounds>,
  fallback: ScreenDisplayBounds = { x: 0, y: 0, width: 800, height: 600 }
): ScreenDisplayBounds => {
  const bounds = displays.length ? displays : [fallback];
  const left = Math.min(...bounds.map((item) => item.x));
  const top = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const bottom = Math.max(...bounds.map((item) => item.y + item.height));
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
};

/** 将系统全局屏幕光标位置转换为透明窗口内部的相对坐标 */
export const screenPointToWindowLocalPoint = (
  screenPoint: PetPointerPosition,
  windowBounds: ScreenDisplayBounds
): PetPointerPosition => ({
  x: screenPoint.x - windowBounds.x,
  y: screenPoint.y - windowBounds.y,
});

/** 判定桌宠窗口在当前光标或拖拽状态下是否应进入可交互模式（取消鼠标穿透） */
export const shouldDesktopPetBeInteractive = (params: {
  cursorScreenPoint: PetPointerPosition;
  windowBounds: ScreenDisplayBounds;
  hitRegions: ReadonlyArray<PetHitRegion>;
  isDragActive: boolean;
  hitPadding?: number;
}): boolean => {
  if (params.isDragActive) return true;
  const localPointer = screenPointToWindowLocalPoint(params.cursorScreenPoint, params.windowBounds);
  return petHitRegionsContainPoint(localPointer, params.hitRegions, params.hitPadding ?? 0);
};
