import { inflateSync } from "node:zlib";

export type InspectedPetImage = {
  contentType: "image/png" | "image/webp";
  height: number;
  width: number;
};

export class PetImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PetImageValidationError";
  }
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxDecodedPngBytes = 128 * 1024 * 1024;

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) {
    current = (current & 1) ? (0xedb88320 ^ (current >>> 1)) : (current >>> 1);
  }
  return current >>> 0;
});

const crc32 = (buffer: Buffer) => {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const pngChannels = (colorType: number) => {
  if (colorType === 0 || colorType === 3) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  return 0;
};

const validPngBitDepth = (colorType: number, bitDepth: number) => {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  if (colorType === 2 || colorType === 4 || colorType === 6) return bitDepth === 8 || bitDepth === 16;
  return colorType === 3 && [1, 2, 4, 8].includes(bitDepth);
};

const adam7Passes = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

const passExtent = (size: number, start: number, step: number) =>
  size <= start ? 0 : Math.ceil((size - start) / step);

const pngScanlines = (
  width: number,
  height: number,
  bitsPerPixel: number,
  interlace: number,
) => {
  const passes = interlace === 0 ? [[0, 0, 1, 1] as const] : adam7Passes;
  return passes.flatMap(([x, y, stepX, stepY]) => {
    const passWidth = passExtent(width, x, stepX);
    const passHeight = passExtent(height, y, stepY);
    if (!passWidth || !passHeight) return [];
    return [{ rows: passHeight, rowBytes: Math.ceil((passWidth * bitsPerPixel) / 8) }];
  });
};

const inspectPng = (buffer: Buffer): InspectedPetImage => {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(pngSignature)) {
    throw new PetImageValidationError("The PNG signature or header is incomplete.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let sawHeader = false;
  let sawEnd = false;
  const imageData: Buffer[] = [];

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new PetImageValidationError("The PNG contains a truncated chunk.");
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > buffer.length) {
      throw new PetImageValidationError("The PNG contains an invalid chunk length.");
    }
    const type = buffer.toString("ascii", typeStart, dataStart);
    const expectedCrc = buffer.readUInt32BE(dataEnd);
    const actualCrc = crc32(buffer.subarray(typeStart, dataEnd));
    if (actualCrc !== expectedCrc) throw new PetImageValidationError(`The PNG ${type} chunk failed its CRC check.`);

    if (!sawHeader && type !== "IHDR") throw new PetImageValidationError("The PNG IHDR chunk must come first.");
    if (type === "IHDR") {
      if (sawHeader || length !== 13) throw new PetImageValidationError("The PNG has an invalid IHDR chunk.");
      sawHeader = true;
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8]!;
      colorType = buffer[dataStart + 9]!;
      interlace = buffer[dataStart + 12]!;
      if (!width || !height || width > 16_384 || height > 16_384) {
        throw new PetImageValidationError("The PNG dimensions are invalid or too large.");
      }
      if (!validPngBitDepth(colorType, bitDepth)
        || buffer[dataStart + 10] !== 0
        || buffer[dataStart + 11] !== 0
        || (interlace !== 0 && interlace !== 1)) {
        throw new PetImageValidationError("The PNG uses an unsupported pixel format.");
      }
    } else if (type === "IDAT") {
      imageData.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (length !== 0) throw new PetImageValidationError("The PNG IEND chunk must be empty.");
      sawEnd = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }

  if (!sawHeader || !imageData.length || !sawEnd || offset !== buffer.length) {
    throw new PetImageValidationError("The PNG is missing image data, its end marker, or contains trailing bytes.");
  }

  const channels = pngChannels(colorType);
  const scanlines = pngScanlines(width, height, channels * bitDepth, interlace);
  const expectedBytes = scanlines.reduce((total, pass) => total + pass.rows * (pass.rowBytes + 1), 0);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > maxDecodedPngBytes) {
    throw new PetImageValidationError("The decoded PNG would be too large.");
  }
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: maxDecodedPngBytes });
  } catch {
    throw new PetImageValidationError("The PNG image data could not be decoded.");
  }
  if (decoded.length !== expectedBytes) throw new PetImageValidationError("The PNG scanline data has an invalid length.");
  let decodedOffset = 0;
  for (const pass of scanlines) {
    for (let row = 0; row < pass.rows; row += 1) {
      if (decoded[decodedOffset]! > 4) throw new PetImageValidationError("The PNG contains an invalid row filter.");
      decodedOffset += pass.rowBytes + 1;
    }
  }
  return { contentType: "image/png", width, height };
};

const readUint24LE = (buffer: Buffer, offset: number) =>
  buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);

const inspectWebp = (buffer: Buffer): InspectedPetImage => {
  if (buffer.length < 20
    || buffer.toString("ascii", 0, 4) !== "RIFF"
    || buffer.toString("ascii", 8, 12) !== "WEBP") {
    throw new PetImageValidationError("The WebP RIFF header is incomplete.");
  }
  if (buffer.readUInt32LE(4) !== buffer.length - 8) {
    throw new PetImageValidationError("The WebP RIFF length does not match the file size.");
  }

  let offset = 12;
  let canvas: { width: number; height: number } | null = null;
  let image: { width: number; height: number } | null = null;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new PetImageValidationError("The WebP contains a truncated chunk header.");
    const kind = buffer.toString("ascii", offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length & 1);
    if (dataEnd < dataStart || paddedEnd > buffer.length) {
      throw new PetImageValidationError(`The WebP ${kind} chunk has an invalid length.`);
    }
    if (kind === "VP8X") {
      if (length !== 10) throw new PetImageValidationError("The WebP VP8X header has an invalid length.");
      canvas = {
        width: readUint24LE(buffer, dataStart + 4) + 1,
        height: readUint24LE(buffer, dataStart + 7) + 1,
      };
    } else if (kind === "VP8L") {
      if (length < 5 || buffer[dataStart] !== 0x2f) throw new PetImageValidationError("The WebP VP8L image header is invalid.");
      image = {
        width: 1 + buffer[dataStart + 1]! + ((buffer[dataStart + 2]! & 0x3f) << 8),
        height: 1 + (buffer[dataStart + 2]! >> 6) + (buffer[dataStart + 3]! << 2) + ((buffer[dataStart + 4]! & 0x0f) << 10),
      };
    } else if (kind === "VP8 ") {
      if (length < 10
        || buffer[dataStart + 3] !== 0x9d
        || buffer[dataStart + 4] !== 0x01
        || buffer[dataStart + 5] !== 0x2a) {
        throw new PetImageValidationError("The WebP VP8 image header is invalid.");
      }
      image = {
        width: buffer.readUInt16LE(dataStart + 6) & 0x3fff,
        height: buffer.readUInt16LE(dataStart + 8) & 0x3fff,
      };
    }
    offset = paddedEnd;
  }

  if (!image || !image.width || !image.height) {
    throw new PetImageValidationError("The WebP does not contain a supported still image.");
  }
  if (canvas && (canvas.width !== image.width || canvas.height !== image.height)) {
    throw new PetImageValidationError("The WebP canvas and image dimensions do not match.");
  }
  return { contentType: "image/webp", ...(canvas ?? image) };
};

export const inspectPetImage = (buffer: Buffer): InspectedPetImage => {
  if (buffer.subarray(0, 8).equals(pngSignature)) return inspectPng(buffer);
  if (buffer.toString("ascii", 0, 4) === "RIFF") return inspectWebp(buffer);
  throw new PetImageValidationError("The pet spritesheet is not a valid PNG or WebP image.");
};
