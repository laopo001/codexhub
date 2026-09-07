import type { ParentRegistrationConnectInput } from "../shared/apiContract.js";

export type RegisterParentOptions = {
  localServerUrl: string;
  localAuthToken?: string;
  parentUrl: string;
  parentAuthToken?: string;
  machineId?: string;
  name?: string;
  timeoutMs?: number;
};

export const resolveRegisterParentTarget = (
  parentValue: string,
  optionValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env
) => {
  let url: URL;
  try {
    url = new URL(parentValue);
  } catch {
    throw new Error("Parent register URL must be a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Parent register URL must use http or https.");
  }
  const urlAuthToken = url.searchParams.has("codexhub_token")
    ? url.searchParams.get("codexhub_token")?.trim() ?? ""
    : undefined;
  const authToken = optionValue !== undefined
    ? optionValue
    : urlAuthToken !== undefined
      ? urlAuthToken
      : env.CODEX_HUB_REGISTER_AUTH_TOKEN;
  return {
    url: url.origin,
    ...(authToken !== undefined ? { authToken } : {})
  };
};

export const registerParent = async (options: RegisterParentOptions) => {
  const payload: ParentRegistrationConnectInput = {
    url: options.parentUrl,
    ...(options.parentAuthToken !== undefined ? { authToken: options.parentAuthToken } : {}),
    ...(options.machineId !== undefined ? { machineId: options.machineId } : {}),
    ...(options.name !== undefined ? { name: options.name } : {})
  };
  const headers = new Headers({ "content-type": "application/json" });
  const localAuthToken = options.localAuthToken?.trim();
  if (localAuthToken) headers.set("authorization", `Bearer ${localAuthToken}`);

  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let responseBody: string;
  try {
    response = await fetch(new URL("/api/registered/parent", options.localServerUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    responseBody = await response.text();
  } catch {
    if (controller.signal.aborted) {
      throw new Error("Timed out waiting for the local CodexHub server response.");
    }
    throw new Error("Could not reach the local CodexHub server; register requires an already running server.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Local CodexHub server rejected parent registration (HTTP ${response.status}).`);
  }

  let responseJson: unknown;
  try {
    responseJson = JSON.parse(responseBody);
  } catch {
    throw new Error("Local CodexHub server returned an invalid parent registration response.");
  }
  if (!hasAcceptedRegistrationStatus(responseJson)) {
    throw new Error("Local CodexHub server did not accept parent registration.");
  }
};

const hasAcceptedRegistrationStatus = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const registration = (value as { registration?: unknown }).registration;
  if (!registration || typeof registration !== "object" || Array.isArray(registration)) return false;
  const status = (registration as { status?: unknown }).status;
  return status === "starting" || status === "connecting" || status === "online";
};
