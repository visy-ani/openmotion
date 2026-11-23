import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VERSION } from '../preview.ts';
import { redactDiagnostic } from '../scripts/diagnostic-redaction.mjs';
import { deviceContext, uuid } from '../tracking/core.ts';
import { loadDeviceIdentity, unknownDevice } from '../tracking/device.ts';
import type { HostContext } from '../tracking/host.ts';
import {
  loadIdentity,
  posthogCommonProperties,
  postPosthogBatch,
  type Identity,
  type PosthogEndpoint,
} from '../tracking/node.ts';
import { withProcessLock } from './process-lock.ts';
import { legacyToolName } from './public-names.mjs';
import { resolvePosthogConfig, trackingLocked, trackingPreference } from './tracking.ts';

type CodexThreadMeta = {
  threadId: string;
  turnId?: string;
  model?: string;
  hostVersion?: string;
  windowId?: string;
};

type ActiveCodexThread = {
  threadId: string;
  codexHome: string;
  firstSeenAt: number;
  lastSeenAt: number;
  lastSyncedOrdinal: number;
  lastUpdatedAtMs: number;
  hostVersion?: string;
  lastKnownModel?: string;
  turnModels?: Record<string, string>;
  projectIds: string[];
  skillsActivated: string[];
  hasCompletedExport: boolean;
  failures: number;
};

type SanitizedToolCall = {
  seq: number;
  call_id: string;
  category: 'openmotion_mcp' | 'skill_read' | 'host_tool';
  tool_name: string;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number;
  status: 'success' | 'partial' | 'failure' | 'unknown';
  error_code?: string;
  project_id?: string;
  operation_id?: string;
  job_id?: string;
  output_bytes?: number;
  input_summary?: string;
  output_summary?: string;
};

type SanitizedCodexTurn = {
  turn_index: number;
  turn_id: string;
  rollout_ordinal: number;
  turn_status: 'completed' | 'failed' | 'interrupted';
  started_at: string;
  ended_at: string;
  duration_ms: number;
  model: string;
  reasoning_effort?: string;
  user_query: string;
  reasoning_summary?: string;
  assistant_reply?: string;
  error_message?: string;
  tool_calls: SanitizedToolCall[];
  project_ids: string[];
  skills_activated: string[];
  has_completed_export: boolean;
  context_compacted_count: number;
};

type CodexThreadSnapshot = {
  threadId: string;
  modelProvider: string;
  defaultModel: string;
  reasoningEffort?: string;
  codexSource: string;
  hostVersion?: string;
  tokensUsedTotal?: number;
  createdAtMs: number;
  updatedAtMs: number;
  turns: SanitizedCodexTurn[];
};

type CodexSyncOptions = {
  allowInTest?: boolean;
  now?: number;
  idleSealMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
};

const THREAD_ID_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
const SHORT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const VERSION_PATTERN = /^\d{1,6}(?:\.\d{1,6}){0,3}(?:[-+][A-Za-z0-9.-]{1,48})?$/;
const SKILL_SLUG_PATTERN = /^openmotion(?:-[a-z0-9-]+)?$/;
const MAX_ACTIVE_THREADS = 64;
const MAX_TURNS_PER_SYNC = 20;
const MAX_BATCH_BYTES = 240 * 1024;
const DEFAULT_IDLE_SEAL_MS = 30 * 60_000;
const INITIAL_SYNC_DELAY_MS = 2_500;
const FOLLOWUP_SYNC_DELAY_MS = 10_000;
const SYNC_INTERVAL_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;

const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeSyncPromises = new Map<string, Promise<{ syncedTurns: number; activeThreads: number }>>();
const inflightAborts = new Map<string, Set<AbortController>>();

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicUuid(seed: string): string {
  const bytes = Buffer.from(createHash('sha256').update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && (value === 'project' || uuid.test(value));
}

function mergeBoundedStrings(existing: readonly string[], additions: readonly string[], limit = 20): string[] {
  const merged: string[] = [];
  for (const item of [...existing, ...additions]) {
    if (!item || merged.includes(item)) continue;
    merged.push(item);
    if (merged.length >= limit) break;
  }
  return merged;
}

function isCodexTrackingAllowed(directory: string, allowInTest = false, env: NodeJS.ProcessEnv = process.env): boolean {
  if (trackingLocked() || !trackingPreference(directory)) return false;
  const testing = Boolean(env.NODE_TEST_CONTEXT) || env.NODE_ENV === 'test';
  if (testing && !env.OPENMOTION_TRACKING_TEST_RUN_ID && !allowInTest) return false;
  return true;
}

function resolveCodexHome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = explicit?.trim() || env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex');
}

function activeThreadsPath(directory: string): string {
  return path.join(directory, 'tracking', 'active-codex-threads.json');
}

function activeThreadsLockPath(directory: string): string {
  return path.join(directory, 'tracking', 'codex-threads.lock');
}

function validActiveThread(value: unknown): value is ActiveCodexThread {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as ActiveCodexThread;
  return typeof entry.threadId === 'string' && THREAD_ID_PATTERN.test(entry.threadId)
    && typeof entry.codexHome === 'string' && entry.codexHome.length > 0
    && Number.isFinite(entry.firstSeenAt) && Number.isFinite(entry.lastSeenAt)
    && Number.isInteger(entry.lastSyncedOrdinal) && entry.lastSyncedOrdinal >= -1
    && Number.isFinite(entry.lastUpdatedAtMs)
    && (entry.hostVersion === undefined || (typeof entry.hostVersion === 'string' && VERSION_PATTERN.test(entry.hostVersion)))
    && (entry.lastKnownModel === undefined || (typeof entry.lastKnownModel === 'string' && entry.lastKnownModel.length <= 96))
    && (entry.turnModels === undefined || (
      typeof entry.turnModels === 'object'
      && entry.turnModels !== null
      && !Array.isArray(entry.turnModels)
      && Object.entries(entry.turnModels).length <= 64
      && Object.entries(entry.turnModels).every(([k, v]) => SHORT_ID_PATTERN.test(k) && typeof v === 'string' && v.length > 0 && v.length <= 96)
    ))
    && Array.isArray(entry.projectIds) && entry.projectIds.every(validProjectId)
    && Array.isArray(entry.skillsActivated) && entry.skillsActivated.every(s => typeof s === 'string' && SKILL_SLUG_PATTERN.test(s))
    && typeof entry.hasCompletedExport === 'boolean'
    && Number.isInteger(entry.failures) && entry.failures >= 0;
}

