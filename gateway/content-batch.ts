import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, jsonFile } from '../phase1-versions.ts';
import { zip } from '../scripts/zip.mjs';
import {
  BATCH_LIMITS,
  BATCH_RECIPES,
  CONTENT_BATCH_API,
  resolveBatchTemplate,
  type BatchCounts,
  type BatchItemOutputRef,
  type BatchItemRecord,
  type BatchMode,
  type BatchPipelineStep,
  type ContentBatchBundleReceipt,
  type ContentBatchCreateInput,
  type ContentBatchJob,
  type ContentBatchSummary,
} from '../shared/content-batch.ts';
import { withProcessLock } from '../shared/process-lock.ts';
import { phase1Tools } from '../shared/phase1-tools.ts';
import type { WorkspaceStore } from '../workspace.ts';

const TOOLS_WITH_TOP_LEVEL_REQUEST_ID = new Set<string>(
  phase1Tools
    .filter(tool => Boolean((tool.inputSchema as { properties?: Record<string, unknown> })?.properties?.requestId))
    .map(tool => tool.name),
);

export type BatchExecutionHost = {
  callMcpTool: (tool: string, args: Record<string, unknown>) => Promise<any>;
  runAgentOptimization: (
    batch: ContentBatchJob,
    item: BatchItemRecord,
    signal: AbortSignal,
  ) => Promise<{ chatId: string; summary?: string; outputs?: BatchItemOutputRef[] }>;
};

const UUID_RE = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const REQUEST_ID_RE = /^[\w-]{1,100}$/;

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`INVALID_ARGUMENT: Invalid ${label}`);
  }
  return value;
}

function clampConcurrency(raw: unknown, mode: BatchMode): number {
  const max = mode === 'agent-optimize' ? BATCH_LIMITS.maxAgentConcurrency : BATCH_LIMITS.maxConcurrency;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return Math.min(BATCH_LIMITS.defaultConcurrency, max);
  }
  return Math.max(1, Math.min(max, Math.floor(raw)));
}

function computeCounts(items: readonly BatchItemRecord[]): BatchCounts {
  const counts: BatchCounts = {
    total: items.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  };
  for (const item of items) {
    counts[item.state] += 1;
  }
  return counts;
}

function summarizeBatch(job: ContentBatchJob): ContentBatchSummary {
  return {
    id: job.id,
    title: job.title,
    mode: job.mode,
    ...(job.recipeId ? { recipeId: job.recipeId } : {}),
    state: job.state,
    concurrency: job.concurrency,
    counts: job.counts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.startedAt !== undefined ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
  };
}

function derivedBatchRequestId(batchId: string, itemId: string, stepId: string, attempt: number): string {
  const raw = `batch-${batchId.slice(0, 8)}-${itemId.slice(0, 8)}-${stepId}-a${attempt}`.replace(/[^A-Za-z0-9_-]/g, '-');
  if (raw.length <= 100 && REQUEST_ID_RE.test(raw)) return raw;
  return `bt-${sha256Hex(`${batchId}:${itemId}:${stepId}:${attempt}`).slice(0, 48)}`;
}

