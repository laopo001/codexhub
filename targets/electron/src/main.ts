import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  app as electronApp,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray
} from "electron";
import { readServerConfigEnv } from "../../../src/core/serverConfigEnv.js";
import { embeddedAuthorityDataDirectory } from "../../../src/core/authorityPaths.js";
import {
  authorityBuildId,
  ensureEmbeddedAuthority,
  type EmbeddedAuthorityHandle
} from "../../../src/core/embeddedAuthority.js";
import {
  configuredAuthorityAuthToken,
  removeLegacyAuthorityTokenFiles
} from "../../../src/core/authorityAuth.js";
import { loadDotEnv } from "../../../src/core/dotenv.js";
import { createCodexHubApiClient, CodexHubApiError } from "../../../src/shared/apiClient.js";
import { apiRoutes } from "../../../src/shared/apiRoutes.js";
import { embeddedSurfaceProtocolVersion } from "../../../src/shared/surfaceTypes.js";

const mainDirectory = electronApp.isPackaged
  ? path.join(electronApp.getAppPath(), "dist-node", "electron")
  : electronApp.getAppPath();
const preloadPath = path.join(mainDirectory, "preload.cjs");
const surfaceHeartbeatMs = 10_000;
const desktopPetSyncMs = 1_000;
const windowsTrayEnabled = process.platform === "win32";
const electronSmokeEnabled = process.env.CODEX_HUB_ELECTRON_SMOKE === "1";

// The icon is kept in the main bundle so installed builds do not depend on
// a source or build-resource path for their tray icon.
const trayIconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQEAYAAABPYyMiAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP///////wlY99wAAAAHdElNRQfqCA4BMBPxnrOsAAABAklEQVRIx2NgGGDAiC6gqHj8eFWVLBeE13ERQkepUGbNsjsQukL//n1Ly7a2x98wHIBq8aOvtPW3HDfMIUyoEjAf0xog7EFzAOGg/rv9lfZnPgaGL9ETd+xjYmB49y4kZNYsBB8mjx8g7GEipBTdwo/mWZrLexDy/CenXY8sQfBh8sQ6iKADcFnIszTfw+kfAwOzp9hV3k8IPi4H/b//1fTXLDIcAAPcLSm1NjMQFuICMHmYekKAaAfQCow6gGgHfK2Z03wkg3CqhsnD1JPoAFiRiQDEZjNC2ZRRkfs0WxqmPWgOqNBHdwCx2QzdQvRsisseiisjWP5G9SE6wF0ZDTgAAPZqtBbO4tnIAAAAAElFTkSuQmCC";

let mainWindow: BrowserWindow | null = null;
let desktopPetWindow: BrowserWindow | null = null;
let authority: EmbeddedAuthorityHandle | null = null;
let tray: Tray | null = null;
let allowQuit = false;
let stoppingSurface: Promise<void> | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatInFlight = false;
let surfaceRegistered = false;
let desktopPetSyncTimer: NodeJS.Timeout | null = null;
let desktopPetSyncInFlight = false;
const surfaceId = `electron-${randomUUID()}`;
const leaseId = randomUUID();

const createWindow = async () => {
  await ensureElectronSurface();
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: "Codex Hub",
    backgroundColor: "#0f1b14",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.on("close", (event) => {
    if (!windowsTrayEnabled || !tray || allowQuit) return;
    event.preventDefault();
    window.hide();
  });

  window.on("closed", () => {
    if (mainWindow !== window) return;
    mainWindow = null;
    void unregisterSurface();
  });

  mainWindow = window;
  await window.loadURL(electronSurfaceUrl(requiredAuthority()));
  startDesktopPetSync();

  if (process.env.CODEX_HUB_ELECTRON_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" });
  }
};

const showMainWindow = async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

