import type { FastifyInstance, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { maxMachineFileChunkBytes } from "../core/filePreview.js";
import { FileStreamTicketStore, type FileStreamTicket } from "../core/fileStreamTickets.js";
import type { MachineHub } from "../core/machineHub.js";
import type { FilePreviewPayload } from "../shared/apiContract.js";

export type FileStreamRoutesContext = {
  machines: MachineHub;
};

export type FileByteRange = {
  start: number;
  end: number;
  partial: boolean;
};

export const registerFileStreamRoutes = (app: FastifyInstance, ctx: FileStreamRoutesContext) => {
  const tickets = new FileStreamTicketStore({ ttlMs: fileStreamTicketTtlMs() });

  app.post("/api/machines/:machineId/files/preview", async (request, reply) => {
    const params = z.object({ machineId: z.string().min(1) }).parse(request.params);
    const input = z.object({ path: z.string().min(1) }).strict().parse(request.body);
    try {
      const preview = await ctx.machines.previewFile(params.machineId, input).promise;
      if (preview.kind !== "media") return preview satisfies FilePreviewPayload;
      const ticket = tickets.create({
        machineId: params.machineId,
        path: preview.path,
        size: preview.size,
        modifiedAtMs: preview.modifiedAtMs,
        contentType: preview.contentType
      });
      return {
        ...preview,
        streamUrl: `/api/file-stream/${ticket.ticketId}`,
        expiresAt: new Date(ticket.expiresAtMs).toISOString()
      } satisfies FilePreviewPayload;
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/file-stream/:ticketId", async (request, reply) => {
    const params = z.object({ ticketId: z.string().uuid() }).parse(request.params);
    const ticket = tickets.get(params.ticketId);
    if (!ticket) return reply.code(404).send({ error: "file_stream_ticket_not_found" });
    const range = parseFileByteRange(request.headers.range, ticket.size);
    if (!range) {
      reply.header("content-range", `bytes */${ticket.size}`);
      return reply.code(416).send({ error: "invalid_file_range" });
    }
    applyFileStreamHeaders(reply, ticket, range);
    if (request.method === "HEAD") return sendFileStreamHead(reply);
    return reply.send(Readable.from(streamMachineFileRange(ctx.machines, ticket, range)));
  });

  app.delete("/api/file-stream/:ticketId", async (request) => {
    const params = z.object({ ticketId: z.string().uuid() }).parse(request.params);
    return { deleted: tickets.delete(params.ticketId) };
  });
};

export const parseFileByteRange = (header: string | undefined, size: number): FileByteRange | null => {
  if (!Number.isInteger(size) || size <= 0) return null;
  if (!header) return { start: 0, end: size - 1, partial: false };
  if (header.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
      partial: true
    };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    return null;
  }
  return {
    start,
    end: Math.min(requestedEnd, size - 1),
    partial: true
  };
};

const applyFileStreamHeaders = (
  reply: FastifyReply,
  ticket: FileStreamTicket,
  range: FileByteRange
) => {
  const contentLength = range.end - range.start + 1;
  reply.code(range.partial ? 206 : 200);
  reply.type(ticket.contentType);
  reply.header("accept-ranges", "bytes");
  reply.header("cache-control", "private, no-store");
  reply.header("content-length", String(contentLength));
  reply.header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(fileStreamFilename(ticket.path))}`);
  reply.header("cross-origin-resource-policy", "same-origin");
  reply.header("x-content-type-options", "nosniff");
  if (range.partial) reply.header("content-range", `bytes ${range.start}-${range.end}/${ticket.size}`);
};

export const fileStreamFilename = (filePath: string) =>
  filePath.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || "media";

const sendFileStreamHead = (reply: FastifyReply) => {
  const statusCode = reply.statusCode;
  const headers = reply.getHeaders();
  reply.hijack();
  reply.raw.statusCode = statusCode;
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
  reply.raw.end();
  return reply;
};

const streamMachineFileRange = async function* (
  machines: MachineHub,
  ticket: FileStreamTicket,
  range: FileByteRange
) {
  let offset = range.start;
  while (offset <= range.end) {
    const requestedLength = Math.min(maxMachineFileChunkBytes, range.end - offset + 1);
    const chunk = await machines.readFileChunk(ticket.machineId, {
      path: ticket.path,
      offset,
      length: requestedLength,
      expectedSize: ticket.size,
      expectedModifiedAtMs: ticket.modifiedAtMs
    }).promise;
    if (
      chunk.path !== ticket.path
      || chunk.size !== ticket.size
      || chunk.modifiedAtMs !== ticket.modifiedAtMs
      || chunk.offset !== offset
    ) {
      throw new Error("file_stream_chunk_mismatch");
    }
    const contents = Buffer.from(chunk.base64, "base64");
    if (!contents.length || contents.length > requestedLength) throw new Error("file_stream_unexpected_eof");
    yield contents;
    offset += contents.length;
  }
};

const fileStreamTicketTtlMs = () => {
  const value = Number(process.env.CODEX_HUB_FILE_STREAM_TICKET_TTL_MS);
  return Number.isInteger(value) && value > 0 ? value : 30 * 60_000;
};
