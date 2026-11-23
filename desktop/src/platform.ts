import type { BrowserWindowConstructorOptions } from 'electron';
import {
  resolveDesktopChrome,
  type DesktopChromeInsets,
  type DesktopPlatform,
} from '../../shared/platform-host.ts';

export { resolveDesktopChrome, type DesktopChromeInsets, type DesktopPlatform };

export function normalizeDesktopPlatform(
  raw: NodeJS.Platform = process.platform,
): DesktopPlatform {
  if (raw === 'darwin' || raw === 'win32') return raw;
  return 'linux';
}

export function getWindowsTitleBarOverlay(theme: 'light' | 'dark' = 'dark') {
  if (theme === 'light') {
    return {
      color: '#f8f8f6',
      symbolColor: '#1b1d20',
      height: 46,
    };
  }
  return {
    color: '#141517',
    symbolColor: '#e6e8ec',
    height: 46,
  };
}

export function getDesktopWindowBackgroundColor(theme: 'light' | 'dark' = 'dark'): string {
  return theme === 'light' ? '#f8f8f6' : '#141517';
}

export function buildMainWindowOptions(input: {
  platform?: DesktopPlatform;
  theme?: 'light' | 'dark';
  linuxCustomTitleBar?: boolean;
  preloadPath: string;
  iconPath?: string;
}): BrowserWindowConstructorOptions {
  const platform = input.platform ?? normalizeDesktopPlatform();
  const theme = input.theme ?? 'dark';
  const chrome = resolveDesktopChrome({
    platform,
    linuxCustomTitleBar: input.linuxCustomTitleBar,
  });

  const base: BrowserWindowConstructorOptions = {
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: 'OpenMotion Studio',
    backgroundColor: getDesktopWindowBackgroundColor(theme),
    ...(input.iconPath ? { icon: input.iconPath } : {}),
    webPreferences: {
      preload: input.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  };

  if (chrome.platform === 'darwin') {
    return {
      ...base,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 15 },
    };
  }

  if (chrome.platform === 'win32') {
    return {
      ...base,
      titleBarStyle: 'hidden',
      titleBarOverlay: getWindowsTitleBarOverlay(theme),
    };
  }

  return {
    ...base,
    frame: !chrome.customWindowControls,
  };
}
