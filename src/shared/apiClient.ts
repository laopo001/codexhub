import type {
  AnyApiRoute,
  ApiRouteCallArgs,
  ApiRoutePathArgs,
  ApiRouteResponse
} from "./apiRoutes.js";

export type ApiAuthTokenProvider = string | null | undefined | (() => string | null | undefined);

export type CodexHubApiClientOptions = {
  baseUrl?: string;
  authToken?: ApiAuthTokenProvider;
  fetch?: typeof fetch;
};

export class CodexHubApiError extends Error {
  readonly status: number;
  readonly responseText: string;

  constructor(status: number, responseText: string) {
    super(`API HTTP ${status}${responseText ? `: ${responseText}` : ""}`);
    this.name = "CodexHubApiError";
    this.status = status;
    this.responseText = responseText;
  }
}

const resolveAuthToken = (provider: ApiAuthTokenProvider) =>
  (typeof provider === "function" ? provider() : provider)?.trim() ?? "";

const resolveUrl = (path: string, baseUrl?: string) =>
  baseUrl ? new URL(path, baseUrl).toString() : path;

export const apiRoutePath = <Route extends AnyApiRoute>(
  route: Route,
  pathArgs: ApiRoutePathArgs<Route>
) => typeof route.path === "function"
    ? route.path(...(pathArgs as never[]))
    : route.path;

export const createCodexHubApiClient = (options: CodexHubApiClientOptions = {}) => {
  const fetchImpl = options.fetch ?? fetch;

  const request = async <Response>(path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const token = resolveAuthToken(options.authToken);
    if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    const response = await fetchImpl(resolveUrl(path, options.baseUrl), { ...init, headers });
    if (!response.ok) throw new CodexHubApiError(response.status, await response.text());
    return await response.json() as Response;
  };

  const route = async <Route extends AnyApiRoute>(
    spec: Route,
    ...args: ApiRouteCallArgs<Route>
  ): Promise<ApiRouteResponse<Route>> => {
    const values = [...args] as unknown[];
    const body = spec.hasBody ? values.pop() : undefined;
    const path = apiRoutePath(spec, values as ApiRoutePathArgs<Route>);
    const init: RequestInit = { method: spec.method };
    if (spec.hasBody) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return request<ApiRouteResponse<Route>>(path, init);
  };

  return { request, route };
};

export type CodexHubApiClient = ReturnType<typeof createCodexHubApiClient>;
