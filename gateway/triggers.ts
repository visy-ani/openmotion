import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, jsonFile } from '../phase1-versions.ts';
import {
  resolveBatchTemplate,
  type ContentBatchCreateInput,
  type ContentBatchJob,
} from '../shared/content-batch.ts';
import { withProcessLock } from '../shared/process-lock.ts';
import {
  TRIGGER_TOKEN_PREFIX,
  TRIGGERS_API,
  type TriggerKind,
  type TriggerRunRecord,
  type TriggerSummary,
  type TriggerTarget,
} from '../shared/triggers.ts';
import type { WorkspaceStore } from '../workspace.ts';
import type { BatchExecutionHost, ContentBatchService } from './content-batch.ts';

const UUID_RE = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_TRIGGERS = 100;
const MAX_RUN_RECORDS = 200;

type StoredTrigger = {
  id: string;
  name: string;
  kind: TriggerKind;
  enabled: boolean;
  target: TriggerTarget;
  intervalSeconds?: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastRunState?: 'completed' | 'failed';
  runCount: number;
  secretHash?: string;
  tokenPrefix?: string;
  createdAt: number;
  updatedAt: number;
};

type StoredRegistry = {
  triggers: StoredTrigger[];
};

export type TriggerExecutionHost = BatchExecutionHost & {
  contentBatches: () => ContentBatchService;
  runSuperAgentTurn: (
    target: Extract<TriggerTarget, { kind: 'super-agent' }>,
    payload: Record<string, unknown>,
  ) => Promise<{ chatId: string; summary?: string }>;
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`INVALID_ARGUMENT: Invalid ${label}`);
  }
  return value;
}

function summarizeTrigger(trigger: StoredTrigger): TriggerSummary {
  return {
    id: trigger.id,
    name: trigger.name,
    kind: trigger.kind,
    enabled: trigger.enabled,
    target: trigger.target,
    ...(trigger.intervalSeconds !== undefined ? { intervalSeconds: trigger.intervalSeconds } : {}),
    ...(trigger.nextRunAt !== undefined ? { nextRunAt: trigger.nextRunAt } : {}),
    ...(trigger.lastRunAt !== undefined ? { lastRunAt: trigger.lastRunAt } : {}),
    ...(trigger.lastRunState !== undefined ? { lastRunState: trigger.lastRunState } : {}),
    runCount: trigger.runCount,
    ...(trigger.kind === 'webhook' ? { webhookPath: `${TRIGGERS_API}/${trigger.id}/fire` } : {}),
    ...(trigger.tokenPrefix ? { tokenPrefix: trigger.tokenPrefix } : {}),
    createdAt: trigger.createdAt,
    updatedAt: trigger.updatedAt,
  };
}

function validateTarget(target: unknown): TriggerTarget {
  if (!target || typeof target !== 'object') {
    throw new Error('INVALID_ARGUMENT: Trigger target is required');
  }
  const raw = target as Record<string, any>;
  if (raw.kind === 'mcp-tool') {
    if (typeof raw.tool !== 'string' || !/^openmotion_[a-z0-9_]{1,80}$/.test(raw.tool)) {
      throw new Error('INVALID_ARGUMENT: Invalid MCP tool name in trigger target');
    }
    if (raw.tool === 'openmotion_assets_use' && raw.arguments?.action === 'trigger') {
      throw new Error('INVALID_ARGUMENT: Recursive trigger invocation is forbidden');
    }
    return {
      kind: 'mcp-tool',
      tool: raw.tool,
      arguments: raw.arguments && typeof raw.arguments === 'object' ? structuredClone(raw.arguments) : {},
    };
  }
  if (raw.kind === 'content-batch') {
    if (!raw.batchInput || typeof raw.batchInput !== 'object') {
      throw new Error('INVALID_ARGUMENT: content-batch target requires batchInput');
    }
    return {
      kind: 'content-batch',
      batchInput: structuredClone(raw.batchInput),
    };
  }
  if (raw.kind === 'super-agent') {
    if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > 12_000) {
      throw new Error('INVALID_ARGUMENT: super-agent target requires a prompt (<= 12000 chars)');
    }
    return {
      kind: 'super-agent',
      prompt: raw.prompt.trim(),
      ...(typeof raw.runtimeId === 'string' ? { runtimeId: raw.runtimeId } : {}),
      ...(typeof raw.engine === 'string' ? { engine: raw.engine } : {}),
      ...(typeof raw.model === 'string' ? { model: raw.model } : {}),
      ...(typeof raw.reasoning === 'string' ? { reasoning: raw.reasoning } : {}),
    };
  }
  throw new Error('INVALID_ARGUMENT: Unsupported trigger target kind');
}

