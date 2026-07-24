import { CodexHubApiError } from "../../shared/apiClient.js";
import type { ThreadTurnPayload } from "../../shared/apiContract.js";

export type ApiErrorDetails = {
  message: string;
  delivery?: NonNullable<ThreadTurnPayload["delivery"]>;
};

export const apiErrorDetails = (
  error: unknown,
  options: { plainHttpMessage?: boolean } = {}
): ApiErrorDetails => {
  if (!(error instanceof CodexHubApiError)) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
  const structured = error.responseText ? structuredApiErrorDetails(error.responseText) : null;
  if (structured) return structured;
  return {
    message: options.plainHttpMessage
      ? error.responseText.trim() || "Request failed"
      : error.message
  };
};

const isTurnDelivery = (value: unknown): value is NonNullable<ApiErrorDetails["delivery"]> =>
  value === "turn" || value === "steer" || value === "goal" || value === "queued";

const structuredApiErrorDetails = (responseText: string): ApiErrorDetails | null => {
  try {
    const payload: unknown = JSON.parse(responseText);
    if (!payload || typeof payload !== "object") return null;
    const error = "error" in payload && typeof payload.error === "string" ? payload.error.trim() : "";
    const delivery = "delivery" in payload && isTurnDelivery(payload.delivery) ? payload.delivery : undefined;
    return error ? { message: error, ...(delivery ? { delivery } : {}) } : null;
  } catch {
    return null;
  }
};
