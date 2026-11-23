import type { LocalAgent } from './local-agents.ts';
import type {
  SuperAgentArtifact,
  SuperAgentFileOperation,
  SuperAgentPermissionMode,
  SuperAgentPlanEntry,
  SuperAgentToolCategory,
  SuperAgentTurnActivity,
  SuperAgentUsage,
} from './super-agent.ts';

export const AGENT_RUNTIMES_API = '/motion-api/agent-runtimes';
export const AGENT_SERVICE_PROTOCOL = 'openmotion-agent-v1';
export const BRIDGE_SCRIPT_VERSION = '1.0.0';
export const LOCAL_DIRECT_RUNTIME_ID = 'local';
export const RUNNABLE_LOCAL_AGENT_IDS = ['codex', 'claude'] as const;

export type DeploymentMode = 'local' | 'cloud' | 'hybrid';
export type AgentRuntimeKind = 'local-direct' | 'local-bridge' | 'remote-service';
export type AgentRuntimeStatus = 'online' | 'offline' | 'degraded' | 'disabled';
export type RemoteServiceAuthType = 'none' | 'bearer' | 'api-key';

export type AgentRuntimeInfo = {
  id: string;
  kind: AgentRuntimeKind;
  name: string;
  status: AgentRuntimeStatus;
  platform?: string;
  arch?: string;
  hostname?: string;
  bridgeVersion?: string;
  endpoint?: string;
  authType?: RemoteServiceAuthType;
  headerName?: string;
  hasCredentials?: boolean;
  protocol?: string;
  enabled?: boolean;
  tokenId?: string;
  lastSeenAt?: string;
  createdAt?: string;
  error?: string;
  agents: LocalAgent[];
  runnableAgentIds: string[];
};

export type BridgeTokenSummary = {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  runtimeId?: string;
  revoked?: boolean;
};

export type BridgeSetupBundle = {
  tokenId: string;
  label: string;
  token: string;
  serverUrl: string;
  scriptUrl: string;
  installScriptUrl: string;
  installPs1Url?: string;
  curlCommand: string;
  powershellCommand?: string;
  nodeCommand: string;
  localCommand: string;
};

export type AgentRuntimeDirectory = {
  deploymentMode: DeploymentMode;
  publicOrigin: string;
  localDirectAvailable: boolean;
  runtimes: AgentRuntimeInfo[];
  tokens: BridgeTokenSummary[];
  defaultRuntimeId: string | null;
};

export type CustomAgentServiceInput = {
  name: string;
  endpoint: string;
  authType: RemoteServiceAuthType;
  apiKey?: string;
  headerName?: string;
  enabled?: boolean;
};

export type AgentServiceProbeResult = {
  ok: boolean;
  protocol?: string;
  version?: string;
  agents: LocalAgent[];
  error?: string;
};

export type AgentDynamicToolDef = {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AgentRunDispatch = {
  runId: string;
  chatId: string;
  engine: string;
  model?: string;
  reasoning?: string;
  threadId?: string;
  workingDir?: string;
  prompt: string;
  instructions: string;
  claudeInstructions?: string;
  dynamicTools: AgentDynamicToolDef[];
  permissionMode: SuperAgentPermissionMode;
};

export type AgentRunEvent =
  | { type: 'thread.started'; threadId: string }
  | { type: 'status.update'; phase: SuperAgentTurnActivity['phase']; label?: string; activeToolName?: string }
  | { type: 'reasoning.delta'; messageId?: string; delta: string }
  | { type: 'reasoning.complete'; messageId?: string; text: string; durationMs?: number }
  | { type: 'plan.update'; entries: SuperAgentPlanEntry[] }
  | { type: 'usage.update'; usage: SuperAgentUsage }
  | { type: 'message.delta'; messageId?: string; delta: string }
  | { type: 'message.complete'; messageId?: string; text: string }
  | {
      type: 'tool.started';
      callId: string;
      tool: string;
      args?: Record<string, unknown>;
      category?: SuperAgentToolCategory;
      title?: string;
      command?: string;
      fileOp?: SuperAgentFileOperation;
      files?: SuperAgentFileOperation[];
    }
  | {
      type: 'tool.finished';
      callId: string;
      tool: string;
      args?: Record<string, unknown>;
      ok: boolean;
      output?: unknown;
      summary?: string;
      category?: SuperAgentToolCategory;
      title?: string;
      command?: string;
      exitCode?: number;
      fileOp?: SuperAgentFileOperation;
      files?: SuperAgentFileOperation[];
      durationMs?: number;
    }
  | { type: 'artifact.upsert'; artifact: Partial<SuperAgentArtifact> }
  | { type: 'turn.completed' }
  | { type: 'turn.failed'; error: string };

export type AgentToolCallRequest = {
  runId: string;
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
};

export type AgentToolCallResponse = {
  ok: boolean;
  contentItems?: { type: string; text?: string; imageUrl?: string }[];
  structuredContent?: unknown;
  error?: string;
};

export function isBridgeRuntimeId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith('bridge:') && id.length > 7 && id.length <= 120;
}

export function isServiceRuntimeId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith('service:') && id.length > 8 && id.length <= 120;
}

export function normalizeRuntimeLabel(value: unknown, fallback = 'Local Machine'): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\r\n\t\0]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || fallback;
}
