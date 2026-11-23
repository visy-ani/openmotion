import type { DesktopUpdateState } from '../../shared/platform-host.ts';

export const GITHUB_LATEST_RELEASE_API = 'https://api.github.com/repos/nexu-io/openmotion/releases/latest';
export const GITHUB_RELEASES_PAGE = 'https://github.com/nexu-io/openmotion/releases';

export type AutoUpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  checkForUpdates: () => Promise<any>;
  downloadUpdate: () => Promise<any>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
};

export type GitHubLatestRelease = {
  tag_name?: string;
  html_url?: string;
};

export function normalizeSemver(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

/**
 * Compares two semver strings (e.g. "0.2.1" vs "0.2.0" or "0.2.1-beta.1").
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (value: string) => {
    const clean = normalizeSemver(value).split('+')[0] ?? '';
    const [corePart = '', prePart = ''] = clean.split('-', 2);
    const core = corePart.split('.').map(part => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
    while (core.length < 3) core.push(0);
    return { core, pre: prePart };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!left.pre && right.pre) return 1;
  if (left.pre && !right.pre) return -1;
  return left.pre.localeCompare(right.pre);
}

export function resolveElectronAutoUpdater(mod: unknown): AutoUpdaterLike {
  const candidate =
    (mod as any)?.autoUpdater ??
    (mod as any)?.default?.autoUpdater ??
    (mod as any)?.['module.exports']?.autoUpdater;
  if (!candidate || typeof candidate.checkForUpdates !== 'function') {
    throw new Error('electron-updater autoUpdater export is unavailable');
  }
  return candidate as AutoUpdaterLike;
}

function isMissingFeedError(message: string): boolean {
  return /latest(?:-[a-z0-9-]+)?\.yml|app-update\.yml|No published versions on GitHub|HttpError:\s*404|status code 404|Cannot find latest/i.test(
    message,
  );
}

export class DesktopUpdaterController {
  private readonly isPackaged: boolean;
  private readonly loadAutoUpdater: () => Promise<AutoUpdaterLike>;
  private readonly fetchLatestRelease: () => Promise<GitHubLatestRelease>;
  private readonly onOpenReleasePage?: (url: string) => void;
  private readonly listeners = new Set<(state: DesktopUpdateState) => void>();
  private state: DesktopUpdateState;
  private updaterPromise: Promise<AutoUpdaterLike> | null = null;
  private attached = false;
  private usingGitHubFallback = false;

  constructor(options: {
    currentVersion: string;
    isPackaged: boolean;
    loadAutoUpdater?: () => Promise<AutoUpdaterLike>;
    fetchLatestRelease?: () => Promise<GitHubLatestRelease>;
    onOpenReleasePage?: (url: string) => void;
  }) {
    this.isPackaged = options.isPackaged;
    this.onOpenReleasePage = options.onOpenReleasePage;
    this.loadAutoUpdater =
      options.loadAutoUpdater ??
      (async () => {
        const mod = await import('electron-updater');
        return resolveElectronAutoUpdater(mod);
      });
    this.fetchLatestRelease =
      options.fetchLatestRelease ??
      (async () => {
        const res = await fetch(GITHUB_LATEST_RELEASE_API, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': `OpenMotion-Desktop/${options.currentVersion}`,
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          throw new Error(`GitHub release check failed (HTTP ${res.status})`);
        }
        return (await res.json()) as GitHubLatestRelease;
      });
    this.state = {
      status: options.isPackaged ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
    };
  }

  getState(): DesktopUpdateState {
    return { ...this.state };
  }

  subscribe(listener: (state: DesktopUpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<DesktopUpdateState>): DesktopUpdateState {
    this.state = {
      ...this.state,
      ...patch,
      currentVersion: this.state.currentVersion,
    };
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Ignore subscriber errors.
      }
    }
    return snapshot;
  }

  private async getUpdater(): Promise<AutoUpdaterLike> {
    if (!this.updaterPromise) {
      this.updaterPromise = this.loadAutoUpdater().catch(error => {
        this.updaterPromise = null;
        throw error;
      });
    }
    const updater = await this.updaterPromise;
    if (!this.attached) {
      this.attached = true;
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.on('checking-for-update', () => {
        this.setState({ status: 'checking', message: undefined });
      });
      updater.on('update-available', (info: any) => {
        this.usingGitHubFallback = false;
        this.setState({
          status: 'available',
          availableVersion: typeof info?.version === 'string' ? info.version : undefined,
          releaseNotesUrl: GITHUB_RELEASES_PAGE,
          checkedAt: new Date().toISOString(),
          message: undefined,
        });
      });
      updater.on('update-not-available', () => {
        this.usingGitHubFallback = false;
        this.setState({
          status: 'up-to-date',
          availableVersion: undefined,
          progress: undefined,
          checkedAt: new Date().toISOString(),
          message: undefined,
        });
      });
      updater.on('download-progress', (progress: any) => {
        const percent = typeof progress?.percent === 'number' ? Math.round(progress.percent) : undefined;
        this.setState({ status: 'downloading', progress: percent });
      });
      updater.on('update-downloaded', (info: any) => {
        this.setState({
          status: 'downloaded',
          availableVersion: typeof info?.version === 'string' ? info.version : this.state.availableVersion,
          progress: 100,
        });
      });
      updater.on('error', (error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        if (isMissingFeedError(msg)) {
          // Handled via GitHub Releases API fallback in checkForUpdates().
          return;
        }
        this.setState({
          status: 'error',
          message: msg,
        });
      });
    }
    return updater;
  }

  private async checkViaGitHubApi(): Promise<DesktopUpdateState> {
    const release = await this.fetchLatestRelease();
    const latestVersion = release.tag_name ? normalizeSemver(release.tag_name) : '';
    if (!latestVersion) {
      throw new Error('GitHub latest release did not contain a valid version tag');
    }
    const releaseNotesUrl = release.html_url || GITHUB_RELEASES_PAGE;
    const checkedAt = new Date().toISOString();
    this.usingGitHubFallback = true;
    if (compareSemver(latestVersion, this.state.currentVersion) > 0) {
      return this.setState({
        status: 'available',
        availableVersion: latestVersion,
        releaseNotesUrl,
        checkedAt,
        message: undefined,
      });
    }
    return this.setState({
      status: 'up-to-date',
      availableVersion: undefined,
      progress: undefined,
      releaseNotesUrl,
      checkedAt,
      message: undefined,
    });
  }

  async checkForUpdates(): Promise<DesktopUpdateState> {
    if (!this.isPackaged) {
      return this.setState({
        status: 'unsupported',
        checkedAt: new Date().toISOString(),
        message: 'Auto-update is available in packaged desktop releases.',
      });
    }
    this.usingGitHubFallback = false;
    this.setState({ status: 'checking', message: undefined, checkedAt: new Date().toISOString() });
    try {
      const updater = await this.getUpdater();
      await updater.checkForUpdates();
      return this.getState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMissingFeedError(message)) {
        try {
          return await this.checkViaGitHubApi();
        } catch (fallbackError) {
          return this.setState({
            status: 'error',
            message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
        }
      }
      return this.setState({
        status: 'error',
        message,
      });
    }
  }

  async downloadUpdate(): Promise<DesktopUpdateState> {
    if (!this.isPackaged) {
      return this.setState({
        status: 'unsupported',
        message: 'Auto-update is available in packaged desktop releases.',
      });
    }
    if (this.usingGitHubFallback) {
      const url = this.state.releaseNotesUrl || GITHUB_RELEASES_PAGE;
      this.onOpenReleasePage?.(url);
      return this.getState();
    }
    this.setState({ status: 'downloading', progress: 0, message: undefined });
    try {
      const updater = await this.getUpdater();
      await updater.downloadUpdate();
      return this.getState();
    } catch (error) {
      return this.setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async installUpdateNow(beforeQuit?: () => Promise<void> | void): Promise<{ ok: boolean; error?: string }> {
    if (!this.isPackaged) {
      return { ok: false, error: 'Auto-update is available in packaged desktop releases.' };
    }
    try {
      const updater = await this.getUpdater();
      await beforeQuit?.();
      updater.quitAndInstall(false, true);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