const createTray = () => {
  if (!windowsTrayEnabled || electronSmokeEnabled || tray) return;
  try {
    const icon = nativeImage.createFromDataURL(trayIconDataUrl);
    if (icon.isEmpty()) {
      console.warn("codexhub electron could not create its Windows tray icon");
      return;
    }
    tray = new Tray(icon);
    tray.setToolTip("Codex Hub");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show Codex Hub", click: () => void showMainWindow() },
      { type: "separator" },
      { label: "Quit Codex Hub", click: () => electronApp.quit() }
    ]));
    tray.on("click", () => void showMainWindow());
    tray.on("double-click", () => void showMainWindow());
  } catch (error) {
    tray?.destroy();
    tray = null;
    console.warn(`codexhub electron tray unavailable: ${errorText(error)}`);
  }
};

const destroyTray = () => {
  if (!tray) return;
  tray.destroy();
  tray = null;
};

const desktopPetBounds = () => {
  const displays = screen.getAllDisplays();
  const fallback = screen.getPrimaryDisplay().bounds;
  const bounds = displays.length ? displays.map((display) => display.bounds) : [fallback];
  const left = Math.min(...bounds.map((item) => item.x));
  const top = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const bottom = Math.max(...bounds.map((item) => item.y + item.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const repositionDesktopPetWindow = () => {
  if (!desktopPetWindow || desktopPetWindow.isDestroyed()) return;
  desktopPetWindow.setBounds(desktopPetBounds());
};

const createDesktopPetWindow = async () => {
  if (desktopPetWindow && !desktopPetWindow.isDestroyed()) return;
  const target = requiredAuthority();
  const petWindow = new BrowserWindow({
    ...desktopPetBounds(),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  desktopPetWindow = petWindow;
  petWindow.setMenuBarVisibility(false);
  petWindow.setAlwaysOnTop(true, "floating");
  petWindow.setIgnoreMouseEvents(true, { forward: true });
  petWindow.on("closed", () => {
    if (desktopPetWindow === petWindow) desktopPetWindow = null;
  });
  try {
    await petWindow.loadURL(electronSurfaceUrl(target, true));
    if (!petWindow.isDestroyed()) petWindow.showInactive();
  } catch (error) {
    if (!petWindow.isDestroyed()) petWindow.destroy();
    throw error;
  }
};

const closeDesktopPetWindow = () => {
  const petWindow = desktopPetWindow;
  desktopPetWindow = null;
  if (petWindow && !petWindow.isDestroyed()) petWindow.close();
};

const syncDesktopPet = async () => {
  if (desktopPetSyncInFlight || !authority || !surfaceRegistered) return;
  desktopPetSyncInFlight = true;
  try {
    const client = createCodexHubApiClient({ baseUrl: authority.url, authToken: authority.authToken });
    const payload = await client.route(apiRoutes.config);
    if (payload.config.ui.showDesktopPet) await createDesktopPetWindow();
    else closeDesktopPetWindow();
  } catch (error) {
    console.warn(`codexhub electron desktop pet sync failed: ${errorText(error)}`);
  } finally {
    desktopPetSyncInFlight = false;
  }
};

const startDesktopPetSync = () => {
  if (desktopPetSyncTimer) return;
  void syncDesktopPet();
  desktopPetSyncTimer = setInterval(() => void syncDesktopPet(), desktopPetSyncMs);
  desktopPetSyncTimer.unref?.();
};

const stopDesktopPetSync = () => {
  if (!desktopPetSyncTimer) return;
  clearInterval(desktopPetSyncTimer);
  desktopPetSyncTimer = null;
};

ipcMain.on("codexhub:pet-ignore-mouse", (event, ignore: unknown) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== desktopPetWindow || sender.isDestroyed()) return;
  sender.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
});

ipcMain.on("codexhub:pet-focus-main", (event, threadId: unknown) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (sender !== desktopPetWindow || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (typeof threadId === "string" && threadId.trim()) {
    mainWindow.webContents.send("codexhub:open-thread", threadId);
  }
});

const ensureElectronSurface = async () => {
  if (!authority) authority = await startElectronAuthority();
  await registerSurface(authority);
  startHeartbeat();
};

const startElectronAuthority = async () => {
  await loadDotEnv();
  const dataDir = embeddedAuthorityDataDirectory();
  const packagedResourceDirectory = electronApp.isPackaged
    ? path.join(process.resourcesPath, "codexhub")
    : path.resolve(mainDirectory, "..", "..");
  const authorityServicePath = process.env.CODEX_HUB_AUTHORITY_SERVICE_PATH?.trim()
    || (electronApp.isPackaged
      ? path.join(packagedResourceDirectory, "authority-service.cjs")
      : path.join(mainDirectory, "authority-service.cjs"));
  const staticDirectory = process.env.CODEX_HUB_STATIC_DIR?.trim()
    || path.join(packagedResourceDirectory, "dist");
  const remoteClientPath = process.env.CODEX_HUB_SSH_REMOTE_CLIENT_PATH?.trim()
    || path.join(packagedResourceDirectory, "dist-node", "ssh", "remote-client.cjs");
  await removeLegacyAuthorityTokenFiles(dataDir).catch((error: unknown) => {
    console.warn(`codexhub electron could not remove obsolete authority token file: ${errorText(error)}`);
  });
  const configEnv = await readServerConfigEnv(path.join(dataDir, "config.yaml"));
  const authToken = configuredAuthorityAuthToken(process.env, configEnv);
  const buildId = await authorityBuildId([
    authorityServicePath,
    path.join(staticDirectory, "index.html")
  ], "electron");
  return await ensureEmbeddedAuthority({
    dataDir,
    authorityServicePath,
    staticDirectory,
    remoteClientPath,
    buildId,
    authToken,
    projectCatalog: "editable",
    runAsElectronNode: true,
    logFileName: "authority.log"
  });
};

const registerSurface = async (target: EmbeddedAuthorityHandle, attempts = 30) => {
  const client = createCodexHubApiClient({ baseUrl: target.url, authToken: target.authToken });
  const workspacePaths = electronWorkspacePaths();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await client.route(apiRoutes.registerEmbeddedSurface, {
        surface: "electron",
        surfaceId,
        leaseId,
        protocolVersion: embeddedSurfaceProtocolVersion,
        workspacePaths,
        activeWorkspacePath: workspacePaths[0],
        label: "Codex Hub Electron",
        buildId: target.buildId
      });
      surfaceRegistered = true;
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientSurfaceRegistrationError(error) || attempt + 1 >= attempts) break;
      await delay(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const startHeartbeat = () => {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => void heartbeat(), surfaceHeartbeatMs);
  heartbeatTimer.unref?.();
};

const stopHeartbeat = () => {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
};

const heartbeat = async () => {
  if (heartbeatInFlight || !surfaceRegistered || !authority) return;
  heartbeatInFlight = true;
  try {
    const client = createCodexHubApiClient({ baseUrl: authority.url, authToken: authority.authToken });
    await client.route(apiRoutes.heartbeatEmbeddedSurface, surfaceId, {
      leaseId,
      protocolVersion: embeddedSurfaceProtocolVersion
    });
  } catch (error) {
    try {
      surfaceRegistered = false;
      authority = await startElectronAuthority();
      await registerSurface(authority, 3);
      if (mainWindow && !mainWindow.isDestroyed()) {
        await mainWindow.loadURL(electronSurfaceUrl(authority));
      }
      if (desktopPetWindow && !desktopPetWindow.isDestroyed()) {
        await desktopPetWindow.loadURL(electronSurfaceUrl(authority, true));
      }
    } catch (reconnectError) {
      console.error(`codexhub electron surface reconnect failed: ${errorText(reconnectError || error)}`);
    }
  } finally {
    heartbeatInFlight = false;
  }
};

const unregisterSurface = async (stopOwnedAuthority = false) => {
  if (stoppingSurface) return stoppingSurface;
  if (stopOwnedAuthority) {
    stopDesktopPetSync();
    closeDesktopPetWindow();
  }
  stopHeartbeat();
  const current = authority;
  authority = null;
  surfaceRegistered = false;
  stoppingSurface = (async () => {
    if (current && current.url) {
      const client = createCodexHubApiClient({ baseUrl: current.url, authToken: current.authToken });
      await client.route(apiRoutes.unregisterEmbeddedSurface, surfaceId, leaseId).catch(() => undefined);
    }
    if (stopOwnedAuthority && current?.startedByCaller && current.pid) {
      try {
        process.kill(current.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          console.warn(`codexhub electron authority stop failed: ${errorText(error)}`);
        }
      }
    }
  })().finally(() => {
    stoppingSurface = null;
  });
  return stoppingSurface;
};

const runSmoke = async () => {
  await ensureElectronSurface();
  const current = requiredAuthority();
  const response = await fetch(new URL("/api/health", current.url));
  if (!response.ok) throw new Error(`Electron smoke health failed: HTTP ${response.status}`);
  console.log(JSON.stringify({ ok: true, url: electronSurfaceUrl(current), health: await response.json() }));
  await unregisterSurface(true);
  allowQuit = true;
  electronApp.quit();
};

const requiredAuthority = () => {
  if (!authority) throw new Error("Electron authority is not available.");
  return authority;
};

const electronSurfaceUrl = (target: EmbeddedAuthorityHandle, desktopPet = false) => {
  const url = new URL("/", target.url);
  if (target.authToken) url.searchParams.set("codexhub_token", target.authToken);
  url.searchParams.set("surface", "electron");
  url.searchParams.set("surfaceId", surfaceId);
  url.searchParams.set(
    "stateScope",
    desktopPet ? `authority:${target.authorityId}:desktop-pet` : `authority:${target.authorityId}`
  );
  if (desktopPet) url.searchParams.set("desktopPet", "1");
  for (const workspacePath of electronWorkspacePaths()) url.searchParams.append("workspaceFolder", workspacePath);
  return url.toString();
};

const electronWorkspacePaths = () => [
  ...(process.env.CODEX_HUB_WORKSPACE_PATH?.trim() ? [process.env.CODEX_HUB_WORKSPACE_PATH.trim()] : []),
  ...(process.env.CODEX_HUB_WORKSPACE_PATHS?.split(path.delimiter).map((value) => value.trim()).filter(Boolean) ?? [])
].filter((value, index, values) => values.indexOf(value) === index);

const isTransientSurfaceRegistrationError = (error: unknown) =>
  error instanceof CodexHubApiError
  && error.status === 409
  && (
    error.responseText.includes("Local project launcher is still starting")
    || error.responseText.includes("No online codexhub project launcher")
  );

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

if (!electronApp.requestSingleInstanceLock()) {
  electronApp.quit();
} else {
  electronApp.on("second-instance", () => {
    void showMainWindow();
  });

  electronApp.whenReady()
    .then(async () => {
      screen.on("display-added", repositionDesktopPetWindow);
      screen.on("display-removed", repositionDesktopPetWindow);
      screen.on("display-metrics-changed", repositionDesktopPetWindow);
      createTray();
      if (electronSmokeEnabled) await runSmoke();
      else await createWindow();
    })
    .catch((error: unknown) => {
      console.error(error);
      electronApp.quit();
    });

  electronApp.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });

  electronApp.on("window-all-closed", () => {
    if (windowsTrayEnabled && tray) return;
    electronApp.quit();
  });

  electronApp.on("before-quit", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    destroyTray();
    stopDesktopPetSync();
    closeDesktopPetWindow();
    void unregisterSurface(electronSmokeEnabled).finally(() => {
      allowQuit = true;
      electronApp.quit();
    });
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      destroyTray();
      stopDesktopPetSync();
      closeDesktopPetWindow();
      void unregisterSurface(electronSmokeEnabled).finally(() => {
        allowQuit = true;
        electronApp.quit();
      });
    });
  }
}
