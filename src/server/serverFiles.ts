import { createReadStream } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";

export const registerStaticRoutes = (app: FastifyInstance, root: string) => {
  const sendIndex = async (_request: unknown, reply: any) => {
    const indexPath = path.join(root, "index.html");
    if (!await fileExists(indexPath)) {
      reply.code(404);
      return { error: "dist_index_not_found", path: indexPath };
    }
    reply.type("text/html; charset=utf-8");
    reply.header("cache-control", "no-cache");
    return reply.send(createReadStream(indexPath));
  };

  app.get("/", sendIndex);
  app.get("/*", async (request, reply) => {
    const rawPath = (request.params as { "*": string })["*"] ?? "";
    if (rawPath === "api" || rawPath.startsWith("api/")) {
      reply.code(404);
      return { error: "api_route_not_found", path: `/${rawPath}` };
    }
    const requested = path.resolve(root, rawPath);
    if (!requested.startsWith(`${root}${path.sep}`)) {
      reply.code(403);
      return { error: "forbidden_path" };
    }
    if (await fileExists(requested)) {
      reply.type(contentType(requested));
      return reply.send(createReadStream(requested));
    }
    return sendIndex(request, reply);
  });
};

const fileExists = async (filePath: string) => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const maxPreviewImageBytes = () => {
  const raw = process.env.CODEX_HUB_MAX_PREVIEW_IMAGE_BYTES;
  if (raw === undefined || raw === "") return 50 * 1024 * 1024;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 50 * 1024 * 1024;
};

export const resolvePreviewImage = async (inputPath: string) => {
  const rawPath = normalizePreviewImagePath(inputPath);
  const resolvedPath = await realpath(rawPath);
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) {
    throw previewImageError("file_not_found", 404);
  }
  if (fileStat.size <= 0) {
    throw previewImageError("empty_file", 415);
  }
  const maxBytes = maxPreviewImageBytes();
  if (fileStat.size > maxBytes) {
    throw previewImageError("file_too_large", 413);
  }
  const contentType = await sniffPreviewImageType(resolvedPath, fileStat.size);
  if (!contentType) {
    throw previewImageError("unsupported_image_type", 415);
  }
  return { path: resolvedPath, contentType, size: fileStat.size };
};

const normalizePreviewImagePath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\0")) {
    throw previewImageError("invalid_path", 400);
  }
  const normalized = process.platform === "win32" ? trimmed : windowsDrivePathToWslPath(trimmed);
  if (!path.isAbsolute(normalized)) {
    throw previewImageError("absolute_path_required", 400);
  }
  return normalized;
};

const windowsDrivePathToWslPath = (value: string) => {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(value);
  if (!match) return value;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/[\\/]+/g, "/")}`;
};

// Use file signatures instead of extensions so renamed text or binary files cannot be rendered through /api/file.
const sniffPreviewImageType = async (filePath: string, fileSize: number) => {
  const headerLength = Math.min(fileSize, 64);
  const buffer = Buffer.alloc(headerLength);
  const file = await open(filePath, "r");
  try {
    await file.read(buffer, 0, headerLength, 0);
  } finally {
    await file.close();
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
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

const previewImageError = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

export const previewImageErrorStatus = (error: unknown) => {
  const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : undefined;
  return statusCode && statusCode >= 400 && statusCode < 600 ? statusCode : 404;
};

export const contentType = (filePath: string) => {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".ico") return "image/x-icon";
  return "application/octet-stream";
};
