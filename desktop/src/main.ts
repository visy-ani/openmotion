import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DesktopAppInfo,
  DesktopChromeInsets,
  DesktopDiagnosticExportResult,
  DesktopMenuAction,
} from '../../shared/platform-host.ts';
import { createDesktopDiagnosticZip, DesktopLogger } from './logger.ts';
import { buildDesktopMenuTemplate } from './menu.ts';
import {
  buildMainWindowOptions,
  getWindowsTitleBarOverlay,
  normalizeDesktopPlatform,
  resolveDesktopChrome,
} from './platform.ts';
import { DesktopSidecarManager } from './sidecar.ts';
import { SplashController } from './splash.ts';
import { DesktopUpdaterController } from './updater.ts';

const __filename = fileURLToPath(import.meta.url);
const distDir = path.dirname(__filename);
const platform = normalizeDesktopPlatform(process.platform);

app.setName('OpenMotion');
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'OpenMotion'));
} catch {
  // Ignore custom userData override failure on restricted hosts.
}

function resolveAppRoot(): string {
  const packagedRoot = process.resourcesPath ? path.join(process.resourcesPath, 'app-server') : '';
  if (packagedRoot && existsSync(path.join(packagedRoot, 'server.ts'))) {
    return packagedRoot;
  }
  return path.resolve(distDir, '..', '..');
}

function resolveLogDir(): string {
  try {
    return app.getPath('logs');
  } catch {
    return path.join(app.getPath('userData'), 'logs');
  }
}

function resolveDataDir(): string {
  return process.env.MOTION_DATA_DIR?.trim() || path.join(app.getPath('userData'), 'workspace-data');
}

function resolveIconPath(): string | undefined {
  for (const file of ['app-icon.png', 'apple-touch-icon.png']) {
    const candidate = path.join(distDir, 'brand', file);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
  process.exit(0);
}

const appRoot = resolveAppRoot();
const logDir = resolveLogDir();
const dataDir = resolveDataDir();
const linuxCustomTitleBar = process.env.MOTION_LINUX_NATIVE_FRAME !== '1';
const releaseChannel: DesktopAppInfo['releaseChannel'] =
  !app.isPackaged ? 'dev' : app.getVersion().includes('-') ? 'beta' : 'stable';

const logger = new DesktopLogger({
  logDir,
  redactPaths: [appRoot, dataDir, logDir, os.homedir()],
});

logger.markSessionStarted({
  version: app.getVersion(),
  platform,
  arch: process.arch,
});

const sidecar = new DesktopSidecarManager({ appRoot, dataDir, logDir, logger });
const updater = new DesktopUpdaterController({
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  onOpenReleasePage: url => {
    void openExternalSafe(url);
  },
});

let mainWindow: BrowserWindow | null = null;
let splash: SplashController | null = null;
let domFullscreen = false;
let currentTheme: 'light' | 'dark' = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
let pendingMenuActions: DesktopMenuAction[] = [];
const MAX_PENDING_MENU_ACTIONS = 32;
let rendererReady = false;
let resolveRendererReadyCallback: (() => void) | null = null;
let bootInFlight: Promise<void> | null = null;
let shuttingDown = false;
let quitPromptOpen = false;
let splashDeferredRelease: (() => void) | null = null;
let splashHoldWelcome = false;

function queuePendingMenuAction(action: DesktopMenuAction): void {
  if (pendingMenuActions.length >= MAX_PENDING_MENU_ACTIONS) {
    pendingMenuActions.shift();
  }
  pendingMenuActions.push(action);
}

function currentChromeState(): DesktopChromeInsets {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const fullscreen = Boolean(win?.isFullScreen() || domFullscreen);
  const maximized = Boolean(win?.isMaximized());
  return resolveDesktopChrome({
    platform,
    fullscreen,
    maximized,
    linuxCustomTitleBar,
  });
}

function broadcastChromeState(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('openmotion:chrome-state', currentChromeState());
}

function dispatchMenuAction(action: DesktopMenuAction): void {
  if (action === 'export-logs') {
    void exportLogsWithDialog();
    return;
  }
  if (action === 'reload-app' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reload();
    return;
  }
  if (action === 'check-updates') {
    void updater.checkForUpdates();
  }
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    if (rendererReady) {
      win.webContents.send('openmotion:menu-action', action);
    } else {
      queuePendingMenuAction(action);
    }
  } else {
    queuePendingMenuAction(action);
  }
}

