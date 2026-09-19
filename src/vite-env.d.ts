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
    getDisplayBounds?: () => Promise<ReadonlyArray<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>>;
    openPetActivity: (target: {
      threadId: string;
      workingDirectory?: string;
      machineId?: string;
      machineHostname?: string;
      projectPath?: string;
      source?: {
        kind: "vscode" | "electron";
        groupId: string;
        label?: string;
        vscodeChannel?: "stable" | "insiders";
      };
    }) => void;
    recoverSurface: () => Promise<{ ok: boolean }>;
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