function extractStepOutputs(tool: string, result: any): BatchItemOutputRef[] {
  if (!result || typeof result !== 'object') return [];
  const refs: BatchItemOutputRef[] = [];
  if (result.project?.id && tool.startsWith('openmotion_design_')) {
    refs.push({
      kind: 'design-project',
      id: String(result.project.id),
      revision: typeof result.project.revision === 'string' ? result.project.revision : undefined,
      title: typeof result.project.title === 'string' ? result.project.title : undefined,
      url: typeof result.previewUrl === 'string' ? result.previewUrl : undefined,
    });
  } else if (typeof result.projectId === 'string' && tool.startsWith('openmotion_design_')) {
    refs.push({
      kind: 'design-project',
      id: result.projectId,
      revision: typeof result.revision === 'string' ? result.revision : undefined,
      url: typeof result.previewUrl === 'string' ? result.previewUrl : undefined,
    });
  } else if (typeof result.projectId === 'string') {
    refs.push({
      kind: 'motion-project',
      id: result.projectId,
      versionId: typeof result.currentVersionId === 'string' ? result.currentVersionId : result.version?.versionId,
      revision: typeof result.revision === 'string' ? result.revision : undefined,
      title: typeof result.title === 'string' ? result.title : result.project?.title,
      url: typeof result.previewUrl === 'string' ? result.previewUrl : undefined,
    });
  }
  if (result.run?.id) {
    refs.push({
      kind: 'scenario-run',
      runId: String(result.run.id),
      title: typeof result.run.title === 'string' ? result.run.title : undefined,
    });
  }
  if (result.bundle?.downloadUrl) {
    refs.push({
      kind: 'bundle',
      id: String(result.bundle.bundleId ?? ''),
      downloadUrl: String(result.bundle.downloadUrl),
    });
  }
  if (result.asset?.id) {
    refs.push({
      kind: 'asset',
      id: String(result.asset.id),
      versionId: typeof result.asset.currentVersionId === 'string' ? result.asset.currentVersionId : undefined,
      title: typeof result.asset.name === 'string' ? result.asset.name : undefined,
    });
  }
  return refs;
}

function mergeOutputs(existing: BatchItemOutputRef[], additions: BatchItemOutputRef[]): BatchItemOutputRef[] {
  const merged = [...existing];
  for (const next of additions) {
    const idx = merged.findIndex(
      prev => prev.kind === next.kind && ((next.id && prev.id === next.id) || (next.runId && prev.runId === next.runId)),
    );
    if (idx >= 0) merged[idx] = { ...merged[idx], ...next };
    else merged.push(next);
  }
  return merged;
}

export class ContentBatchService {
  readonly directory: string;
  readonly root: string;
  readonly lockPath: string;
  private activeControllers = new Map<string, AbortController>();
  private activeExecutions = new Map<string, Promise<ContentBatchJob>>();

  constructor(directory: string) {
    this.directory = directory;
    this.root = path.join(directory, 'content-batches');
    this.lockPath = path.join(this.root, '.lock');
  }

  private jobFile(id: string): string {
    return path.join(this.root, `${id}.json`);
  }

  private indexFile(): string {
    return path.join(this.root, 'index.json');
  }

  bundleFile(bundleId: string): string {
    const safeId = validateUuid(bundleId, 'bundleId');
    return path.join(this.root, 'bundles', `${safeId}.zip`);
  }

  private async readIndex(): Promise<{ requestMap: Record<string, string>; summaries: ContentBatchSummary[] }> {
    const raw = await jsonFile<Partial<{ requestMap: Record<string, string>; summaries: ContentBatchSummary[] }>>(
      this.indexFile(),
      { requestMap: {}, summaries: [] },
    );
    return {
      requestMap: raw.requestMap && typeof raw.requestMap === 'object' ? raw.requestMap : {},
      summaries: Array.isArray(raw.summaries) ? raw.summaries : [],
    };
  }

