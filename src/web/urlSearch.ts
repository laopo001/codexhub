const codexHubQueryKeys = new Set(["codexhub_token", "surface"]);

const hasCodexHubQueryKey = (params: URLSearchParams) =>
  [...params.keys()].some((key) => codexHubQueryKeys.has(key.toLowerCase()));

/**
 * VSCode remote/webview URI serialization can encode the complete query as one
 * query component (`?surface%3Dvscode%26...`). Normalize that representation
 * before any surface or access-token consumer reads it.
 */
export const normalizeCodexHubSearch = (rawSearch: string) => {
  if (!rawSearch) return rawSearch;
  const original = rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch;
  if (hasCodexHubQueryKey(new URLSearchParams(original))) return `?${original}`;

  let candidate = original;
  for (let depth = 0; depth < 3 && candidate.includes("%"); depth += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return rawSearch;
    }
    if (decoded === candidate) break;
    if (hasCodexHubQueryKey(new URLSearchParams(decoded))) return `?${decoded}`;
    candidate = decoded;
  }
  return rawSearch;
};

export const codexHubSearchParams = (rawSearch: string) =>
  new URLSearchParams(normalizeCodexHubSearch(rawSearch));
