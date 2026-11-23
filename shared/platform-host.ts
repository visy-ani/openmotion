export type DesktopPlatform = 'darwin' | 'win32' | 'linux';

export type DesktopTitleBarStyle = 'hiddenInset' | 'hiddenOverlay' | 'custom' | 'native';

export type DesktopChromeInsets = {
  platform: DesktopPlatform;
  titleBarStyle: DesktopTitleBarStyle;
  insetLeft: number;
  insetRight: number;
  titleBarHeight: number;
  customWindowControls: boolean;
  fullscreen: boolean;
  maximized: boolean;
};

export type DesktopUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'unsupported'
  | 'error';

export type DesktopUpdateState = {
  status: DesktopUpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  message?: string;
  releaseNotesUrl?: string;
  checkedAt?: string;
};

export type DesktopMenuAction =
  | 'open-settings'
  | 'open-about'
  | 'open-help'
  | 'check-updates'
  | 'export-logs'
  | 'report-issue'
  | 'join-community-feishu'
  | 'join-community-discord'
  | 'new-project'
  | 'open-mcp-connect'
  | 'open-agent-runtimes'
  | 'reload-app';

export type DesktopAppInfo = {
  isDesktop: true;
  platform: DesktopPlatform;
  arch: string;
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  isPackaged: boolean;
  logDir: string;
  dataDir: string;
  releaseChannel: 'stable' | 'beta' | 'dev';
};

export type DesktopDiagnosticExportResult = {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  entryCount?: number;
  error?: string;
};

export type DesktopSplashStep = 'engine' | 'agents' | 'account' | 'ready';

export type DesktopSplashAccountView = {
  state: string;
  name?: string;
  email?: string;
  plan?: string;
  authorizationUrl?: string;
  userCode?: string;
  browserOpened?: boolean;
  syncing?: boolean;
  error?: string;
  errorCode?: string;
};

export type DesktopSplashProgress = {
  step: DesktopSplashStep;
  status: string;
  detail?: string;
  agentsCount?: number;
  agentsNames?: string[];
  mode?: 'booting' | 'signin' | 'welcome' | 'error';
  account?: DesktopSplashAccountView;
  errorMessage?: string;
};

export type DesktopBridgeApi = {
  getAppInfo: () => Promise<DesktopAppInfo>;
  getChromeState: () => Promise<DesktopChromeInsets>;
  subscribeChromeState: (callback: (state: DesktopChromeInsets) => void) => () => void;
  setTheme: (theme: 'light' | 'dark') => Promise<void>;
  windowMinimize: () => Promise<void>;
  windowToggleMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;
  checkForUpdates: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateState>;
  installUpdateNow: () => Promise<{ ok: boolean; error?: string }>;
  getUpdateState: () => Promise<DesktopUpdateState>;
  subscribeUpdateState: (callback: (state: DesktopUpdateState) => void) => () => void;
  exportDesktopLogs: () => Promise<DesktopDiagnosticExportResult>;
  openLogsFolder: () => Promise<{ ok: boolean; path?: string; error?: string }>;
  openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
  subscribeMenuActions: (callback: (action: DesktopMenuAction) => void) => () => void;
  notifyRendererReady: () => void;
  retryDesktopStartup?: () => Promise<void>;
  splashContinueToStudio?: () => Promise<void>;
  splashStartSignIn?: () => Promise<Record<string, unknown>>;
  splashCancelSignIn?: () => Promise<Record<string, unknown>>;
  splashRefreshAccount?: () => Promise<Record<string, unknown>>;
};

/**
 * Resolves platform-specific title bar style and safe inset geometry so macOS
 * traffic lights, Windows caption overlay, and Linux controls never collide
 * with shared Studio navigation chrome.
 */
export function resolveDesktopChrome(input: {
  platform: DesktopPlatform;
  fullscreen?: boolean;
  maximized?: boolean;
  linuxCustomTitleBar?: boolean;
}): DesktopChromeInsets {
  const fullscreen = Boolean(input.fullscreen);
  const maximized = Boolean(input.maximized);
  const titleBarHeight = 46;

  if (input.platform === 'darwin') {
    return {
      platform: 'darwin',
      titleBarStyle: 'hiddenInset',
      insetLeft: fullscreen ? 0 : 78,
      insetRight: 0,
      titleBarHeight,
      customWindowControls: false,
      fullscreen,
      maximized,
    };
  }

  if (input.platform === 'win32') {
    return {
      platform: 'win32',
      titleBarStyle: 'hiddenOverlay',
      insetLeft: 0,
      insetRight: fullscreen ? 0 : 138,
      titleBarHeight,
      customWindowControls: false,
      fullscreen,
      maximized,
    };
  }

  const useCustom = input.linuxCustomTitleBar !== false;
  return {
    platform: 'linux',
    titleBarStyle: useCustom ? 'custom' : 'native',
    insetLeft: 0,
    insetRight: useCustom && !fullscreen ? 132 : 0,
    titleBarHeight,
    customWindowControls: useCustom,
    fullscreen,
    maximized,
  };
}
