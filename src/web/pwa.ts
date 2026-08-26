import { isEmbeddedHostSurface } from "./appConfig.js";
import { codexHubSearchParams } from "./urlSearch.js";

export const appServiceWorkerUrl = "/codexhub-notification-sw.js";

export type PwaEnvironment = {
  window?: Window;
  navigator?: Navigator;
};

const isEmbeddedSearch = (search?: string) => {
  if (!search) return false;
  try {
    const params = codexHubSearchParams(search);
    const surface = params.get("surface");
    return surface === "vscode" || surface === "electron" || params.has("surfaceId") || params.has("stateScope");
  } catch {
    return false;
  }
};

const serviceWorkerScriptPath = (worker?: ServiceWorker | null) => {
  if (!worker?.scriptURL) return "";
  try {
    return new URL(worker.scriptURL).pathname;
  } catch {
    return "";
  }
};

const updateExistingCodexHubServiceWorker = async (serviceWorker: ServiceWorkerContainer) => {
  if (typeof serviceWorker.getRegistration !== "function") return;
  try {
    const registration = await serviceWorker.getRegistration(appServiceWorkerUrl);
    if (!registration) return;
    const ownsRegistration = [registration.active, registration.waiting, registration.installing]
      .some((worker) => serviceWorkerScriptPath(worker) === appServiceWorkerUrl);
    if (!ownsRegistration) return;
    await registration.update();
  } catch (error) {
    console.warn("CodexHub embedded service worker migration failed.", error);
  }
};

export const registerPwaServiceWorker = async (
  environment?: PwaEnvironment
): Promise<ServiceWorkerRegistration | null> => {
  const currentWindow = environment?.window ?? (typeof window !== "undefined" ? window : undefined);
  const currentNavigator = environment?.navigator ?? (typeof navigator !== "undefined" ? navigator : undefined);
  if (!currentWindow || !currentNavigator) return null;
  if (currentWindow.location?.protocol !== "http:" && currentWindow.location?.protocol !== "https:") return null;
  if (!("serviceWorker" in currentNavigator) || !currentNavigator.serviceWorker) return null;
  if (
    isEmbeddedHostSurface
    || isEmbeddedSearch(currentWindow.location?.search)
    || currentWindow.self !== currentWindow.top
  ) {
    await updateExistingCodexHubServiceWorker(currentNavigator.serviceWorker);
    return null;
  }

  try {
    return await currentNavigator.serviceWorker.register(appServiceWorkerUrl, { scope: "/" });
  } catch (error) {
    console.warn("CodexHub PWA service worker registration failed.", error);
    return null;
  }
};