  private async saveJobLocked(job: ContentBatchJob): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    job.counts = computeCounts(job.items);
    job.updatedAt = Date.now();
    await atomicJson(this.jobFile(job.id), job);
    const index = await this.readIndex();
    const summary = summarizeBatch(job);
    const filtered = index.summaries.filter(item => item.id !== job.id);
    filtered.unshift(summary);
    if (job.requestId) {
      index.requestMap[job.requestId] = job.id;
    }
    await atomicJson(this.indexFile(), {
      requestMap: index.requestMap,
      summaries: filtered.slice(0, BATCH_LIMITS.maxBatchesListed),
    });
  }

  private async loadJob(id: string): Promise<ContentBatchJob> {
    const validId = validateUuid(id, 'batchId');
    const job = await jsonFile<ContentBatchJob | null>(this.jobFile(validId), null);
    if (!job) throw new Error('BATCH_NOT_FOUND: Batch job does not exist');
    return job;
  }

  catalog() {
    return {
      recipes: BATCH_RECIPES,
      limits: BATCH_LIMITS,
    };
  }

  async list(limit = 30): Promise<{ batches: ContentBatchSummary[]; total: number }> {
    const index = await this.readIndex();
    const bounded = Math.max(1, Math.min(BATCH_LIMITS.maxBatchesListed, Math.floor(limit)));
    return {
      batches: index.summaries.slice(0, bounded),
      total: index.summaries.length,
    };
  }

  async get(id: string): Promise<ContentBatchJob> {
    return this.loadJob(id);
  }

  async create(
    input: ContentBatchCreateInput,
    host?: BatchExecutionHost,
  ): Promise<{ batch: ContentBatchJob; replayed?: boolean }> {
    if (!input || typeof input !== 'object') {
      throw new Error('INVALID_ARGUMENT: Batch input object required');
    }
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 160) : '';
    if (!title) throw new Error('INVALID_ARGUMENT: Batch title is required');
    if (!['mcp-pipeline', 'agent-optimize', 'scenario-matrix'].includes(input.mode)) {
      throw new Error('INVALID_ARGUMENT: Unsupported batch mode');
    }
    if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > BATCH_LIMITS.maxItems) {
      throw new Error(`INVALID_ARGUMENT: Batch requires 1..${BATCH_LIMITS.maxItems} items`);
    }
    if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !REQUEST_ID_RE.test(input.requestId))) {
      throw new Error('INVALID_ARGUMENT: Invalid requestId');
    }

    const recipe = input.recipeId ? BATCH_RECIPES.find(item => item.id === input.recipeId) : undefined;
    const pipeline: BatchPipelineStep[] = Array.isArray(input.pipeline)
      ? input.pipeline
      : recipe?.pipeline
        ? structuredClone(recipe.pipeline)
        : [];
    if (input.mode === 'mcp-pipeline') {
      if (!pipeline.length || pipeline.length > BATCH_LIMITS.maxSteps) {
        throw new Error(`INVALID_ARGUMENT: mcp-pipeline requires 1..${BATCH_LIMITS.maxSteps} steps`);
      }
      for (const step of pipeline) {
        if (!step?.id || !step?.tool || typeof step.tool !== 'string' || !step.tool.startsWith('openmotion_')) {
          throw new Error(`INVALID_ARGUMENT: Invalid pipeline step tool "${String(step?.tool)}"`);
        }
        if (step.tool === 'openmotion_assets_use' && step.arguments?.action === 'batch') {
          throw new Error('INVALID_ARGUMENT: Recursive batch invocation inside pipeline is forbidden');
        }
      }
    }

    const created = await withProcessLock(this.lockPath, async () => {
      if (input.requestId) {
        const index = await this.readIndex();
        const existingId = index.requestMap[input.requestId];
        if (existingId) {
          const existing = await jsonFile<ContentBatchJob | null>(this.jobFile(existingId), null);
          if (existing) return { batch: existing, replayed: true };
        }
      }

      const now = Date.now();
      const items: BatchItemRecord[] = input.items.map((item, idx) => {
        const label = typeof item?.label === 'string' ? item.label.trim().slice(0, BATCH_LIMITS.maxLabelChars) : '';
        if (!label) throw new Error(`INVALID_ARGUMENT: Item ${idx + 1} label is required`);
        return {
          id: typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 80) : `item-${idx + 1}`,
          index: idx,
          label,
          ...(item.target ? { target: item.target } : {}),
          variables: item.variables && typeof item.variables === 'object' ? structuredClone(item.variables) : {},
          ...(typeof item.prompt === 'string' && item.prompt.trim()
            ? { prompt: item.prompt.trim().slice(0, BATCH_LIMITS.maxPromptChars) }
            : {}),
          ...(Array.isArray(item.criteria) ? { criteria: item.criteria.map(c => String(c).slice(0, 400)) } : {}),
          state: 'pending',
          attempts: 0,
          stepOutputs: {},
          outputs: [],
        };
      });

      const job: ContentBatchJob = {
        schemaVersion: 1,
        id: randomUUID(),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        title,
        ...(typeof input.description === 'string' && input.description.trim()
          ? { description: input.description.trim().slice(0, 1000) }
          : {}),
        mode: input.mode,
        ...(recipe ? { recipeId: recipe.id } : input.recipeId ? { recipeId: input.recipeId } : {}),
        state: 'draft',
        concurrency: clampConcurrency(input.concurrency ?? recipe?.defaultConcurrency, input.mode),
        sharedVariables:
          input.sharedVariables && typeof input.sharedVariables === 'object'
            ? structuredClone(input.sharedVariables)
            : {},
        pipeline,
        ...(input.promptTemplate
          ? { promptTemplate: input.promptTemplate.slice(0, BATCH_LIMITS.maxPromptChars) }
          : recipe?.promptTemplate
            ? { promptTemplate: recipe.promptTemplate }
            : {}),
        criteria: Array.isArray(input.criteria)
          ? input.criteria.map(c => String(c).slice(0, 400))
          : recipe?.criteria
            ? [...recipe.criteria]
            : [],
        ...(input.agentConfig ? { agentConfig: structuredClone(input.agentConfig) } : {}),
        ...(input.scenarioConfig
          ? { scenarioConfig: structuredClone(input.scenarioConfig) }
          : recipe?.scenarioConfig
            ? { scenarioConfig: structuredClone(recipe.scenarioConfig) }
            : {}),
        items,
        counts: computeCounts(items),
        createdAt: now,
        updatedAt: now,
      };
      await this.saveJobLocked(job);
      return { batch: job, replayed: false };
    });

    if (input.autoStart && !created.replayed && host) {
      const started = await this.start(created.batch.id, host, { wait: input.wait === true });
      return { batch: started, replayed: false };
    }
    return created;
  }

  async start(
    id: string,
    host: BatchExecutionHost,
    options: { wait?: boolean; onlyFailed?: boolean } = {},
  ): Promise<ContentBatchJob> {
    const validId = validateUuid(id, 'batchId');
    const existingRun = this.activeExecutions.get(validId);
    if (existingRun) {
      return options.wait ? existingRun : this.loadJob(validId);
    }

    const controller = new AbortController();
    const initial = await withProcessLock(this.lockPath, async () => {
      const job = await this.loadJob(validId);
      if (job.state === 'running') return job;
      if (options.onlyFailed) {
        let resetAny = false;
        for (const item of job.items) {
          if (item.state === 'failed' || item.state === 'cancelled') {
            item.state = 'pending';
            item.error = undefined;
            resetAny = true;
          }
        }
        if (!resetAny) return job;
      } else {
        for (const item of job.items) {
          if (item.state === 'running') item.state = 'pending';
        }
      }
      if (!job.items.some(item => item.state === 'pending')) {
        return job;
      }
      job.state = 'running';
      job.startedAt ??= Date.now();
      job.finishedAt = undefined;
      job.error = undefined;
      await this.saveJobLocked(job);
      return job;
    });

    if (initial.state !== 'running') {
      return initial;
    }

    this.activeControllers.set(validId, controller);
    const execution = this.runPool(validId, host, controller.signal).finally(() => {
      this.activeControllers.delete(validId);
      if (this.activeExecutions.get(validId) === execution) {
        this.activeExecutions.delete(validId);
      }
    });
    this.activeExecutions.set(validId, execution);

    if (options.wait) {
      return execution;
    }
    return initial;
  }

  async retryFailed(
    id: string,
    host: BatchExecutionHost,
    options: { wait?: boolean } = {},
  ): Promise<ContentBatchJob> {
    return this.start(id, host, { ...options, onlyFailed: true });
  }

  private async updateItemState(
    batchId: string,
    itemId: string,
    updater: (item: BatchItemRecord, job: ContentBatchJob) => void,
  ): Promise<void> {
    await withProcessLock(this.lockPath, async () => {
      const job = await this.loadJob(batchId);
      const target = job.items.find(item => item.id === itemId);
      if (!target) return;
      updater(target, job);
      await this.saveJobLocked(job);
    });
  }

  private async runPool(
    batchId: string,
    host: BatchExecutionHost,
    signal: AbortSignal,
  ): Promise<ContentBatchJob> {
    const jobSnapshot = await this.loadJob(batchId);
    const pendingItems = jobSnapshot.items.filter(item => item.state === 'pending');
    let cursor = 0;

    const executeOne = async (itemSnapshot: BatchItemRecord): Promise<void> => {
      if (signal.aborted) return;
      const attempt = itemSnapshot.attempts + 1;
      const startedAt = Date.now();
      await this.updateItemState(batchId, itemSnapshot.id, item => {
        item.state = 'running';
        item.attempts = attempt;
        item.startedAt = startedAt;
        item.finishedAt = undefined;
        item.error = undefined;
      });

      const stepOutputs: Record<string, unknown> = { ...itemSnapshot.stepOutputs };
      let outputs: BatchItemOutputRef[] = [...itemSnapshot.outputs];
      let assistantSummary: string | undefined = itemSnapshot.assistantSummary;
      let chatId: string | undefined = itemSnapshot.chatId;

      try {
        if (jobSnapshot.mode === 'mcp-pipeline') {
          for (const step of jobSnapshot.pipeline) {
            if (signal.aborted) throw new Error('Batch job cancelled');
            const stepRequestId = derivedBatchRequestId(batchId, itemSnapshot.id, step.id, attempt);
            const context = {
              item: itemSnapshot,
              shared: jobSnapshot.sharedVariables,
              steps: stepOutputs,
              batch: { id: jobSnapshot.id, title: jobSnapshot.title },
              batchRequestId: stepRequestId,
            };
            const resolvedArgs = resolveBatchTemplate(step.arguments, context);
            if (resolvedArgs.requestId === undefined && TOOLS_WITH_TOP_LEVEL_REQUEST_ID.has(step.tool)) {
              resolvedArgs.requestId = stepRequestId;
            }
            try {
              const stepResult = await host.callMcpTool(step.tool, resolvedArgs);
              stepOutputs[step.id] = stepResult;
              outputs = mergeOutputs(outputs, extractStepOutputs(step.tool, stepResult));
            } catch (err) {
              if (step.optional) {
                stepOutputs[step.id] = { skipped: true, error: err instanceof Error ? err.message : String(err) };
              } else {
                throw err;
              }
            }
          }
        } else if (jobSnapshot.mode === 'scenario-matrix') {
          const scenarioId = jobSnapshot.scenarioConfig?.scenarioId || 'motion-full-chain';
          const created = await host.callMcpTool('openmotion_assets_use', {
            action: 'scenario',
            scenario: {
              command: 'create',
              scenarioId,
              title: itemSnapshot.label,
              ...(jobSnapshot.scenarioConfig?.locale ? { locale: jobSnapshot.scenarioConfig.locale } : {}),
              requestId: derivedBatchRequestId(batchId, itemSnapshot.id, 'sc-create', attempt),
            },
          });
          stepOutputs.create = created;
          outputs = mergeOutputs(outputs, extractStepOutputs('openmotion_assets_use', created));
          let runRevision = created.run.revision as number;
          const runId = String(created.run.id);

          const briefValues: Record<string, string> = {};
          for (const [k, v] of Object.entries({ ...jobSnapshot.sharedVariables, ...itemSnapshot.variables })) {
            if (v !== undefined && v !== null) briefValues[k] = String(v);
          }
          if (itemSnapshot.prompt) briefValues.prompt = itemSnapshot.prompt;
          if (Object.keys(briefValues).length > 0) {
            const briefed = await host.callMcpTool('openmotion_assets_use', {
              action: 'scenario',
              scenario: {
                command: 'update_brief',
                runId,
                expectedRevision: runRevision,
                brief: briefValues,
                requestId: derivedBatchRequestId(batchId, itemSnapshot.id, 'sc-brief', attempt),
              },
            });
            stepOutputs.brief = briefed;
            runRevision = briefed.run.revision;
          }

          if (jobSnapshot.scenarioConfig?.createPage) {
            const paged = await host.callMcpTool('openmotion_assets_use', {
              action: 'scenario',
              scenario: {
                command: 'create_page',
                runId,
                expectedRevision: runRevision,
                requestId: derivedBatchRequestId(batchId, itemSnapshot.id, 'sc-page', attempt),
              },
            });
            stepOutputs.create_page = paged;
            runRevision = paged.run?.revision ?? runRevision;
          }

          if (jobSnapshot.scenarioConfig?.autoExport) {
            const exported = await host.callMcpTool('openmotion_assets_use', {
              action: 'scenario',
              scenario: {
                command: 'export',
                runId,
                requestId: derivedBatchRequestId(batchId, itemSnapshot.id, 'sc-export', attempt),
              },
            });
            stepOutputs.export = exported;
            outputs = mergeOutputs(outputs, extractStepOutputs('openmotion_assets_use', exported));
          }
        } else {
          const agentOutcome = await host.runAgentOptimization(jobSnapshot, itemSnapshot, signal);
          chatId = agentOutcome.chatId;
          assistantSummary = agentOutcome.summary;
          stepOutputs.agent = { chatId, summary: assistantSummary };
          if (agentOutcome.outputs?.length) {
            outputs = mergeOutputs(outputs, agentOutcome.outputs);
          }
        }

        const finishedAt = Date.now();
        await this.updateItemState(batchId, itemSnapshot.id, item => {
          item.state = 'completed';
          item.finishedAt = finishedAt;
          item.durationMs = Math.max(0, finishedAt - startedAt);
          item.stepOutputs = stepOutputs;
          item.outputs = outputs;
          if (assistantSummary !== undefined) item.assistantSummary = assistantSummary;
          if (chatId !== undefined) item.chatId = chatId;
        });
      } catch (err) {
        const finishedAt = Date.now();
        const cancelled = signal.aborted;
        const message = err instanceof Error ? err.message : String(err);
        await this.updateItemState(batchId, itemSnapshot.id, item => {
          item.state = cancelled ? 'cancelled' : 'failed';
          item.finishedAt = finishedAt;
          item.durationMs = Math.max(0, finishedAt - startedAt);
          item.error = cancelled ? 'Cancelled' : message.slice(0, 2000);
          item.stepOutputs = stepOutputs;
          item.outputs = outputs;
          if (assistantSummary !== undefined) item.assistantSummary = assistantSummary;
          if (chatId !== undefined) item.chatId = chatId;
        });
      }
    };

    const workerCount = Math.min(jobSnapshot.concurrency, Math.max(1, pendingItems.length));
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (!signal.aborted) {
          const nextIdx = cursor++;
          if (nextIdx >= pendingItems.length) break;
          await executeOne(pendingItems[nextIdx]);
        }
      }),
    );

    return withProcessLock(this.lockPath, async () => {
      const finalJob = await this.loadJob(batchId);
      if (signal.aborted) {
        for (const item of finalJob.items) {
          if (item.state === 'pending' || item.state === 'running') {
            item.state = 'cancelled';
            item.finishedAt = Date.now();
          }
        }
      }
      const counts = computeCounts(finalJob.items);
      if (signal.aborted && counts.completed === 0) {
        finalJob.state = 'cancelled';
      } else if (counts.failed === 0 && counts.cancelled === 0 && counts.pending === 0) {
        finalJob.state = 'completed';
      } else if (counts.completed > 0) {
        finalJob.state = 'partial';
      } else {
        finalJob.state = 'failed';
      }
      finalJob.finishedAt = Date.now();
      await this.saveJobLocked(finalJob);
      return finalJob;
    });
  }

  async cancel(id: string): Promise<ContentBatchJob> {
    const validId = validateUuid(id, 'batchId');
    const controller = this.activeControllers.get(validId);
    if (controller) {
      controller.abort();
      const running = this.activeExecutions.get(validId);
      if (running) await running.catch(() => {});
      return this.loadJob(validId);
    }

    return withProcessLock(this.lockPath, async () => {
      const job = await this.loadJob(validId);
      if (job.state === 'draft' || job.state === 'running') {
        for (const item of job.items) {
          if (item.state === 'pending' || item.state === 'running') {
            item.state = 'cancelled';
          }
        }
        job.state = 'cancelled';
        job.finishedAt = Date.now();
        await this.saveJobLocked(job);
      }
      return job;
    });
  }

  async exportBundle(id: string): Promise<ContentBatchBundleReceipt> {
    const job = await this.loadJob(id);
    const bundleId = randomUUID();
    const filename = `openmotion-batch-${job.id.slice(0, 8)}.zip`;
    const archivePath = this.bundleFile(bundleId);
    await mkdir(path.dirname(archivePath), { recursive: true, mode: 0o700 });

    const summaryLines = [
      `# ${job.title}`,
      '',
      `- Batch ID: \`${job.id}\``,
      `- Mode: \`${job.mode}\``,
      `- Status: \`${job.state}\``,
      `- Completed: ${job.counts.completed}/${job.counts.total}`,
      '',
      '## Items',
      ...job.items.map(
        item =>
          `- [${item.state}] ${item.label}${item.error ? ` — ${item.error}` : ''}${
            item.outputs.length ? ` (${item.outputs.map(o => `${o.kind}:${o.id ?? o.runId ?? o.url ?? ''}`).join(', ')})` : ''
          }`,
      ),
    ];

    const entries: { name: string; data: Buffer }[] = [
      {
        name: 'manifest.json',
        data: Buffer.from(JSON.stringify(job, null, 2)),
      },
      {
        name: 'summary.md',
        data: Buffer.from(summaryLines.join('\n') + '\n'),
      },
      ...job.items.map((item, idx) => {
        const slug = item.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || `item-${idx + 1}`;
        return {
          name: `items/${String(idx + 1).padStart(2, '0')}-${slug}.json`,
          data: Buffer.from(JSON.stringify(item, null, 2)),
        };
      }),
    ];

    const archive = zip(entries);
    await writeFile(archivePath, archive, { mode: 0o600 });
    return {
      bundleId,
      batchId: job.id,
      filename,
      bytes: archive.length,
      sha256: sha256Hex(archive),
      archivePath,
      downloadUrl: `${CONTENT_BATCH_API}/bundles/${bundleId}/file`,
      entries: entries.length,
    };
  }

  async close(): Promise<void> {
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    await Promise.allSettled([...this.activeExecutions.values()]);
    this.activeControllers.clear();
    this.activeExecutions.clear();
    for (const [key, inst] of services) {
      if (inst === this) services.delete(key);
    }
  }
}

