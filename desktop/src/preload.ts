import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopBridgeApi,
  DesktopChromeInsets,
  DesktopMenuAction,
  DesktopUpdateState,
} from '../../shared/platform-host.ts';

const bridge: DesktopBridgeApi = {
  getAppInfo: () => ipcRenderer.invoke('openmotion:get-app-info'),
  getChromeState: () => ipcRenderer.invoke('openmotion:get-chrome-state'),
  subscribeChromeState: callback => {
    const handler = (_event: unknown, state: DesktopChromeInsets) => {
      callback(state);
    };
    ipcRenderer.on('openmotion:chrome-state', handler);
    return () => ipcRenderer.removeListener('openmotion:chrome-state', handler);
  },
  setTheme: theme => ipcRenderer.invoke('openmotion:set-theme', theme),
  windowMinimize: () => ipcRenderer.invoke('openmotion:window-minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('openmotion:window-toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('openmotion:window-close'),
  checkForUpdates: () => ipcRenderer.invoke('openmotion:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('openmotion:download-update'),
  installUpdateNow: () => ipcRenderer.invoke('openmotion:install-update-now'),
  getUpdateState: () => ipcRenderer.invoke('openmotion:get-update-state'),
  subscribeUpdateState: callback => {
    const handler = (_event: unknown, state: DesktopUpdateState) => {
      callback(state);
    };
    ipcRenderer.on('openmotion:update-state', handler);
    return () => ipcRenderer.removeListener('openmotion:update-state', handler);
  },
  exportDesktopLogs: () => ipcRenderer.invoke('openmotion:export-logs'),
  openLogsFolder: () => ipcRenderer.invoke('openmotion:open-logs-folder'),
  openExternal: url => ipcRenderer.invoke('openmotion:open-external', url),
  subscribeMenuActions: callback => {
    const handler = (_event: unknown, action: DesktopMenuAction) => {
      callback(action);
    };
    ipcRenderer.on('openmotion:menu-action', handler);
    return () => ipcRenderer.removeListener('openmotion:menu-action', handler);
  },
  notifyRendererReady: () => {
    ipcRenderer.send('openmotion:renderer-ready');
  },
  retryDesktopStartup: () => ipcRenderer.invoke('openmotion:splash-retry'),
  splashContinueToStudio: () => ipcRenderer.invoke('openmotion:splash-continue'),
  splashStartSignIn: () => ipcRenderer.invoke('openmotion:splash-sign-in'),
  splashCancelSignIn: () => ipcRenderer.invoke('openmotion:splash-cancel-sign-in'),
  splashRefreshAccount: () => ipcRenderer.invoke('openmotion:splash-refresh-account'),
};

contextBridge.exposeInMainWorld('__OPENMOTION_DESKTOP__', bridge);

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('fullscreenchange', () => {
    ipcRenderer.send('openmotion:dom-fullscreen', Boolean(document.fullscreenElement));
  });
}
