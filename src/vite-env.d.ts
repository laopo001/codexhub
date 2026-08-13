/// <reference types="vite/client" />

interface Window {
  codexhubElectronPet?: {
    setIgnoreMouseEvents: (ignore: boolean) => void;
    focusMainWindow: (threadId?: string) => void;
    onOpenThread: (listener: (threadId: string) => void) => () => void;
  };
}
