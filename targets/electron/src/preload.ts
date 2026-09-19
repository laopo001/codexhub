import { contextBridge, ipcRenderer } from "electron";
import type { PetActivityOpenTarget } from "../../../src/shared/petActivityRouting.js";
import type { PetHitRegion, ScreenDisplayBounds } from "../../../src/shared/petInput.js";
import type { TaskCompleteNotification } from "../../../src/shared/taskNotifications.js";

contextBridge.exposeInMainWorld("codexhubElectronPet", {
  setPetHitRegions: (regions: ReadonlyArray<PetHitRegion>) => {
    ipcRenderer.send("codexhub:pet-hit-regions", regions);
  },
  setPetDragActive: (active: boolean) => {
    ipcRenderer.send("codexhub:pet-drag-active", Boolean(active));
  },
  getDisplayBounds: () => ipcRenderer.invoke("codexhub:pet-display-bounds") as Promise<ReadonlyArray<ScreenDisplayBounds>>,
  openPetActivity: (target: PetActivityOpenTarget) => {
    ipcRenderer.send("codexhub:pet-open-activity", target);
  },
  recoverSurface: () => ipcRenderer.invoke("codexhub:recover-surface") as Promise<{ ok: boolean }>,
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
