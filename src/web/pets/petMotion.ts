export type PetPosition = {
  x: number;
  y: number;
};

export type PetSize = {
  width: number;
  height: number;
};

export const clampPetPosition = (
  position: PetPosition,
  viewport: PetSize,
  pet: PetSize,
  margin = 8
): PetPosition => ({
  x: Math.min(Math.max(margin, position.x), Math.max(margin, viewport.width - pet.width - margin)),
  y: Math.min(Math.max(margin, position.y), Math.max(margin, viewport.height - pet.height - margin)),
});

export const defaultPetPosition = (viewport: PetSize, compact: boolean): PetPosition => {
  const pet = compact ? { width: 96, height: 104 } : { width: 126, height: 136 };
  const right = compact ? 10 : 20;
  const bottom = compact ? 88 : 106;
  return clampPetPosition({
    x: viewport.width - pet.width - right,
    y: viewport.height - pet.height - bottom,
  }, viewport, pet);
};

export type PetTrayHorizontalAlignment = "center" | "left" | "right";
export type PetTrayVerticalAlignment = "above" | "below";

export type PetDisplayBounds = PetPosition & PetSize;

export type PetTrayLayout = {
  horizontal: PetTrayHorizontalAlignment;
  vertical: PetTrayVerticalAlignment;
  offsetLeft: number;
  width: number;
};

const displayDistanceToPoint = (display: PetDisplayBounds, point: PetPosition) => {
  const right = display.x + display.width;
  const bottom = display.y + display.height;
  const dx = point.x < display.x ? display.x - point.x : point.x > right ? point.x - right : 0;
  const dy = point.y < display.y ? display.y - point.y : point.y > bottom ? point.y - bottom : 0;
  return dx * dx + dy * dy;
};

const displayForPet = (
  petPosition: PetPosition,
  petSize: PetSize,
  displays: ReadonlyArray<PetDisplayBounds>
): PetDisplayBounds | null => {
  if (!displays.length) return null;
  const petCenter = {
    x: petPosition.x + petSize.width / 2,
    y: petPosition.y + petSize.height / 2,
  };
  return displays.find((display) =>
    petCenter.x >= display.x
    && petCenter.x <= display.x + display.width
    && petCenter.y >= display.y
    && petCenter.y <= display.y + display.height
  ) ?? displays.reduce((nearest, display) =>
    displayDistanceToPoint(display, petCenter) < displayDistanceToPoint(nearest, petCenter)
      ? display
      : nearest
  );
};

export const calculatePetTrayLayout = (
  petPosition: PetPosition,
  viewport: PetSize,
  petSize: PetSize,
  preferredWidth = 310,
  viewportMargin = 12,
  displays: ReadonlyArray<PetDisplayBounds> = []
): PetTrayLayout => {
  const display = displayForPet(petPosition, petSize, displays);
  const trayViewport = display ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const width = Math.min(preferredWidth, Math.max(0, trayViewport.width - 32));
  const petCenterX = petPosition.x + petSize.width / 2;
  const idealLeft = petCenterX - width / 2;
  const margin = Math.min(viewportMargin, Math.max(0, (trayViewport.width - width) / 2));
  const minLeft = trayViewport.x + margin;
  const maxLeft = Math.max(minLeft, trayViewport.x + trayViewport.width - width - margin);
  const clampedLeft = Math.max(minLeft, Math.min(maxLeft, idealLeft));
  const offsetLeft = Math.round(clampedLeft - petPosition.x);
  const horizontal: PetTrayHorizontalAlignment = clampedLeft === idealLeft
    ? "center"
    : clampedLeft > idealLeft
      ? "left"
      : "right";
  const petCenterY = petPosition.y + petSize.height / 2;
  return {
    horizontal,
    vertical: petCenterY > trayViewport.y + trayViewport.height / 2 ? "above" : "below",
    offsetLeft,
    width,
  };
};
