/// <reference types="vite/client" />

interface Window {
  codexhubElectronPet?: {
    setPetHitRegions: (regions: ReadonlyArray<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>) => void;
    setPetDragActive: (active: boolean) => void;
    focusMainWindow: (threadId?: string) => void;
    restartAuthority: () => Promise<{ ok: boolean; restarting: boolean }>;
    onOpenThread: (listener: (threadId: string) => void) => () => void;
    showTaskCompleteNotification: (notification: {
      title: string;
      body: string;
      threadId: string;
      machineLabel?: string;
      duration?: string;
      durationMs?: number;
      persistent?: boolean;
    }) => void;
  };
}
