import type { LocalTask, LocalTaskRun, TaskCompleteNotification } from "../types.js";
import type { MachineActivitySummary, MachineSummary } from "../../shared/machineTypes.js";
import type { ProjectSource } from "../../shared/projectTypes.js";
import type { ProjectTarget, WorkspaceTarget } from "../../shared/petActivityRouting.js";
import {
  formatStatusDuration,
  formatTaskNotificationBody,
  taskCompleteNotificationTitle,
  type TaskCompleteNotificationOptions
} from "../../shared/taskNotifications.js";
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

export const taskRunCompleteNotification = (
  task: LocalTask,
  run: LocalTaskRun,
  options?: TaskCompleteNotificationOptions | string
): TaskCompleteNotification => {
  const opts: TaskCompleteNotificationOptions = typeof options === "string"
    ? { machineLabel: options }
    : options || {};
  const durationMs = typeof run.durationMs === "number" ? run.durationMs : undefined;
  const duration = typeof durationMs === "number" ? formatStatusDuration(durationMs) : undefined;
  const body = formatTaskNotificationBody({
    source: opts.source,
    machine: opts.machine,
    workingDirectory: task.projectPath,
    duration,
    message: "任务已完成"
  });
  return {
    title: task.name?.trim() || "计划任务",
    body,
    threadId: run.threadId || `task:${task.taskId}:${run.runId}`,
    machineId: task.machineId,
    ...(opts.machineHostname || opts.machine?.hostname
      ? { machineHostname: opts.machineHostname || opts.machine?.hostname }
      : {}),
    projectPath: task.projectPath,
    workingDirectory: task.projectPath,
    ...(opts.projectTarget ? { projectTarget: opts.projectTarget } : {}),
    ...(opts.workspaceTarget ? { workspaceTarget: opts.workspaceTarget } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.machineLabel?.trim() ? { machineLabel: opts.machineLabel.trim() } : {}),
    ...(duration ? { duration } : {}),
    ...(durationMs === undefined ? {} : { durationMs })
  };
};

export const taskCompleteNotificationFromActivity = (
  machine: MachineSummary,
  activity: MachineActivitySummary,
  source?: ProjectSource,
  options?: { projectTarget?: ProjectTarget; workspaceTarget?: WorkspaceTarget }
): TaskCompleteNotification => {
  const workingDirectory = activity.workingDirectory || "";
  const body = formatTaskNotificationBody({
    source,
    machine,
    workingDirectory,
    message: null
  });
  return {
    title: activity.activityTitle?.trim() || activity.title?.trim() || "远程任务",
    body,
    threadId: activity.threadId,
    machineId: machine.machineId,
    machineHostname: machine.hostname,
    workingDirectory,
    ...(options?.projectTarget ? { projectTarget: options.projectTarget } : {}),
    ...(options?.workspaceTarget ? { workspaceTarget: options.workspaceTarget } : {}),
    ...(source ? { source } : {}),
    machineLabel: machineNotificationLabel(machine, workingDirectory)
  };
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
  openThread?: (threadId: string) => void;
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
  environment?: BrowserTaskNotificationEnvironment,
  openThread?: (threadId: string) => void
): Promise<BrowserTaskNotificationResult> => {
  try {
    const current = environment ?? currentBrowserNotificationEnvironment();
    const NotificationApi = current.notificationApi;
    if (!NotificationApi || NotificationApi.permission !== "granted") return "unavailable";

    const title = taskCompleteNotificationTitle(notification);

    try {
      const browserNotification = new NotificationApi(
        title,
        notificationOptions(notification)
      );
      browserNotification.onclick = () => {
        current.focusWindow();
        const open = current.openThread ?? openThread;
        if (open && notification.threadId) {
          open(notification.threadId);
        }
        browserNotification.close();
      };
      return "notification";
    } catch {
      const serviceWorker = current.serviceWorker;
      if (!serviceWorker) return "unavailable";
      const registration = await serviceWorker.register(appServiceWorkerUrl, { scope: "/" });
      const readyRegistration = serviceWorker.ready ? await serviceWorker.ready : registration;
      const activeRegistration = await activatedServiceWorkerRegistration(readyRegistration);
      await activeRegistration.showNotification(title, {
        ...notificationOptions(notification),
        data: { url: notificationPageUrl(current.pageUrl) }
      });
      return "service-worker";
    }
  } catch {
    return "unavailable";
  }
};
