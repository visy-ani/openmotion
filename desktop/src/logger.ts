import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type DesktopLogStream = 'main' | 'renderer' | 'sidecar';
export type DesktopLogLevel = 'info' | 'warn' | 'error' | 'debug';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TOKEN_PREFIX_RE = /\b(?:om_mcp|om_brg|om_trg)_[A-Za-z0-9_-]+\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const SK_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

function compilePathMatchers(extraPaths: Array<string | undefined>): RegExp[] {
  const unique = new Set<string>();
  const matchers: RegExp[] = [];
  for (const raw of [os.homedir(), ...extraPaths]) {
    const trimmed = raw?.trim();
    if (!trimmed || trimmed.length <= 1 || unique.has(trimmed)) continue;
    unique.add(trimmed);
    matchers.push(new RegExp(escapeRegex(trimmed), 'gi'));
  }
  return matchers;
}

function redactWithMatchers(text: string, pathMatchers: readonly RegExp[]): string {
  let out = String(text);
  for (const matcher of pathMatchers) {
    matcher.lastIndex = 0;
    out = out.replace(matcher, '<REDACTED_PATH>');
  }
  return out
    .replace(TOKEN_PREFIX_RE, match => match.slice(0, 10) + '***')
    .replace(BEARER_RE, 'Bearer ***')
    .replace(SK_RE, 'sk-***');
}

export function redactDesktopText(
  text: string,
  extraPaths: Array<string | undefined> = [],
): string {
  return redactWithMatchers(text, compilePathMatchers(extraPaths));
}

export class DesktopLogger {
  readonly logDir: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  private readonly extraPaths: string[];
  private readonly pathMatchers: RegExp[];
  private readonly streamSizes = new Map<DesktopLogStream, number>();

  constructor(options: {
    logDir: string;
    maxBytes?: number;
    maxFiles?: number;
    redactPaths?: string[];
  }) {
    this.logDir = path.resolve(options.logDir);
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 2;
    this.extraPaths = options.redactPaths ?? [];
    this.pathMatchers = compilePathMatchers(this.extraPaths);
    mkdirSync(this.logDir, { recursive: true });
  }

  filePath(stream: DesktopLogStream): string {
    return path.join(this.logDir, `${stream}.log`);
  }

  private getCurrentSize(stream: DesktopLogStream, targetFile: string): number {
    const cached = this.streamSizes.get(stream);
    if (cached !== undefined) return cached;
    let size = 0;
    if (existsSync(targetFile)) {
      try {
        size = statSync(targetFile).size;
      } catch {
        size = 0;
      }
    }
    this.streamSizes.set(stream, size);
    return size;
  }

  private rotateIfNeeded(stream: DesktopLogStream, targetFile: string, incomingBytes: number): void {
    const size = this.getCurrentSize(stream, targetFile);
    if (size + incomingBytes <= this.maxBytes || !existsSync(targetFile)) return;

    for (let idx = this.maxFiles - 1; idx >= 1; idx--) {
      const older = `${targetFile}.${idx}`;
      const next = `${targetFile}.${idx + 1}`;
      if (existsSync(next)) {
        rmSync(next, { force: true });
      }
      if (existsSync(older)) {
        renameSync(older, next);
      }
    }

    if (this.maxFiles >= 1) {
      const firstArchive = `${targetFile}.1`;
      if (existsSync(firstArchive)) {
        rmSync(firstArchive, { force: true });
      }
      renameSync(targetFile, firstArchive);
    } else {
      rmSync(targetFile, { force: true });
    }
    this.streamSizes.set(stream, 0);
  }

  log(
    stream: DesktopLogStream,
    level: DesktopLogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    const cleanMessage = redactWithMatchers(message, this.pathMatchers);
    const metaSuffix = meta
      ? ' ' + redactWithMatchers(JSON.stringify(meta), this.pathMatchers)
      : '';
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${cleanMessage}${metaSuffix}\n`;
    const file = this.filePath(stream);
    const incomingBytes = Buffer.byteLength(line);
    this.rotateIfNeeded(stream, file, incomingBytes);
    appendFileSync(file, line, 'utf8');
    this.streamSizes.set(stream, (this.streamSizes.get(stream) ?? 0) + incomingBytes);
  }

  info(stream: DesktopLogStream, message: string, meta?: Record<string, unknown>): void {
    this.log(stream, 'info', message, meta);
  }

  warn(stream: DesktopLogStream, message: string, meta?: Record<string, unknown>): void {
    this.log(stream, 'warn', message, meta);
  }

  error(stream: DesktopLogStream, message: string, meta?: Record<string, unknown>): void {
    this.log(stream, 'error', message, meta);
  }

  readTail(stream: DesktopLogStream, maxChars = 16_000): string {
    const file = this.filePath(stream);
    if (!existsSync(file)) return '';
    const text = readFileSync(file, 'utf8');
    return text.length > maxChars ? text.slice(text.length - maxChars) : text;
  }

  markSessionStarted(info: { version: string; platform: string; arch: string }): void {
    const sessionFile = path.join(this.logDir, 'session-state.json');
    if (existsSync(sessionFile)) {
      try {
        const prev = JSON.parse(readFileSync(sessionFile, 'utf8'));
        if (prev?.active === true) {
          this.writeCrashMarker('unclean-previous-exit', {
            previousSessionStartedAt: prev.startedAt,
            previousVersion: prev.version,
          });
        }
      } catch {
        // Ignore corrupt previous session state.
      }
    }
    writeFileSync(
      sessionFile,
      JSON.stringify(
        {
          active: true,
          startedAt: new Date().toISOString(),
          pid: process.pid,
          version: info.version,
          platform: info.platform,
          arch: info.arch,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  markSessionEnded(reason = 'normal-exit'): void {
    const sessionFile = path.join(this.logDir, 'session-state.json');
    let prev: Record<string, unknown> = {};
    if (existsSync(sessionFile)) {
      try {
        prev = JSON.parse(readFileSync(sessionFile, 'utf8'));
      } catch {
        prev = {};
      }
    }
    writeFileSync(
      sessionFile,
      JSON.stringify(
        {
          ...prev,
          active: false,
          endedAt: new Date().toISOString(),
          endReason: reason,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  writeCrashMarker(reason: string, details?: unknown): void {
    const markerFile = path.join(this.logDir, 'crash-marker.json');
    const serialized =
      details instanceof Error
        ? { name: details.name, message: details.message, stack: details.stack }
        : details;
    writeFileSync(
      markerFile,
      redactDesktopText(
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            reason,
            details: serialized ?? null,
          },
          null,
          2,
        ),
        this.extraPaths,
      ),
      'utf8',
    );
  }
}

export async function createDesktopDiagnosticZip(options: {
  appRoot: string;
  dataDir: string;
  logDir: string;
  outPath: string;
}): Promise<{ path: string; entryCount: number }> {
  const diagnosticsModule = await import(
    pathToFileURL(path.join(options.appRoot, 'scripts', 'diagnostics.mjs')).href
  );
  const zipModule = await import(
    pathToFileURL(path.join(options.appRoot, 'scripts', 'zip.mjs')).href
  );
  const bundle = await diagnosticsModule.collectDiagnostics({
    appRoot: options.appRoot,
    dataDirectory: options.dataDir,
    desktopLogDirectory: options.logDir,
  });
  const archive = zipModule.zip(bundle.entries);
  mkdirSync(path.dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, archive);
  return {
    path: options.outPath,
    entryCount: bundle.entries.length,
  };
}