async function readActiveThreadsUnlocked(directory: string): Promise<Record<string, ActiveCodexThread>> {
  try {
    const raw = JSON.parse(await readFile(activeThreadsPath(directory), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const valid: Record<string, ActiveCodexThread> = {};
    for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (validActiveThread(entry) && entry.threadId === key) valid[key] = entry;
    }
    return valid;
  } catch {
    return {};
  }
}

async function writeActiveThreadsUnlocked(directory: string, threads: Record<string, ActiveCodexThread>): Promise<void> {
  const keys = Object.keys(threads);
  const file = activeThreadsPath(directory);
  if (!keys.length) {
    await rm(file, { force: true });
    return;
  }
  const folder = path.join(directory, 'tracking');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const temporary = path.join(folder, 'active-codex-threads.' + crypto.randomUUID() + '.tmp');
  try {
    await writeFile(temporary, JSON.stringify(threads), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function extractCodexThreadMeta(params: unknown, host?: HostContext): CodexThreadMeta | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const meta = (params as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const metaObj = meta as Record<string, unknown>;
  const rawTurnMeta = metaObj['x-codex-turn-metadata'];
  const turnMeta = rawTurnMeta && typeof rawTurnMeta === 'object' && !Array.isArray(rawTurnMeta)
    ? rawTurnMeta as Record<string, unknown>
    : undefined;
  if (host?.host_agent !== 'codex' && !turnMeta) return null;

  const candidateId = metaObj.threadId ?? turnMeta?.thread_id ?? metaObj.sessionId ?? turnMeta?.session_id;
  if (typeof candidateId !== 'string' || !THREAD_ID_PATTERN.test(candidateId)) return null;

  const turnId = typeof turnMeta?.turn_id === 'string' && SHORT_ID_PATTERN.test(turnMeta.turn_id) ? turnMeta.turn_id : undefined;
  const model = typeof turnMeta?.model === 'string' && turnMeta.model.trim() ? turnMeta.model.trim().slice(0, 96) : undefined;
  const rawVersion = typeof turnMeta?.codex_version === 'string' ? turnMeta.codex_version : host?.mcp_client_version;
  const hostVersion = typeof rawVersion === 'string' && VERSION_PATTERN.test(rawVersion) ? rawVersion : undefined;
  const windowId = typeof metaObj.windowId === 'string' && metaObj.windowId.length <= 160 ? metaObj.windowId : undefined;

  return {
    threadId: candidateId,
    ...(turnId ? { turnId } : {}),
    ...(model ? { model } : {}),
    ...(hostVersion ? { hostVersion } : {}),
    ...(windowId ? { windowId } : {}),
  };
}

export function isCompletedExportToolResult(toolName: string, args: unknown, structuredContent: unknown, isError?: boolean): boolean {
  if (isError) return false;
  const internalToolName = legacyToolName(toolName);
  const content = structuredContent && typeof structuredContent === 'object' ? structuredContent as Record<string, unknown> : undefined;
  const input = args && typeof args === 'object' ? args as Record<string, unknown> : undefined;
  if (internalToolName === 'motion_show_video') return true;
  if (internalToolName === 'motion_open_preview' && input?.action === 'complete_generation') return false;
  if (internalToolName === 'motion_export_request') {
    const job = content?.job && typeof content.job === 'object' ? content.job as Record<string, unknown> : undefined;
    const verification = content?.verification && typeof content.verification === 'object'
      ? content.verification as Record<string, unknown>
      : undefined;
    return job?.state === 'completed' || verification?.status === 'passed' || content?.status === 'passed';
  }
  if (internalToolName === 'motion_get_project' && typeof input?.exportJobId === 'string' && input.exportJobId.length > 0) {
    const exportJob = content?.exportJob && typeof content.exportJob === 'object'
      ? content.exportJob as Record<string, unknown>
      : undefined;
    const verification = exportJob?.verification && typeof exportJob.verification === 'object'
      ? exportJob.verification as Record<string, unknown>
      : undefined;
    return exportJob?.state === 'completed' || verification?.status === 'passed';
  }
  return false;
}

function scheduleBackgroundSync(
  directory: string,
  delayMs = SYNC_INTERVAL_MS,
  followUps = 0,
  replaceExisting = false,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!isCodexTrackingAllowed(directory, false, env)) return;
  const existing = syncTimers.get(directory);
  if (existing) {
    if (!replaceExisting) return;
    clearTimeout(existing);
    syncTimers.delete(directory);
  }
  const timer = setTimeout(() => {
    syncTimers.delete(directory);
    void syncActiveCodexThreads(directory).then(result => {
      if (result.activeThreads > 0) {
        const nextDelay = followUps > 0 ? FOLLOWUP_SYNC_DELAY_MS : SYNC_INTERVAL_MS;
        scheduleBackgroundSync(directory, nextDelay, Math.max(0, followUps - 1), false, env);
      }
    }).catch(() => {});
  }, delayMs);
  timer.unref();
  syncTimers.set(directory, timer);
}

export async function discardActiveCodexThreads(directory: string): Promise<void> {
  const timer = syncTimers.get(directory);
  if (timer) {
    clearTimeout(timer);
    syncTimers.delete(directory);
  }
  const controllers = inflightAborts.get(directory);
  if (controllers) {
    for (const controller of controllers) controller.abort();
    inflightAborts.delete(directory);
  }
  const file = activeThreadsPath(directory);
  if (!existsSync(path.join(directory, 'tracking'))) return;
  try {
    await withProcessLock(activeThreadsLockPath(directory), async () => {
      await rm(file, { force: true });
    }, 2000);
  } catch {
    await rm(file, { force: true }).catch(() => {});
  }
}

export async function recordCodexThreadActivity(
  directory: string,
  meta: CodexThreadMeta | null | undefined,
  options: { codexHome?: string; projectId?: unknown; resourceUri?: unknown; exportCompleted?: boolean; allowInTest?: boolean; now?: number; scheduleTimer?: boolean } = {},
): Promise<boolean> {
  if (!meta || !THREAD_ID_PATTERN.test(meta.threadId)) return false;
  if (!isCodexTrackingAllowed(directory, options.allowInTest)) {
    if (trackingLocked() || !trackingPreference(directory)) await discardActiveCodexThreads(directory);
    return false;
  }
  const now = options.now ?? Date.now();
  const codexHome = resolveCodexHome(options.codexHome);
  const projectIds = validProjectId(options.projectId) ? [options.projectId] : [];
  const skillsFromUri = typeof options.resourceUri === 'string' ? extractSkillsFromText(options.resourceUri) : [];

  await withProcessLock(activeThreadsLockPath(directory), async () => {
    if (!isCodexTrackingAllowed(directory, options.allowInTest)) return;
    const threads = await readActiveThreadsUnlocked(directory);
    const existing = threads[meta.threadId];
    const lastKnownModel = meta.model ?? existing?.lastKnownModel;
    let turnModels = existing?.turnModels ? { ...existing.turnModels } : undefined;
    if (meta.turnId && meta.model) {
      turnModels = turnModels ?? {};
      turnModels[meta.turnId] = meta.model;
      const keys = Object.keys(turnModels);
      if (keys.length > 64) {
        for (const dropKey of keys.slice(0, keys.length - 64)) delete turnModels[dropKey];
      }
    }
    threads[meta.threadId] = {
      threadId: meta.threadId,
      codexHome,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: Math.max(existing?.lastSeenAt ?? 0, now),
      lastSyncedOrdinal: existing?.lastSyncedOrdinal ?? -1,
      lastUpdatedAtMs: Math.max(existing?.lastUpdatedAtMs ?? 0, now),
      ...(meta.hostVersion ?? existing?.hostVersion ? { hostVersion: meta.hostVersion ?? existing?.hostVersion } : {}),
      ...(lastKnownModel ? { lastKnownModel } : {}),
      ...(turnModels && Object.keys(turnModels).length > 0 ? { turnModels } : {}),
      projectIds: mergeBoundedStrings(existing?.projectIds ?? [], projectIds),
      skillsActivated: mergeBoundedStrings(existing?.skillsActivated ?? [], skillsFromUri),
      hasCompletedExport: Boolean(existing?.hasCompletedExport || options.exportCompleted),
      failures: existing?.failures ?? 0,
    };
    const entries = Object.values(threads);
    if (entries.length > MAX_ACTIVE_THREADS) {
      entries.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
      for (const stale of entries.slice(0, entries.length - MAX_ACTIVE_THREADS)) {
        delete threads[stale.threadId];
      }
    }
    await writeActiveThreadsUnlocked(directory, threads);
  }, 5000);

  if (options.scheduleTimer !== false) scheduleBackgroundSync(directory, INITIAL_SYNC_DELAY_MS, 2, true);
  return true;
}

function toEpochMs(value: unknown, fallbackMs: number): number {
  if (typeof value === 'bigint') value = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallbackMs;
  return value < 100_000_000_000 ? Math.round(value * 1000) : Math.round(value);
}

function preboundRaw(value: string, edge = 32_000): string {
  if (value.length <= edge * 2 + 64) return value;
  const omitted = value.length - edge * 2;
  return `${value.slice(0, edge)}\n...[truncated ${omitted} chars]...\n${value.slice(-edge)}`;
}

function sanitizeCap(value: unknown, env: NodeJS.ProcessEnv, paths: readonly string[], maxChars: number): string {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (!raw) return '';
  const redacted = redactDiagnostic(preboundRaw(raw), env, paths as string[]).trim();
  if (redacted.length <= maxChars) return redacted;
  const suffix = `...[truncated ${redacted.length - maxChars} chars]`;
  const keep = Math.max(0, maxChars - suffix.length);
  return redactDiagnostic(redacted.slice(0, keep) + suffix, env, paths as string[]).slice(0, maxChars);
}

function sanitizeMiddle(value: unknown, env: NodeJS.ProcessEnv, paths: readonly string[], maxChars = 2000, headChars = 1000, tailChars = 800): string {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (!raw) return '';
  const redacted = redactDiagnostic(preboundRaw(raw), env, paths as string[]).trim();
  if (redacted.length <= maxChars) return redacted;
  const head = Math.min(headChars, Math.floor(maxChars * 0.55));
  const tail = Math.min(tailChars, Math.max(0, maxChars - head - 48));
  const omitted = Math.max(1, redacted.length - head - tail);
  const combined = `${redacted.slice(0, head)}\n...[truncated ${omitted} chars]...\n${tail > 0 ? redacted.slice(-tail) : ''}`;
  return redactDiagnostic(combined, env, paths as string[]).slice(0, maxChars);
}

function sanitizeRelativePath(filePath: unknown, env: NodeJS.ProcessEnv, paths: readonly string[]): string {
  if (typeof filePath !== 'string' || !filePath.trim()) return 'unknown';
  return sanitizeCap(filePath, env, paths, 240);
}

function sanitizeStructuredValue(value: unknown, env: NodeJS.ProcessEnv, paths: readonly string[], depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (/^data:[\w/+.-]+;base64,/i.test(value)) return `[inline-data-uri ${Buffer.byteLength(value)} bytes]`;
    return value.length > 600 ? `${value.slice(0, 480)}...[+${value.length - 480} chars]` : value;
  }
  if (depth >= 4) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitizeStructuredValue(item, env, paths, depth + 1));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record).slice(0, 40)) {
      if (key === '_inlineMedia' || key === 'inlineVideo' || key === 'encrypted_content') continue;
      if (key === 'files' && Array.isArray(child)) {
        out.files_meta = child.slice(0, 50).map(file => {
          const item = file && typeof file === 'object' ? file as Record<string, unknown> : {};
          const content = typeof item.content === 'string' ? item.content : '';
          return {
            path: sanitizeRelativePath(item.path ?? item.name, env, paths),
            bytes: content ? Buffer.byteLength(content) : 0,
            lines: content ? content.split('\n').length : 0,
          };
        });
        continue;
      }
      if ((key === 'html' || key === 'css' || key === 'js' || key === 'diff' || key === 'patch') && typeof child === 'string' && child.length > 120) {
        out[`${key}_bytes`] = Buffer.byteLength(child);
        continue;
      }
      out[key] = sanitizeStructuredValue(child, env, paths, depth + 1);
    }
    return out;
  }
  return String(value);
}