async function openExternalSafe(url: string): Promise<{ ok: boolean; error?: string }> {
  if (!isAllowedExternalUrl(url)) {
    return { ok: false, error: 'Unsupported external URL protocol' };
  }
  await shell.openExternal(url);
  return { ok: true };
}

async function exportLogsWithDialog(): Promise<DesktopDiagnosticExportResult> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultName = `openmotion-diagnostics-${stamp}.zip`;
    const parent =
      mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : splash?.window && !splash.window.isDestroyed()
          ? splash.window
          : undefined;
    const saveOptions = {
      title: 'Export OpenMotion Diagnostic Logs',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    };
    const picked = parent
      ? await dialog.showSaveDialog(parent, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (picked.canceled || !picked.filePath) {
      return { ok: false, canceled: true };
    }
    const result = await createDesktopDiagnosticZip({
      appRoot,
      dataDir,
      logDir,
      outPath: picked.filePath,
    });
    logger.info('main', 'Exported diagnostic bundle', { entryCount: result.entryCount });
    return { ok: true, path: result.path, entryCount: result.entryCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('main', 'Failed to export diagnostics', { error: message });
    return { ok: false, error: message };
  }
}

async function openLogsFolder(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const err = await shell.openPath(logDir);
  if (err) {
    return { ok: false, error: err };
  }
  return { ok: true, path: logDir };
}

function revealMainWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) {
    win.show();
  }
  void splash?.playExitAndClose().catch(() => splash?.close());
  broadcastChromeState();
}

