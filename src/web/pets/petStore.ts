import { petAtlas } from "./petAtlas.js";

export type PetManifest = {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
};

export type StoredPet = PetManifest & {
  blob: Blob;
  mimeType: string;
  installedAt: string;
};

export type PetDefinition = PetManifest & {
  kind: "builtin" | "imported";
  spriteUrl?: string;
};

const databaseName = "codexhub-pets-v1";
const storeName = "pets";

const requestResult = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Pet database request failed."));
});

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  if (!window.indexedDB) {
    reject(new Error("This browser does not support persistent pet storage."));
    return;
  }
  const request = window.indexedDB.open(databaseName, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: "id" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Unable to open the pet database."));
});

const withStore = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
  const database = await openDatabase();
  try {
    return await requestResult(action(database.transaction(storeName, mode).objectStore(storeName)));
  } finally {
    database.close();
  }
};

export const loadStoredPets = () => withStore("readonly", (store) => store.getAll() as IDBRequest<StoredPet[]>);

export const saveStoredPet = (pet: StoredPet) => withStore("readwrite", (store) => store.put(pet));

export const deleteStoredPet = (id: string) => withStore("readwrite", (store) => store.delete(id));

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
  if (id === "codexhub-spud") throw new Error("That pet id is reserved by CodexHub.");
  const spritesheetPath = nonEmptyString(record?.spritesheetPath) || fallbackImageName;
  if (spritesheetPath.split(/[\\/]/).pop() !== fallbackImageName) {
    throw new Error(`pet.json expects ${spritesheetPath}, but ${fallbackImageName} was selected.`);
  }
  return {
    id,
    displayName: nonEmptyString(record?.displayName) || fallbackName,
    description: nonEmptyString(record?.description) || "Imported Codex-compatible pet",
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

export const importedPetFromFiles = async (files: File[]): Promise<StoredPet> => {
  const image = files.find((file) => file.type === "image/png" || file.type === "image/webp" || /\.(png|webp)$/i.test(file.name));
  if (!image) throw new Error("Choose a PNG or WebP spritesheet.");
  if (image.size > petAtlas.maxBytes) throw new Error("Pet spritesheets must be 20 MiB or smaller.");
  const dimensions = await imageDimensions(image);
  if (dimensions.width !== petAtlas.width || dimensions.height !== petAtlas.height) {
    throw new Error(`Pet spritesheets must be exactly ${petAtlas.width} x ${petAtlas.height} pixels.`);
  }

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
  return {
    ...manifest,
    blob: image,
    mimeType: image.type || (/\.png$/i.test(image.name) ? "image/png" : "image/webp"),
    installedAt: new Date().toISOString(),
  };
};

export const builtinPet: PetDefinition = {
  id: "codexhub-spud",
  displayName: "小地瓜",
  description: "CodexHub built-in test pet",
  spritesheetPath: "",
  kind: "builtin",
};
