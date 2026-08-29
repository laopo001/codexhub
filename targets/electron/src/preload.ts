import { contextBridge, ipcRenderer } from "electron";
import type { PetActivityOpenTarget } from "../../../src/shared/petActivityRouting.js";
import type { RestartPayload } from "../../../src/shared/apiContract.js";
import type { PetHitRegion } from "../../../src/shared/petInput.js";
import type { TaskCompleteNotification } from "../../../src/shared/taskNotifications.js";

contextBridge.exposeInMainWorld("codexhubElectronPet", {
  setPetHitRegions: (regions: ReadonlyArray<PetHitRegion>) => {
    ipcRenderer.send("codexhub:pet-hit-regions", regions);
  },
  setPetDragActive: (active: boolean) => {
    ipcRenderer.send("codexhub:pet-drag-active", Boolean(active));
  },
  openPetActivity: (target: PetActivityOpenTarget) => {
    ipcRenderer.send("codexhub:pet-open-activity", target);
  },
  restartAuthority: () => ipcRenderer.invoke("codexhub:restart-authority") as Promise<RestartPayload>,
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
