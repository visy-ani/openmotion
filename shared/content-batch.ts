export const CONTENT_BATCH_API = '/motion-api/content-batches';

export const BATCH_LIMITS = {
  maxItems: 50,
  maxSteps: 12,
  maxConcurrency: 8,
  defaultConcurrency: 2,
  maxAgentConcurrency: 4,
  maxLabelChars: 160,
  maxPromptChars: 12_000,
  maxBatchesListed: 100,
} as const;

export type BatchMode = 'mcp-pipeline' | 'agent-optimize' | 'scenario-matrix';
export type BatchItemState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';
export type BatchRunState = 'draft' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export type BatchItemTargetKind =
  | 'motion-project'
  | 'design-project'
  | 'game-project'
  | 'asset'
  | 'scenario'
  | 'brief';

export type BatchItemTarget = {
  kind: BatchItemTargetKind;
  id?: string;
  versionId?: string;
};

export type BatchPipelineStep = {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  optional?: boolean;
};

export type BatchContentItemInput = {
  id?: string;
  label: string;
  target?: BatchItemTarget;
  variables?: Record<string, unknown>;
  prompt?: string;
  criteria?: string[];
};

export type BatchItemOutputRef = {
  kind: string;
  id?: string;
  versionId?: string;
  revision?: string;
  title?: string;
  url?: string;
  downloadUrl?: string;
  chatId?: string;
  runId?: string;
};

export type BatchItemRecord = {
  id: string;
  index: number;
  label: string;
  target?: BatchItemTarget;
  variables: Record<string, unknown>;
  prompt?: string;
  criteria?: string[];
  state: BatchItemState;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
  stepOutputs: Record<string, unknown>;
  outputs: BatchItemOutputRef[];
  assistantSummary?: string;
  chatId?: string;
};

export type BatchAgentConfig = {
  runtimeId?: string;
  engine?: string;
  model?: string;
  reasoning?: string;
  permissionMode?: 'auto' | 'on-request';
};

export type BatchScenarioConfig = {
  scenarioId: string;
  locale?: string;
  createPage?: boolean;
  createMotion?: boolean;
  autoExport?: boolean;
};

export type BatchCounts = {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
};

export type ContentBatchJob = {
  schemaVersion: 1;
  id: string;
  requestId?: string;
  title: string;
  description?: string;
  mode: BatchMode;
  recipeId?: string;
  state: BatchRunState;
  concurrency: number;
  sharedVariables: Record<string, unknown>;
  pipeline: BatchPipelineStep[];
  promptTemplate?: string;
  criteria: string[];
  agentConfig?: BatchAgentConfig;
  scenarioConfig?: BatchScenarioConfig;
  items: BatchItemRecord[];
  counts: BatchCounts;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
};

export type ContentBatchSummary = Pick<
  ContentBatchJob,
  'id' | 'title' | 'mode' | 'recipeId' | 'state' | 'concurrency' | 'counts' | 'createdAt' | 'updatedAt' | 'startedAt' | 'finishedAt'
>;

export type ContentBatchCreateInput = {
  requestId?: string;
  title: string;
  description?: string;
  mode: BatchMode;
  recipeId?: string;
  concurrency?: number;
  sharedVariables?: Record<string, unknown>;
  pipeline?: BatchPipelineStep[];
  promptTemplate?: string;
  criteria?: string[];
  agentConfig?: BatchAgentConfig;
  scenarioConfig?: BatchScenarioConfig;
  items: BatchContentItemInput[];
  autoStart?: boolean;
  wait?: boolean;
};

export type ContentBatchBundleReceipt = {
  bundleId: string;
  batchId: string;
  filename: string;
  bytes: number;
  sha256: string;
  archivePath: string;
  downloadUrl: string;
  entries: number;
};

export type BatchRecipeDefinition = {
  id: string;
  title: string;
  description: string;
  mode: BatchMode;
  defaultConcurrency: number;
  criteria: string[];
  pipeline?: BatchPipelineStep[];
  promptTemplate?: string;
  scenarioConfig?: BatchScenarioConfig;
  sampleItems: BatchContentItemInput[];
};