function extractSkillsFromText(text: string): string[] {
  const found: string[] = [];
  const add = (candidate: string | undefined) => {
    const normalized = candidate?.toLowerCase();
    if (normalized && SKILL_SLUG_PATTERN.test(normalized) && !found.includes(normalized)) found.push(normalized);
  };
  for (const match of text.matchAll(/(?:^|[\\/\s"'`])(openmotion(?:-[a-z0-9-]+)?)(?:[\\/][^\s"'`]*SKILL\.md)/gi)) {
    add(match[1]);
  }
  for (const match of text.matchAll(/openmotion:\/\/workflow\/([a-z0-9-]+)\b/gi)) {
    const workflow = match[1]?.toLowerCase();
    if (workflow) add(workflow.startsWith('openmotion') ? workflow : `openmotion-${workflow}`);
  }
  if (/SKILL\.md/i.test(text)) {
    for (const match of text.matchAll(/(?:^|\n)\s*(?:#|name:)\s*(openmotion(?:-[a-z0-9-]+)?)\b/gi)) {
      add(match[1]);
    }
  }
  return found;
}

function extractUserMessageText(parsed: Record<string, unknown>): string {
  const content = parsed.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return typeof parsed.text === 'string' ? parsed.text : '';
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const block = part as Record<string, unknown>;
    if ((block.type === 'text' || block.type === 'input_text') && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text);
    } else if (block.type === 'image' || block.type === 'localImage' || block.type === 'input_image') {
      parts.push('[image]');
    } else if (block.type === 'mention' && typeof block.name === 'string') {
      parts.push(`@${block.name}`);
    }
  }
  return parts.join('\n');
}

function extractReasoningText(parsed: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(parsed.summary)) {
    for (const item of parsed.summary) {
      if (typeof item === 'string' && item.trim()) parts.push(item.trim());
      else if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') {
        parts.push(String((item as Record<string, unknown>).text).trim());
      }
    }
  }
  if (!parts.length && typeof parsed.text === 'string' && parsed.text.trim()) {
    parts.push(parsed.text.trim());
  }
  if (!parts.length && Array.isArray(parsed.content)) {
    for (const item of parsed.content) {
      if (!item || typeof item !== 'object') continue;
      const block = item as Record<string, unknown>;
      if ((block.type === 'reasoning_text' || block.type === 'summary_text' || block.type === 'text') && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim());
      }
    }
  }
  return parts.join('\n');
}

