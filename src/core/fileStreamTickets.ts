import { randomUUID } from "node:crypto";

export type FileStreamTicketInput = {
  machineId: string;
  path: string;
  size: number;
  modifiedAtMs: number;
  contentType: "video/mp4";
};

export type FileStreamTicket = FileStreamTicketInput & {
  ticketId: string;
  expiresAtMs: number;
};

export class FileStreamTicketStore {
  private readonly tickets = new Map<string, FileStreamTicket>();
  private readonly ttlMs: number;
  private readonly maxTickets: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; maxTickets?: number; now?: () => number } = {}) {
    this.ttlMs = positiveInteger(options.ttlMs, 30 * 60_000);
    this.maxTickets = positiveInteger(options.maxTickets, 128);
    this.now = options.now ?? Date.now;
  }

  create(input: FileStreamTicketInput) {
    this.purgeExpired();
    while (this.tickets.size >= this.maxTickets) {
      const oldest = this.tickets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tickets.delete(oldest);
    }
    const ticket: FileStreamTicket = {
      ...input,
      ticketId: randomUUID(),
      expiresAtMs: this.now() + this.ttlMs
    };
    this.tickets.set(ticket.ticketId, ticket);
    return ticket;
  }

  get(ticketId: string) {
    this.purgeExpired();
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return null;
    ticket.expiresAtMs = this.now() + this.ttlMs;
    return ticket;
  }

  delete(ticketId: string) {
    return this.tickets.delete(ticketId);
  }

  private purgeExpired() {
    const now = this.now();
    for (const [ticketId, ticket] of this.tickets) {
      if (ticket.expiresAtMs <= now) this.tickets.delete(ticketId);
    }
  }
}

const positiveInteger = (value: number | undefined, fallback: number) =>
  Number.isInteger(value) && value! > 0 ? value! : fallback;
