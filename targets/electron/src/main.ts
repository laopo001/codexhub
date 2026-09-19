import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
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
import {
  buildSafeWindowsCmdInvocation,
  parsePetActivityOpenTarget,
  resolveVsCodeLaunchPlan,
  resolveWindowsVsCodeCliExecutable,
  type PetActivityOpenTarget
} from "../../../src/shared/petActivityRouting.js";
import { applyServerConfigEnv, mergeServerConfigEnv, readServerConfigEnv } from "../../../src/core/serverConfigEnv.js";
import { embeddedAuthorityDataDirectory } from "../../../src/core/authorityPaths.js";
import { resolveAuthorityPackage } from "../../../src/core/authorityPackage.js";
import { withUserPath } from "../../../src/core/userPath.js";
import {
  authorityBuildId,
  ensureEmbeddedAuthority,
  probeEmbeddedAuthority,
  shouldStopOwnedAuthorityProcess,
  type AuthorityStopReason,
  type EmbeddedAuthorityHandle
} from "../../../src/core/embeddedAuthority.js";
import {
  configuredAuthorityAuthToken,
  removeLegacyAuthorityTokenFiles
} from "../../../src/core/authorityAuth.js";
import { createCodexHubApiClient, CodexHubApiError } from "../../../src/shared/apiClient.js";
import { apiRoutes } from "../../../src/shared/apiRoutes.js";
import { httpUrlFromValue } from "../../../src/shared/externalUrl.js";
import {
  calculateDesktopPetUnionBounds,
  parsePetHitRegions,
  petHitRegionsContainScreenPoint,
  shouldDesktopPetBeInteractive,
  type PetHitRegion,
  type ScreenDisplayBounds
} from "../../../src/shared/petInput.js";
import { embeddedSurfaceProtocolVersion } from "../../../src/shared/surfaceTypes.js";
import {
  isTaskCompleteNotification,
  taskCompleteNotificationOpenTarget,
  taskCompleteNotificationTitle,
  type TaskCompleteNotification
} from "../../../src/shared/taskNotifications.js";

const mainDirectory = electronApp.isPackaged
  ? path.join(electronApp.getAppPath(), "dist-node", "electron")
  : electronApp.getAppPath();
const preloadPath = path.join(mainDirectory, "preload.cjs");
const desktopPetSyncMs = 1_000;
const desktopPetInputPollMs = 16;
const desktopPetInputExitGraceMs = 100;
const desktopPetHitPadding = 12;
const windowsTrayEnabled = process.platform === "win32";
const electronSmokeEnabled = process.env.CODEX_HUB_ELECTRON_SMOKE === "1";
const electronAppUserModelId = "com.dadigua.codexhub";

// electron-builder uses appId as the Windows AUMID. Set it before any
// BrowserWindow or single-instance setup so native Toast notifications can
// resolve the installed Start Menu shortcut correctly.
if (process.platform === "win32") {
  // The desktop-pet window spans the complete virtual desktop. A single
  // per-monitor-DPI BrowserWindow can render across mixed-scale displays but
  // Chromium then receives physical mouse coordinates that do not match its
  // DIP DOM coordinates on the secondary display. Keep the Electron host in
  // one physical coordinate space so the transparent window, DOM hit regions,
  // and native input all agree across displays.
  electronApp.commandLine.appendSwitch("force-device-scale-factor", "1");
  electronApp.setAppUserModelId(electronAppUserModelId);
}

