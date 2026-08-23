import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { isWslEnvironment } from "../shared/surfaceTypes.js";
import type {
  MachineFileChunkResult,
  MachineFilePreviewMediaContentType,
  MachineFilePreviewResult
} from "../shared/machineTypes.js";

const defaultMaxFilePreviewBytes = 2 * 1024 * 1024;
const previewSignatureBytes = 4096;
export const maxMachineFileChunkBytes = 1024 * 1024;

export type ResolveMachineFilePreviewOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  maxBytes?: number;
};

export const resolveMachineFilePreview = async (
  inputPath: string,
  options: ResolveMachineFilePreviewOptions = {}
): Promise<MachineFilePreviewResult> => {
  const filePath = normalizeMachineFilePreviewPath(inputPath, options);
  const resolvedPath = await realpath(filePath);
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) throw new Error("file_not_found");

  const maxBytes = options.maxBytes ?? maxMachineFilePreviewBytes(options.env);
  const header = await readFilePrefix(resolvedPath, Math.min(fileStat.size, previewSignatureBytes));
  const imageContentType = sniffPreviewImageType(header);
  if (imageContentType) {
    if (fileStat.size > maxBytes) {
      return {
        kind: "unsupported",
        path: resolvedPath,
        size: fileStat.size,
        reason: "file_too_large",
        maxBytes
      };
    }
    const contents = await readFilePrefix(resolvedPath, fileStat.size);
    return {
      kind: "image",
      path: resolvedPath,
      size: fileStat.size,
      contentType: imageContentType,
      base64: contents.toString("base64")
    };
  }

  const mediaContentType = sniffPreviewMediaType(header);
  if (mediaContentType) {
    return {
      kind: "media",
      path: resolvedPath,
      size: fileStat.size,
      modifiedAtMs: Math.trunc(fileStat.mtimeMs),
      contentType: mediaContentType
    };
  }

  const previewBytes = await readFilePrefix(resolvedPath, Math.min(fileStat.size, maxBytes));
  const text = decodePreviewText(previewBytes, fileStat.size > previewBytes.length);
  if (text !== null) {
    return {
      kind: "text",
      path: resolvedPath,
      size: fileStat.size,
      contentType: "text/plain; charset=utf-8",
      text,
      truncated: fileStat.size > previewBytes.length
    };
  }

  return {
    kind: "unsupported",
    path: resolvedPath,
    size: fileStat.size,
    reason: "unsupported_type"
  };
};

export type ReadMachineFileChunkInput = {
  path: string;
  offset: number;
  length: number;
  expectedSize: number;
  expectedModifiedAtMs: number;
};

export const readMachineFileChunk = async (
  input: ReadMachineFileChunkInput
): Promise<MachineFileChunkResult> => {
  if (!Number.isInteger(input.offset) || input.offset < 0) throw new Error("invalid_file_offset");
  if (!Number.isInteger(input.length) || input.length <= 0 || input.length > maxMachineFileChunkBytes) {
    throw new Error("invalid_file_chunk_length");
  }
  const filePath = normalizeMachineFilePreviewPath(input.path);
  const resolvedPath = await realpath(filePath);
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) throw new Error("file_not_found");
  const modifiedAtMs = Math.trunc(fileStat.mtimeMs);
  if (fileStat.size !== input.expectedSize || modifiedAtMs !== input.expectedModifiedAtMs) {
    throw new Error("file_changed");
  }
  if (input.offset >= fileStat.size) {
    return {
      path: resolvedPath,
      size: fileStat.size,
      modifiedAtMs,
      offset: input.offset,
      base64: "",
      eof: true
    };
  }
  const contents = await readFileSlice(
    resolvedPath,
    input.offset,
    Math.min(input.length, fileStat.size - input.offset)
  );
  return {
    path: resolvedPath,
    size: fileStat.size,
    modifiedAtMs,
    offset: input.offset,
    base64: contents.toString("base64"),
    eof: input.offset + contents.length >= fileStat.size
  };
};

export const normalizeMachineFilePreviewPath = (
  value: string,
  options: Pick<ResolveMachineFilePreviewOptions, "env" | "platform"> = {}
) => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) throw new Error("invalid_path");
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const normalized = platform !== "win32" && isWslEnvironment(env, platform)
    ? windowsDrivePathToWslPath(trimmed)
    : trimmed;
  if (!pathForPlatform(platform).isAbsolute(normalized)) throw new Error("absolute_path_required");
  return normalized;
};

const pathForPlatform = (platform: NodeJS.Platform) => platform === "win32" ? path.win32 : path.posix;

