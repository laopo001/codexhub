import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("codexhubElectronPet", {
  setIgnoreMouseEvents: (ignore: boolean) => {
    ipcRenderer.send("codexhub:pet-ignore-mouse", Boolean(ignore));
  },
  focusMainWindow: (threadId?: string) => {
    ipcRenderer.send("codexhub:pet-focus-main", typeof threadId === "string" ? threadId : "");
  },
  onOpenThread: (listener: (threadId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, threadId: unknown) => {
      if (typeof threadId === "string" && threadId.trim()) listener(threadId);
    };
    ipcRenderer.on("codexhub:open-thread", handler);
    return () => ipcRenderer.removeListener("codexhub:open-thread", handler);
  }
});