// Keep the 16px transparent raster aligned with the blue cube used by the
// packaged application icon so the tray and taskbar show the same identity.
const trayIconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAJcEhZcwAACxIAAAsSAdLdfvwAAAJbSURBVDjLjZM/SNRhHMY/3/d3dl1RUBZBLSdZDtFSaY3qIIJ3N6UtKgZRY9BY5OWQUxo1mTrknUVcm38iKJwyyMHFaghBwUEphIg079/7NJwXJ2T0TN/3+77Pw/fP+0AlJGvPKEAygLZnOtX2TKf+dlfGn0N7RsHLT4g+862v/MHQuvWauIkDicECuv+6y/0gKdd+BnvZYcUdAgDXn6hqbT/X5enH2DS45r1+uip7Ic8+eW4f/8Xw8A3LlzmuXFI8pebVCO+8uCujb3KRE+EwbzDOyXMAWDTj1uo+3sdTai635TBT6yMfdmFGIkdpMNE31WWDiZN0bGW1ao5e81yd7LTziAeRI1xwYUZaH/kwZnIAoRoLlMc2vzIj071YWt8JkfayB5Od7pCTPsZT+iBT/+Y33iqPhWosKLUAVK/jJSIW8DArO2vwVkUCB8fiKY1or30G1go5Ow08lohUr+MBQjvWiPa86XZfgcttT9WwZ78yAvIbdnG6x+YA4uO+iopNOoBlQJL3MgFcGlBkusfmCls2W9yy2ekem7s0oAiAl0mSX64UiEYhqLIg2E6GD6PSkAlJpSrLuYDS22i0QmCsiWwxz5LQaGxcVxqXyQGYIbMSsXGZXGxcV4RGi3mWxprIbgvIwORytEg2ZJ7n87XMJ9KqEyoIFRIZ1c3XMm+e55INuRwtYAKZKwUwscLGVLfdcQWiEl88LASBJYLAEj7LgsQXVyA61W13JlbY2HaCdjVSLK36WEozsZRmYmnV/8tQO5BMyrVnFJQNVhknk6WP919ISiWfSJbU7sTfZ8k/gPO0GAIAAAAASUVORK5CYII=";

let mainWindow: BrowserWindow | null = null;
let desktopPetWindow: BrowserWindow | null = null;
let authority: EmbeddedAuthorityHandle | null = null;
let tray: Tray | null = null;
let allowQuit = false;
let stoppingSurface: Promise<void> | null = null;
let authorityRecoveryInFlight: Promise<void> | null = null;
let surfaceRegistered = false;
let desktopPetSyncTimer: NodeJS.Timeout | null = null;
let desktopPetSyncInFlight = false;
let desktopPetInputTimer: NodeJS.Timeout | null = null;
let desktopPetHitRegions: PetHitRegion[] = [];
let desktopPetDragActive = false;
let desktopPetInputHoldUntilMs = 0;
let desktopPetMouseIgnored: boolean | null = null;
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
    const externalUrl = httpUrlFromValue(url);
    if (externalUrl) void shell.openExternal(externalUrl);
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
      title: taskCompleteNotificationTitle(notification),
      body: notification.body,
      ...(notification.persistent ? { timeoutType: "never" as const } : {})
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
      const openTarget = taskCompleteNotificationOpenTarget(notification);
      handleHostActivityOpenTarget(openTarget, { fallbackToElectron: true });
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
  return calculateDesktopPetUnionBounds(
    displays.map((display) => display.bounds),
    fallback
  );
};

const desktopPetDisplayBounds = (): ScreenDisplayBounds[] => {
  const windowBounds = desktopPetBounds();
  return screen.getAllDisplays().map((display) => ({
    x: display.bounds.x - windowBounds.x,
    y: display.bounds.y - windowBounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
  }));
};

const ensureDesktopPetAlwaysOnTop = (petWindow: BrowserWindow | null = desktopPetWindow) => {
  if (!petWindow || petWindow.isDestroyed()) return;
  // Use the highest available level to stay above floating and topmost windows (e.g. QQ, notifications).
  petWindow.setAlwaysOnTop(true, "screen-saver");
};

const setDesktopPetMouseIgnored = (ignore: boolean, force = false) => {
  const petWindow = desktopPetWindow;
  if (!petWindow || petWindow.isDestroyed()) return;
  if (!force && desktopPetMouseIgnored === ignore) return;
  if (!ignore) ensureDesktopPetAlwaysOnTop(petWindow);
  petWindow.setIgnoreMouseEvents(ignore, { forward: true });
  desktopPetMouseIgnored = ignore;
};

const updateDesktopPetInputMode = (force = false) => {
  const petWindow = desktopPetWindow;
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = petWindow.getBounds();
  const pointer = screen.getCursorScreenPoint();
  const nowMs = Date.now();
  if (petHitRegionsContainScreenPoint({
    cursorScreenPoint: pointer,
    windowBounds: bounds,
    hitRegions: desktopPetHitRegions,
    hitPadding: desktopPetHitPadding,
  })) {
    // Keep the native window interactive for a few polling frames after the
    // pointer leaves a reported hit region. That gives the renderer's
    // pointerdown handler time to publish drag-active before a fast first move
    // would otherwise turn mouse-through back on and break the drag.
    desktopPetInputHoldUntilMs = nowMs + desktopPetInputExitGraceMs;
  }
  const interactive = shouldDesktopPetBeInteractive({
    cursorScreenPoint: pointer,
    windowBounds: bounds,
    hitRegions: desktopPetHitRegions,
    isDragActive: desktopPetDragActive,
    inputHoldActive: nowMs < desktopPetInputHoldUntilMs,
    hitPadding: desktopPetHitPadding,
  });
  setDesktopPetMouseIgnored(!interactive, force);
};

