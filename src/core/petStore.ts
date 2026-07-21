import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  PetImportInput,
  PetManifest,
  PetSpriteVersion,
} from "../shared/petTypes.js";

const maxImageBytes = 20 * 1024 * 1024;
const reservedPetIds = new Set(["red-spark"]);
const petIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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

type InspectedPetImage = {
  contentType: "image/png" | "image/webp";
  height: number;
  width: number;
};

export type ResolvedPetImage = InspectedPetImage & {
  path: string;
  size: number;
};

export class PetStoreError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "PetStoreError";
    this.statusCode = statusCode;
  }
}

const readUint24LE = (buffer: Buffer, offset: number) =>
  buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);

const inspectPng = (header: Buffer): InspectedPetImage | null => {
  if (header.length < 24 || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return null;
  }
  return {
    contentType: "image/png",
    width: header.readUInt32BE(16),
    height: header.readUInt32BE(20),
  };
};

const inspectWebp = (header: Buffer): InspectedPetImage | null => {
  if (header.length < 30 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const kind = header.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    return {
      contentType: "image/webp",
      width: readUint24LE(header, 24) + 1,
      height: readUint24LE(header, 27) + 1,
    };
  }
  if (kind === "VP8L" && header[20] === 0x2f) {
    return {
      contentType: "image/webp",
      width: 1 + header[21]! + ((header[22]! & 0x3f) << 8),
      height: 1 + (header[22]! >> 6) + (header[23]! << 2) + ((header[24]! & 0x0f) << 10),
    };
  }
  if (kind === "VP8 " && header[23] === 0x9d && header[24] === 0x01 && header[25] === 0x2a) {
    return {
      contentType: "image/webp",
      width: header.readUInt16LE(26) & 0x3fff,
      height: header.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
};

const inspectImageHeader = (header: Buffer) => inspectPng(header) ?? inspectWebp(header);

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
  const manifest = manifestSchema.parse(value);
  if (path.basename(manifest.spritesheetPath) !== manifest.spritesheetPath) {
    throw new PetStoreError("spritesheetPath must be a filename without directories.");
  }
  if (reservedPetIds.has(manifest.id)) {
    throw new PetStoreError(`Pet id ${manifest.id} is reserved by CodexHub.`, 409);
  }
  return manifest;
};

const decodeBase64 = (value: string) => {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new PetStoreError("The pet spritesheet is not valid base64 data.");
  }
  const buffer = Buffer.from(value, "base64");
  if (!buffer.length || buffer.length > maxImageBytes) {
    throw new PetStoreError("Pet spritesheets must be 20 MiB or smaller.");
  }
  return buffer;
};

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

  async list(): Promise<PetManifest[]> {
    let entries;
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const pets = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && petIdPattern.test(entry.name) && !reservedPetIds.has(entry.name))
      .map(async (entry) => {
        try {
          const manifest = parseManifest(JSON.parse(await fs.readFile(path.join(this.root, entry.name, "pet.json"), "utf8")));
          if (manifest.id !== entry.name) return null;
          await this.resolveImage(manifest.id, manifest);
          return manifest;
        } catch {
          return null;
        }
      }));
    return pets.filter((pet): pet is PetManifest => Boolean(pet))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  async install(input: PetImportInput): Promise<PetManifest> {
    const manifest = parseManifest(input.manifest);
    const image = decodeBase64(input.imageBase64);
    const inspected = inspectImageHeader(image.subarray(0, 32));
    if (!inspected) throw new PetStoreError("The pet spritesheet is not a valid PNG or WebP image.");
    if (input.mimeType !== inspected.contentType) {
      throw new PetStoreError(`The spritesheet content does not match ${input.mimeType}.`);
    }
    assertImageContract(inspected, manifest);

    const directory = path.join(this.root, manifest.id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new PetStoreError(`Pet directory ${manifest.id} must not be a symbolic link.`, 409);
    }
    await fs.chmod(directory, 0o700);
    const nonce = `${process.pid}-${Date.now()}`;
    const imagePath = path.join(directory, manifest.spritesheetPath);
    const manifestPath = path.join(directory, "pet.json");
    const temporaryImagePath = `${imagePath}.${nonce}.tmp`;
    const temporaryManifestPath = `${manifestPath}.${nonce}.tmp`;
    try {
      await fs.writeFile(temporaryImagePath, image, { mode: 0o600 });
      await fs.writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporaryImagePath, imagePath);
      await fs.rename(temporaryManifestPath, manifestPath);
      await Promise.all((await fs.readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.(png|webp)$/i.test(entry.name) && entry.name !== manifest.spritesheetPath)
        .map((entry) => fs.rm(path.join(directory, entry.name), { force: true })));
      await Promise.all([fs.chmod(imagePath, 0o600), fs.chmod(manifestPath, 0o600)]);
    } finally {
      await Promise.all([
        fs.rm(temporaryImagePath, { force: true }),
        fs.rm(temporaryManifestPath, { force: true }),
      ]);
    }
    return manifest;
  }

  async delete(id: string): Promise<boolean> {
    this.assertCustomId(id);
    try {
      await fs.rm(path.join(this.root, id), { recursive: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async resolveImage(id: string, knownManifest?: PetManifest): Promise<ResolvedPetImage> {
    this.assertCustomId(id);
    const directory = path.join(this.root, id);
    const manifest = knownManifest ?? parseManifest(JSON.parse(await fs.readFile(path.join(directory, "pet.json"), "utf8")));
    if (manifest.id !== id) throw new PetStoreError("Pet manifest id does not match its directory.");
    const imagePath = path.join(directory, manifest.spritesheetPath);
    const imageStat = await fs.lstat(imagePath);
    if (!imageStat.isFile() || imageStat.isSymbolicLink()) {
      throw new PetStoreError("Pet spritesheets must be regular files.");
    }
    const file = await fs.open(imagePath, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxImageBytes) {
        throw new PetStoreError("Pet spritesheets must be 20 MiB or smaller.");
      }
      const header = Buffer.alloc(32);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      const inspected = inspectImageHeader(header.subarray(0, bytesRead));
      if (!inspected) throw new PetStoreError("The pet spritesheet is not a valid PNG or WebP image.");
      assertImageContract(inspected, manifest);
      return { ...inspected, path: imagePath, size: stat.size };
    } finally {
      await file.close();
    }
  }

  private assertCustomId(id: string) {
    if (!petIdPattern.test(id)) throw new PetStoreError("Invalid pet id.");
    if (reservedPetIds.has(id)) throw new PetStoreError(`Pet id ${id} is reserved by CodexHub.`, 409);
  }
}
