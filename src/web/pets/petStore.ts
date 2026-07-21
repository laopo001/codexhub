import { defaultPetId, type PetManifest, type PetMutationPayload } from "../../shared/petTypes.js";
import { authFetch, authToken } from "../helpers/core.js";
import { petAtlasForVersion } from "./petAtlas.js";

const redSparkSpriteUrl = new URL("./assets/red-spark.webp", import.meta.url).href;

export type { PetManifest } from "../../shared/petTypes.js";

export type PetDefinition = PetManifest & {
  kind: "builtin" | "imported";
  spriteUrl: string;
};

export type PetImportSelection = {
  image: File;
  manifest: PetManifest;
};

export class PetUploadError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PetUploadError";
    this.status = status;
  }
}

const legacyDatabaseName = "codexhub-pets-v1";

const jsonRecord = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : null;

const nonEmptyString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : "";

export const petIdFromName = (value: string) => {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || `pet-${Date.now().toString(36)}`;
};

export const parsePetManifest = (value: unknown, fallbackImageName: string): PetManifest => {
  const record = jsonRecord(value);
  const fallbackName = fallbackImageName.replace(/\.(png|webp)$/i, "") || "Custom pet";
  const id = petIdFromName(nonEmptyString(record?.id) || fallbackName);
  if (id === "red-spark") throw new Error("That pet id is reserved by CodexHub.");
  const spritesheetPath = nonEmptyString(record?.spritesheetPath) || fallbackImageName;
  if (spritesheetPath.split(/[\\/]/).pop() !== fallbackImageName) {
    throw new Error(`pet.json expects ${spritesheetPath}, but ${fallbackImageName} was selected.`);
  }
  const spriteVersionValue = record?.spriteVersionNumber;
  if (spriteVersionValue !== undefined && spriteVersionValue !== 1 && spriteVersionValue !== 2) {
    throw new Error("pet.json spriteVersionNumber must be 1 or 2.");
  }
  return {
    id,
    displayName: nonEmptyString(record?.displayName) || fallbackName,
    description: nonEmptyString(record?.description) || "Imported Codex-compatible pet",
    spriteVersionNumber: spriteVersionValue === 2 ? 2 : 1,
    spritesheetPath: fallbackImageName,
  };
};

const imageDimensions = async (file: File) => {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error("Unable to read the pet spritesheet."));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
};

export const importedPetFromFiles = async (files: File[]): Promise<PetImportSelection> => {
  const image = files.find((file) => file.type === "image/png" || file.type === "image/webp" || /\.(png|webp)$/i.test(file.name));
  if (!image) throw new Error("Choose a PNG or WebP spritesheet.");

  const manifestFile = files.find((file) => /(^|\/)pet\.json$/i.test(file.name) || file.name.toLowerCase() === "pet.json");
  let manifestValue: unknown = null;
  if (manifestFile) {
    try {
      manifestValue = JSON.parse(await manifestFile.text());
    } catch {
      throw new Error("pet.json is not valid JSON.");
    }
  }
  const manifest = parsePetManifest(manifestValue, image.name);
  const atlas = petAtlasForVersion(manifest.spriteVersionNumber);
  if (image.size > atlas.maxBytes) throw new Error("Pet spritesheets must be 20 MiB or smaller.");
  const dimensions = await imageDimensions(image);
  if (dimensions.width !== atlas.width || dimensions.height !== atlas.height) {
    throw new Error(`Version ${manifest.spriteVersionNumber} pet spritesheets must be exactly ${atlas.width} x ${atlas.height} pixels.`);
  }
  return {
    image,
    manifest,
  };
};

const errorMessage = (value: unknown, fallback: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const message = (value as Record<string, unknown>).error;
  return typeof message === "string" && message.trim() ? message : fallback;
};

export const uploadImportedPet = async (selection: PetImportSelection, replace = false) => {
  const form = new FormData();
  form.append("manifest", JSON.stringify(selection.manifest));
  form.append("spritesheet", selection.image, selection.image.name);
  const response = await authFetch(`/api/pets${replace ? "?replace=true" : ""}`, {
    method: "POST",
    body: form,
  });
  const payload = await response.json().catch(() => null) as PetMutationPayload | null;
  if (!response.ok) {
    throw new PetUploadError(errorMessage(payload, `Pet import failed with HTTP ${response.status}.`), response.status);
  }
  if (!payload?.pet) throw new PetUploadError("The server did not return the installed pet.", 502);
  return payload.pet;
};

export const clearLegacyPetDatabase = () => new Promise<void>((resolve) => {
  if (typeof window === "undefined" || !window.indexedDB) {
    resolve();
    return;
  }
  const request = window.indexedDB.deleteDatabase(legacyDatabaseName);
  request.onsuccess = () => resolve();
  request.onerror = () => resolve();
  request.onblocked = () => resolve();
});

export const petSpriteUrl = (id: string) => {
  const pathname = `/api/pets/${encodeURIComponent(id)}/spritesheet`;
  if (typeof window === "undefined") return pathname;
  const token = authToken();
  if (!token) return pathname;
  const url = new URL(pathname, window.location.origin);
  url.searchParams.set("codexhub_token", token);
  return `${url.pathname}${url.search}`;
};

export const installedPetDefinition = (manifest: PetManifest): PetDefinition => ({
  ...manifest,
  kind: "imported",
  spriteUrl: petSpriteUrl(manifest.id),
});

export const redSparkPet: PetDefinition = {
  id: defaultPetId,
  displayName: "Red Spark",
  description: "A red-hatted chibi adventurer companion with a backpack, map, and white mascot bomb.",
  spriteVersionNumber: 2,
  spritesheetPath: "spritesheet.webp",
  kind: "builtin",
  spriteUrl: redSparkSpriteUrl,
};

export const builtinPet = redSparkPet;
export const builtinPets = [redSparkPet] as const;