async function fetchBackendJson<T>(url: string, init?: RequestInit, timeoutMs = 4_000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function bootDesktop(): Promise<void> {
  if (bootInFlight) {
    if (splash?.window && !splash.window.isDestroyed()) {
      if (splash.window.isMinimized()) splash.window.restore();
      splash.window.focus();
    }
    return bootInFlight;
  }
  bootInFlight = (async () => {
    const preloadPath = path.join(distDir, 'preload.cjs');
    splash ??= new SplashController({
      onRetry: () => {
        void startBackendAndOpenWindow();
      },
    });
    const splashWin = splash.open(distDir, preloadPath, currentTheme);
    splashWin.once('closed', () => {
      if (splashDeferredRelease) {
        const release = splashDeferredRelease;
        splashDeferredRelease = null;
        if (!shuttingDown && mainWindow && !mainWindow.isDestroyed()) {
          release();
        }
      }
    });
    await startBackendAndOpenWindow();
  })().finally(() => {
    bootInFlight = null;
  });
  return bootInFlight;
}

async function startBackendAndOpenWindow(): Promise<void> {
  const preloadPath = path.join(distDir, 'preload.cjs');
  splashDeferredRelease = null;
  try {
    splash?.setProgress({
      step: 'engine',
      mode: 'booting',
      status: 'Starting the local engine',
      detail: 'Launching local workspace runtime',
    });

    const started = await sidecar.start({
      onProgress: (step, status) => {
        splash?.setProgress({ step, mode: 'booting', status });
      },
    });

    // Launch main BrowserWindow immediately in parallel with agent/account checks
    // so React hydration and CSS/JS compile overlap zero extra round-trips.
    const existingMain = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    rendererReady = false;
    resolveRendererReadyCallback = null;

    let windowReadyPromise: Promise<void>;
    if (existingMain) {
      void existingMain.loadURL(started.appUrl);
      windowReadyPromise = new Promise<void>(resolve => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(fallbackTimer);
          resolveRendererReadyCallback = null;
          resolve();
        };
        resolveRendererReadyCallback = done;
        if (rendererReady) {
          done();
          return;
        }
        const fallbackTimer = setTimeout(done, 4_000);
      });
    } else {
      const win = new BrowserWindow(
        buildMainWindowOptions({
          platform,
          theme: currentTheme,
          linuxCustomTitleBar,
          preloadPath,
          iconPath: resolveIconPath(),
        }),
      );
      mainWindow = win;

      let shownReady = false;
      let paintSettled = false;
      let finishWindow!: () => void;
      windowReadyPromise = new Promise<void>(resolve => {
        finishWindow = () => {
          if (paintSettled) return;
          paintSettled = true;
          clearTimeout(fallbackShow);
          clearTimeout(postShowFallback);
          resolveRendererReadyCallback = null;
          resolve();
        };
      });

      let postShowFallback: ReturnType<typeof setTimeout> | undefined;
      const fallbackShow = setTimeout(finishWindow, 10_000);
      resolveRendererReadyCallback = () => {
        if (shownReady || win.isVisible()) finishWindow();
      };
      win.once('ready-to-show', () => {
        shownReady = true;
        if (rendererReady) {
          finishWindow();
          return;
        }
        postShowFallback = setTimeout(finishWindow, 1_200);
      });
      win.on('close', event => {
        if (platform === 'darwin' && !shuttingDown) {
          event.preventDefault();
          if (win.isFullScreen()) {
            win.once('leave-full-screen', () => {
              if (!win.isDestroyed() && !shuttingDown) win.hide();
            });
            win.setFullScreen(false);
          } else {
            win.hide();
          }
        }
      });
      win.on('closed', () => {
        clearTimeout(fallbackShow);
        clearTimeout(postShowFallback);
        finishWindow();
        if (mainWindow === win) mainWindow = null;
      });
      win.on('enter-full-screen', broadcastChromeState);
      win.on('leave-full-screen', broadcastChromeState);
      win.on('maximize', broadcastChromeState);
      win.on('unmaximize', broadcastChromeState);

      win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || input.alt || input.shift) return;
        const primaryMod = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
        if (!primaryMod) return;
        const key = input.key.toLowerCase();
        if (key === 'w') {
          event.preventDefault();
          minimizeFocusedWindow();
        } else if (key === 'm') {
          event.preventDefault();
          hideDesktopApp();
        } else if (key === 'q') {
          event.preventDefault();
          void requestQuitWithConfirmation();
        }
      });

      win.webContents.setWindowOpenHandler(({ url }) => {
        if (isAllowedExternalUrl(url)) {
          void shell.openExternal(url);
        }
        return { action: 'deny' };
      });

      win.webContents.on('render-process-gone', (_event, details) => {
        logger.error('renderer', 'Renderer process gone', {
          reason: details.reason,
          exitCode: details.exitCode,
        });
        logger.writeCrashMarker('renderer-gone', details);
      });

      void win.loadURL(started.appUrl);
    }

    splash?.setProgress({
      step: 'agents',
      mode: 'booting',
      status: 'Discovering local AI agents & account',
    });
    const [agentList, fetchedAccount] = await Promise.all([
      fetchBackendJson<Array<{ id?: string; label?: string; installed?: boolean }>>(
        `${started.apiOrigin}/motion-api/settings/agents`,
      ),
      fetchBackendJson<{
        state?: string;
        user?: { name?: string; email?: string };
        plan?: string;
        authorizationUrl?: string;
        userCode?: string;
        browserOpened?: boolean;
        syncing?: boolean;
        error?: string;
        errorCode?: string;
      }>(`${started.apiOrigin}/motion-api/settings/account`),
    ]);

    const installedAgents = Array.isArray(agentList) ? agentList.filter(a => a?.installed) : [];
    const agentsCount = installedAgents.length;
    const account = fetchedAccount ?? { state: 'signed-out' };

    const forceSignIn = process.env.MOTION_DESKTOP_FORCE_SIGNIN === '1';
    const isSignedIn = account.state === 'signed-in' && !forceSignIn;

    if (isSignedIn) {
      splashHoldWelcome = true;
      splash?.setProgress({
        step: 'ready',
        mode: 'welcome',
        status: 'Opening OpenMotion Studio',
        agentsCount,
        account: {
          state: 'signed-in',
          name: account.user?.name,
          email: account.user?.email,
          plan: account.plan,
        },
      });
      const elapsedSinceSplash = splash?.startedAt ? Date.now() - splash.startedAt : 0;
      const minHoldMs = Math.max(0, 320 - elapsedSinceSplash);
      await Promise.all([
        windowReadyPromise,
        ...(minHoldMs > 0 ? [new Promise(resolve => setTimeout(resolve, minHoldMs))] : []),
      ]);
      splashHoldWelcome = false;
      revealMainWindow();
    } else {
      splash?.setProgress({
        step: 'account',
        mode: 'signin',
        status: 'Connect your OpenDesign account',
        agentsCount,
        account: {
          state: account.state ?? 'signed-out',
          authorizationUrl: account.authorizationUrl,
          userCode: account.userCode,
          browserOpened: account.browserOpened,
          syncing: account.syncing,
          error: account.error,
          errorCode: account.errorCode,
        },
      });
      await new Promise<void>(resolve => {
        splashDeferredRelease = resolve;
      });
      await windowReadyPromise;
      revealMainWindow();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('main', 'Desktop startup failed', { error: message });
    splash?.setProgress({
      step: 'engine',
      mode: 'error',
      status: 'Startup paused — check logs or retry.',
      errorMessage: message,
    });
  }
}