const services = new Map<string, ContentBatchService>();
export function contentBatchesFor(store: WorkspaceStore): ContentBatchService {
  const root = store.workspaceStore ?? store;
  const key = path.resolve(root.directory);
  let service = services.get(key);
  if (!service) {
    service = new ContentBatchService(key);
    services.set(key, service);
  }
  return service;
}

export async function contentBatchOperation(
  service: ContentBatchService,
  input: Record<string, any>,
  host: BatchExecutionHost,
) {
  const command = String(input?.command || '');
  switch (command) {
    case 'catalog':
      return service.catalog();
    case 'list':
      return service.list(typeof input.limit === 'number' ? input.limit : 30);
    case 'get':
      return { batch: await service.get(input.batchId) };
    case 'create':
      return service.create(input as unknown as ContentBatchCreateInput, host);
    case 'start':
      return { batch: await service.start(input.batchId, host, { wait: input.wait === true }) };
    case 'cancel':
      return { batch: await service.cancel(input.batchId) };
    case 'retry_failed':
      return { batch: await service.retryFailed(input.batchId, host, { wait: input.wait === true }) };
    case 'export':
      return { bundle: await service.exportBundle(input.batchId) };
    default:
      throw new Error(`INVALID_ARGUMENT: Unknown batch command "${command}"`);
  }
}
