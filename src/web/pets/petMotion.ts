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
