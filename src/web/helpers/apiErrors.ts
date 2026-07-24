import { CodexHubApiError } from "../../shared/apiClient.js";

export type ApiErrorDetails = {
  message: string;
  delivery?: "turn" | "steer" | "goal" | "queued";
};

export const apiResponseErrorDetails = (responseText: string): ApiErrorDetails => {
  const structured = structuredApiErrorDetails(responseText);
  if (structured) return structured;
  return { message: responseText.trim() || "Request failed" };
};

export const apiErrorMessage = (error: unknown) =>
  error instanceof CodexHubApiError && error.responseText
    ? structuredApiErrorDetails(error.responseText)?.message ?? error.message
    : error instanceof Error ? error.message : String(error);

export const forkErrorMessage = apiErrorMessage;

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
