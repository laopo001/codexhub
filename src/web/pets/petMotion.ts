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

export type PetTrayLayout = {
  horizontal: PetTrayHorizontalAlignment;
  offsetLeft: number;
  width: number;
};

export const calculatePetTrayLayout = (
  petPosition: PetPosition,
  viewport: PetSize,
  petSize: PetSize,
  preferredWidth = 310,
  viewportMargin = 12
): PetTrayLayout => {
  const width = Math.min(preferredWidth, Math.max(0, viewport.width - 32));
  const petCenterX = petPosition.x + petSize.width / 2;
  const idealLeft = petCenterX - width / 2;
  const margin = Math.min(viewportMargin, Math.max(0, (viewport.width - width) / 2));
  const maxLeft = Math.max(margin, viewport.width - width - margin);
  const clampedLeft = Math.max(margin, Math.min(maxLeft, idealLeft));
  const offsetLeft = Math.round(clampedLeft - petPosition.x);
  const horizontal: PetTrayHorizontalAlignment = clampedLeft === idealLeft
    ? "center"
    : clampedLeft > idealLeft
      ? "left"
      : "right";
  return {
    horizontal,
    offsetLeft,
    width,
  };
};

