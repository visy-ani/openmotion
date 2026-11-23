// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridgeApi } from '../../../shared/platform-host';
import {
  applyDesktopDocumentAttributes,
  bindDesktopHost,
  exportDesktopDiagnosticBundle,
  isDesktopApp,
  notifyDesktopRendererReady,
  openExternalUrl,
  syncDesktopTheme,
} from './platformHost';

afterEach(() => {
  delete window.__OPENMOTION_DESKTOP__;
  applyDesktopDocumentAttributes(null);
  vi.restoreAllMocks();
});

describe('platformHost browser/desktop abstraction', () => {
  it('stays inactive in regular Web browsers and applies/cleans attributes in Desktop shell', async () => {
    expect(isDesktopApp()).toBe(false);

    let listener: ((state: any) => void) | undefined;
    const setTheme = vi.fn(async () => {});
    const notifyRendererReady = vi.fn();
    const openExternal = vi.fn(async () => ({ ok: true }));
    const exportDesktopLogs = vi.fn(async () => ({ ok: true, entryCount: 4 }));
    const unsubscribe = vi.fn();

    const bridge: DesktopBridgeApi = {
      getAppInfo: vi.fn(),
      getChromeState: vi.fn(async () => ({
        platform: 'darwin',
        titleBarStyle: 'hiddenInset',
        insetLeft: 78,
        insetRight: 0,
        titleBarHeight: 46,
        customWindowControls: false,
        fullscreen: false,
        maximized: false,
      })),
      subscribeChromeState: vi.fn(cb => {
        listener = cb;
        return unsubscribe;
      }),
      setTheme,
      windowMinimize: vi.fn(),
      windowToggleMaximize: vi.fn(),
      windowClose: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      installUpdateNow: vi.fn(),
      getUpdateState: vi.fn(),
      subscribeUpdateState: vi.fn(() => () => {}),
      exportDesktopLogs,
      openLogsFolder: vi.fn(),
      openExternal,
      subscribeMenuActions: vi.fn(() => () => {}),
      notifyRendererReady,
    };

    window.__OPENMOTION_DESKTOP__ = bridge;
    expect(isDesktopApp()).toBe(true);

    const stop = bindDesktopHost();
    await Promise.resolve();
    await Promise.resolve();

    expect(notifyRendererReady).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.desktop).toBe('true');
    expect(document.documentElement.dataset.desktopPlatform).toBe('darwin');
    expect(document.documentElement.style.getPropertyValue('--om-desktop-inset-left')).toBe('78px');

    listener?.({
      platform: 'darwin',
      titleBarStyle: 'hiddenInset',
      insetLeft: 0,
      insetRight: 0,
      titleBarHeight: 46,
      customWindowControls: false,
      fullscreen: true,
      maximized: false,
    });
    expect(document.documentElement.dataset.desktopFullscreen).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--om-desktop-inset-left')).toBe('0px');

    syncDesktopTheme('light');
    expect(setTheme).toHaveBeenCalledWith('light');

    await openExternalUrl('https://github.com/nexu-io/openmotion');
    expect(openExternal).toHaveBeenCalledWith('https://github.com/nexu-io/openmotion');

    const exported = await exportDesktopDiagnosticBundle();
    expect(exported).toEqual({ ok: true, entryCount: 4 });

    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('defers renderer readiness when deferReady is set and makes notifyDesktopRendererReady idempotent', async () => {
    const notifyRendererReady = vi.fn();
    window.__OPENMOTION_DESKTOP__ = {
      getAppInfo: vi.fn(),
      getChromeState: vi.fn(async () => ({
        platform: 'darwin',
        titleBarStyle: 'hiddenInset',
        insetLeft: 78,
        insetRight: 0,
        titleBarHeight: 46,
        customWindowControls: false,
        fullscreen: false,
        maximized: false,
      })),
      subscribeChromeState: vi.fn(() => () => {}),
      setTheme: vi.fn(async () => {}),
      windowMinimize: vi.fn(),
      windowToggleMaximize: vi.fn(),
      windowClose: vi.fn(),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      installUpdateNow: vi.fn(),
      getUpdateState: vi.fn(),
      subscribeUpdateState: vi.fn(() => () => {}),
      exportDesktopLogs: vi.fn(),
      openLogsFolder: vi.fn(),
      openExternal: vi.fn(),
      subscribeMenuActions: vi.fn(() => () => {}),
      notifyRendererReady,
    };

    const stop = bindDesktopHost({ deferReady: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyRendererReady).not.toHaveBeenCalled();

    notifyDesktopRendererReady();
    notifyDesktopRendererReady();
    expect(notifyRendererReady).toHaveBeenCalledTimes(1);

    stop();
  });
});
