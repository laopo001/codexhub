import type { TaskCompleteNotification } from "../types.js";
import type { MachineActivitySummary, MachineSummary } from "../../shared/machineTypes.js";
import { taskCompleteNotificationTitle } from "../../shared/taskNotifications.js";
import { appServiceWorkerUrl } from "../pwa.js";

export type RegisteredMachineActivityCompletion = {
  machine: MachineSummary;
  activity: MachineActivitySummary;
};

export const machineNotificationLabel = (machine: MachineSummary, workingDirectory: string) => {
  const directoryName = workingDirectory.split(/[\\/]/).filter(Boolean).pop();
  const machineName = (machine.name ?? machine.hostname).trim();
  const machineContext = machineName.split(" · ").slice(1).filter(Boolean).join(" · ") || machineName;
  return [directoryName, machineContext].filter(Boolean).join(" · ");
};

/**
 * Registered machines expose activity-only snapshots to the parent server.
 * Keep the transition detector separate from the notification transport so
 * reconnects and the Electron/VS Code hosts can share the same semantics.
 */
export const collectRegisteredMachineActivityCompletions = (
  previous: ReadonlyMap<string, MachineActivitySummary["status"]>,
  machines: MachineSummary[]
) => {
  const currentRegisteredMachineIds = new Set(
    machines.filter((machine) => machine.type === "registered").map((machine) => machine.machineId)
  );
  const currentActivityKeys = new Set<string>();
  const completed: RegisteredMachineActivityCompletion[] = [];
  const next = new Map(previous);

  for (const machine of machines) {
    if (machine.type !== "registered") continue;
    for (const activity of machine.activities ?? []) {
      const key = registeredMachineActivityKey(machine.machineId, activity.threadId);
      currentActivityKeys.add(key);
      if (previous.get(key) === "running" && activity.status === "idle") {
        completed.push({ machine, activity });
      }
      next.set(key, activity.status);
    }
  }

  for (const key of next.keys()) {
    const separator = key.indexOf("\u0000");
    const machineId = separator === -1 ? key : key.slice(0, separator);
    if (!currentRegisteredMachineIds.has(machineId) || !currentActivityKeys.has(key)) {
      next.delete(key);
    }
  }

  return { completed, next };
};

const registeredMachineActivityKey = (machineId: string, threadId: string) => `${machineId}\u0000${threadId}`;

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

export type ElectronTaskNotificationBridge = {
  showTaskCompleteNotification: (notification: TaskCompleteNotification) => void;
};

export type ElectronTaskNotificationResult = "notification" | "unavailable";

export const sendElectronTaskCompleteNotification = (
  notification: TaskCompleteNotification,
  bridge?: ElectronTaskNotificationBridge
): ElectronTaskNotificationResult => {
  if (!bridge) return "unavailable";
  try {
    bridge.showTaskCompleteNotification(notification);
    return "notification";
  } catch {
    return "unavailable";
  }
};

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
  tag: `codexhub-task-complete:${notification.threadId}`,
  ...(notification.persistent ? { requireInteraction: true } : {})
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
      const browserNotification = new NotificationApi(
        taskCompleteNotificationTitle(notification),
        notificationOptions(notification)
      );
      browserNotification.onclick = () => {
        current.focusWindow();
        browserNotification.close();
      };
      return "notification";
    } catch {
      const serviceWorker = current.serviceWorker;
      if (!serviceWorker) return "unavailable";
      const registration = await serviceWorker.register(appServiceWorkerUrl, { scope: "/" });
      const readyRegistration = serviceWorker.ready ? await serviceWorker.ready : registration;
      const activeRegistration = await activatedServiceWorkerRegistration(readyRegistration);
      await activeRegistration.showNotification(taskCompleteNotificationTitle(notification), {
        ...notificationOptions(notification),
        data: { url: notificationPageUrl(current.pageUrl) }
      });
      return "service-worker";
    }
  } catch {
    return "unavailable";
  }
};