const windowsDrivePathToWslPath = (value: string) => {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(value);
  if (!match) return value;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/[\\/]+/g, "/")}`;
};

const maxMachineFilePreviewBytes = (env: NodeJS.ProcessEnv = process.env) => {
  const raw = env.CODEX_HUB_MAX_FILE_PREVIEW_BYTES;
  if (raw === undefined || raw === "") return defaultMaxFilePreviewBytes;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : defaultMaxFilePreviewBytes;
};

const readFilePrefix = async (filePath: string, length: number) => await readFileSlice(filePath, 0, length);

const readFileSlice = async (filePath: string, start: number, length: number) => {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const file = await open(filePath, "r");
  let readOffset = 0;
  try {
    while (readOffset < length) {
      const result = await file.read(buffer, readOffset, length - readOffset, start + readOffset);
      if (!result.bytesRead) break;
      readOffset += result.bytesRead;
    }
  } finally {
    await file.close();
  }
  return readOffset === length ? buffer : buffer.subarray(0, readOffset);
};

const decodePreviewText = (buffer: Buffer, truncated: boolean) => {
  if (hasBinaryControlBytes(buffer)) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const attempts = truncated ? Math.min(3, buffer.length) : 0;
  for (let trim = 0; trim <= attempts; trim += 1) {
    try {
      return decoder.decode(trim ? buffer.subarray(0, buffer.length - trim) : buffer);
    } catch {
      // A truncated UTF-8 code point can span up to four bytes. Retry without its trailing bytes.
    }
  }
  return null;
};

const hasBinaryControlBytes = (buffer: Buffer) => {
  for (const byte of buffer) {
    if (byte === 0 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) return true;
  }
  return false;
};

const sniffPreviewImageType = (buffer: Buffer) => {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  const ascii = buffer.toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (ascii.startsWith("BM")) return "image/bmp";
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) return "image/x-icon";
  if (isAvifImage(buffer)) return "image/avif";
  return null;
};

const isAvifImage = (buffer: Buffer) => {
  if (buffer.length < 12 || buffer.subarray(4, 8).toString("ascii") !== "ftyp") return false;
  const brands = buffer.subarray(8).toString("ascii");
  return brands.includes("avif") || brands.includes("avis");
};

const sniffPreviewMediaType = (buffer: Buffer): MachineFilePreviewMediaContentType | null => {
  if (isWaveAudio(buffer)) return "audio/wav";
  if (buffer.subarray(0, 4).toString("ascii") === "fLaC") return "audio/flac";
  if (isOggAudio(buffer)) return "audio/ogg";
  if (buffer.subarray(0, 3).toString("ascii") === "ID3") return "audio/mpeg";
  if (isAacAdtsAudio(buffer)) return "audio/aac";
  if (isMpegAudioFrame(buffer)) return "audio/mpeg";

  const brands = isoBaseMediaBrands(buffer);
  if (!brands) return null;
  const mp4AudioBrands = new Set(["M4A ", "M4B ", "M4P ", "F4A ", "F4B "]);
  if (brands.some((brand) => mp4AudioBrands.has(brand))) return "audio/mp4";
  const mp4Brands = new Set([
    "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9",
    "mp41", "mp42", "avc1", "M4V ", "MSNV", "dash", "cmfc", "cmfs"
  ]);
  return brands.some((brand) => mp4Brands.has(brand)) ? "video/mp4" : null;
};

const isWaveAudio = (buffer: Buffer) => {
  const container = buffer.subarray(0, 4).toString("ascii");
  return (container === "RIFF" || container === "RIFX" || container === "RF64")
    && buffer.subarray(8, 12).toString("ascii") === "WAVE";
};

const isOggAudio = (buffer: Buffer) => {
  if (buffer.length < 28 || buffer.subarray(0, 4).toString("ascii") !== "OggS") return false;
  const packetOffset = 27 + buffer[26]!;
  if (packetOffset >= buffer.length) return false;
  const packet = buffer.subarray(packetOffset);
  return packet.subarray(0, 8).toString("ascii") === "OpusHead"
    || (packet[0] === 0x01 && packet.subarray(1, 7).toString("ascii") === "vorbis");
};

const isAacAdtsAudio = (buffer: Buffer) =>
  buffer.length >= 2
  && buffer[0] === 0xff
  && (buffer[1]! & 0xf6) === 0xf0;

const isMpegAudioFrame = (buffer: Buffer) => {
  if (buffer.length < 4 || buffer[0] !== 0xff || (buffer[1]! & 0xe0) !== 0xe0) return false;
  const version = (buffer[1]! >> 3) & 0x03;
  const layer = (buffer[1]! >> 1) & 0x03;
  const bitrate = (buffer[2]! >> 4) & 0x0f;
  const sampleRate = (buffer[2]! >> 2) & 0x03;
  return version !== 0x01 && layer !== 0x00 && bitrate !== 0x00 && bitrate !== 0x0f && sampleRate !== 0x03;
};

const isoBaseMediaBrands = (buffer: Buffer) => {
  if (buffer.length < 12 || buffer.subarray(4, 8).toString("ascii") !== "ftyp") return null;
  const boxSize = buffer.readUInt32BE(0);
  if (boxSize !== 0 && boxSize < 12) return null;
  const boxEnd = boxSize === 0 ? buffer.length : Math.min(buffer.length, boxSize);
  const brands = [buffer.subarray(8, 12).toString("ascii")];
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    brands.push(buffer.subarray(offset, offset + 4).toString("ascii"));
  }
  return brands;
};