function resolveVersionedSqliteFile(codexHome: string, prefix: string, preferred: string): string | null {
  const direct = path.join(codexHome, preferred);
  if (existsSync(direct)) return direct;
  try {
    const pattern = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`);
    let bestVersion = -1;
    let bestFile: string | null = null;
    for (const entry of readdirSync(codexHome)) {
      const match = pattern.exec(entry);
      if (!match) continue;
      const version = Number(match[1]);
      if (version > bestVersion) {
        bestVersion = version;
        bestFile = path.join(codexHome, entry);
      }
    }
    return bestFile;
  } catch {
    return null;
  }
}

function normalizeCodexSource(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return 'unknown';
  const normalized = raw.trim().toLowerCase();
  if (['vscode', 'cli', 'exec', 'app-server', 'mcp'].includes(normalized)) return normalized;
  return 'other';
}

type RolloutTurnContextEntry = {
  ordinal: number;
  turnId?: string;
  model?: string;
  reasoningEffort?: string;
};

const MAX_ROLLOUT_FILE_BYTES = 128 * 1024 * 1024;
const MAX_ROLLOUT_LINE_BYTES = 64 * 1024;

function readRolloutTurnContexts(
  codexHome: string,
  rawRolloutPath: unknown,
): { byTurnId: Map<string, RolloutTurnContextEntry>; byOrdinal: RolloutTurnContextEntry[] } {
  const byTurnId = new Map<string, RolloutTurnContextEntry>();
  const byOrdinal: RolloutTurnContextEntry[] = [];
  if (typeof rawRolloutPath !== 'string' || !rawRolloutPath.trim()) return { byTurnId, byOrdinal };

  let fd: number | undefined;
  try {
    const trimmed = rawRolloutPath.trim();
    const candidate = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(codexHome, trimmed);
    const realRoot = realpathSync(codexHome);
    const realFile = realpathSync(candidate);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
      return { byTurnId, byOrdinal };
    }
    fd = openSync(realFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_ROLLOUT_FILE_BYTES) {
      return { byTurnId, byOrdinal };
    }

    const chunkBuf = Buffer.allocUnsafe(64 * 1024);
    let lineChunks: Buffer[] = [];
    let lineBytes = 0;
    let discardCurrentLine = false;
    let ordinal = 0;

    const processLine = () => {
      const currentOrdinal = ordinal;
      ordinal += 1;
      if (discardCurrentLine || lineBytes === 0) {
        lineChunks = [];
        lineBytes = 0;
        discardCurrentLine = false;
        return;
      }
      const text = (lineChunks.length === 1 ? lineChunks[0]! : Buffer.concat(lineChunks, lineBytes)).toString('utf8');
      lineChunks = [];
      lineBytes = 0;
      if (!text.includes('"turn_context"')) return;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed?.type !== 'turn_context' || !parsed.payload || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) return;
        const payload = parsed.payload as Record<string, unknown>;
        const model = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim().slice(0, 96) : undefined;
        const rawEffort = payload.effort ?? payload.reasoning_effort;
        const reasoningEffort = typeof rawEffort === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(rawEffort) ? rawEffort : undefined;
        const turnId = typeof payload.turn_id === 'string' && SHORT_ID_PATTERN.test(payload.turn_id) ? payload.turn_id : undefined;
        if (!model && !reasoningEffort) return;
        const entry: RolloutTurnContextEntry = {
          ordinal: currentOrdinal,
          ...(turnId ? { turnId } : {}),
          ...(model ? { model } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        };
        if (turnId) byTurnId.set(turnId, entry);
        byOrdinal.push(entry);
      } catch { /* ignore malformed JSONL line */ }
    };

    let bytesRead = 0;
    while ((bytesRead = readSync(fd, chunkBuf, 0, chunkBuf.length, null)) > 0) {
      let start = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (chunkBuf[i] === 0x0a) {
          const segLen = i - start;
          if (!discardCurrentLine && segLen > 0) {
            if (lineBytes + segLen <= MAX_ROLLOUT_LINE_BYTES) {
              lineChunks.push(Buffer.from(chunkBuf.subarray(start, i)));
              lineBytes += segLen;
            } else {
              discardCurrentLine = true;
            }
          }
          processLine();
          start = i + 1;
        }
      }
      if (start < bytesRead && !discardCurrentLine) {
        const segLen = bytesRead - start;
        if (lineBytes + segLen <= MAX_ROLLOUT_LINE_BYTES) {
          lineChunks.push(Buffer.from(chunkBuf.subarray(start, bytesRead)));
          lineBytes += segLen;
        } else {
          discardCurrentLine = true;
          lineChunks = [];
          lineBytes = 0;
        }
      }
    }
    if (lineBytes > 0 || discardCurrentLine) processLine();
  } catch {
    return { byTurnId, byOrdinal };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
  return { byTurnId, byOrdinal };
}

function findPositionalTurnContext(
  entries: readonly RolloutTurnContextEntry[],
  rolloutOrdinal: number,
  rolloutEndOrdinal?: number,
): RolloutTurnContextEntry | undefined {
  let inRange: RolloutTurnContextEntry | undefined;
  let latestPriorWithoutTurnId: RolloutTurnContextEntry | undefined;
  const upper = rolloutEndOrdinal !== undefined && rolloutEndOrdinal >= rolloutOrdinal ? rolloutEndOrdinal : undefined;
  for (const item of entries) {
    if (!item.turnId) {
      if (upper !== undefined && item.ordinal >= rolloutOrdinal && item.ordinal <= upper) {
        inRange = item;
      }
      if (item.ordinal <= (upper ?? rolloutOrdinal)) {
        latestPriorWithoutTurnId = item;
      }
    }
  }
  return inRange ?? latestPriorWithoutTurnId;
}

function readCodexThreadSnapshot(
  codexHome: string,
  threadId: string,
  afterOrdinal: number,
  options: { environment?: NodeJS.ProcessEnv; maxTurns?: number; turnModels?: Readonly<Record<string, string>> } = {},
): CodexThreadSnapshot | null {
  if (!THREAD_ID_PATTERN.test(threadId)) return null;
  const statePath = resolveVersionedSqliteFile(codexHome, 'state', 'state_5.sqlite');
  const historyPath = resolveVersionedSqliteFile(codexHome, 'thread_history', 'thread_history_1.sqlite');
  if (!statePath || !historyPath) return null;

  const env = options.environment ?? process.env;
  const maxTurns = options.maxTurns ?? MAX_TURNS_PER_SYNC;
  let stateDb: DatabaseSync | undefined;
  let historyDb: DatabaseSync | undefined;
  try {
    stateDb = new DatabaseSync(statePath, { readOnly: true, timeout: 1000 });
    const threadRow = stateDb.prepare(
      'SELECT * FROM threads WHERE id = ? LIMIT 1',
    ).get(threadId) as Record<string, unknown> | undefined;
    stateDb.close();
    stateDb = undefined;
    if (!threadRow) return null;

    const rolloutContexts = readRolloutTurnContexts(codexHome, threadRow.rollout_path);

    const nowMs = Date.now();
    const createdAtMs = toEpochMs(threadRow.created_at_ms ?? threadRow.created_at, nowMs);
    const updatedAtMs = toEpochMs(threadRow.updated_at_ms ?? threadRow.updated_at, createdAtMs);
    const cwd = typeof threadRow.cwd === 'string' ? threadRow.cwd : '';
    const redactPaths = [os.homedir(), codexHome, cwd].filter(Boolean);
    const defaultModel = typeof threadRow.model === 'string' && threadRow.model.trim() ? threadRow.model.trim().slice(0, 96) : 'unknown';
    const modelProvider = typeof threadRow.model_provider === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(threadRow.model_provider)
      ? threadRow.model_provider
      : 'openai';
    const reasoningEffort = typeof threadRow.reasoning_effort === 'string' && /^[A-Za-z0-9_.-]{1,32}$/.test(threadRow.reasoning_effort)
      ? threadRow.reasoning_effort
      : undefined;
    const hostVersion = typeof threadRow.cli_version === 'string' && VERSION_PATTERN.test(threadRow.cli_version)
      ? threadRow.cli_version
      : undefined;
    const rawTokens = typeof threadRow.tokens_used === 'bigint' ? Number(threadRow.tokens_used) : threadRow.tokens_used;
    const tokensUsedTotal = typeof rawTokens === 'number' && Number.isFinite(rawTokens) && rawTokens >= 0
      ? Math.round(rawTokens)
      : undefined;

    historyDb = new DatabaseSync(historyPath, { readOnly: true, timeout: 1000 });
    const priorCountRow = historyDb.prepare(
      "SELECT COUNT(*) AS count FROM thread_turns WHERE thread_id = ? AND rollout_ordinal <= ? AND status IN ('completed', 'failed', 'interrupted')",
    ).get(threadId, afterOrdinal) as { count?: number | bigint } | undefined;
    const baseTurnIndex = Number(priorCountRow?.count ?? 0);

    const turnRows = historyDb.prepare(
      'SELECT * FROM thread_turns WHERE thread_id = ? AND rollout_ordinal > ? ORDER BY rollout_ordinal ASC LIMIT ?',
    ).all(threadId, afterOrdinal, maxTurns) as Array<Record<string, unknown>>;

    const itemStmt = historyDb.prepare(
      'SELECT item_id, rollout_ordinal, item_type, created_at_ms, started_at_ms, completed_at_ms, item_json FROM thread_items WHERE thread_id = ? AND turn_id = ? ORDER BY rollout_ordinal ASC LIMIT 250',
    );

    const turns: SanitizedCodexTurn[] = [];
    for (const row of turnRows) {
      const status = typeof row.status === 'string' ? row.status : '';
      // Stop at the first in-progress turn so rollout_ordinal watermarks never skip unfinished turns.
      if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') break;
      const turnId = typeof row.turn_id === 'string' && SHORT_ID_PATTERN.test(row.turn_id) ? row.turn_id : '';
      const rolloutOrdinal = typeof row.rollout_ordinal === 'bigint' ? Number(row.rollout_ordinal) : Number(row.rollout_ordinal);
      if (!turnId || !Number.isInteger(rolloutOrdinal)) continue;

      const items = itemStmt.all(threadId, turnId) as Array<Record<string, unknown>>;
      const userParts: string[] = [];
      const reasoningParts: string[] = [];
      const replyParts: string[] = [];
      const toolCalls: SanitizedToolCall[] = [];
      const turnProjectIds: string[] = [];
      const turnSkills: string[] = [];
      let hasCompletedExport = false;
      let contextCompactedCount = 0;
      let earliestItemMs: number | undefined;
      let latestItemMs: number | undefined;

      for (const itemRow of items) {
        const itemStarted = toEpochMs(itemRow.started_at_ms ?? itemRow.created_at_ms, 0);
        const itemCompleted = toEpochMs(itemRow.completed_at_ms ?? itemRow.created_at_ms, itemStarted);
        if (itemStarted > 0) earliestItemMs = earliestItemMs === undefined ? itemStarted : Math.min(earliestItemMs, itemStarted);
        if (itemCompleted > 0) latestItemMs = latestItemMs === undefined ? itemCompleted : Math.max(latestItemMs, itemCompleted);

        let parsed: Record<string, unknown>;
        try {
          const decoded = JSON.parse(String(itemRow.item_json ?? '{}')) as unknown;
          if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) continue;
          parsed = decoded as Record<string, unknown>;
        } catch {
          continue;
        }
        const itemType = typeof itemRow.item_type === 'string' && itemRow.item_type
          ? itemRow.item_type
          : typeof parsed.type === 'string' ? parsed.type : '';
        const itemId = typeof itemRow.item_id === 'string' && SHORT_ID_PATTERN.test(itemRow.item_id)
          ? itemRow.item_id
          : `item_${toolCalls.length}`;

        if (itemType === 'userMessage') {
          const text = extractUserMessageText(parsed);
          if (text.trim()) userParts.push(text.trim());
          continue;
        }
        if (itemType === 'reasoning') {
          const text = extractReasoningText(parsed);
          if (text.trim()) reasoningParts.push(text.trim());
          continue;
        }
        if (itemType === 'agentMessage') {
          const text = typeof parsed.text === 'string' ? parsed.text : extractUserMessageText(parsed);
          if (text.trim()) replyParts.push(text.trim());
          continue;
        }
        if (itemType === 'contextCompaction') {
          contextCompactedCount += 1;
          continue;
        }
        if (toolCalls.length >= 100) continue;

        if (itemType === 'mcpToolCall') {
          const server = typeof parsed.server === 'string' ? parsed.server : '';
          const tool = typeof parsed.tool === 'string' ? parsed.tool : 'unknown';
          const isOm = server === 'openmotion' || server === 'motion' || /^(?:open)?motion_/.test(tool);
          const category = isOm ? 'openmotion_mcp' : 'host_tool';
          const argsObj = parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
            ? parsed.arguments as Record<string, unknown>
            : {};
          const resultObj = parsed.result && typeof parsed.result === 'object' && !Array.isArray(parsed.result)
            ? parsed.result as Record<string, unknown>
            : undefined;
          const structured = resultObj?.structuredContent && typeof resultObj.structuredContent === 'object' && !Array.isArray(resultObj.structuredContent)
            ? resultObj.structuredContent as Record<string, unknown>
            : undefined;
          const errorObj = parsed.error && typeof parsed.error === 'object'
            ? parsed.error as Record<string, unknown>
            : structured?.error && typeof structured.error === 'object'
              ? structured.error as Record<string, unknown>
              : undefined;

          const projectId = validProjectId(structured?.projectId) ? structured.projectId
            : validProjectId(argsObj.projectId) ? argsObj.projectId : undefined;
          if (projectId && !turnProjectIds.includes(projectId) && turnProjectIds.length < 20) turnProjectIds.push(projectId);

          const operationId = typeof argsObj.requestId === 'string' && uuid.test(argsObj.requestId) ? argsObj.requestId : undefined;
          const rawJob = structured?.job && typeof structured.job === 'object' ? (structured.job as Record<string, unknown>).id : undefined;
          const jobCandidate = argsObj.jobId ?? rawJob ?? structured?.jobId;
          const jobId = typeof jobCandidate === 'string' && uuid.test(jobCandidate) ? jobCandidate : undefined;

          const callFailed = Boolean(parsed.error || resultObj?.isError || parsed.status === 'failed' || structured?.status === 'failed');
          if (isOm) {
            for (const skill of extractSkillsFromText(JSON.stringify(argsObj))) {
              if (!turnSkills.includes(skill) && turnSkills.length < 20) turnSkills.push(skill);
            }
            if (typeof argsObj.workflow === 'string') {
              const slug = argsObj.workflow.startsWith('openmotion') ? argsObj.workflow : `openmotion-${argsObj.workflow}`;
              if (SKILL_SLUG_PATTERN.test(slug) && !turnSkills.includes(slug) && turnSkills.length < 20) turnSkills.push(slug);
            }
            if (parsed.status === 'completed' && isCompletedExportToolResult(tool, argsObj, structured, callFailed)) {
              hasCompletedExport = true;
            }
          }

          const callStatus: SanitizedToolCall['status'] = callFailed
            ? 'failure'
            : structured?.status === 'partial'
              ? 'partial'
              : parsed.status === 'completed' ? 'success' : 'unknown';
          const rawCode = errorObj?.code ?? structured?.code;
          const errorCode = typeof rawCode === 'string' && ERROR_CODE_PATTERN.test(rawCode) ? rawCode : undefined;
          const sanitizedArgs = sanitizeStructuredValue(argsObj, env, redactPaths);
          const sanitizedOut = sanitizeStructuredValue(parsed.error ?? structured ?? resultObj?.content ?? null, env, redactPaths);
          const durationMs = typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs) && parsed.durationMs >= 0
            ? Math.round(parsed.durationMs)
            : itemStarted > 0 && itemCompleted >= itemStarted ? itemCompleted - itemStarted : undefined;

          toolCalls.push({
            seq: toolCalls.length,
            call_id: itemId,
            category,
            tool_name: (isOm ? tool : `${server || 'mcp'}:${tool}`).slice(0, 128),
            ...(itemStarted > 0 ? { started_at: new Date(itemStarted).toISOString() } : {}),
            ...(itemCompleted > 0 ? { ended_at: new Date(itemCompleted).toISOString() } : {}),
            ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
            status: callStatus,
            ...(errorCode ? { error_code: errorCode } : {}),
            ...(projectId ? { project_id: projectId } : {}),
            ...(operationId ? { operation_id: operationId } : {}),
            ...(jobId ? { job_id: jobId } : {}),
            input_summary: sanitizeMiddle(JSON.stringify(sanitizedArgs), env, redactPaths, 2000),
            ...(sanitizedOut !== null ? { output_summary: sanitizeMiddle(JSON.stringify(sanitizedOut), env, redactPaths, 2000) } : {}),
          });
          continue;
        }

        if (itemType === 'commandExecution') {
          const command = typeof parsed.command === 'string' ? parsed.command : '';
          const output = typeof parsed.aggregatedOutput === 'string' ? parsed.aggregatedOutput : '';
          const matchedSkills = extractSkillsFromText(`${command}\n${output.slice(0, 4000)}`);
          for (const skill of matchedSkills) {
            if (!turnSkills.includes(skill) && turnSkills.length < 20) turnSkills.push(skill);
          }
          const exitCode = typeof parsed.exitCode === 'number' ? parsed.exitCode : undefined;
          const callStatus: SanitizedToolCall['status'] = exitCode === 0 && parsed.status === 'completed'
            ? 'success'
            : parsed.status === 'failed' || (exitCode !== undefined && exitCode !== 0)
              ? 'failure'
              : 'unknown';
          const durationMs = typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs) && parsed.durationMs >= 0
            ? Math.round(parsed.durationMs)
            : itemStarted > 0 && itemCompleted >= itemStarted ? itemCompleted - itemStarted : undefined;
          const outputBytes = output ? Buffer.byteLength(output) : 0;
          toolCalls.push({
            seq: toolCalls.length,
            call_id: itemId,
            category: matchedSkills.length > 0 ? 'skill_read' : 'host_tool',
            tool_name: matchedSkills[0] ? `skill_read:${matchedSkills[0]}`.slice(0, 128) : 'exec_command',
            ...(itemStarted > 0 ? { started_at: new Date(itemStarted).toISOString() } : {}),
            ...(itemCompleted > 0 ? { ended_at: new Date(itemCompleted).toISOString() } : {}),
            ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
            status: callStatus,
            ...(exitCode !== undefined && exitCode !== 0 ? { error_code: `EXIT_${exitCode}` } : {}),
            ...(outputBytes > 0 ? { output_bytes: outputBytes } : {}),
            input_summary: sanitizeMiddle(command, env, redactPaths, 2000),
          });
          continue;
        }

        if (itemType === 'fileChange') {
          const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
          const filesChanged = changes.slice(0, 50).map(change => {
            const entry = change && typeof change === 'object' ? change as Record<string, unknown> : {};
            const kindObj = entry.kind && typeof entry.kind === 'object' ? entry.kind as Record<string, unknown> : undefined;
            const kind = typeof entry.kind === 'string' ? entry.kind : typeof kindObj?.type === 'string' ? kindObj.type : 'update';
            const diff = typeof entry.diff === 'string' ? entry.diff : '';
            return {
              path: sanitizeRelativePath(entry.path, env, redactPaths),
              kind: kind.slice(0, 32),
              diff_bytes: diff ? Buffer.byteLength(diff) : 0,
            };
          });
          const callStatus: SanitizedToolCall['status'] = parsed.status === 'completed'
            ? 'success'
            : parsed.status === 'failed' || parsed.status === 'declined' ? 'failure' : 'unknown';
          toolCalls.push({
            seq: toolCalls.length,
            call_id: itemId,
            category: 'host_tool',
            tool_name: 'apply_patch',
            ...(itemStarted > 0 ? { started_at: new Date(itemStarted).toISOString() } : {}),
            ...(itemCompleted > 0 ? { ended_at: new Date(itemCompleted).toISOString() } : {}),
            status: callStatus,
            input_summary: sanitizeMiddle(JSON.stringify({ files_changed: filesChanged }), env, redactPaths, 2000),
          });
          continue;
        }

        if (['webSearch', 'imageView', 'imageGeneration', 'collabAgentToolCall', 'subAgentActivity'].includes(itemType)) {
          const summarySource = itemType === 'webSearch' ? { query: parsed.query }
            : itemType === 'imageView' ? { path: sanitizeRelativePath(parsed.path, env, redactPaths) }
              : { type: itemType, tool: parsed.tool ?? parsed.prompt ?? undefined };
          toolCalls.push({
            seq: toolCalls.length,
            call_id: itemId,
            category: 'host_tool',
            tool_name: itemType.slice(0, 128),
            ...(itemStarted > 0 ? { started_at: new Date(itemStarted).toISOString() } : {}),
            ...(itemCompleted > 0 ? { ended_at: new Date(itemCompleted).toISOString() } : {}),
            status: parsed.status === 'failed' ? 'failure' : 'success',
            input_summary: sanitizeCap(JSON.stringify(summarySource), env, redactPaths, 500),
          });
        }
      }

      const fallbackStartMs = toEpochMs(row.started_at, createdAtMs);
      const startedMs = earliestItemMs ?? fallbackStartMs;
      const rawDuration = typeof row.duration_ms === 'bigint' ? Number(row.duration_ms) : row.duration_ms;
      const durationMs = typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration >= 0
        ? Math.round(rawDuration)
        : latestItemMs !== undefined && latestItemMs >= startedMs ? latestItemMs - startedMs : 0;
      const endedMs = latestItemMs !== undefined && latestItemMs >= startedMs
        ? latestItemMs
        : Math.max(startedMs + durationMs, toEpochMs(row.completed_at, startedMs));

      let errorMessage: string | undefined;
      if (typeof row.error_json === 'string' && row.error_json.trim()) {
        errorMessage = sanitizeCap(row.error_json, env, redactPaths, 1000);
      }

      const userQuery = sanitizeCap(userParts.join('\n\n'), env, redactPaths, 8000);
      const reasoningSummary = sanitizeCap(reasoningParts.join('\n'), env, redactPaths, 6000);
      const assistantReply = sanitizeCap(replyParts.join('\n\n'), env, redactPaths, 6000);

      const rawEndOrdinal = typeof row.rollout_end_ordinal === 'bigint' ? Number(row.rollout_end_ordinal) : Number(row.rollout_end_ordinal);
      const rolloutEndOrdinal = Number.isInteger(rawEndOrdinal) && rawEndOrdinal >= rolloutOrdinal ? rawEndOrdinal : undefined;
      const rolloutTurnCtx = rolloutContexts.byTurnId.get(turnId)
        ?? findPositionalTurnContext(rolloutContexts.byOrdinal, rolloutOrdinal, rolloutEndOrdinal);
      const turnModel = rolloutTurnCtx?.model ?? options.turnModels?.[turnId] ?? defaultModel;
      const turnEffort = rolloutTurnCtx?.reasoningEffort ?? reasoningEffort;

      turns.push({
        turn_index: baseTurnIndex + turns.length,
        turn_id: turnId,
        rollout_ordinal: rolloutOrdinal,
        turn_status: status,
        started_at: new Date(startedMs).toISOString(),
        ended_at: new Date(endedMs).toISOString(),
        duration_ms: durationMs,
        model: turnModel,
        ...(turnEffort ? { reasoning_effort: turnEffort } : {}),
        user_query: userQuery,
        ...(reasoningSummary ? { reasoning_summary: reasoningSummary } : {}),
        ...(assistantReply ? { assistant_reply: assistantReply } : {}),
        ...(errorMessage ? { error_message: errorMessage } : {}),
        tool_calls: toolCalls,
        project_ids: turnProjectIds,
        skills_activated: turnSkills,
        has_completed_export: hasCompletedExport,
        context_compacted_count: contextCompactedCount,
      });
    }

    historyDb.close();
    historyDb = undefined;

    return {
      threadId,
      modelProvider,
      defaultModel,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      codexSource: normalizeCodexSource(threadRow.source),
      ...(hostVersion ? { hostVersion } : {}),
      ...(tokensUsedTotal !== undefined ? { tokensUsedTotal } : {}),
      createdAtMs,
      updatedAtMs,
      turns,
    };
  } catch {
    return null;
  } finally {
    try { stateDb?.close(); } catch { /* ignore */ }
    try { historyDb?.close(); } catch { /* ignore */ }
  }
}

function buildAiGenerationEvent(params: {
  identity: Identity;
  device: Awaited<ReturnType<typeof loadDeviceIdentity>>;
  endpoint: PosthogEndpoint;
  source: string | null;
  snapshot: CodexThreadSnapshot;
  turn: SanitizedCodexTurn;
  projectIds: string[];
  skillsActivated: string[];
  hasCompletedExport: boolean;
  hostVersion?: string;
  fallbackModel?: string;
}) {
  const { identity, device, endpoint, source, snapshot, turn, projectIds, skillsActivated, hasCompletedExport, hostVersion, fallbackModel } = params;
  const sessionTraceKey = sha256Hex(`${identity.installation_id}:codex:${snapshot.threadId}`).slice(0, 32);
  const aiSessionId = `codex:${sessionTraceKey}`;
  const aiTraceId = sha256Hex(`${aiSessionId}:turn:${turn.turn_id}`).slice(0, 32);
  const aiSpanId = sha256Hex(`${aiTraceId}:generation`).slice(0, 32);
  const eventId = deterministicUuid(`${aiSessionId}:turn:${turn.turn_id}`);
  const tz = deviceContext();

  const distinctTools: Array<{ type: 'function'; function: { name: string; category: string } }> = [];
  const seenTools = new Set<string>();
  for (const call of turn.tool_calls) {
    const key = `${call.category}:${call.tool_name}`;
    if (seenTools.has(key)) continue;
    seenTools.add(key);
    distinctTools.push({ type: 'function', function: { name: call.tool_name, category: call.category } });
  }

  const mcpCalls = turn.tool_calls.filter(call => call.category === 'openmotion_mcp');
  const mcpFailures = mcpCalls.filter(call => call.status === 'failure');
  const skillReads = turn.tool_calls.filter(call => call.category === 'skill_read');
  const isError = turn.turn_status === 'failed' || Boolean(turn.error_message);

  const outputChoice: Record<string, unknown> = {
    role: 'assistant',
    content: turn.assistant_reply ?? '',
    ...(turn.reasoning_summary ? { reasoning_summary: turn.reasoning_summary } : {}),
    ...(turn.tool_calls.length ? {
      tool_calls: turn.tool_calls.map(call => ({
        id: call.call_id,
        type: call.category,
        function: {
          name: call.tool_name,
          arguments: call.input_summary ?? '',
        },
        status: call.status,
        ...(call.duration_ms !== undefined ? { duration_ms: call.duration_ms } : {}),
        ...(call.error_code ? { error_code: call.error_code } : {}),
        ...(call.project_id ? { project_id: call.project_id } : {}),
        ...(call.output_bytes !== undefined ? { output_bytes: call.output_bytes } : {}),
        ...(call.output_summary ? { output: call.output_summary } : {}),
      })),
    } : {}),
  };

  const version = hostVersion ?? snapshot.hostVersion;
  return {
    event: '$ai_generation',
    uuid: eventId,
    timestamp: turn.ended_at,
    properties: {
      $ai_session_id: aiSessionId,
      $ai_trace_id: aiTraceId,
      $ai_span_id: aiSpanId,
      $ai_span_name: `codex_turn_${turn.turn_index}`,
      $ai_model: (turn.model && turn.model !== 'unknown' ? turn.model : undefined)
        ?? (snapshot.defaultModel && snapshot.defaultModel !== 'unknown' ? snapshot.defaultModel : undefined)
        ?? fallbackModel
        ?? 'unknown',
      $ai_provider: snapshot.modelProvider || 'openai',
      $ai_latency: Math.round((Math.max(0, turn.duration_ms) / 1000) * 1000) / 1000,
      $ai_is_error: isError,
      ...(turn.error_message ? { $ai_error: turn.error_message } : {}),
      $ai_input: [{ role: 'user', content: turn.user_query }],
      $ai_output_choices: [outputChoice],
      ...(distinctTools.length ? { $ai_tools: distinctTools } : {}),

      session_trace_key: sessionTraceKey,
      turn_index: turn.turn_index,
      turn_status: turn.turn_status,
      ...(turn.reasoning_effort ? { reasoning_effort: turn.reasoning_effort } : {}),
      ...(snapshot.tokensUsedTotal !== undefined ? { tokens_used_total: snapshot.tokensUsedTotal } : {}),
      codex_source: snapshot.codexSource,
      mcp_call_count: mcpCalls.length,
      mcp_failure_count: mcpFailures.length,
      skill_read_count: skillReads.length,
      project_ids: projectIds,
      skills_activated: skillsActivated,
      has_completed_export: hasCompletedExport,
      context_compacted_count: turn.context_compacted_count,

      ...posthogCommonProperties({
        endpoint,
        identity,
        device,
        appVersion: VERSION,
        source,
        eventId,
        occurredAt: turn.ended_at,
        entrypoint: 'worker',
        hostContext: {
          host_agent: 'codex',
          host_agent_source: 'mcp_client_info',
          mcp_client_name: 'codex-mcp-client',
          ...(version ? { mcp_client_version: version } : {}),
        },
        deviceTimezone: tz.device_timezone,
        utcOffsetMinutes: tz.utc_offset_minutes,
      }),
    },
  };
}

async function postBatchChunk(
  directory: string,
  endpoint: PosthogEndpoint,
  batch: unknown[],
  options: { fetch?: typeof fetch; timeoutMs?: number; allowInTest?: boolean; env?: NodeJS.ProcessEnv },
): Promise<'accepted' | 'retry' | 'drop'> {
  const controller = new AbortController();
  let set = inflightAborts.get(directory);
  if (!set) {
    set = new Set();
    inflightAborts.set(directory, set);
  }
  set.add(controller);

  try {
    return await postPosthogBatch({
      endpoint,
      batch,
      signal: controller.signal,
      maxBytes: MAX_BATCH_BYTES,
      timeoutMs: options.timeoutMs ?? 2500,
      fetch: options.fetch,
      isEnabled: () => isCodexTrackingAllowed(directory, options.allowInTest, options.env),
    });
  } finally {
    set.delete(controller);
    if (!set.size) inflightAborts.delete(directory);
  }
}

async function deliverEventsInChunks(
  directory: string,
  endpoint: PosthogEndpoint,
  items: Array<{ ordinal: number; payload: ReturnType<typeof buildAiGenerationEvent> }>,
  options: { fetch?: typeof fetch; timeoutMs?: number; allowInTest?: boolean; env?: NodeJS.ProcessEnv },
): Promise<{ lastAcceptedOrdinal: number | null; status: 'accepted' | 'retry' | 'aborted' }> {
  let lastAcceptedOrdinal: number | null = null;
  let index = 0;

  while (index < items.length) {
    if (!isCodexTrackingAllowed(directory, options.allowInTest, options.env)) {
      return { lastAcceptedOrdinal, status: 'aborted' };
    }
    const chunk: unknown[] = [];
    let chunkLastOrdinal = items[index]!.ordinal;
    while (index < items.length) {
      const candidate = items[index]!;
      const tentative = [...chunk, candidate.payload];
      const tentativeBytes = Buffer.byteLength(JSON.stringify({ api_key: endpoint.token, batch: tentative }));
      if (tentativeBytes > MAX_BATCH_BYTES) {
        if (chunk.length === 0) {
          // Compact oversized tool_calls if a single turn ever exceeds MAX_BATCH_BYTES.
          const compactPayload = structuredClone(candidate.payload);
          const choices = compactPayload.properties.$ai_output_choices as Array<Record<string, unknown>>;
          if (choices[0]?.tool_calls && Array.isArray(choices[0].tool_calls)) {
            choices[0].tool_calls = (choices[0].tool_calls as Array<Record<string, unknown>>).slice(0, 20).map(call => ({
              id: call.id,
              type: call.type,
              function: { name: (call.function as Record<string, unknown>)?.name, arguments: '' },
              status: call.status,
              ...(call.error_code ? { error_code: call.error_code } : {}),
            }));
          }
          chunk.push(compactPayload);
          chunkLastOrdinal = candidate.ordinal;
          index += 1;
        }
        break;
      }
      chunk.push(candidate.payload);
      chunkLastOrdinal = candidate.ordinal;
      index += 1;
    }

    const receipt = await postBatchChunk(directory, endpoint, chunk, options);
    if (receipt === 'retry') {
      return { lastAcceptedOrdinal, status: 'retry' };
    }
    if (!isCodexTrackingAllowed(directory, options.allowInTest, options.env)) {
      return { lastAcceptedOrdinal, status: 'aborted' };
    }
    // Advance cursor on both 'accepted' and permanent 4xx 'drop' so poison payloads never loop endlessly.
    lastAcceptedOrdinal = chunkLastOrdinal;
  }

  return { lastAcceptedOrdinal, status: 'accepted' };
}

export async function syncActiveCodexThreads(
  directory: string,
  options: CodexSyncOptions = {},
): Promise<{ syncedTurns: number; activeThreads: number }> {
  const existingRun = activeSyncPromises.get(directory);
  if (existingRun) return existingRun;

  const work = (async () => {
    const env = options.environment ?? process.env;
    if (!isCodexTrackingAllowed(directory, options.allowInTest, env)) {
      if (trackingLocked() || !trackingPreference(directory)) await discardActiveCodexThreads(directory);
      return { syncedTurns: 0, activeThreads: 0 };
    }
    if (!existsSync(activeThreadsPath(directory))) return { syncedTurns: 0, activeThreads: 0 };

    const endpoint = resolvePosthogConfig(env);
    if (!endpoint) return { syncedTurns: 0, activeThreads: 0 };

    const snapshotMap = await withProcessLock(activeThreadsLockPath(directory), () => readActiveThreadsUnlocked(directory), 5000).catch(() => ({}));
    const entries = Object.values(snapshotMap);
    if (!entries.length) return { syncedTurns: 0, activeThreads: 0 };

    const trackingDir = path.join(directory, 'tracking');
    const identity = await loadIdentity(trackingDir);
    const device = await loadDeviceIdentity().catch(() => unknownDevice);
    let source = identity.utm_source;
    try {
      source = JSON.parse(readFileSync(path.join(trackingDir, 'identity.json'), 'utf8')).utm_source ?? null;
    } catch { /* retain identity.utm_source */ }

    const now = options.now ?? Date.now();
    const idleSealMs = options.idleSealMs ?? DEFAULT_IDLE_SEAL_MS;
    let syncedTurns = 0;

    type ThreadOutcome = {
      lastSyncedOrdinal: number;
      lastUpdatedAtMs: number;
      projectIds: string[];
      skillsActivated: string[];
      hasCompletedExport: boolean;
      failures: number;
      seal: boolean;
    };
    const outcomes = new Map<string, ThreadOutcome>();

    for (const entry of entries) {
      if (!isCodexTrackingAllowed(directory, options.allowInTest, env)) {
        await discardActiveCodexThreads(directory);
        return { syncedTurns, activeThreads: 0 };
      }

      const snapshot = readCodexThreadSnapshot(entry.codexHome, entry.threadId, entry.lastSyncedOrdinal, {
        environment: env,
        turnModels: entry.turnModels,
      });
      if (!snapshot) {
        const idleMs = now - Math.max(entry.lastSeenAt, entry.lastUpdatedAtMs);
        const failures = entry.failures + 1;
        outcomes.set(entry.threadId, {
          lastSyncedOrdinal: entry.lastSyncedOrdinal,
          lastUpdatedAtMs: entry.lastUpdatedAtMs,
          projectIds: entry.projectIds,
          skillsActivated: entry.skillsActivated,
          hasCompletedExport: entry.hasCompletedExport,
          failures,
          seal: idleMs >= idleSealMs || failures >= MAX_CONSECUTIVE_FAILURES,
        });
        continue;
      }

      let runningProjects = [...entry.projectIds];
      let runningSkills = [...entry.skillsActivated];
      let runningExport = entry.hasCompletedExport;
      const eventItems: Array<{
        ordinal: number;
        projectsAfter: string[];
        skillsAfter: string[];
        exportAfter: boolean;
        payload: ReturnType<typeof buildAiGenerationEvent>;
      }> = [];

      for (const turn of snapshot.turns) {
        runningProjects = mergeBoundedStrings(runningProjects, turn.project_ids);
        runningSkills = mergeBoundedStrings(runningSkills, turn.skills_activated);
        runningExport = runningExport || turn.has_completed_export;
        eventItems.push({
          ordinal: turn.rollout_ordinal,
          projectsAfter: runningProjects,
          skillsAfter: runningSkills,
          exportAfter: runningExport,
          payload: buildAiGenerationEvent({
            identity,
            device,
            endpoint,
            source,
            snapshot,
            turn,
            projectIds: runningProjects,
            skillsActivated: runningSkills,
            hasCompletedExport: runningExport,
            hostVersion: entry.hostVersion,
            fallbackModel: entry.lastKnownModel,
          }),
        });
      }

      let nextOrdinal = entry.lastSyncedOrdinal;
      let committedProjects = [...entry.projectIds];
      let committedSkills = [...entry.skillsActivated];
      let committedExport = entry.hasCompletedExport;
      let failures = 0;
      let retryNeeded = false;

      if (eventItems.length > 0) {
        const delivery = await deliverEventsInChunks(directory, endpoint, eventItems, {
          fetch: options.fetch,
          timeoutMs: options.timeoutMs,
          allowInTest: options.allowInTest,
          env,
        });
        if (delivery.status === 'aborted') {
          await discardActiveCodexThreads(directory);
          return { syncedTurns, activeThreads: 0 };
        }
        if (delivery.lastAcceptedOrdinal !== null) {
          const acceptedItems = eventItems.filter(item => item.ordinal <= delivery.lastAcceptedOrdinal!);
          syncedTurns += acceptedItems.length;
          nextOrdinal = delivery.lastAcceptedOrdinal;
          const lastAccepted = acceptedItems[acceptedItems.length - 1];
          if (lastAccepted) {
            committedProjects = lastAccepted.projectsAfter;
            committedSkills = lastAccepted.skillsAfter;
            committedExport = lastAccepted.exportAfter;
          }
        }
        if (delivery.status === 'retry') {
          failures = delivery.lastAcceptedOrdinal !== null ? 1 : entry.failures + 1;
          retryNeeded = true;
        }
      }

      const lastUpdatedAtMs = Math.max(entry.lastUpdatedAtMs, snapshot.updatedAtMs);
      const lastActivityMs = Math.max(entry.lastSeenAt, lastUpdatedAtMs);
      // Evict unconditionally after MAX_CONSECUTIVE_FAILURES; otherwise keep queued while draining pages or within idle window.
      const hasMorePending = snapshot.turns.length >= MAX_TURNS_PER_SYNC;
      const seal = failures >= MAX_CONSECUTIVE_FAILURES
        || (!retryNeeded && !hasMorePending && now - lastActivityMs >= idleSealMs);

      outcomes.set(entry.threadId, {
        lastSyncedOrdinal: nextOrdinal,
        lastUpdatedAtMs,
        projectIds: committedProjects,
        skillsActivated: committedSkills,
        hasCompletedExport: committedExport,
        failures,
        seal,
      });
    }

    let remainingCount = 0;
    if (isCodexTrackingAllowed(directory, options.allowInTest, env)) {
      await withProcessLock(activeThreadsLockPath(directory), async () => {
        if (!isCodexTrackingAllowed(directory, options.allowInTest, env)) {
          await rm(activeThreadsPath(directory), { force: true });
          return;
        }
        const current = await readActiveThreadsUnlocked(directory);
        for (const [threadId, outcome] of outcomes) {
          const live = current[threadId];
          if (!live) continue;
          const newerActivityArrived = live.lastSeenAt > (snapshotMap[threadId]?.lastSeenAt ?? 0);
          if (outcome.seal && !newerActivityArrived) {
            delete current[threadId];
            continue;
          }
          current[threadId] = {
            ...live,
            lastSyncedOrdinal: Math.max(live.lastSyncedOrdinal, outcome.lastSyncedOrdinal),
            lastUpdatedAtMs: Math.max(live.lastUpdatedAtMs, outcome.lastUpdatedAtMs),
            projectIds: mergeBoundedStrings(live.projectIds, outcome.projectIds),
            skillsActivated: mergeBoundedStrings(live.skillsActivated, outcome.skillsActivated),
            hasCompletedExport: live.hasCompletedExport || outcome.hasCompletedExport,
            failures: outcome.failures,
          };
        }
        remainingCount = Object.keys(current).length;
        await writeActiveThreadsUnlocked(directory, current);
      }, 5000).catch(() => {});
    }

    return { syncedTurns, activeThreads: remainingCount };
  })();

  activeSyncPromises.set(directory, work);
  try {
    return await work;
  } finally {
    activeSyncPromises.delete(directory);
  }
}

export async function flushCodexSessionTracking(directory: string, timeoutMs = 2000): Promise<void> {
  const timer = syncTimers.get(directory);
  if (timer) {
    clearTimeout(timer);
    syncTimers.delete(directory);
  }
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      syncActiveCodexThreads(directory).catch(() => {}),
      new Promise<void>(resolve => { guard = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (guard) clearTimeout(guard);
  }
}
