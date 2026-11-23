import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import type { DesktopSplashProgress } from '../../shared/platform-host.ts';

const TARGET_SPLASH_WIDTH = 1280;
const TARGET_SPLASH_HEIGHT = 900;

function getSplashBackgroundColor(theme: 'light' | 'dark'): string {
  return theme === 'light' ? '#f2f4f5' : '#141517';
}

function resolveSplashBounds(): { width: number; height: number } {
  try {
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    return {
      width: Math.min(TARGET_SPLASH_WIDTH, Math.max(820, Math.round(workArea.width * 0.88))),
      height: Math.min(TARGET_SPLASH_HEIGHT, Math.max(580, Math.round(workArea.height * 0.88))),
    };
  } catch {
    return { width: TARGET_SPLASH_WIDTH, height: TARGET_SPLASH_HEIGHT };
  }
}

export class SplashController {
  window: BrowserWindow | null = null;
  startedAt = 0;
  private onRetry?: () => void;
  private closingPromise: Promise<void> | null = null;

  constructor(options: { onRetry?: () => void } = {}) {
    this.onRetry = options.onRetry;
  }

  open(distDir: string, preloadPath: string, theme: 'light' | 'dark' = 'dark'): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      return this.window;
    }
    const { width, height } = resolveSplashBounds();
    this.startedAt = Date.now();
    const win = new BrowserWindow({
      width,
      height,
      frame: false,
      transparent: false,
      hasShadow: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      center: true,
      show: false,
      title: 'OpenMotion',
      backgroundColor: getSplashBackgroundColor(theme),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.webContents.on('did-navigate-in-page', (_event, url) => {
      if (url.includes('#retry=')) {
        this.onRetry?.();
      }
    });

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    void win.loadFile(path.join(distDir, 'splash.html'), {
      query: { theme },
    });
    win.on('closed', () => {
      if (this.window === win) this.window = null;
    });
    this.window = win;
    return win;
  }

  setProgress(progress: DesktopSplashProgress): void {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    const payload = JSON.stringify(progress);
    void win.webContents
      .executeJavaScript(`window.__updateDesktopSplash && window.__updateDesktopSplash(${payload})`)
      .catch(() => {});
  }

  setStatus(message: string, errorMessage?: string): void {
    this.setProgress({
      step: errorMessage ? 'engine' : 'ready',
      mode: errorMessage ? 'error' : 'booting',
      status: message,
      ...(errorMessage ? { errorMessage } : {}),
    });
  }

  async playExitAndClose(delayMs = 140): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    const win = this.window;
    if (!win || win.isDestroyed()) {
      this.window = null;
      return;
    }
    this.closingPromise = (async () => {
      void win.webContents
        .executeJavaScript(
          'window.__omSplashStopLogo && window.__omSplashStopLogo(); document.body && document.body.setAttribute("data-leaving", "true");',
        )
        .catch(() => {});
      await new Promise(resolve => setTimeout(resolve, delayMs));
      this.close();
      this.closingPromise = null;
    })();
    return this.closingPromise;
  }

  close(): void {
    this.closingPromise = null;
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
  }
}