const resetDesktopPetInputMode = () => {
  desktopPetMouseIgnored = null;
  setDesktopPetMouseIgnored(true, true);
  updateDesktopPetInputMode(true);
};

const startDesktopPetInputPolling = () => {
  if (desktopPetInputTimer) return;
  updateDesktopPetInputMode(true);
  desktopPetInputTimer = setInterval(() => updateDesktopPetInputMode(), desktopPetInputPollMs);
  desktopPetInputTimer.unref?.();
};

const stopDesktopPetInputPolling = () => {
  if (desktopPetInputTimer) clearInterval(desktopPetInputTimer);
  desktopPetInputTimer = null;
  desktopPetHitRegions = [];
  desktopPetDragActive = false;
  desktopPetInputHoldUntilMs = 0;
  desktopPetMouseIgnored = null;
};

const repositionDesktopPetWindow = () => {
  if (!desktopPetWindow || desktopPetWindow.isDestroyed()) return;
  const bounds = desktopPetBounds();
  desktopPetWindow.setBounds(bounds);
  // Re-assert topmost hierarchy after cross-monitor repositioning on Windows.
  ensureDesktopPetAlwaysOnTop(desktopPetWindow);
  // The renderer hit regions are relative to this window. Re-evaluate the
  // native input mode after the coordinate space changes instead of relying
  // on a forwarded mouse event that may arrive late or out of order.
  resetDesktopPetInputMode();
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
  ensureDesktopPetAlwaysOnTop(petWindow);
  resetDesktopPetInputMode();
  petWindow.on("closed", () => {
    if (desktopPetWindow === petWindow) desktopPetWindow = null;
  });
  try {
    await petWindow.loadURL(electronSurfaceUrl(target, true));
    if (!petWindow.isDestroyed()) {
      petWindow.showInactive();
      // Windows can clamp the constructor bounds to the primary work area
      // while the frameless window is hidden. Reapply the virtual-desktop
      // bounds after the first show so the renderer viewport spans every
      // display and drag clamping does not stop at the primary screen edge.
      repositionDesktopPetWindow();
      startDesktopPetInputPolling();
    }
  } catch (error) {
    stopDesktopPetInputPolling();
    if (!petWindow.isDestroyed()) petWindow.destroy();
    throw error;
  }
};

const closeDesktopPetWindow = () => {
  const petWindow = desktopPetWindow;
  desktopPetWindow = null;
  stopDesktopPetInputPolling();
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

ipcMain.on("codexhub:pet-hit-regions", (event, value: unknown) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== desktopPetWindow || sender.isDestroyed()) return;
  const regions = parsePetHitRegions(value);
  if (!regions) return;
  desktopPetHitRegions = regions;
  updateDesktopPetInputMode();
});

ipcMain.on("codexhub:pet-drag-active", (event, active: unknown) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== desktopPetWindow || sender.isDestroyed()) return;
  desktopPetDragActive = Boolean(active);
  updateDesktopPetInputMode(true);
});

ipcMain.handle("codexhub:pet-display-bounds", (event) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== desktopPetWindow || sender.isDestroyed()) return [];
  return desktopPetDisplayBounds();
});

