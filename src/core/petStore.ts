import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  builtinPetIds,
  petIdPattern,
  type InvalidPetPackage,
  type PetManifest,
  type PetSpriteVersion,
  type PetsPayload,
} from "../shared/petTypes.js";
import { inspectPetImage, PetImageValidationError, type InspectedPetImage } from "./petImage.js";

export const maxPetImageBytes = 20 * 1024 * 1024;
const reservedPetIds = new Set<string>(builtinPetIds);

const manifestSchema = z.object({
  id: z.string().regex(petIdPattern),
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1_000),
  spriteVersionNumber: z.union([z.literal(1), z.literal(2)]),
  spritesheetPath: z.string().trim().min(1).max(255),
}).strict();

const expectedDimensions = (version: PetSpriteVersion) => version === 2
  ? { width: 1536, height: 2288 }
  : { width: 1536, height: 1872 };

export type ResolvedPetImage = InspectedPetImage & {
  path: string;
  size: number;
};

export type PetInstallInput = {
  image: Buffer;
  manifest: unknown;
  replace?: boolean;
};

export type PetFileInstallInput = {
  imagePath: string;
  manifest: unknown;
  replace?: boolean;
};

export class PetStoreError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "PetStoreError";
    this.statusCode = statusCode;
  }
}

const assertImageContract = (image: InspectedPetImage, manifest: PetManifest) => {
  const expected = expectedDimensions(manifest.spriteVersionNumber);
  if (image.width !== expected.width || image.height !== expected.height) {
    throw new PetStoreError(
      `Version ${manifest.spriteVersionNumber} pet spritesheets must be exactly ${expected.width} x ${expected.height} pixels.`
    );
  }
  const extension = path.extname(manifest.spritesheetPath).toLowerCase();
  if ((image.contentType === "image/png" && extension !== ".png")
    || (image.contentType === "image/webp" && extension !== ".webp")) {
    throw new PetStoreError(`The spritesheet extension does not match ${image.contentType}.`);
  }
};

const parseManifest = (value: unknown): PetManifest => {
  let manifest: PetManifest;
  try {
    manifest = manifestSchema.parse(value);
  } catch {
    throw new PetStoreError("pet.json does not match the Codex pet manifest contract.");
  }
  if (path.basename(manifest.spritesheetPath) !== manifest.spritesheetPath) {
    throw new PetStoreError("spritesheetPath must be a filename without directories.");
  }
  if (reservedPetIds.has(manifest.id)) {
    throw new PetStoreError(`Pet id ${manifest.id} is reserved by CodexHub.`, 409);
  }
  return manifest;
};

const inspectImage = (image: Buffer) => {
  if (!image.length || image.length > maxPetImageBytes) {
    throw new PetStoreError("Pet spritesheets must be 20 MiB or smaller.");
  }
  try {
    return inspectPetImage(image);
  } catch (error) {
    if (error instanceof PetImageValidationError) throw new PetStoreError(error.message);
    throw error;
  }
};

const diagnosticMessage = (error: unknown) => {
  if (error instanceof PetStoreError) return error.message;
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return "pet.json or the configured spritesheet is missing.";
  if (error instanceof SyntaxError) return "pet.json is not valid JSON.";
  return "CodexHub could not read this pet package.";
};

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export const resolveCodexPetsRoot = (env: NodeJS.ProcessEnv = process.env, homeDirectory = os.homedir()) => {
  const configured = env.CODEX_HOME?.trim();
  const codexHome = configured ? path.resolve(configured) : path.join(homeDirectory, ".codex");
  return path.join(codexHome, "pets");
};

export class CodexPetStore {
  readonly root: string;

  constructor(root = resolveCodexPetsRoot()) {
    this.root = path.resolve(root);
  }

