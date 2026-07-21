export type PetSpriteVersion = 1 | 2;

export type PetManifest = {
  id: string;
  displayName: string;
  description: string;
  spriteVersionNumber: PetSpriteVersion;
  spritesheetPath: string;
};

export type PetsPayload = {
  pets: PetManifest[];
};

export type PetImportInput = {
  manifest: PetManifest;
  imageBase64: string;
  mimeType: "image/png" | "image/webp";
};

export type PetMutationPayload = {
  pet?: PetManifest;
  deleted?: boolean;
};