const launchVsCodeTarget = (plan: { command: string; args: string[] }) => {
  try {
    const isWindows = process.platform === "win32";
    if (isWindows) {
      const invocation = buildSafeWindowsCmdInvocation(plan.command, plan.args, {
        env: process.env
      });
      if (!invocation) {
        console.warn("[codexhub:electron] Refusing unsafe Windows cmd invocation for VSCode target");
        return false;
      }
      const child = spawn(invocation.cmdExe, invocation.cmdArgs, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        cwd: invocation.cwd
      });
      child.unref();
      child.on("error", (error) => {
        console.warn("[codexhub:electron] Failed to launch VSCode target:", error);
      });
      return true;
    }
    const child = spawn(plan.command, plan.args, {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    child.on("error", (error) => {
      console.warn("[codexhub:electron] Failed to launch VSCode target:", error);
    });
    return true;
  } catch (error) {
    console.warn("[codexhub:electron] Failed to spawn VSCode process:", error);
    return false;
  }
};

const handleHostActivityOpenTarget = (
  target: PetActivityOpenTarget | null,
  options?: { fallbackToElectron?: boolean }
): boolean => {
  if (!target) return false;

  // 1. Explicit workspace target chooses the host surface; ProjectTarget alone is insufficient.
  if (target.workspaceTarget?.kind === "electron") {
    if (target.threadId.trim()) {
      void focusMainWindowForThread(target.threadId.trim());
    } else {
      void showMainWindow();
    }
    return true;
  }

  // 2. Explicit VSCode workspace: only a validated workspace target may launch VSCode.
  if (target.workspaceTarget?.kind === "vscode") {
    const channel = target.workspaceTarget.vscodeChannel;
    if (channel) {
      const customExecutable = process.platform === "win32"
        ? resolveWindowsVsCodeCliExecutable(channel, process.env, existsSync)
        : undefined;
      if (process.platform !== "win32" || customExecutable) {
        const plan = resolveVsCodeLaunchPlan(target, {
          localHostname: os.hostname(),
          ...(customExecutable ? { customExecutable } : {})
        });
        if (plan) {
          const launched = launchVsCodeTarget(plan);
          if (launched) return true;
        }
      }
    }
    // 当 VSCode 无法唤起时（如 hostname mismatch 或无本地 CLI）：
    // 若开启 fallbackToElectron（如通知点击），则回退聚焦 Electron 并打开 thread；
    // 桌宠点击匹配不到目标时不打开其他窗口；不从 cwd/projectPath 推断 VSCode 目标。
    if (options?.fallbackToElectron && target.threadId.trim()) {
      void focusMainWindowForThread(target.threadId.trim());
      return true;
    }
    return false;
  }

  // 3. Legacy/source-only payloads may safely fall back to Electron for notifications,
  // but never use cwd/projectPath to launch VSCode.
  if (options?.fallbackToElectron && target.threadId.trim()) {
    void focusMainWindowForThread(target.threadId.trim());
    return true;
  }

  return false;
};

ipcMain.on("codexhub:pet-open-activity", (event, value: unknown) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== desktopPetWindow || sender.isDestroyed()) return;
  const target = parsePetActivityOpenTarget(value);
  handleHostActivityOpenTarget(target, { fallbackToElectron: false });
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
};

const startElectronAuthority = async () => {
  const dataDir = embeddedAuthorityDataDirectory();
  const configEnv = await readServerConfigEnv(path.join(dataDir, "config.yaml"));
  applyServerConfigEnv(configEnv);
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
  // Electron main-process behavior is not a VS Code setting. Apply the same
  // shared config.yaml env map before DevTools/workspace handling runs.
  const environment = await withUserPath(mergeServerConfigEnv(process.env, configEnv));
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

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Stop only an authority process that this Electron host started itself. */
const stopOwnedAuthorityProcess = async (
  target: EmbeddedAuthorityHandle | null,
  reason: AuthorityStopReason
) => {
  if (!target?.startedByCaller || !target.pid) return;
  const currentHealth = await probeEmbeddedAuthority(target.url, target.authorityId, Boolean(target.authToken), target.authToken).catch(() => null);
  if (!shouldStopOwnedAuthorityProcess(target, currentHealth, reason)) return;
  const pid = target.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      console.warn(`codexhub electron authority stop failed: ${errorText(error)}`);
    }
    return;
  }

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await delay(50);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      console.warn(`codexhub electron authority force-stop failed: ${errorText(error)}`);
    }
  }
};

