import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  app as electronApp,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  shell,
  Tray
} from "electron";
import { applyServerConfigEnv, readServerConfigEnv } from "../../../src/core/serverConfigEnv.js";
import { embeddedAuthorityDataDirectory } from "../../../src/core/authorityPaths.js";
import { resolveAuthorityPackage } from "../../../src/core/authorityPackage.js";
import { withUserPath } from "../../../src/core/userPath.js";
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
import {
  isTaskCompleteNotification,
  type TaskCompleteNotification
} from "../../../src/shared/taskNotifications.js";

const mainDirectory = electronApp.isPackaged
  ? path.join(electronApp.getAppPath(), "dist-node", "electron")
  : electronApp.getAppPath();
const preloadPath = path.join(mainDirectory, "preload.cjs");
const surfaceHeartbeatMs = 10_000;
const desktopPetSyncMs = 1_000;
const windowsTrayEnabled = process.platform === "win32";
const electronSmokeEnabled = process.env.CODEX_HUB_ELECTRON_SMOKE === "1";

// Keep the 16px transparent raster aligned with the blue cube used by the
// packaged application icon so the tray and taskbar show the same identity.
const trayIconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAJcEhZcwAACxIAAAsSAdLdfvwAAAJbSURBVDjLjZM/SNRhHMY/3/d3dl1RUBZBLSdZDtFSaY3qIIJ3N6UtKgZRY9BY5OWQUxo1mTrknUVcm38iKJwyyMHFaghBwUEphIg079/7NJwXJ2T0TN/3+77Pw/fP+0AlJGvPKEAygLZnOtX2TKf+dlfGn0N7RsHLT4g+862v/MHQuvWauIkDicECuv+6y/0gKdd+BnvZYcUdAgDXn6hqbT/X5enH2DS45r1+uip7Ic8+eW4f/8Xw8A3LlzmuXFI8pebVCO+8uCujb3KRE+EwbzDOyXMAWDTj1uo+3sdTai635TBT6yMfdmFGIkdpMNE31WWDiZN0bGW1ao5e81yd7LTziAeRI1xwYUZaH/kwZnIAoRoLlMc2vzIj071YWt8JkfayB5Od7pCTPsZT+iBT/+Y33iqPhWosKLUAVK/jJSIW8DArO2vwVkUCB8fiKY1or30G1go5Ow08lohUr+MBQjvWiPa86XZfgcttT9WwZ78yAvIbdnG6x+YA4uO+iopNOoBlQJL3MgFcGlBkusfmCls2W9yy2ekem7s0oAiAl0mSX64UiEYhqLIg2E6GD6PSkAlJpSrLuYDS22i0QmCsiWwxz5LQaGxcVxqXyQGYIbMSsXGZXGxcV4RGi3mWxprIbgvIwORytEg2ZJ7n87XMJ9KqEyoIFRIZ1c3XMm+e55INuRwtYAKZKwUwscLGVLfdcQWiEl88LASBJYLAEj7LgsQXVyA61W13JlbY2HaCdjVSLK36WEozsZRmYmnV/8tQO5BMyrVnFJQNVhknk6WP919ISiWfSJbU7sTfZ8k/gPO0GAIAAAAASUVORK5CYII=";

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
const activeTaskNotifications = new Set<Notification>();
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

const focusMainWindowForThread = async (threadId: string) => {
  await showMainWindow();
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send("codexhub:open-thread", threadId);
};

