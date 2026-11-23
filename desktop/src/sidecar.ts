import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { DesktopLogger } from './logger.ts';

const HEALTH_POLL_INTERVALS_MS = [40, 80, 120, 180, 250] as const;
const MAX_LINE_BUFFER_CHARS = 64 * 1024;

/**
 * Resolve the executable used to spawn the local Node backend with
 * `ELECTRON_RUN_AS_NODE=1`. On macOS, spawning the top-level `.app` binary
 * triggers a second Dock icon even with `ELECTRON_RUN_AS_NODE=1`; routing
 * through `<App> Helper.app` (`LSUIElement=true`) keeps the backend Dockless.
 */
export function resolveSidecarRuntimeBinary(options: {
  platform?: NodeJS.Platform;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
} = {}): string {
  const env = options.env ?? process.env;
  const override = env.MOTION_NODE_BINARY?.trim();
  if (override) return override;

  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const exists = options.exists ?? existsSync;

  if (platform === 'darwin') {
    const normalized = path.resolve(execPath);
    const macOsDir = path.dirname(normalized);
    if (path.basename(macOsDir) === 'MacOS') {
      const appName = path.basename(normalized);
      const frameworksDir = path.resolve(macOsDir, '..', 'Frameworks');
      const helperNames = appName === 'Electron'
        ? ['Electron Helper']
        : [`${appName} Helper`, 'Electron Helper'];
      for (const helper of helperNames) {
        const candidate = path.join(frameworksDir, `${helper}.app`, 'Contents', 'MacOS', helper);
        if (exists(candidate)) {
          return candidate;
        }
      }
    }
  }

  return execPath;
}

export function augmentDesktopPath(basePath = process.env.PATH || ''): string {
  if (process.platform === 'win32') return basePath;
  const home = os.homedir();
  const candidates = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.asdf', 'shims'),
  ];
  const nvmDir = path.join(home, '.nvm', 'versions', 'node');
  if (existsSync(nvmDir)) {
    try {
      const versions = readdirSync(nvmDir).sort().reverse();
      if (versions[0]) {
        candidates.push(path.join(nvmDir, versions[0], 'bin'));
      }
    } catch {
      // Ignore unreadable nvm directory.
    }
  }
  const existing = basePath.split(path.delimiter).filter(Boolean);
  const merged = [...existing];
  for (const dir of candidates) {
    if (existsSync(dir) && !merged.includes(dir)) {
      merged.unshift(dir);
    }
  }
  return merged.join(path.delimiter);
}

export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not bind an ephemeral localhost port')));
        return;
      }
      const port = address.port;
      server.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

export class HealthWakeSignal {
  private resolvers = new Set<() => void>();

  wake(): void {
    for (const resolve of this.resolvers) {
      resolve();
    }
    this.resolvers.clear();
  }

  wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.resolvers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.resolvers.add(done);
    });
  }
}

