export const defaultPetId = "red-spark";
export const petIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type PetSpriteVersion = 1 | 2;

export type PetManifest = {
  id: string;
  displayName: string;
  description: string;
  spriteVersionNumber: PetSpriteVersion;
  spritesheetPath: string;
};

export type InvalidPetPackage = {
  id: string;
  error: string;
};

export type PetsPayload = {
  invalidPets: InvalidPetPackage[];
  pets: PetManifest[];
};

export type PetMutationPayload = {
  pet?: PetManifest;
  deleted?: boolean;
  trashed?: boolean;
};