function registerIpc(): void {
  ipcMain.handle('openmotion:get-app-info', (): DesktopAppInfo => ({
    isDesktop: true,
    platform,
    arch: process.arch,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    chromeVersion: process.versions.chrome ?? '',
    nodeVersion: process.versions.node ?? '',
    isPackaged: app.isPackaged,
    logDir,
    dataDir,
    releaseChannel,
  }));

  ipcMain.handle('openmotion:get-chrome-state', () => currentChromeState());

  ipcMain.handle('openmotion:set-theme', (_event, theme: 'light' | 'dark') => {
    currentTheme = theme === 'light' ? 'light' : 'dark';
    nativeTheme.themeSource = currentTheme;
    if (platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.setTitleBarOverlay(getWindowsTitleBarOverlay(currentTheme));
      } catch {
        // Older Electron window modes ignore overlay updates safely.
      }
    }
  });

  ipcMain.handle('openmotion:window-minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('openmotion:window-toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.handle('openmotion:window-close', () => {
    mainWindow?.close();
  });

  ipcMain.handle('openmotion:check-updates', () => updater.checkForUpdates());
  ipcMain.handle('openmotion:download-update', () => updater.downloadUpdate());
  ipcMain.handle('openmotion:install-update-now', () =>
    updater.installUpdateNow(async () => {
      shuttingDown = true;
      await sidecar.stop();
      logger.markSessionEnded('install-update');
    }),
  );
  ipcMain.handle('openmotion:get-update-state', () => updater.getState());
  ipcMain.handle('openmotion:export-logs', () => exportLogsWithDialog());
  ipcMain.handle('openmotion:open-logs-folder', () => openLogsFolder());
  ipcMain.handle('openmotion:open-external', (_event, url: string) => openExternalSafe(url));
  ipcMain.handle('openmotion:splash-retry', () => {
    void startBackendAndOpenWindow();
  });
  ipcMain.handle('openmotion:splash-continue', () => {
    const release = splashDeferredRelease;
    splashDeferredRelease = null;
    if (release) {
      release();
    } else {
      revealMainWindow();
    }
  });
  ipcMain.handle('openmotion:splash-sign-in', async () => {
    if (!sidecar.origin) return { state: 'signed-out', error: 'Studio engine not started yet.' };
    const result = await fetchBackendJson<Record<string, unknown>>(
      `${sidecar.origin}/motion-api/settings/account/login`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      15_000,
    );
    return result ?? { state: 'signed-out', error: 'Could not start browser sign-in.' };
  });
  ipcMain.handle('openmotion:splash-cancel-sign-in', async () => {
    if (!sidecar.origin) return { state: 'signed-out' };
    const result = await fetchBackendJson<Record<string, unknown>>(
      `${sidecar.origin}/motion-api/settings/account/cancel`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    return result ?? { state: 'signed-out' };
  });
  ipcMain.handle('openmotion:splash-refresh-account', async () => {
    if (!sidecar.origin) return { state: 'signed-out' };
    const result = await fetchBackendJson<Record<string, unknown>>(
      `${sidecar.origin}/motion-api/settings/account`,
    );
    return result ?? { state: 'signed-out' };
  });

  ipcMain.on('openmotion:renderer-ready', () => {
    rendererReady = true;
    resolveRendererReadyCallback?.();
    resolveRendererReadyCallback = null;
    if (!splashDeferredRelease && !splashHoldWelcome) {
      revealMainWindow();
    }
    const queued = pendingMenuActions;
    pendingMenuActions = [];
    for (const action of queued) {
      mainWindow?.webContents.send('openmotion:menu-action', action);
    }
  });

  ipcMain.on('openmotion:dom-fullscreen', (_event, active: boolean) => {
    domFullscreen = Boolean(active);
    broadcastChromeState();
  });

  updater.subscribe(state => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('openmotion:update-state', state);
    }
  });
}