export class TriggerService {
  readonly directory: string;
  readonly root: string;
  readonly registryFile: string;
  readonly runsFile: string;
  readonly lockPath: string;
  private runningTriggerIds = new Set<string>();
  private tickBusy = false;
  private closed = false;

  constructor(directory: string) {
    this.directory = directory;
    this.root = path.join(directory, 'triggers');
    this.registryFile = path.join(this.root, 'registry.json');
    this.runsFile = path.join(this.root, 'runs.json');
    this.lockPath = path.join(this.root, '.lock');
  }

  private async readRegistry(): Promise<StoredRegistry> {
    const raw = await jsonFile<Partial<StoredRegistry>>(this.registryFile, { triggers: [] });
    return {
      triggers: Array.isArray(raw.triggers) ? raw.triggers : [],
    };
  }

  private async saveRegistry(reg: StoredRegistry): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await atomicJson(this.registryFile, reg);
  }

  private async readRuns(): Promise<TriggerRunRecord[]> {
    const raw = await jsonFile<{ runs?: TriggerRunRecord[] }>(this.runsFile, { runs: [] });
    return Array.isArray(raw.runs) ? raw.runs : [];
  }

  private async appendRun(record: TriggerRunRecord): Promise<void> {
    await withProcessLock(this.lockPath, async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const runs = await this.readRuns();
      const idx = runs.findIndex(item => item.id === record.id);
      if (idx >= 0) runs[idx] = record;
      else runs.unshift(record);
      await atomicJson(this.runsFile, { runs: runs.slice(0, MAX_RUN_RECORDS) });
    });
  }

  async list(): Promise<{ triggers: TriggerSummary[] }> {
    const reg = await this.readRegistry();
    return { triggers: reg.triggers.map(summarizeTrigger) };
  }

  async get(id: string): Promise<TriggerSummary> {
    const validId = validateUuid(id, 'triggerId');
    const reg = await this.readRegistry();
    const found = reg.triggers.find(item => item.id === validId);
    if (!found) throw new Error('TRIGGER_NOT_FOUND: Trigger not found');
    return summarizeTrigger(found);
  }

  async runs(triggerId?: string, limit = 30): Promise<{ runs: TriggerRunRecord[] }> {
    const validFilter = triggerId !== undefined ? validateUuid(triggerId, 'triggerId') : undefined;
    const all = await this.readRuns();
    const filtered = validFilter ? all.filter(item => item.triggerId === validFilter) : all;
    return { runs: filtered.slice(0, Math.max(1, Math.min(100, Math.floor(limit)))) };
  }

  async create(input: {
    name: string;
    kind: TriggerKind;
    target: TriggerTarget;
    enabled?: boolean;
    intervalSeconds?: number;
  }): Promise<{ trigger: TriggerSummary; webhookSecret?: string }> {
    const name = typeof input?.name === 'string' ? input.name.trim().slice(0, 120) : '';
    if (!name) throw new Error('INVALID_ARGUMENT: Trigger name is required');
    if (!['webhook', 'schedule', 'manual'].includes(input?.kind)) {
      throw new Error('INVALID_ARGUMENT: Unsupported trigger kind');
    }
    const target = validateTarget(input.target);
    const enabled = input.enabled !== false;
    let intervalSeconds: number | undefined;
    if (input.kind === 'schedule') {
      const secs = Number(input.intervalSeconds ?? 300);
      if (!Number.isFinite(secs) || secs < 60 || secs > 604800) {
        throw new Error('INVALID_ARGUMENT: Schedule intervalSeconds must be between 60 and 604800');
      }
      intervalSeconds = Math.floor(secs);
    }

    let webhookSecret: string | undefined;
    let secretHash: string | undefined;
    let tokenPrefix: string | undefined;
    if (input.kind === 'webhook') {
      webhookSecret = `${TRIGGER_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
      secretHash = sha256Hex(webhookSecret);
      tokenPrefix = webhookSecret.slice(0, 14);
    }

    const now = Date.now();
    const stored: StoredTrigger = {
      id: randomUUID(),
      name,
      kind: input.kind,
      enabled,
      target,
      ...(intervalSeconds !== undefined ? { intervalSeconds, nextRunAt: now + intervalSeconds * 1000 } : {}),
      runCount: 0,
      ...(secretHash ? { secretHash, tokenPrefix } : {}),
      createdAt: now,
      updatedAt: now,
    };

    await withProcessLock(this.lockPath, async () => {
      const reg = await this.readRegistry();
      if (reg.triggers.length >= MAX_TRIGGERS) {
        throw new Error('LIMIT_EXCEEDED: Maximum number of triggers reached');
      }
      reg.triggers.unshift(stored);
      await this.saveRegistry(reg);
    });

    return {
      trigger: summarizeTrigger(stored),
      ...(webhookSecret ? { webhookSecret } : {}),
    };
  }

  async update(
    id: string,
    patch: { name?: string; enabled?: boolean; intervalSeconds?: number; target?: TriggerTarget },
  ): Promise<TriggerSummary> {
    const validId = validateUuid(id, 'triggerId');
    return withProcessLock(this.lockPath, async () => {
      const reg = await this.readRegistry();
      const target = reg.triggers.find(item => item.id === validId);
      if (!target) throw new Error('TRIGGER_NOT_FOUND: Trigger not found');
      if (patch.name !== undefined) {
        const trimmed = String(patch.name).trim().slice(0, 120);
        if (!trimmed) throw new Error('INVALID_ARGUMENT: Trigger name cannot be empty');
        target.name = trimmed;
      }
      if (patch.enabled !== undefined) target.enabled = Boolean(patch.enabled);
      if (patch.target !== undefined) target.target = validateTarget(patch.target);
      if (patch.intervalSeconds !== undefined && target.kind === 'schedule') {
        const secs = Number(patch.intervalSeconds);
        if (!Number.isFinite(secs) || secs < 60 || secs > 604800) {
          throw new Error('INVALID_ARGUMENT: intervalSeconds must be between 60 and 604800');
        }
        target.intervalSeconds = Math.floor(secs);
        target.nextRunAt = Date.now() + target.intervalSeconds * 1000;
      }
      target.updatedAt = Date.now();
      await this.saveRegistry(reg);
      return summarizeTrigger(target);
    });
  }

  async delete(id: string): Promise<{ deleted: true }> {
    const validId = validateUuid(id, 'triggerId');
    return withProcessLock(this.lockPath, async () => {
      const reg = await this.readRegistry();
      const before = reg.triggers.length;
      reg.triggers = reg.triggers.filter(item => item.id !== validId);
      if (reg.triggers.length === before) throw new Error('TRIGGER_NOT_FOUND: Trigger not found');
      await this.saveRegistry(reg);
      return { deleted: true };
    });
  }

  async authenticateWebhook(
    triggerId: string,
    headers: { authorization?: string; signature?: string },
    rawBody: string,
  ): Promise<TriggerSummary> {
    const validId = validateUuid(triggerId, 'triggerId');
    const reg = await this.readRegistry();
    const trigger = reg.triggers.find(item => item.id === validId);
    if (!trigger) throw new Error('TRIGGER_NOT_FOUND: Trigger not found');
    if (trigger.kind !== 'webhook') throw new Error('INVALID_ARGUMENT: Trigger is not a webhook');
    if (!trigger.enabled) throw new Error('TRIGGER_DISABLED: Trigger is disabled');
    if (!trigger.secretHash) throw new Error('Unauthorized webhook');

    const storedDigest = Buffer.from(trigger.secretHash, 'hex');
    const authMatch = typeof headers.authorization === 'string'
      ? headers.authorization.match(/^Bearer\s+([^\s]+)$/i)
      : null;
    if (authMatch?.[1]) {
      const candidate = Buffer.from(sha256Hex(authMatch[1].trim()), 'hex');
      if (candidate.length === storedDigest.length && timingSafeEqual(candidate, storedDigest)) {
        return summarizeTrigger(trigger);
      }
    }

    const sigMatch = typeof headers.signature === 'string'
      ? headers.signature.match(/^sha256=([a-f0-9]{64})$/i)
      : null;
    if (sigMatch?.[1]) {
      const expected = Buffer.from(
        createHmac('sha256', trigger.secretHash).update(rawBody, 'utf8').digest('hex'),
        'hex',
      );
      const actual = Buffer.from(sigMatch[1].toLowerCase(), 'hex');
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
        return summarizeTrigger(trigger);
      }
    }

    throw new Error('Unauthorized webhook');
  }

  async fire(
    id: string,
    payload: Record<string, unknown>,
    host: TriggerExecutionHost,
    source: TriggerRunRecord['source'] = 'manual',
    options: { wait?: boolean } = {},
  ): Promise<{ run: TriggerRunRecord }> {
    const validId = validateUuid(id, 'triggerId');
    const reg = await this.readRegistry();
    const trigger = reg.triggers.find(item => item.id === validId);
    if (!trigger) throw new Error('TRIGGER_NOT_FOUND: Trigger not found');
    if (!trigger.enabled) throw new Error('TRIGGER_DISABLED: Trigger is disabled');

    const startedAt = Date.now();
    const run: TriggerRunRecord = {
      id: randomUUID(),
      triggerId: trigger.id,
      source,
      state: 'running',
      startedAt,
    };
    await this.appendRun(run);
    this.runningTriggerIds.add(trigger.id);

    try {
      const context = { payload, trigger: { id: trigger.id, name: trigger.name } };
      let output: unknown;
      let outputSummary = 'Completed';

      if (trigger.target.kind === 'mcp-tool') {
        const resolvedArgs = resolveBatchTemplate(trigger.target.arguments, context);
        output = await host.callMcpTool(trigger.target.tool, resolvedArgs);
        outputSummary = `${trigger.target.tool} succeeded`;
      } else if (trigger.target.kind === 'content-batch') {
        const resolvedBatch = resolveBatchTemplate(trigger.target.batchInput, context) as ContentBatchCreateInput;
        const created = await host.contentBatches().create(
          {
            ...resolvedBatch,
            autoStart: true,
            wait: options.wait === true,
          },
          host,
        );
        const batch: ContentBatchJob = created.batch;
        output = { batchId: batch.id, state: batch.state, counts: batch.counts };
        outputSummary = `Batch ${batch.id} (${batch.state})`;
      } else {
        const resolvedPrompt = resolveBatchTemplate(trigger.target.prompt, context);
        const sa = await host.runSuperAgentTurn({ ...trigger.target, prompt: resolvedPrompt }, payload);
        output = sa;
        outputSummary = sa.summary ? sa.summary.slice(0, 200) : `Super Agent chat ${sa.chatId}`;
      }

      run.state = 'completed';
      run.finishedAt = Date.now();
      run.output = output;
      run.outputSummary = outputSummary;
      await this.appendRun(run);

      await withProcessLock(this.lockPath, async () => {
        const currentReg = await this.readRegistry();
        const stored = currentReg.triggers.find(item => item.id === validId);
        if (stored) {
          stored.lastRunAt = run.finishedAt;
          stored.lastRunState = 'completed';
          stored.runCount += 1;
          if (stored.kind === 'schedule' && stored.intervalSeconds) {
            stored.nextRunAt = Date.now() + stored.intervalSeconds * 1000;
          }
          stored.updatedAt = Date.now();
          await this.saveRegistry(currentReg);
        }
      });
      return { run };
    } catch (error) {
      run.state = 'failed';
      run.finishedAt = Date.now();
      run.error = error instanceof Error ? error.message : String(error);
      await this.appendRun(run);
      await withProcessLock(this.lockPath, async () => {
        const currentReg = await this.readRegistry();
        const stored = currentReg.triggers.find(item => item.id === validId);
        if (stored) {
          stored.lastRunAt = run.finishedAt;
          stored.lastRunState = 'failed';
          stored.runCount += 1;
          if (stored.kind === 'schedule' && stored.intervalSeconds) {
            stored.nextRunAt = Date.now() + stored.intervalSeconds * 1000;
          }
          stored.updatedAt = Date.now();
          await this.saveRegistry(currentReg);
        }
      });
      return { run };
    } finally {
      this.runningTriggerIds.delete(trigger.id);
    }
  }

  async tick(host: TriggerExecutionHost, now = Date.now()): Promise<number> {
    if (this.closed || this.tickBusy) return 0;
    this.tickBusy = true;
    let fired = 0;
    try {
      const reg = await this.readRegistry();
      for (const trigger of reg.triggers) {
        if (this.closed) break;
        if (
          trigger.kind === 'schedule'
          && trigger.enabled
          && trigger.intervalSeconds
          && (trigger.nextRunAt ?? 0) <= now
          && !this.runningTriggerIds.has(trigger.id)
        ) {
          await this.fire(trigger.id, { scheduledAt: now }, host, 'schedule');
          fired += 1;
        }
      }
      return fired;
    } finally {
      this.tickBusy = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [key, inst] of triggerServices) {
      if (inst === this) triggerServices.delete(key);
    }
  }
}

const triggerServices = new Map<string, TriggerService>();
export function triggersFor(store: WorkspaceStore): TriggerService {
  const root = store.workspaceStore ?? store;
  const key = path.resolve(root.directory);
  let service = triggerServices.get(key);
  if (!service) {
    service = new TriggerService(key);
    triggerServices.set(key, service);
  }
  return service;
}

export async function triggerOperation(
  service: TriggerService,
  input: Record<string, any>,
  host: TriggerExecutionHost,
) {
  const command = String(input?.command || '');
  switch (command) {
    case 'list':
      return service.list();
    case 'get':
      return { trigger: await service.get(input.triggerId) };
    case 'create':
      return service.create({
        name: input.name,
        kind: input.kind,
        target: input.target,
        enabled: input.enabled,
        intervalSeconds: input.intervalSeconds,
      });
    case 'update':
      return {
        trigger: await service.update(input.triggerId, {
          name: input.name,
          enabled: input.enabled,
          intervalSeconds: input.intervalSeconds,
          target: input.target,
        }),
      };
    case 'delete':
      return service.delete(input.triggerId);
    case 'fire':
      return service.fire(
        input.triggerId,
        input.payload && typeof input.payload === 'object' ? input.payload : {},
        host,
        'mcp',
        { wait: input.wait === true },
      );
    case 'runs':
      return service.runs(input.triggerId, typeof input.limit === 'number' ? input.limit : 30);
    default:
      throw new Error(`INVALID_ARGUMENT: Unknown trigger command "${command}"`);
  }
}