  async list(): Promise<PetsPayload> {
    let entries;
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return { pets: [], invalidPets: [] };
      throw error;
    }
    const candidates = entries.filter((entry) => entry.isDirectory()
      && !entry.name.startsWith(".")
      && !reservedPetIds.has(entry.name));
    const scanned = await Promise.all(candidates.map(async (entry) => {
      if (!petIdPattern.test(entry.name)) {
        return {
          invalid: { id: entry.name, error: "The directory name is not a valid pet id." } satisfies InvalidPetPackage,
        };
      }
      try {
        const manifest = parseManifest(JSON.parse(await fs.readFile(path.join(this.root, entry.name, "pet.json"), "utf8")));
        if (manifest.id !== entry.name) throw new PetStoreError("The manifest id does not match its directory name.");
        await this.resolveImage(manifest.id, manifest);
        return { pet: manifest };
      } catch (error) {
        return { invalid: { id: entry.name, error: diagnosticMessage(error) } satisfies InvalidPetPackage };
      }
    }));
    return {
      pets: scanned.flatMap((item) => item.pet ? [item.pet] : [])
        .sort((left, right) => left.displayName.localeCompare(right.displayName)),
      invalidPets: scanned.flatMap((item) => item.invalid ? [item.invalid] : [])
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  async install(input: PetInstallInput): Promise<PetManifest> {
    const manifest = parseManifest(input.manifest);
    const inspected = inspectImage(input.image);
    assertImageContract(inspected, manifest);
    return this.persistValidatedImage(manifest, input.image, input.replace === true);
  }

  async installFromFile(input: PetFileInstallInput): Promise<PetManifest> {
    const sourceStat = await fs.lstat(input.imagePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size <= 0 || sourceStat.size > maxPetImageBytes) {
      throw new PetStoreError("Pet spritesheets must be regular files no larger than 20 MiB.");
    }
    return this.install({
      image: await fs.readFile(input.imagePath),
      manifest: input.manifest,
      replace: input.replace,
    });
  }

  async delete(id: string): Promise<boolean> {
    this.assertCustomId(id);
    const directory = path.join(this.root, id);
    let stat;
    try {
      stat = await fs.lstat(directory);
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new PetStoreError(`Pet directory ${id} must be a regular directory.`, 409);
    }
    await this.moveToTrash(directory, id, "deleted");
    return true;
  }

  async resolveImage(id: string, knownManifest?: PetManifest): Promise<ResolvedPetImage> {
    this.assertCustomId(id);
    const directory = path.join(this.root, id);
    const manifest = knownManifest ?? parseManifest(JSON.parse(await fs.readFile(path.join(directory, "pet.json"), "utf8")));
    if (manifest.id !== id) throw new PetStoreError("Pet manifest id does not match its directory.");
    const imagePath = path.join(directory, manifest.spritesheetPath);
    const imageStat = await fs.lstat(imagePath);
    if (!imageStat.isFile() || imageStat.isSymbolicLink() || imageStat.size <= 0 || imageStat.size > maxPetImageBytes) {
      throw new PetStoreError("Pet spritesheets must be regular files no larger than 20 MiB.");
    }
    const image = await fs.readFile(imagePath);
    if (image.length !== imageStat.size) throw new PetStoreError("The pet spritesheet changed while it was being validated.", 409);
    const inspected = inspectImage(image);
    assertImageContract(inspected, manifest);
    return { ...inspected, path: imagePath, size: imageStat.size };
  }

  private async persistValidatedImage(manifest: PetManifest, image: Buffer, replace: boolean) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
    const destination = path.join(this.root, manifest.id);
    let existing = false;
    try {
      const stat = await fs.lstat(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new PetStoreError(`Pet directory ${manifest.id} must be a regular directory.`, 409);
      }
      existing = true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (existing && !replace) {
      throw new PetStoreError(`A pet with id ${manifest.id} is already installed. Confirm replacement to overwrite it.`, 409);
    }

    const temporaryDirectory = await fs.mkdtemp(path.join(this.root, `.${manifest.id}.install-`));
    let previousTrashPath: string | null = null;
    try {
      await fs.chmod(temporaryDirectory, 0o700);
      const imagePath = path.join(temporaryDirectory, manifest.spritesheetPath);
      const manifestPath = path.join(temporaryDirectory, "pet.json");
      await fs.writeFile(imagePath, image, { mode: 0o600, flag: "wx" });
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      if (existing) previousTrashPath = await this.moveToTrash(destination, manifest.id, "replaced");
      try {
        await fs.rename(temporaryDirectory, destination);
      } catch (error) {
        if (previousTrashPath) await fs.rename(previousTrashPath, destination).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
          throw new PetStoreError(`A pet with id ${manifest.id} is already installed.`, 409);
        }
        throw error;
      }
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
    return manifest;
  }

  private async moveToTrash(directory: string, id: string, reason: "deleted" | "replaced") {
    const trashRoot = path.join(this.root, ".trash");
    await fs.mkdir(trashRoot, { recursive: true, mode: 0o700 });
    const trashStat = await fs.lstat(trashRoot);
    if (!trashStat.isDirectory() || trashStat.isSymbolicLink()) {
      throw new PetStoreError("The Codex pet trash location must be a regular directory.", 409);
    }
    await fs.chmod(trashRoot, 0o700);
    const destination = path.join(trashRoot, `${id}-${Date.now()}-${reason}-${randomUUID()}`);
    await fs.rename(directory, destination);
    return destination;
  }

  private assertCustomId(id: string) {
    if (!petIdPattern.test(id)) throw new PetStoreError("Invalid pet id.");
    if (reservedPetIds.has(id)) throw new PetStoreError(`Pet id ${id} is reserved by CodexHub.`, 409);
  }
}
