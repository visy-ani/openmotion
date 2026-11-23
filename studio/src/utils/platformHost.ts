import { useCallback, useEffect, useState } from 'react';
import type {
  DesktopBridgeApi,
  DesktopChromeInsets,
  DesktopDiagnosticExportResult,
  DesktopUpdateState,
} from '../../../shared/platform-host';

declare global {
  interface Window {
    __OPENMOTION_DESKTOP__?: DesktopBridgeApi;
  }
}

export function getDesktopBridge(): DesktopBridgeApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.__OPENMOTION_DESKTOP__;
}

export function isDesktopApp(): boolean {
  const bridge = getDesktopBridge();
  return Boolean(bridge && typeof bridge.getChromeState === 'function');
}

export function applyDesktopDocumentAttributes(chrome: DesktopChromeInsets | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!chrome) {
    delete root.dataset.desktop;
    delete root.dataset.desktopPlatform;
    delete root.dataset.desktopTitlebar;
    delete root.dataset.desktopFullscreen;
    root.style.removeProperty('--om-desktop-inset-left');
    root.style.removeProperty('--om-desktop-inset-right');
    return;
  }
  root.dataset.desktop = 'true';
  root.dataset.desktopPlatform = chrome.platform;
  root.dataset.desktopTitlebar = chrome.titleBarStyle;
  root.dataset.desktopFullscreen = chrome.fullscreen ? 'true' : 'false';
  root.style.setProperty('--om-desktop-inset-left', `${chrome.insetLeft}px`);
  root.style.setProperty('--om-desktop-inset-right', `${chrome.insetRight}px`);
}

export function syncDesktopTheme(theme: 'light' | 'dark'): void {
  const bridge = getDesktopBridge();
  if (!bridge || typeof bridge.setTheme !== 'function') return;
  void Promise.resolve(bridge.setTheme(theme)).catch(() => {});
}

let desktopReadyGeneration = 0;
let notifiedReadyGeneration = 0;

/**
 * Signal once per desktop host binding that the initial React tree has painted.
 * Safe to invoke from both animation-frame and timeout fallback callbacks.
 */
export function notifyDesktopRendererReady(): void {
  const bridge = getDesktopBridge();
  if (!bridge || typeof bridge.notifyRendererReady !== 'function') return;
  if (desktopReadyGeneration === 0) desktopReadyGeneration = 1;
  if (notifiedReadyGeneration === desktopReadyGeneration) return;
  notifiedReadyGeneration = desktopReadyGeneration;
  bridge.notifyRendererReady();
}

export function bindDesktopHost(options?: { deferReady?: boolean }): () => void {
  const bridge = getDesktopBridge();
  if (!bridge || typeof bridge.getChromeState !== 'function') {
    return () => {};
  }
  let active = true;
  desktopReadyGeneration += 1;
  const generation = desktopReadyGeneration;

  void bridge
    .getChromeState()
    .then(chrome => {
      if (active) applyDesktopDocumentAttributes(chrome);
    })
    .catch(() => {});

  const unsubscribe =
    typeof bridge.subscribeChromeState === 'function'
      ? bridge.subscribeChromeState(chrome => {
          if (active) applyDesktopDocumentAttributes(chrome);
        })
      : () => {};

  if (!options?.deferReady && typeof bridge.notifyRendererReady === 'function') {
    queueMicrotask(() => {
      if (active && generation === desktopReadyGeneration) {
        notifyDesktopRendererReady();
      }
    });
  }

  return () => {
    active = false;
    unsubscribe();
  };
}

export function useDesktopChrome(): DesktopChromeInsets | null {
  const [chrome, setChrome] = useState<DesktopChromeInsets | null>(null);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge || typeof bridge.getChromeState !== 'function') return;
    let active = true;
    void bridge
      .getChromeState()
      .then(next => {
        if (active) {
          setChrome(next);
          applyDesktopDocumentAttributes(next);
        }
      })
      .catch(() => {});
    const unsubscribe =
      typeof bridge.subscribeChromeState === 'function'
        ? bridge.subscribeChromeState(next => {
            if (active) {
              setChrome(next);
              applyDesktopDocumentAttributes(next);
            }
          })
        : () => {};
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return chrome;
}

export function useDesktopUpdateState() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge || typeof bridge.getUpdateState !== 'function') return;
    let active = true;
    void bridge
      .getUpdateState()
      .then(next => {
        if (active) setState(next);
      })
      .catch(() => {});
    const unsubscribe =
      typeof bridge.subscribeUpdateState === 'function'
        ? bridge.subscribeUpdateState(next => {
            if (active) setState(next);
          })
        : () => {};
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const checkForUpdates = useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge) return null;
    setBusy(true);
    try {
      const next = await bridge.checkForUpdates();
      setState(next);
      return next;
    } finally {
      setBusy(false);
    }
  }, []);

  const downloadUpdate = useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge) return null;
    setBusy(true);
    try {
      const next = await bridge.downloadUpdate();
      setState(next);
      return next;
    } finally {
      setBusy(false);
    }
  }, []);

  const installUpdateNow = useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge) return { ok: false, error: 'Desktop bridge unavailable' };
    setBusy(true);
    try {
      return await bridge.installUpdateNow();
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    state,
    busy,
    checkForUpdates,
    downloadUpdate,
    installUpdateNow,
  };
}

export async function openExternalUrl(url: string): Promise<void> {
  const bridge = getDesktopBridge();
  if (bridge && typeof bridge.openExternal === 'function') {
    await bridge.openExternal(url);
    return;
  }
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export async function exportDesktopDiagnosticBundle(): Promise<DesktopDiagnosticExportResult> {
  const bridge = getDesktopBridge();
  if (!bridge || typeof bridge.exportDesktopLogs !== 'function') {
    return { ok: false, error: 'Desktop bridge unavailable' };
  }
  return await bridge.exportDesktopLogs();
}
