import type { TaskCompleteNotification } from "../types.js";

type BrowserNotificationInstance = {
  close: () => void;
  onclick: ((event: Event) => void) | null;
};

type BrowserNotificationApi = {
  readonly permission: NotificationPermission;
  new (title: string, options?: NotificationOptions): BrowserNotificationInstance;
};

type BrowserServiceWorkerRegistration = {
  active?: BrowserServiceWorker | null;
  installing?: BrowserServiceWorker | null;
  waiting?: BrowserServiceWorker | null;
  showNotification: (title: string, options?: NotificationOptions) => Promise<void>;
};

type BrowserServiceWorker = {
  readonly state: ServiceWorkerState;
  addEventListener: (type: "statechange", listener: () => void) => void;
  removeEventListener: (type: "statechange", listener: () => void) => void;
};

type BrowserServiceWorkerContainer = {
  register: (scriptUrl: string, options?: RegistrationOptions) => Promise<BrowserServiceWorkerRegistration>;
  ready?: Promise<BrowserServiceWorkerRegistration>;
};

export type BrowserTaskNotificationEnvironment = {
  notificationApi?: BrowserNotificationApi;
  serviceWorker?: BrowserServiceWorkerContainer;
  focusWindow: () => void;
  pageUrl: string;
};

export type BrowserTaskNotificationResult = "notification" | "service-worker" | "unavailable";

const currentBrowserNotificationEnvironment = (): BrowserTaskNotificationEnvironment => ({
  notificationApi: window.Notification as BrowserNotificationApi | undefined,
  serviceWorker: "serviceWorker" in navigator
    ? navigator.serviceWorker as unknown as BrowserServiceWorkerContainer
    : undefined,
  focusWindow: () => window.focus(),
  pageUrl: window.location.href
});

const notificationOptions = (notification: TaskCompleteNotification): NotificationOptions => ({
  body: notification.body,
  tag: `codexhub-task-complete:${notification.threadId}`
});

const notificationPageUrl = (pageUrl: string) => {
  try {
    const url = new URL(pageUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "/";
  }
};

const activatedServiceWorkerRegistration = async (registration: BrowserServiceWorkerRegistration) => {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker || worker.state === "activated") return registration;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      worker.removeEventListener("statechange", handleStateChange);
      if (error) reject(error);
      else resolve();
    };
    const handleStateChange = () => {
      if (worker.state === "activated") finish();
      else if (worker.state === "redundant") finish(new Error("notification service worker became redundant"));
    };
    const timeout = setTimeout(() => finish(new Error("notification service worker activation timed out")), 10_000);
    worker.addEventListener("statechange", handleStateChange);
    handleStateChange();
  });
  return registration;
};

export const showBrowserTaskCompleteNotification = async (
  notification: TaskCompleteNotification,
  environment?: BrowserTaskNotificationEnvironment
): Promise<BrowserTaskNotificationResult> => {
  try {
    const current = environment ?? currentBrowserNotificationEnvironment();
    const NotificationApi = current.notificationApi;
    if (!NotificationApi || NotificationApi.permission !== "granted") return "unavailable";

    try {
      const browserNotification = new NotificationApi(notification.title, notificationOptions(notification));
      browserNotification.onclick = () => {
        current.focusWindow();
        browserNotification.close();
      };
      return "notification";
    } catch {
      const serviceWorker = current.serviceWorker;
      if (!serviceWorker) return "unavailable";
      const registration = await serviceWorker.register("/codexhub-notification-sw.js", { scope: "/" });
      const readyRegistration = serviceWorker.ready ? await serviceWorker.ready : registration;
      const activeRegistration = await activatedServiceWorkerRegistration(readyRegistration);
      await activeRegistration.showNotification(notification.title, {
        ...notificationOptions(notification),
        data: { url: notificationPageUrl(current.pageUrl) }
      });
      return "service-worker";
    }
  } catch {
    return "unavailable";
  }
};