export async function waitForServerHealth(
  origin: string,
  options: { timeoutMs?: number; intervalMs?: number; isAlive?: () => boolean; wakeSignal?: HealthWakeSignal } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const fixedInterval = options.intervalMs;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    if (options.isAlive && !options.isAlive()) {
      throw new Error('OpenMotion backend process exited before becoming healthy.');
    }
    try {
      const response = await fetch(`${origin}/motion-api/health`, {
        signal: AbortSignal.timeout(2_500),
      });
      if (response.ok) return;
    } catch {
      // Retry until timeout.
    }
    const waitMs =
      fixedInterval ?? HEALTH_POLL_INTERVALS_MS[Math.min(attempt, HEALTH_POLL_INTERVALS_MS.length - 1)]!;
    attempt += 1;
    if (options.wakeSignal) {
      await options.wakeSignal.wait(waitMs);
    } else {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
  throw new Error(`OpenMotion backend did not become ready within ${Math.round(timeoutMs / 1000)}s.`);
}

export class DesktopSidecarManager {
  readonly appRoot: string;
  readonly dataDir: string;
  readonly logDir: string;
  private readonly logger: DesktopLogger;
  private child: ChildProcess | null = null;
  private exitedUnexpectedly = false;
  private stopping = false;
  private _origin = '';
  private _appUrl = '';

  constructor(options: {
    appRoot: string;
    dataDir: string;
    logDir: string;
    logger: DesktopLogger;
  }) {
    this.appRoot = options.appRoot;
    this.dataDir = options.dataDir;
    this.logDir = options.logDir;
    this.logger = options.logger;
  }

  get origin(): string {
    return this._origin;
  }

  get appUrl(): string {
    return this._appUrl;
  }

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.exitedUnexpectedly);
  }

  async start(options: {
    onProgress?: (stage: 'engine' | 'agents' | 'account' | 'ready', message: string) => void;
  } = {}): Promise<{ appUrl: string; apiOrigin: string; managed: boolean }> {
    const devUrl = process.env.MOTION_DESKTOP_DEV_URL?.trim();
    const devApi = process.env.MOTION_DESKTOP_API_URL?.trim();
    if (devUrl && devApi) {
      this._appUrl = devUrl;
      this._origin = devApi;
      this.logger.info('sidecar', 'Connecting to unified dev server', { devUrl, devApi });
      options.onProgress?.('engine', 'Connecting to unified OpenMotion server…');
      await waitForServerHealth(devApi);
      return { appUrl: devUrl, apiOrigin: devApi, managed: false };
    }

    if (this.child && this.child.exitCode === null) {
      await this.stop();
    }

    const serverEntry = path.join(this.appRoot, 'server.ts');
    if (!existsSync(serverEntry)) {
      throw new Error(`Packaged server entry not found at ${serverEntry}`);
    }

    const port = await findFreePort('127.0.0.1');
    const origin = `http://127.0.0.1:${port}`;
    this._origin = origin;
    this._appUrl = origin;
    this.stopping = false;
    this.exitedUnexpectedly = false;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: augmentDesktopPath(process.env.PATH || ''),
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      HOST: '127.0.0.1',
      MOTION_PARENT_PID: String(process.pid),
      MOTION_DATA_DIR: this.dataDir,
      MOTION_DESKTOP_APP: '1',
      MOTION_SHARED_EDITOR: '0',
      MOTION_DESKTOP_LOG_DIR: this.logDir,
      MOTION_HEADLESS: '1',
      MOTION_OPEN_BROWSER: '0',
      HYPERFRAMES_HEADLESS: '1',
      MOTION_DEPLOYMENT_MODE: process.env.MOTION_DEPLOYMENT_MODE || 'local',
    };

    const nodeBin = resolveSidecarRuntimeBinary({ env });
    this.logger.info('sidecar', 'Starting OpenMotion backend sidecar', {
      port,
      nodeBin,
      appRoot: this.appRoot,
      dataDir: this.dataDir,
    });
    options.onProgress?.('engine', 'Starting local Studio engine…');

    const wakeSignal = new HealthWakeSignal();
    const child = spawn(nodeBin, ['--experimental-strip-types', serverEntry], {
      cwd: this.appRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    const pipeLines = (stream: 'stdout' | 'stderr', level: 'info' | 'warn') => {
      const target = stream === 'stdout' ? child.stdout : child.stderr;
      let buffer = '';
      target?.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (buffer.length > MAX_LINE_BUFFER_CHARS && !buffer.includes('\n')) {
          this.logger.log('sidecar', level, buffer.slice(0, MAX_LINE_BUFFER_CHARS) + '… [truncated]');
          buffer = '';
          return;
        }
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            this.logger.log('sidecar', level, line);
            if (stream === 'stdout' && line.includes('Motion + Hyperframes Studio:')) {
              wakeSignal.wake();
            }
          }
        }
      });
      target?.on('end', () => {
        if (buffer.trim()) {
          this.logger.log('sidecar', level, buffer.trim());
        }
        buffer = '';
      });
    };

    pipeLines('stdout', 'info');
    pipeLines('stderr', 'warn');

    child.on('exit', (code, signal) => {
      wakeSignal.wake();
      if (!this.stopping) {
        this.exitedUnexpectedly = true;
        this.logger.error('sidecar', 'Sidecar exited unexpectedly', { code, signal });
      } else {
        this.logger.info('sidecar', 'Sidecar stopped', { code, signal });
      }
      if (this.child === child) {
        this.child = null;
      }
    });

    try {
      await waitForServerHealth(origin, {
        timeoutMs: 45_000,
        isAlive: () => child.exitCode === null,
        wakeSignal,
      });
    } catch (error) {
      await this.stop();
      throw error;
    }

    return { appUrl: origin, apiOrigin: origin, managed: true };
  }

  async stop(timeoutMs = 3_500): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      return;
    }
    this.stopping = true;
    await new Promise<void>(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        if (this.child === child) this.child = null;
        resolve();
      };
      child.once('exit', done);
      try {
        child.kill('SIGTERM');
      } catch {
        done();
        return;
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Process already exited.
        }
        setTimeout(done, 400);
      }, timeoutMs);
    });
  }
}
