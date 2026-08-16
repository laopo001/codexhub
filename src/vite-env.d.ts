/// <reference types="vite/client" />

interface Window {
  codexhubElectronPet?: {
    setIgnoreMouseEvents: (ignore: boolean) => void;
    onPointerPosition: (listener: (position: { clientX: number; clientY: number }) => void) => () => void;
    requestPointerPosition: () => void;
    focusMainWindow: (threadId?: string) => void;
    onOpenThread: (listener: (threadId: string) => void) => () => void;
    showTaskCompleteNotification: (notification: {
      title: string;
      body: string;
      threadId: string;
      machineLabel?: string;
      duration?: string;
    }) => void;
  };
}
