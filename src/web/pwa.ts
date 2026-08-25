export const appServiceWorkerUrl = "/codexhub-notification-sw.js";

export const registerPwaServiceWorker = async (): Promise<ServiceWorkerRegistration | null> => {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  if (window.location.protocol !== "http:" && window.location.protocol !== "https:") return null;
  if (!("serviceWorker" in navigator)) return null;

  try {
    return await navigator.serviceWorker.register(appServiceWorkerUrl, { scope: "/" });
  } catch (error) {
    console.warn("CodexHub PWA service worker registration failed.", error);
    return null;
  }
};