const recoverElectronSurface = () => {
  if (authorityRecoveryInFlight) return authorityRecoveryInFlight;

  authorityRecoveryInFlight = (async () => {
    const previous = authority;
    surfaceRegistered = false;
    authority = null;

    // A normal restart closes the service before this recovery runs. If the
    // old service is still responsive, keep it and re-attach instead of
    // killing a shared VS Code-owned authority. If it is non-responsive and
    // Electron owns it, reap it so the new linked package can bind the port.
    const previousHealth = previous
      ? await probeEmbeddedAuthority(previous.url, previous.authorityId, Boolean(previous.authToken), previous.authToken).catch(() => null)
      : null;
    // Recovery may stop only an owned, still-unreachable authority. A changed
    // generation means takeover/self-restart; a same generation means attach.
    if (previous && shouldStopOwnedAuthorityProcess(previous, previousHealth, "recovery")) {
      await stopOwnedAuthorityProcess(previous, "recovery");
    }

    let lastError: unknown = new Error("Electron authority recovery failed.");
    for (let attempt = 0; attempt < 12; attempt += 1) {
      let launched: EmbeddedAuthorityHandle | null = null;
      try {
        launched = await startElectronAuthority();
        authority = launched;
        await registerSurface(launched, 3);
        // Keep renderer recovery in the shared Web app. Repoint native windows
        // only when their effective document URL (authority/auth/scope) changed;
        // otherwise realtime compares serverInstanceId and reloads exactly once.
        const mainDocumentChanged = !previous || electronSurfaceUrl(previous) !== electronSurfaceUrl(launched);
        const petDocumentChanged = !previous || electronSurfaceUrl(previous, true) !== electronSurfaceUrl(launched, true);
        if (mainDocumentChanged && mainWindow && !mainWindow.isDestroyed()) {
          await mainWindow.loadURL(electronSurfaceUrl(launched));
        }
        if (petDocumentChanged && desktopPetWindow && !desktopPetWindow.isDestroyed()) {
          await desktopPetWindow.loadURL(electronSurfaceUrl(launched, true));
          ensureDesktopPetAlwaysOnTop(desktopPetWindow);
          resetDesktopPetInputMode();
        }
        return;
      } catch (error) {
        lastError = error;
        surfaceRegistered = false;
        authority = null;
        if (launched?.startedByCaller) await stopOwnedAuthorityProcess(launched, "recovery");
        if (attempt + 1 < 12) await delay(250 + attempt * 250);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  })().finally(() => {
    authorityRecoveryInFlight = null;
  });

  return authorityRecoveryInFlight;
};

const unregisterSurface = async (stopOwnedAuthority = false) => {
  if (stoppingSurface) return stoppingSurface;
  if (stopOwnedAuthority) {
    stopDesktopPetSync();
    closeDesktopPetWindow();
  }
  const current = authority;
  authority = null;
  surfaceRegistered = false;
  stoppingSurface = (async () => {
    if (current && current.url) {
      const client = createCodexHubApiClient({ baseUrl: current.url, authToken: current.authToken });
      await client.route(apiRoutes.unregisterEmbeddedSurface, surfaceId, leaseId).catch(() => undefined);
    }
    if (stopOwnedAuthority) await stopOwnedAuthorityProcess(current, "shutdown");
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
  const health = await response.json();
  const initialGeneration = current.serverInstanceId;
  const client = createCodexHubApiClient({ baseUrl: current.url, authToken: current.authToken });
  const restart = await client.route(apiRoutes.restartAuthority);
  if (!restart.ok || !restart.restarting) {
    throw new Error(`Electron smoke restart request failed: ${JSON.stringify(restart)}`);
  }
  const recoveryDeadline = Date.now() + 30_000;
  let restartHealth: Record<string, unknown> | null = null;
  while (Date.now() < recoveryDeadline) {
    try {
      const recovered = await fetch(new URL("/api/health", current.url));
      if (recovered.ok) {
        const candidate = await recovered.json() as Record<string, unknown>;
        if (candidate.serverInstanceId !== initialGeneration) {
          restartHealth = candidate;
          break;
        }
      }
    } catch {
      // The supervisor may still be waiting for the old authority to release the port.
    }
    await delay(250);
  }
  if (!restartHealth) throw new Error("Electron smoke authority did not recover after restart.");

  console.log(JSON.stringify({
    ok: true,
    url: electronSurfaceUrl(requiredAuthority()),
    health,
    restartHealth
  }));
  await unregisterSurface(true);
  allowQuit = true;
  electronApp.quit();
};

const requiredAuthority = () => {
  if (!authority) throw new Error("Electron authority is not available.");
  return authority;
};

ipcMain.handle("codexhub:recover-surface", async (event) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || (sender !== mainWindow && sender !== desktopPetWindow) || sender.isDestroyed()) {
    throw new Error("CodexHub surface recovery is only available to an active Electron window.");
  }
  await recoverElectronSurface();
  return { ok: true };
});

const electronSurfaceUrl = (target: EmbeddedAuthorityHandle, desktopPet = false) => {
  const url = new URL("/", target.url);
  if (target.authToken) url.searchParams.set("codexhub_token", target.authToken);
  url.searchParams.set("surface", "electron");
  url.searchParams.set("surfaceId", surfaceId);
  if (!desktopPet) url.searchParams.set("surfaceLeaseId", leaseId);
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
