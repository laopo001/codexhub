import { CodexHubApiError } from "../../shared/apiClient.js";

export const forkErrorMessage = (error: unknown) => {
  if (error instanceof CodexHubApiError && error.responseText) {
    try {
      const payload: unknown = JSON.parse(error.responseText);
      if (
        payload
        && typeof payload === "object"
        && "error" in payload
        && typeof payload.error === "string"
        && payload.error.trim()
      ) {
        return payload.error.trim();
      }
    } catch {
      // Fall through to the regular Error message when the response is not JSON.
    }
  }
  return error instanceof Error ? error.message : String(error);
};
