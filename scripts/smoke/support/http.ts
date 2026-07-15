export const apiJson = async <T = unknown>(
  apiBase: string,
  pathname: string,
  init?: RequestInit,
  timeoutMs = 30_000
): Promise<T> => {
  const response = await fetch(new URL(pathname, apiBase), {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`HTTP ${response.status} ${pathname}: ${text}`);
  return data as T;
};