process.on('uncaughtException', error => {
  logger.error('main', 'Uncaught exception', { message: error.message, stack: error.stack });
  logger.writeCrashMarker('uncaught-exception', error);
});

process.on('unhandledRejection', reason => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.error('main', 'Unhandled rejection', { message });
  logger.writeCrashMarker('unhandled-rejection', reason);
});

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  if (platform !== 'darwin') {
    app.quit();
  }
});

function minimizeFocusedWindow(): void {
  const target = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (target && !target.isDestroyed()) {
    target.minimize();
  }
}

function hideDesktopApp(): void {
  if (platform === 'darwin') {
    app.hide();
    return;
  }
  const target = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (target && !target.isDestroyed()) {
    target.minimize();
  }
}

async function requestQuitWithConfirmation(): Promise<void> {
  if (shuttingDown || quitPromptOpen) return;
  quitPromptOpen = true;
  try {
    const isZh = app.getLocale().toLowerCase().startsWith('zh');
    const parent = BrowserWindow.getFocusedWindow() ?? (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined);
    const options = {
      type: 'question' as const,
      title: isZh ? '退出 OpenMotion' : 'Quit OpenMotion',
      message: isZh ? '确认退出 OpenMotion 吗？' : 'Are you sure you want to quit OpenMotion?',
      detail: isZh
        ? '退出后将停止本地 Studio 引擎和正在运行的 MCP 服务。'
        : 'Quitting will stop the local Studio engine and active MCP server.',
      buttons: isZh ? ['取消', '退出'] : ['Cancel', 'Quit'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    };
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (response === 1) {
      app.quit();
    }
  } finally {
    quitPromptOpen = false;
  }
}

app.on('activate', () => {
  if (!mainWindow && app.isReady()) {
    void bootDesktop();
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', event => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  resolveRendererReadyCallback = null;
  splashDeferredRelease = null;
  splash?.close();
  void sidecar
    .stop()
    .catch(() => {})
    .finally(() => {
      logger.markSessionEnded('app-quit');
      app.quit();
    });
});

void app.whenReady().then(async () => {
  const dockIcon = !app.isPackaged ? resolveIconPath() : undefined;
  if (platform === 'darwin' && dockIcon) {
    try {
      app.dock?.setIcon(dockIcon);
    } catch {
      // Ignore invalid dock icon fallback.
    }
  }
  registerIpc();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildDesktopMenuTemplate({
        platform,
        appVersion: app.getVersion(),
        onAction: dispatchMenuAction,
        onOpenUrl: url => void openExternalSafe(url),
        onOpenLogsFolder: () => void openLogsFolder(),
        onMinimizeWindow: minimizeFocusedWindow,
        onHideApp: hideDesktopApp,
        onRequestQuit: () => void requestQuitWithConfirmation(),
      }),
    ),
  );
  await bootDesktop();
});