export const BATCH_RECIPES: readonly BatchRecipeDefinition[] = [
  {
    id: 'motion-multi-ratio',
    title: 'Multi-ratio Motion adaptation',
    description: 'Duplicate a Motion project and adapt compositions across 16:9, 9:16, and 1:1 canvases via MCP.',
    mode: 'mcp-pipeline',
    defaultConcurrency: 2,
    criteria: ['Preserve core visual hierarchy and typography readability', 'Keep timeline duration and audio sync intact'],
    pipeline: [
      {
        id: 'duplicate',
        tool: 'openmotion_manage_project',
        arguments: {
          action: 'duplicate',
          projectId: '{{shared.sourceProjectId}}',
          title: '{{item.label}}',
        },
      },
      {
        id: 'inspect',
        tool: 'openmotion_get_project',
        arguments: {
          projectId: '{{steps.duplicate.projectId}}',
        },
      },
      {
        id: 'canvas',
        tool: 'openmotion_edit_project',
        arguments: {
          projectId: '{{steps.duplicate.projectId}}',
          expectedRevision: '{{steps.inspect.revision}}',
          expectedVersionId: '{{steps.inspect.currentVersionId}}',
          canvas: {
            compositionPath: '{{shared.compositionPath}}',
            ratio: '{{item.variables.ratio}}',
            fit: '{{item.variables.fit}}',
          },
          summary: 'Batch adapt canvas to {{item.variables.ratio}}',
        },
      },
    ],
    sampleItems: [
      { label: 'Landscape 16:9 Master', variables: { ratio: '16:9', fit: 'contain' } },
      { label: 'Vertical 9:16 Reels', variables: { ratio: '9:16', fit: 'cover' } },
      { label: 'Square 1:1 Feed', variables: { ratio: '1:1', fit: 'contain' } },
    ],
  },
  {
    id: 'design-variant-matrix',
    title: 'Design Studio multi-variant pages',
    description: 'Generate localized or audience-tailored Design Studio HTML projects in parallel using MCP tools.',
    mode: 'mcp-pipeline',
    defaultConcurrency: 3,
    criteria: ['Consistent brand tokens', 'Responsive viewport fidelity'],
    pipeline: [
      {
        id: 'create',
        tool: 'openmotion_design_project',
        arguments: {
          action: 'create',
          scenario: '{{item.variables.scenario}}',
          title: '{{item.label}}',
          brief: '{{item.prompt}}',
        },
      },
    ],
    sampleItems: [
      { label: 'Developer Launch Page (EN)', prompt: 'Create a high-contrast developer launch page.', variables: { scenario: 'prototype' } },
      { label: 'Enterprise Briefing Deck (ZH)', prompt: 'Create a 10-slide enterprise briefing deck.', variables: { scenario: 'deck' } },
    ],
  },
  {
    id: 'agent-content-polish',
    title: 'Agent-driven batch content optimization',
    description: 'Dispatch items through Super Agent (local CLI, bridge, or remote service) to inspect, refine, and present artifacts.',
    mode: 'agent-optimize',
    defaultConcurrency: 2,
    criteria: [
      'Audit existing project structure and visual hierarchy',
      'Apply targeted improvements via OpenMotion MCP tools',
      'Present the updated artifact for review',
    ],
    promptTemplate:
      'Optimize "{{item.label}}" according to the criteria below. Inspect the target first via OpenMotion MCP tools, commit a revision-checked update, and present the resulting artifact.',
    sampleItems: [
      { label: 'Hero Copy & Motion Polish', criteria: ['Tighten headline to <= 7 words', 'Smooth ease-out reveal timing'] },
      { label: 'Mobile Contrast & Spacing Pass', criteria: ['Ensure WCAG AA contrast', 'Verify 390px layout spacing'] },
    ],
  },
  {
    id: 'campaign-scenario-batch',
    title: 'Multi-product Scenario Workflow matrix',
    description: 'Create and seed Scenario Workflow runs across multiple SKUs, campaigns, or locales.',
    mode: 'scenario-matrix',
    defaultConcurrency: 2,
    criteria: ['Complete brief binding', 'Seed starter landing page deliverable'],
    scenarioConfig: {
      scenarioId: 'motion-full-chain',
      createPage: true,
    },
    sampleItems: [
      { label: 'Spring Launch - US', variables: { product: 'OpenMotion Pro', audience: 'Motion Designers', tone: 'Crisp & technical' } },
      { label: 'Spring Launch - JP', variables: { product: 'OpenMotion Pro', audience: 'クリエイター', tone: '丁寧で洗練された表現' } },
    ],
  },
];

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function lookupPath(root: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split('.').map(part => part.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  let current: unknown = root;
  for (const part of parts) {
    if (FORBIDDEN_PATH_SEGMENTS.has(part)) return undefined;
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    if (!Object.hasOwn(current as object, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function resolveBatchTemplate<T = unknown>(
  value: T,
  context: Record<string, unknown>,
): T {
  if (typeof value === 'string') {
    const exactMatch = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/.exec(value);
    if (exactMatch) {
      const resolved = lookupPath(context, exactMatch[1]);
      return (resolved !== undefined ? resolved : value) as T;
    }
    return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, expr: string) => {
      const resolved = lookupPath(context, expr);
      if (resolved === undefined || resolved === null) return '';
      if (typeof resolved === 'object') return JSON.stringify(resolved);
      return String(resolved);
    }) as T;
  }
  if (Array.isArray(value)) {
    return value.map(item => resolveBatchTemplate(item, context)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_PATH_SEGMENTS.has(k)) continue;
      out[k] = resolveBatchTemplate(v, context);
    }
    return out as T;
  }
  return value;
}

export const batchCommands = [
  'catalog',
  'list',
  'get',
  'create',
  'start',
  'cancel',
  'retry_failed',
  'export',
] as const;
export type BatchCommand = typeof batchCommands[number];

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' };
const requestIdSchema = { type: 'string', pattern: '^[\\w-]{1,100}$' };

const batchItemInputSchema = obj(
  {
    id: { type: 'string', minLength: 1, maxLength: 80 },
    label: { type: 'string', minLength: 1, maxLength: BATCH_LIMITS.maxLabelChars },
    target: obj(
      {
        kind: { enum: ['motion-project', 'design-project', 'game-project', 'asset', 'scenario', 'brief'] },
        id: { type: 'string', minLength: 1, maxLength: 128 },
        versionId: { type: 'string', minLength: 1, maxLength: 128 },
      },
      ['kind'],
    ),
    variables: { type: 'object', additionalProperties: true },
    prompt: { type: 'string', minLength: 1, maxLength: BATCH_LIMITS.maxPromptChars },
    criteria: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 400 } },
  },
  ['label'],
);