const showTaskCompleteNativeNotification = (notification: TaskCompleteNotification) => {
  if (!Notification.isSupported()) {
    console.warn("codexhub electron native notifications are not supported on this platform");
    return;
  }
  try {
    const nativeNotification = new Notification({
      id: `codexhub-task-complete:${notification.threadId}`,
      title: notification.title,
      body: notification.body
    });
    activeTaskNotifications.add(nativeNotification);
    const release = () => activeTaskNotifications.delete(nativeNotification);
    nativeNotification.once("close", release);
    nativeNotification.once("failed", (_event, error) => {
      release();
      console.warn(`codexhub electron native notification failed: ${error}`);
    });
    nativeNotification.once("click", () => {
      release();
      void focusMainWindowForThread(notification.threadId);
    });
    nativeNotification.show();
  } catch (error) {
    console.warn(`codexhub electron native notification could not be shown: ${errorText(error)}`);
  }
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

const syncDesktopPetPointerPosition = (petWindow: BrowserWindow, bounds = petWindow.getBounds()) => {
  if (petWindow.isDestroyed() || petWindow.webContents.isDestroyed()) return;
  const pointer = screen.getCursorScreenPoint();
  petWindow.webContents.send("codexhub:pet-pointer-position", {
    clientX: pointer.x - bounds.x,
    clientY: pointer.y - bounds.y,
  });
};

const repositionDesktopPetWindow = () => {
  if (!desktopPetWindow || desktopPetWindow.isDestroyed()) return;
  const bounds = desktopPetBounds();
  desktopPetWindow.setBounds(bounds);
  // Display changes resize the transparent click-through window without
  // necessarily producing a mouse event. Re-evaluate the current pointer
  // against the new renderer coordinate space immediately.
  syncDesktopPetPointerPosition(desktopPetWindow, bounds);
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
    if (!petWindow.isDestroyed()) {
      petWindow.showInactive();
      syncDesktopPetPointerPosition(petWindow);
    }
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

ipcMain.on("codexhub:pet-request-pointer-position", (event) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== desktopPetWindow || sender.isDestroyed()) return;
  syncDesktopPetPointerPosition(sender);
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

ipcMain.on("codexhub:task-complete-notification", (event, value: unknown) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== mainWindow || sender.isDestroyed()) return;
  if (!isTaskCompleteNotification(value)) return;
  showTaskCompleteNativeNotification(value);
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
  const configuredAuthorityServicePath = process.env.CODEX_HUB_AUTHORITY_SERVICE_PATH?.trim();
  const bundledAuthorityServicePath = configuredAuthorityServicePath
    || (electronApp.isPackaged
      ? path.join(packagedResourceDirectory, "authority-service.cjs")
      : path.join(mainDirectory, "authority-service.cjs"));
  const configuredStaticDirectory = process.env.CODEX_HUB_STATIC_DIR?.trim();
  const bundledStaticDirectory = configuredStaticDirectory
    || path.join(packagedResourceDirectory, "dist");
  const configuredRemoteClientPath = process.env.CODEX_HUB_SSH_REMOTE_CLIENT_PATH?.trim();
  const bundledRemoteClientPath = configuredRemoteClientPath
    || path.join(packagedResourceDirectory, "dist-node", "ssh", "remote-client.cjs");
  await removeLegacyAuthorityTokenFiles(dataDir).catch((error: unknown) => {
    console.warn(`codexhub electron could not remove obsolete authority token file: ${errorText(error)}`);
  });
  const configEnv = await readServerConfigEnv(path.join(dataDir, "config.yaml"));
  // Electron main-process behavior is not a VS Code setting. Apply the same
  // shared config.yaml env map before DevTools/workspace handling runs.
  applyServerConfigEnv(configEnv);
  const environment = await withUserPath({ ...(configEnv ?? {}), ...process.env });
  // Prefer the current local npm/link package discovered through PATH. This
  // is shared with VS Code and lets `pnpm run link:all` update the Windows
  // authority for both embedded clients. Fall back to the bundled authority
  // only when PATH has no usable CodexHub package, while still honoring an
  // explicit CODEX_HUB_AUTHORITY_PACKAGE override.
  const hasDirectBundleOverride = Boolean(configuredAuthorityServicePath || configuredStaticDirectory);
  const hasExplicitAuthorityPackage = Boolean(environment.CODEX_HUB_AUTHORITY_PACKAGE?.trim());
  const packageResolutionEnvironment = hasDirectBundleOverride && !hasExplicitAuthorityPackage
    ? Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== "path"))
    : environment;
  const packageResolution = await resolveAuthorityPackage({
    authorityServicePath: bundledAuthorityServicePath,
    staticDirectory: bundledStaticDirectory,
    remoteClientPath: bundledRemoteClientPath
  }, packageResolutionEnvironment);
  const authorityServicePath = packageResolution.authorityServicePath;
  const staticDirectory = packageResolution.staticDirectory;
  const remoteClientPath = configuredRemoteClientPath || packageResolution.remoteClientPath;
  const authToken = configuredAuthorityAuthToken(process.env, configEnv);
  const buildId = await authorityBuildId([
    authorityServicePath,
    path.join(staticDirectory, "index.html")
  ], packageResolution.source === "bundled" ? "electron" : "npm");
  return await ensureEmbeddedAuthority({
    dataDir,
    authorityServicePath,
    staticDirectory,
    remoteClientPath,
    buildId,
    authToken,
    projectCatalog: "editable",
    runAsElectronNode: true,
    logFileName: "authority.log",
    environment,
    authorityServiceSource: packageResolution.source
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
