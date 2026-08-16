import { contextBridge, ipcRenderer } from "electron";
import type { TaskCompleteNotification } from "../../../src/shared/taskNotifications.js";

contextBridge.exposeInMainWorld("codexhubElectronPet", {
  setIgnoreMouseEvents: (ignore: boolean) => {
    ipcRenderer.send("codexhub:pet-ignore-mouse", Boolean(ignore));
  },
  onPointerPosition: (listener: (position: { clientX: number; clientY: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (!value || typeof value !== "object") return;
      const position = value as { clientX?: unknown; clientY?: unknown };
      if (typeof position.clientX !== "number" || typeof position.clientY !== "number") return;
      listener({ clientX: position.clientX, clientY: position.clientY });
    };
    ipcRenderer.on("codexhub:pet-pointer-position", handler);
    return () => ipcRenderer.removeListener("codexhub:pet-pointer-position", handler);
  },
  requestPointerPosition: () => {
    ipcRenderer.send("codexhub:pet-request-pointer-position");
  },
  focusMainWindow: (threadId?: string) => {
    ipcRenderer.send("codexhub:pet-focus-main", typeof threadId === "string" ? threadId : "");
  },
  showTaskCompleteNotification: (notification: TaskCompleteNotification) => {
    ipcRenderer.send("codexhub:task-complete-notification", notification);
  },
  onOpenThread: (listener: (threadId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, threadId: unknown) => {
      if (typeof threadId === "string" && threadId.trim()) listener(threadId);
    };
    ipcRenderer.on("codexhub:open-thread", handler);
    return () => ipcRenderer.removeListener("codexhub:open-thread", handler);
  }
});
