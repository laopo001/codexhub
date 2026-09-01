import { asRecord } from "../../shared/recordTypes.js";

export type RendererDiagnosticEvent = {
  receivedAt: string;
  type: string;
  seq?: number;
  threadId?: string;
  recordId?: string;
  recordType?: string;
  payloadType?: string;
  deltaField?: string;
  snapshot?: {
    page?: number;
    reset?: boolean;
    complete?: boolean;
  };
};

export type RendererDiagnosticContext = {
  activeThreadId?: string;
  openThreadIds: string[];
  serverInstanceId?: string;
  authorityId?: string;
  surface?: string;
};

export type RendererDiagnosticReport = {
  version: 1;
  capturedAt: string;
  error: {
    name: string;
    message: string;
    stack?: string;
    componentStack?: string;
  };
  context: RendererDiagnosticContext;
  recentRealtimeEvents: RendererDiagnosticEvent[];
};

const maxRecentRealtimeEvents = 24;
let recentRealtimeEvents: RendererDiagnosticEvent[] = [];
let diagnosticContext: RendererDiagnosticContext = { openThreadIds: [] };

const optionalString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const optionalNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const rendererRealtimeEventMetadata = (
  message: unknown,
  receivedAt = new Date().toISOString()
): RendererDiagnosticEvent | null => {
  const event = asRecord(message);
  const type = optionalString(event?.type ?? event?.kind);
  if (!event || !type) return null;
  const thread = asRecord(event.thread);
  const record = asRecord(event.record);
  const payload = asRecord(record?.payload);
  const delta = asRecord(event.delta);
  const snapshot = asRecord(event.snapshot);
  const snapshotMetadata = snapshot ? {
    ...(optionalNumber(snapshot.page) !== undefined ? { page: optionalNumber(snapshot.page) } : {}),
    ...(typeof snapshot.reset === "boolean" ? { reset: snapshot.reset } : {}),
    ...(typeof snapshot.complete === "boolean" ? { complete: snapshot.complete } : {})
  } : undefined;
  return {
    receivedAt,
    type,
    ...(optionalNumber(event.seq) !== undefined ? { seq: optionalNumber(event.seq) } : {}),
    ...(optionalString(thread?.threadId ?? event.threadId) ? { threadId: optionalString(thread?.threadId ?? event.threadId) } : {}),
    ...(optionalString(record?.id ?? delta?.recordId) ? { recordId: optionalString(record?.id ?? delta?.recordId) } : {}),
    ...(optionalString(record?.type) ? { recordType: optionalString(record?.type) } : {}),
    ...(optionalString(payload?.type) ? { payloadType: optionalString(payload?.type) } : {}),
    ...(optionalString(delta?.field) ? { deltaField: optionalString(delta?.field) } : {}),
    ...(snapshotMetadata && Object.keys(snapshotMetadata).length ? { snapshot: snapshotMetadata } : {})
  };
};

export const recordRendererRealtimeEvent = (message: unknown) => {
  const metadata = rendererRealtimeEventMetadata(message);
  if (!metadata) return;
  recentRealtimeEvents = [...recentRealtimeEvents, metadata].slice(-maxRecentRealtimeEvents);
};

export const updateRendererDiagnosticContext = (update: Partial<RendererDiagnosticContext>) => {
  diagnosticContext = {
    ...diagnosticContext,
    ...update,
    openThreadIds: update.openThreadIds
      ? [...new Set(update.openThreadIds.filter((threadId) => typeof threadId === "string" && threadId.trim()))].slice(0, 64)
      : diagnosticContext.openThreadIds
  };
};

const redactedDiagnosticText = (value: string) => value
  .replace(/([?&]codexhub_token=)[^&\s)]+/gi, "$1[redacted]")
  .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[redacted]");

export const captureRendererDiagnosticReport = (
  error: Error,
  componentStack?: string
): RendererDiagnosticReport => ({
  version: 1,
  capturedAt: new Date().toISOString(),
  error: {
    name: error.name || "Error",
    message: redactedDiagnosticText(error.message || "Unknown renderer error"),
    ...(error.stack ? { stack: redactedDiagnosticText(error.stack) } : {}),
    ...(componentStack?.trim() ? { componentStack: redactedDiagnosticText(componentStack) } : {})
  },
  context: {
    ...diagnosticContext,
    openThreadIds: [...diagnosticContext.openThreadIds]
  },
  recentRealtimeEvents: recentRealtimeEvents.map((event) => ({
    ...event,
    ...(event.snapshot ? { snapshot: { ...event.snapshot } } : {})
  }))
});

export const resetRendererDiagnosticsForTest = () => {
  recentRealtimeEvents = [];
  diagnosticContext = { openThreadIds: [] };
};
