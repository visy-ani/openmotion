export const TRIGGERS_API = '/motion-api/triggers';
export const TRIGGER_TOKEN_PREFIX = 'om_trg_';

export type TriggerKind = 'webhook' | 'schedule' | 'manual';

export type TriggerTarget =
  | {
      kind: 'mcp-tool';
      tool: string;
      arguments: Record<string, unknown>;
    }
  | {
      kind: 'content-batch';
      batchInput: Record<string, unknown>;
    }
  | {
      kind: 'super-agent';
      prompt: string;
      runtimeId?: string;
      engine?: string;
      model?: string;
      reasoning?: string;
    };

export type TriggerSummary = {
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
  webhookPath?: string;
  tokenPrefix?: string;
  createdAt: number;
  updatedAt: number;
};

export type TriggerRunRecord = {
  id: string;
  triggerId: string;
  source: 'webhook' | 'schedule' | 'manual' | 'mcp';
  state: 'running' | 'completed' | 'failed';
  startedAt: number;
  finishedAt?: number;
  outputSummary?: string;
  output?: unknown;
  error?: string;
};

export const triggerCommands = ['list', 'get', 'create', 'update', 'delete', 'fire', 'runs'] as const;
export type TriggerCommand = typeof triggerCommands[number];

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' };

const triggerTargetSchema = {
  oneOf: [
    obj(
      {
        kind: { enum: ['mcp-tool'] },
        tool: { type: 'string', pattern: '^openmotion_[a-z0-9_]{1,80}$' },
        arguments: { type: 'object', additionalProperties: true },
      },
      ['kind', 'tool', 'arguments'],
    ),
    obj(
      {
        kind: { enum: ['content-batch'] },
        batchInput: { type: 'object', additionalProperties: true },
      },
      ['kind', 'batchInput'],
    ),
    obj(
      {
        kind: { enum: ['super-agent'] },
        prompt: { type: 'string', minLength: 1, maxLength: 12000 },
        runtimeId: { type: 'string', minLength: 1, maxLength: 120 },
        engine: { type: 'string', minLength: 1, maxLength: 80 },
        model: { type: 'string', minLength: 1, maxLength: 300 },
        reasoning: { type: 'string', minLength: 1, maxLength: 40 },
      },
      ['kind', 'prompt'],
    ),
  ],
};

const commandRequirements: Record<TriggerCommand, { required: string[] }> = {
  list: { required: ['command'] },
  get: { required: ['command', 'triggerId'] },
  create: { required: ['command', 'name', 'kind', 'target'] },
  update: { required: ['command', 'triggerId'] },
  delete: { required: ['command', 'triggerId'] },
  fire: { required: ['command', 'triggerId'] },
  runs: { required: ['command'] },
};

export const triggerToolArguments = {
  type: 'object',
  properties: {
    command: { enum: [...triggerCommands] },
    triggerId: uuid,
    requestId: { type: 'string', pattern: '^[\\w-]{1,100}$' },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    kind: { enum: ['webhook', 'schedule', 'manual'] },
    enabled: { type: 'boolean' },
    intervalSeconds: { type: 'integer', minimum: 60, maximum: 604800 },
    target: triggerTargetSchema,
    payload: { type: 'object', additionalProperties: true },
    wait: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  required: ['command'],
  oneOf: triggerCommands.map(command => ({
    type: 'object',
    properties: { command: { enum: [command] } },
    required: commandRequirements[command].required,
    additionalProperties: true,
  })),
};

export const triggerToolDescription =
  ' action=trigger manages automated webhook, interval-schedule, and manual triggers (list, get, create, update, delete, fire, runs) that invoke an OpenMotion MCP tool, a Batch Content Optimization job, or a Super Agent run.';