const pipelineStepSchema = obj(
  {
    id: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' },
    tool: { type: 'string', pattern: '^openmotion_[a-z0-9_]{1,80}$' },
    arguments: { type: 'object', additionalProperties: true },
    optional: { type: 'boolean' },
  },
  ['id', 'tool', 'arguments'],
);

const commandRequirements: Record<BatchCommand, { required: string[] }> = {
  catalog: { required: ['command'] },
  list: { required: ['command'] },
  get: { required: ['command', 'batchId'] },
  create: { required: ['command', 'title', 'mode', 'items'] },
  start: { required: ['command', 'batchId'] },
  cancel: { required: ['command', 'batchId'] },
  retry_failed: { required: ['command', 'batchId'] },
  export: { required: ['command', 'batchId'] },
};

export const batchToolArguments = {
  type: 'object',
  properties: {
    command: { enum: [...batchCommands] },
    batchId: uuid,
    requestId: requestIdSchema,
    title: { type: 'string', minLength: 1, maxLength: 160 },
    description: { type: 'string', maxLength: 1000 },
    mode: { enum: ['mcp-pipeline', 'agent-optimize', 'scenario-matrix'] },
    recipeId: { type: 'string', minLength: 1, maxLength: 80 },
    concurrency: { type: 'integer', minimum: 1, maximum: BATCH_LIMITS.maxConcurrency },
    sharedVariables: { type: 'object', additionalProperties: true },
    pipeline: { type: 'array', minItems: 1, maxItems: BATCH_LIMITS.maxSteps, items: pipelineStepSchema },
    promptTemplate: { type: 'string', minLength: 1, maxLength: BATCH_LIMITS.maxPromptChars },
    criteria: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 400 } },
    agentConfig: obj({
      runtimeId: { type: 'string', minLength: 1, maxLength: 120 },
      engine: { type: 'string', minLength: 1, maxLength: 80 },
      model: { type: 'string', minLength: 1, maxLength: 300 },
      reasoning: { type: 'string', minLength: 1, maxLength: 40 },
      permissionMode: { enum: ['auto', 'on-request'] },
    }),
    scenarioConfig: obj(
      {
        scenarioId: { type: 'string', minLength: 1, maxLength: 80 },
        locale: { type: 'string', minLength: 2, maxLength: 35 },
        createPage: { type: 'boolean' },
        createMotion: { type: 'boolean' },
        autoExport: { type: 'boolean' },
      },
      ['scenarioId'],
    ),
    items: { type: 'array', minItems: 1, maxItems: BATCH_LIMITS.maxItems, items: batchItemInputSchema },
    autoStart: { type: 'boolean' },
    wait: { type: 'boolean' },
  },
  required: ['command'],
  oneOf: batchCommands.map(command => ({
    type: 'object',
    properties: { command: { enum: [command] } },
    required: commandRequirements[command].required,
    additionalProperties: true,
  })),
};

export const batchToolDescription =
  ' action=batch runs Batch Content Optimization (catalog, list, get, create, start, cancel, retry_failed, export) across mcp-pipeline, agent-optimize, and scenario-matrix modes so MCP clients and Super Agents can generate, adapt, and optimize up to 50 content variants in parallel.';
