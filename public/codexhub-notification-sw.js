const SHELL_CACHE = "codexhub-shell-v1";
const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/codexhub-192.png",
  "/icons/codexhub-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith("codexhub-shell-") && cacheName !== SHELL_CACHE)
          .map((cacheName) => caches.delete(cacheName))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  const url = new URL(request.url);
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;

  if (request.destination === "document") {
    event.respondWith(networkFirstDocument(request));
    return;
  }

  if (["font", "image", "manifest", "script", "style"].includes(request.destination)) {
    event.respondWith(cacheFirstStatic(request));
  }
});

const networkFirstDocument = async (request) => {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) ?? (await cache.match("/")) ?? Response.error();
  }
};

const cacheFirstStatic = async (request) => {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
};

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const notificationUrl = typeof event.notification.data?.url === "string"
      ? event.notification.data.url
      : "/";
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existingWindow = windows.find((client) => client.url === notificationUrl)
      ?? windows.find((client) => "focus" in client);
    if (existingWindow) return existingWindow.focus();
    return self.clients.openWindow(notificationUrl);
  })());
});
