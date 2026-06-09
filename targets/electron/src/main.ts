import { app as electronApp, BrowserWindow, shell } from "electron";
import type { ServerHandle } from "../../../src/server/index.js";
import { localServerUrl, parseEmbeddedPort, startEmbeddedServer as startSharedEmbeddedServer } from "../../../src/server/embedded.js";

let mainWindow: BrowserWindow | null = null;
let server: ServerHandle | null = null;
let allowQuit = false;
let stoppingServer: Promise<void> | null = null;

const createWindow = async () => {
  if (!server) server = await startElectronServer();

  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: "Codex Hub",
    backgroundColor: "#0f1b14",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  mainWindow = window;
  await window.loadURL(localServerUrl(server));

  if (process.env.CODEX_HUB_ELECTRON_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" });
  }
};

const startElectronServer = async () => {
  const host = process.env.CODEX_HUB_ELECTRON_HOST ?? "127.0.0.1";
  const explicitPort = process.env.CODEX_HUB_ELECTRON_PORT ?? process.env.CODEX_HUB_PORT;
  return await startSharedEmbeddedServer({
    host,
    preferredPort: parseEmbeddedPort(explicitPort ?? "18788", "Electron server port"),
    explicitPort: Boolean(explicitPort),
    logPrefix: "codexhub electron"
  });
};

const stopServer = async () => {
  if (stoppingServer) return stoppingServer;
  const current = server;
  server = null;
  stoppingServer = current
    ? current.stop().catch((error: unknown) => {
      console.error(`codexhub electron server stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      stoppingServer = null;
    })
    : Promise.resolve();
  return stoppingServer;
};

const runSmoke = async () => {
  server = await startElectronServer();
  const url = localServerUrl(server);
  const response = await fetch(new URL("/api/health", url));
  if (!response.ok) throw new Error(`Electron smoke health failed: HTTP ${response.status}`);
  console.log(JSON.stringify({ ok: true, url, health: await response.json() }));
  await stopServer();
  allowQuit = true;
  electronApp.quit();
};

if (!electronApp.requestSingleInstanceLock()) {
  electronApp.quit();
} else {
  electronApp.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  electronApp.whenReady()
    .then(process.env.CODEX_HUB_ELECTRON_SMOKE === "1" ? runSmoke : createWindow)
    .catch((error: unknown) => {
      console.error(error);
      electronApp.quit();
    });

  electronApp.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });

  electronApp.on("window-all-closed", () => {
    electronApp.quit();
  });

  electronApp.on("before-quit", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    void stopServer().finally(() => {
      allowQuit = true;
      electronApp.quit();
    });
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stopServer().finally(() => {
        allowQuit = true;
        electronApp.quit();
      });
    });
  }
}
