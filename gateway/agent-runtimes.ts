import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import {
  AGENT_RUNTIMES_API,
  BRIDGE_SCRIPT_VERSION,
  LOCAL_DIRECT_RUNTIME_ID,
  isBridgeRuntimeId,
  isServiceRuntimeId,
  normalizeRuntimeLabel,
  type AgentRunDispatch,
  type AgentRunEvent,
  type AgentRuntimeDirectory,
  type AgentRuntimeInfo,
  type AgentRuntimeStatus,
  type AgentServiceProbeResult,
  type AgentToolCallRequest,
  type AgentToolCallResponse,
  type BridgeSetupBundle,
  type BridgeTokenSummary,
  type CustomAgentServiceInput,
  type DeploymentMode,
  type RemoteServiceAuthType,
} from '../shared/agent-runtimes.ts';
import { localAgents, type LocalAgent } from '../shared/local-agents.ts';
import { normalizeAgentModels } from './agent-discovery.ts';
import {
  probeRemoteAgentService,
  sanitizeServiceError,
  validateHeaderName,
  validateServiceEndpoint,
  type RemoteServiceConnectionConfig,
} from './agent-service-adapter.ts';
import { localAgentsFor } from './local-agents.ts';
import { readSettings, writeSettings } from './settings-storage.ts';

const BRIDGE_ONLINE_TTL_MS = 45_000;
const INSPECT_TIMEOUT_MS = 20_000;
const VALID_BRIDGE_TOKEN = /^om_brg_[a-f0-9]{16,128}$/;

type StoredBridgeToken = {
  id: string;
  label: string;
  prefix: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt?: string;
  runtimeId?: string;
  revoked?: boolean;
};

type StoredBridgeMachine = {
  id: string;
  tokenId: string;
  machineId: string;
  name: string;
  platform: string;
  arch: string;
  hostname?: string;
  bridgeVersion?: string;
  createdAt: string;
  lastSeenAt: string;
  agents: LocalAgent[];
};

type StoredAgentService = {
  id: string;
  name: string;
  endpoint: string;
  authType: RemoteServiceAuthType;
  headerName?: string;
  secret?: string;
  enabled: boolean;
  status: AgentRuntimeStatus;
  protocol?: string;
  createdAt: string;
  lastSeenAt?: string;
  error?: string;
  agents: LocalAgent[];
};

type StoredRuntimesState = {
  tokens: StoredBridgeToken[];
  bridges: StoredBridgeMachine[];
  services: StoredAgentService[];
  defaultRuntimeId: string | null;
};

type ActiveBridgeRun = {
  runId: string;
  chatId: string;
  runtimeId: string;
  tokenId: string;
  onEvent: (event: AgentRunEvent) => Promise<void> | void;
  onToolCall: (req: AgentToolCallRequest) => Promise<AgentToolCallResponse>;
  resolve: () => void;
  reject: (error: Error) => void;
};

function createEmptyState(): StoredRuntimesState {
  return {
    tokens: [],
    bridges: [],
    services: [],
    defaultRuntimeId: null,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function deploymentMode(env: NodeJS.ProcessEnv = process.env): DeploymentMode {
  const raw = env.MOTION_DEPLOYMENT_MODE?.trim().toLowerCase();
  if (raw === 'cloud' || raw === 'hybrid' || raw === 'local') return raw;
  return 'local';
}

export function isLocalDirectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return deploymentMode(env) !== 'cloud' && env.MOTION_DISABLE_LOCAL_DIRECT !== '1';
}

export function resolvePublicOrigin(fallbackOrigin: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MOTION_PUBLIC_ORIGIN?.trim();
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.origin;
      }
    } catch {
      /* ignore invalid override and fall back */
    }
  }
  return fallbackOrigin;
}

export function allowedHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  const extra = env.MOTION_ALLOWED_HOSTS?.trim();
  if (extra) {
    for (const part of extra.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        const parsed = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
        if (parsed.hostname) hosts.add(parsed.hostname.toLowerCase());
      } catch {
        hosts.add(trimmed.toLowerCase());
      }
    }
  }
  const publicRaw = env.MOTION_PUBLIC_ORIGIN?.trim();
  if (publicRaw) {
    try {
      const parsed = new URL(publicRaw);
      if (parsed.hostname) hosts.add(parsed.hostname.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return hosts;
}

export function isHostAllowed(hostHeader: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!hostHeader) return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return allowedHosts(env).has(hostname);
  } catch {
    return false;
  }
}

function sanitizeBridgeAgents(rawList: unknown): LocalAgent[] {
  if (!Array.isArray(rawList)) return [];
  const results: LocalAgent[] = [];
  const seen = new Set<string>();
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || seen.has(id) || !/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(id)) continue;
    seen.add(id);
    const known = localAgents.find(def => def.id === id);
    const auth = raw.auth === 'signed-in' || raw.auth === 'signed-out' ? raw.auth : 'unknown';
    results.push({
      id,
      label: known?.label ?? normalizeRuntimeLabel(raw.label, id),
      bin: known?.bin ?? (typeof raw.bin === 'string' ? raw.bin.slice(0, 64) : id),
      icon: known?.icon ?? (typeof raw.icon === 'string' && /^[a-z0-9-]+$/i.test(raw.icon) ? raw.icon : 'robot'),
      website: known?.website ?? '',
      ...(known?.loginHint ? { loginHint: known.loginHint } : {}),
      ...(known?.modelFlag ? { modelFlag: known.modelFlag } : typeof raw.modelFlag === 'string' && raw.modelFlag === '--model' ? { modelFlag: '--model' } : {}),
      installed: Boolean(raw.installed),
      auth,
      ...(typeof raw.version === 'string' ? { version: raw.version.slice(0, 60) } : {}),
      ...(typeof raw.checkedAt === 'string' ? { checkedAt: raw.checkedAt.slice(0, 60) } : {}),
      ...(typeof raw.discoveryError === 'string' ? { discoveryError: raw.discoveryError.slice(0, 240) } : {}),
      models: Array.isArray(raw.models) ? normalizeAgentModels(raw.models, 'cli') : [],
    });
    if (results.length >= 100) break;
  }
  return results;
}

function sanitizeSingleBridgeAgent(raw: unknown): LocalAgent | null {
  const list = sanitizeBridgeAgents(raw ? [raw] : []);
  return list[0] ?? null;
}

export class AgentRuntimeRegistry {
  readonly directoryPath: string;
  readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();
  private statePromise: Promise<StoredRuntimesState> | null = null;
  private bridgeStreams = new Map<string, Set<ServerResponse>>();
  private activeBridgeRuns = new Map<string, ActiveBridgeRun>();
  private pendingInspects = new Map<string, {
    runtimeId: string;
    tokenId: string;
    resolve: (agent: LocalAgent) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private lastTokenTouch = new Map<string, number>();

  constructor(directoryPath: string) {
    this.directoryPath = directoryPath;
    this.file = path.join(directoryPath, 'agents/runtimes.json');
  }

  private async loadState(): Promise<StoredRuntimesState> {
    if (!this.statePromise) {
      this.statePromise = readSettings<Partial<StoredRuntimesState>>(this.file, createEmptyState()).then(raw => ({
        tokens: Array.isArray(raw.tokens) ? structuredClone(raw.tokens) : [],
        bridges: Array.isArray(raw.bridges) ? structuredClone(raw.bridges) : [],
        services: Array.isArray(raw.services) ? structuredClone(raw.services) : [],
        defaultRuntimeId: typeof raw.defaultRuntimeId === 'string' ? raw.defaultRuntimeId : null,
      }));
    }
    return this.statePromise;
  }

  private mutate<T>(fn: (state: StoredRuntimesState) => Promise<T> | T): Promise<T> {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        const state = await this.loadState();
        const result = await fn(state);
        await writeSettings(this.file, state);
        return result;
      });
    this.queue = task.catch(() => {});
    return task;
  }

  private hasLiveBridgeStream(runtimeId: string): boolean {
    const set = this.bridgeStreams.get(runtimeId);
    if (!set) return false;
    for (const res of set) {
      if (!res.destroyed && res.writableEnded !== true) return true;
    }
    return false;
  }

  private isBridgeOnline(bridge: StoredBridgeMachine): boolean {
    if (this.hasLiveBridgeStream(bridge.id)) return true;
    const seen = Date.parse(bridge.lastSeenAt || '');
    return Number.isFinite(seen) && Date.now() - seen < BRIDGE_ONLINE_TTL_MS;
  }

  private pushBridgeSse(runtimeId: string, eventName: string, payload: unknown): boolean {
    const set = this.bridgeStreams.get(runtimeId);
    if (!set || !set.size) return false;
    const targets = [...set].filter(res => !res.destroyed && !res.writableEnded);
    const target = targets.at(-1);
    if (!target) return false;
    target.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  }

  private buildBridgeRuntimeInfo(bridge: StoredBridgeMachine): AgentRuntimeInfo {
    const online = this.isBridgeOnline(bridge);
    const runnableAgentIds = bridge.agents
      .filter(agent => agent.installed && agent.auth !== 'signed-out')
      .map(agent => agent.id);
    return {
      id: bridge.id,
      kind: 'local-bridge',
      name: bridge.name,
      status: online ? 'online' : 'offline',
      platform: bridge.platform,
      arch: bridge.arch,
      ...(bridge.hostname ? { hostname: bridge.hostname } : {}),
      ...(bridge.bridgeVersion ? { bridgeVersion: bridge.bridgeVersion } : {}),
      tokenId: bridge.tokenId,
      createdAt: bridge.createdAt,
      lastSeenAt: bridge.lastSeenAt,
      agents: bridge.agents,
      runnableAgentIds,
    };
  }

  private buildServiceRuntimeInfo(service: StoredAgentService): AgentRuntimeInfo {
    const status: AgentRuntimeStatus = service.enabled ? service.status : 'disabled';
    return {
      id: service.id,
      kind: 'remote-service',
      name: service.name,
      status,
      endpoint: service.endpoint,
      authType: service.authType,
      ...(service.authType === 'api-key' ? { headerName: service.headerName || 'X-API-Key' } : {}),
      hasCredentials: Boolean(service.secret),
      ...(service.protocol ? { protocol: service.protocol } : {}),
      enabled: service.enabled,
      createdAt: service.createdAt,
      ...(service.lastSeenAt ? { lastSeenAt: service.lastSeenAt } : {}),
      ...(service.error ? { error: service.error } : {}),
      agents: service.agents,
      runnableAgentIds: service.enabled
        ? service.agents.filter(a => a.installed && a.auth !== 'signed-out').map(a => a.id)
        : [],
    };
  }

  async directory(fallbackOrigin: string): Promise<AgentRuntimeDirectory> {
    const state = await this.loadState();
    const localDirectAvailable = isLocalDirectEnabled();
    const runtimes: AgentRuntimeInfo[] = [];

    if (localDirectAvailable) {
      const localList = await localAgentsFor(this.directoryPath).list();
      runtimes.push({
        id: LOCAL_DIRECT_RUNTIME_ID,
        kind: 'local-direct',
        name: 'This computer',
        status: 'online',
        platform: process.platform,
        arch: process.arch,
        agents: localList.agents,
        runnableAgentIds: localList.agents
          .filter(agent => agent.installed && agent.auth !== 'signed-out')
          .map(agent => agent.id),
      });
    }

    const revokedIds = new Set(state.tokens.filter(t => t.revoked).map(t => t.id));
    for (const bridge of state.bridges) {
      if (revokedIds.has(bridge.tokenId)) continue;
      runtimes.push(this.buildBridgeRuntimeInfo(bridge));
    }

    for (const service of state.services) {
      runtimes.push(this.buildServiceRuntimeInfo(service));
    }

    const tokens: BridgeTokenSummary[] = state.tokens
      .filter(token => !token.revoked)
      .map(token => ({
        id: token.id,
        label: token.label,
        prefix: token.prefix,
        createdAt: token.createdAt,
        ...(token.lastUsedAt ? { lastUsedAt: token.lastUsedAt } : {}),
        ...(token.runtimeId ? { runtimeId: token.runtimeId } : {}),
      }));

    return {
      deploymentMode: deploymentMode(),
      publicOrigin: resolvePublicOrigin(fallbackOrigin),
      localDirectAvailable,
      runtimes,
      tokens,
      defaultRuntimeId: state.defaultRuntimeId && runtimes.some(r => r.id === state.defaultRuntimeId)
        ? state.defaultRuntimeId
        : null,
    };
  }

  async getRuntimeInfo(id: string, fallbackOrigin = 'http://127.0.0.1'): Promise<AgentRuntimeInfo | null> {
    const dir = await this.directory(fallbackOrigin);
    return dir.runtimes.find(r => r.id === id) ?? null;
  }

  async getServiceConfig(id: string): Promise<RemoteServiceConnectionConfig & { id: string; name: string; enabled: boolean; agents: LocalAgent[] }> {
    const state = await this.loadState();
    const service = state.services.find(s => s.id === id);
    if (!service) throw new Error('Agent service not found');
    if (!service.enabled) throw new Error(`Agent service "${service.name}" is disabled`);
    return {
      id: service.id,
      name: service.name,
      endpoint: service.endpoint,
      authType: service.authType,
      headerName: service.headerName,
      secret: service.secret,
      enabled: service.enabled,
      agents: service.agents,
    };
  }

  async setDefaultRuntime(runtimeId: string | null): Promise<{ defaultRuntimeId: string | null }> {
    return this.mutate(state => {
      if (runtimeId === null || runtimeId === '') {
        state.defaultRuntimeId = null;
        return { defaultRuntimeId: null };
      }
      if (typeof runtimeId !== 'string') throw new Error('Invalid runtime ID');
      const exists =
        (runtimeId === LOCAL_DIRECT_RUNTIME_ID && isLocalDirectEnabled())
        || state.bridges.some(b => b.id === runtimeId)
        || state.services.some(s => s.id === runtimeId);
      if (!exists) throw new Error('Runtime not found');
      state.defaultRuntimeId = runtimeId;
      return { defaultRuntimeId: runtimeId };
    });
  }

  async createBridgeToken(label: unknown, fallbackOrigin: string): Promise<BridgeSetupBundle> {
    const safeLabel = normalizeRuntimeLabel(label, 'My Computer');
    const rawToken = `om_brg_${randomBytes(24).toString('hex')}`;
    const tokenId = randomUUID();
    const serverUrl = resolvePublicOrigin(fallbackOrigin);

    await this.mutate(state => {
      state.tokens.unshift({
        id: tokenId,
        label: safeLabel,
        prefix: rawToken.slice(0, 14),
        tokenHash: sha256Hex(rawToken),
        createdAt: new Date().toISOString(),
      });
      if (state.tokens.length > 100) {
        const active = state.tokens.filter(t => !t.revoked);
        const revoked = state.tokens.filter(t => t.revoked).slice(0, Math.max(0, 100 - active.length));
        state.tokens = [...active, ...revoked].slice(0, 100);
      }
    });

    const scriptUrl = `${serverUrl}${AGENT_RUNTIMES_API}/bridge/script`;
    const installScriptUrl = `${serverUrl}${AGENT_RUNTIMES_API}/bridge/install.sh?token=${rawToken}`;
    const installPs1Url = `${serverUrl}${AGENT_RUNTIMES_API}/bridge/install.ps1?token=${rawToken}`;
    const curlCommand = `curl -fsSL ${shellSingleQuote(installScriptUrl)} | bash`;
    const powershellCommand = `irm ${shellSingleQuote(installPs1Url)} | iex`;
    const nodeCommand = `curl -fsSL ${shellSingleQuote(scriptUrl)} -o openmotion-agent-bridge.mjs && node openmotion-agent-bridge.mjs --server ${shellSingleQuote(serverUrl)} --token ${shellSingleQuote(rawToken)} --name ${shellSingleQuote(safeLabel)}`;
    const localCommand = `node --experimental-strip-types gateway/agent-bridge.ts --server ${shellSingleQuote(serverUrl)} --token ${shellSingleQuote(rawToken)} --name ${shellSingleQuote(safeLabel)}`;

    return {
      tokenId,
      label: safeLabel,
      token: rawToken,
      serverUrl,
      scriptUrl,
      installScriptUrl,
      installPs1Url,
      curlCommand,
      powershellCommand,
      nodeCommand,
      localCommand,
    };
  }

  async revokeBridgeToken(tokenId: string): Promise<{ ok: boolean }> {
    let closedBridgeIds: string[] = [];
    await this.mutate(state => {
      const token = state.tokens.find(t => t.id === tokenId && !t.revoked);
      if (!token) throw new Error('Bridge token not found');
      token.revoked = true;
      closedBridgeIds = state.bridges.filter(b => b.tokenId === tokenId).map(b => b.id);
      state.bridges = state.bridges.filter(b => b.tokenId !== tokenId);
      if (state.defaultRuntimeId && closedBridgeIds.includes(state.defaultRuntimeId)) {
        state.defaultRuntimeId = null;
      }
    });

    for (const bridgeId of closedBridgeIds) {
      const streams = this.bridgeStreams.get(bridgeId);
      if (streams) {
        for (const res of streams) {
          if (!res.destroyed) res.end();
        }
        this.bridgeStreams.delete(bridgeId);
      }
    }
    for (const [runId, run] of this.activeBridgeRuns) {
      if (run.tokenId === tokenId || closedBridgeIds.includes(run.runtimeId)) {
        this.activeBridgeRuns.delete(runId);
        run.reject(new Error('Bridge token was revoked'));
      }
    }
    for (const [requestId, pending] of this.pendingInspects) {
      if (pending.tokenId === tokenId || closedBridgeIds.includes(pending.runtimeId)) {
        clearTimeout(pending.timer);
        this.pendingInspects.delete(requestId);
        pending.reject(new Error('Bridge token was revoked'));
      }
    }

    return { ok: true };
  }

  async authenticateBridgeToken(authHeaderOrRaw: string | undefined, isRaw = false): Promise<StoredBridgeToken> {
    let raw = '';
    if (isRaw) {
      raw = (authHeaderOrRaw ?? '').trim();
    } else if (typeof authHeaderOrRaw === 'string') {
      const match = authHeaderOrRaw.match(/^Bearer\s+([^\s]+)$/i);
      if (match) raw = match[1].trim();
    }
    if (!VALID_BRIDGE_TOKEN.test(raw)) {
      throw new Error('Unauthorized bridge token');
    }
    const candidateDigest = Buffer.from(sha256Hex(raw), 'hex');
    const state = await this.loadState();
    let matched: StoredBridgeToken | undefined;
    for (const token of state.tokens) {
      if (token.revoked) continue;
      const storedDigest = Buffer.from(token.tokenHash, 'hex');
      if (storedDigest.length === candidateDigest.length && timingSafeEqual(storedDigest, candidateDigest)) {
        matched = token;
        break;
      }
    }
    if (!matched) {
      throw new Error('Unauthorized bridge token');
    }

    const nowMs = Date.now();
    const lastTouched = this.lastTokenTouch.get(matched.id) ?? 0;
    if (nowMs - lastTouched > 15_000) {
      this.lastTokenTouch.set(matched.id, nowMs);
      const tokenId = matched.id;
      void this.mutate(st => {
        const entry = st.tokens.find(t => t.id === tokenId && !t.revoked);
        if (entry) entry.lastUsedAt = new Date(nowMs).toISOString();
      }).catch(() => {});
    }
    return matched;
  }

  async registerBridge(
    token: StoredBridgeToken,
    payload: {
      machineId?: unknown;
      name?: unknown;
      platform?: unknown;
      arch?: unknown;
      hostname?: unknown;
      bridgeVersion?: unknown;
      agents?: unknown;
    },
  ): Promise<{ runtimeId: string; heartbeatIntervalMs: number }> {
    const rawMachine = typeof payload.machineId === 'string' ? payload.machineId.trim() : '';
    if (!rawMachine || rawMachine.length > 120) {
      throw new Error('Invalid bridge machineId');
    }
    const hostname = typeof payload.hostname === 'string' ? payload.hostname.trim().slice(0, 100) : undefined;
    const name = normalizeRuntimeLabel(payload.name, hostname || token.label || 'Local Machine');
    const platform = typeof payload.platform === 'string' ? payload.platform.slice(0, 32) : 'unknown';
    const arch = typeof payload.arch === 'string' ? payload.arch.slice(0, 32) : 'unknown';
    const bridgeVersion = typeof payload.bridgeVersion === 'string' ? payload.bridgeVersion.slice(0, 32) : BRIDGE_SCRIPT_VERSION;
    const agents = sanitizeBridgeAgents(payload.agents);
    const now = new Date().toISOString();

    return this.mutate(state => {
      const liveToken = state.tokens.find(t => t.id === token.id && !t.revoked);
      if (!liveToken) throw new Error('Bridge token was revoked');

      let bridge = state.bridges.find(
        b => b.tokenId === token.id && b.machineId === rawMachine,
      );
      if (!bridge && liveToken.runtimeId) {
        bridge = state.bridges.find(b => b.id === liveToken.runtimeId && b.tokenId === token.id);
      }
      if (!bridge) {
        bridge = {
          id: `bridge:${randomUUID()}`,
          tokenId: token.id,
          machineId: rawMachine,
          name,
          platform,
          arch,
          ...(hostname ? { hostname } : {}),
          bridgeVersion,
          createdAt: now,
          lastSeenAt: now,
          agents,
        };
        state.bridges.push(bridge);
      } else {
        bridge.machineId = rawMachine;
        bridge.name = name;
        bridge.platform = platform;
        bridge.arch = arch;
        bridge.hostname = hostname;
        bridge.bridgeVersion = bridgeVersion;
        bridge.lastSeenAt = now;
        bridge.agents = agents;
      }

      liveToken.runtimeId = bridge.id;
      liveToken.lastUsedAt = now;
      return { runtimeId: bridge.id, heartbeatIntervalMs: 15_000 };
    });
  }

  async heartbeatBridge(
    token: StoredBridgeToken,
    payload: { runtimeId?: unknown; agents?: unknown; bridgeVersion?: unknown } = {},
  ): Promise<{ ok: true; runtimeId: string }> {
    const now = new Date().toISOString();
    return this.mutate(state => {
      const liveToken = state.tokens.find(t => t.id === token.id && !t.revoked);
      if (!liveToken) throw new Error('Bridge token was revoked');

      const requestedId = typeof payload.runtimeId === 'string' ? payload.runtimeId : undefined;
      const bridge = state.bridges.find(
        b => b.tokenId === token.id && (!requestedId || b.id === requestedId),
      );
      if (!bridge) throw new Error('Bridge machine not registered');

      bridge.lastSeenAt = now;
      if (Array.isArray(payload.agents)) {
        bridge.agents = sanitizeBridgeAgents(payload.agents);
      }
      if (typeof payload.bridgeVersion === 'string') {
        bridge.bridgeVersion = payload.bridgeVersion.slice(0, 32);
      }
      liveToken.lastUsedAt = now;
      return { ok: true, runtimeId: bridge.id };
    });
  }

  async attachBridgeStream(runtimeId: string, token: StoredBridgeToken, res: ServerResponse): Promise<void> {
    const state = await this.loadState();
    const bridge = state.bridges.find(b => b.id === runtimeId && b.tokenId === token.id);
    if (!bridge || token.revoked) {
      throw new Error('Bridge machine not registered for this token');
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let set = this.bridgeStreams.get(runtimeId);
    if (!set) {
      set = new Set();
      this.bridgeStreams.set(runtimeId, set);
    }
    set.add(res);
    bridge.lastSeenAt = new Date().toISOString();

    res.write(
      `event: connected\ndata: ${JSON.stringify({ runtimeId, bridgeVersion: BRIDGE_SCRIPT_VERSION })}\n\n`,
    );

    const pingTimer = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        clearInterval(pingTimer);
        return;
      }
      res.write(': ping\n\n');
    }, 15_000);
    pingTimer.unref();

    const cleanupBridgeStream = () => {
      clearInterval(pingTimer);
      const current = this.bridgeStreams.get(runtimeId);
      if (current) {
        current.delete(res);
        if (!current.size) this.bridgeStreams.delete(runtimeId);
      }
    };
    res.once('close', cleanupBridgeStream);
    res.once('error', cleanupBridgeStream);
  }

  async inspectBridgeAgent(runtimeId: string, agentId: string): Promise<LocalAgent> {
    const state = await this.loadState();
    const bridge = state.bridges.find(b => b.id === runtimeId);
    if (!bridge) throw new Error('Bridge machine not found');
    if (!this.hasLiveBridgeStream(runtimeId)) {
      throw new Error('Bridge machine is offline');
    }

    const requestId = randomUUID();
    const agent = await new Promise<LocalAgent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInspects.delete(requestId);
        reject(new Error('Bridge agent inspection timed out'));
      }, INSPECT_TIMEOUT_MS);
      timer.unref();
      this.pendingInspects.set(requestId, {
        runtimeId,
        tokenId: bridge.tokenId,
        resolve,
        reject,
        timer,
      });
      const sent = this.pushBridgeSse(runtimeId, 'agent.inspect', { requestId, agentId });
      if (!sent) {
        clearTimeout(timer);
        this.pendingInspects.delete(requestId);
        reject(new Error('Bridge machine is offline'));
      }
    });

    await this.mutate(st => {
      const target = st.bridges.find(b => b.id === runtimeId);
      if (!target) return;
      const idx = target.agents.findIndex(item => item.id === agent.id);
      if (idx >= 0) target.agents[idx] = agent;
      else target.agents.push(agent);
      target.lastSeenAt = new Date().toISOString();
    });

    return agent;
  }

  async dispatchBridgeRun(
    runtimeId: string,
    dispatch: AgentRunDispatch,
    handlers: {
      onEvent: (event: AgentRunEvent) => Promise<void> | void;
      onToolCall: (req: AgentToolCallRequest) => Promise<AgentToolCallResponse>;
      signal: AbortSignal;
    },
  ): Promise<void> {
    const state = await this.loadState();
    const bridge = state.bridges.find(b => b.id === runtimeId);
    if (!bridge) throw new Error('Bridge machine not found');
    if (!this.hasLiveBridgeStream(runtimeId)) {
      throw new Error(`Local machine "${bridge.name}" is offline. Start the bridge script on that machine first.`);
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        handlers.signal.removeEventListener('abort', onAbort);
        this.activeBridgeRuns.delete(dispatch.runId);
        if (err) reject(err);
        else resolve();
      };

      const onAbort = () => {
        this.pushBridgeSse(runtimeId, 'turn.cancel', { runId: dispatch.runId });
        settle(new Error('Agent conversation stopped'));
      };

      if (handlers.signal.aborted) {
        settle(new Error('Agent conversation stopped'));
        return;
      }
      handlers.signal.addEventListener('abort', onAbort, { once: true });

      this.activeBridgeRuns.set(dispatch.runId, {
        runId: dispatch.runId,
        chatId: dispatch.chatId,
        runtimeId,
        tokenId: bridge.tokenId,
        onEvent: handlers.onEvent,
        onToolCall: handlers.onToolCall,
        resolve: () => settle(),
        reject: err => settle(err),
      });

      const pushed = this.pushBridgeSse(runtimeId, 'turn.dispatch', dispatch);
      if (!pushed) {
        settle(new Error(`Local machine "${bridge.name}" is offline. Start the bridge script on that machine first.`));
      }
    });
  }

  async handleBridgeEvent(token: StoredBridgeToken, body: any): Promise<{ ok: true }> {
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid bridge event payload');
    }

    if (body.type === 'inspect.result') {
      const requestId = typeof body.requestId === 'string' ? body.requestId : '';
      const pending = this.pendingInspects.get(requestId);
      if (!pending || pending.tokenId !== token.id) {
        throw new Error('Unknown inspection request');
      }
      clearTimeout(pending.timer);
      this.pendingInspects.delete(requestId);
      if (typeof body.error === 'string' && body.error) {
        pending.reject(new Error(body.error.slice(0, 300)));
        return { ok: true };
      }
      const agent = sanitizeSingleBridgeAgent(body.agent);
      if (!agent) {
        pending.reject(new Error('Bridge returned invalid agent inspection data'));
        return { ok: true };
      }
      pending.resolve(agent);
      return { ok: true };
    }

    const runId = typeof body.runId === 'string' ? body.runId : '';
    const run = this.activeBridgeRuns.get(runId);
    if (!run) throw new Error('Active bridge run not found');
    if (run.tokenId !== token.id) throw new Error('Forbidden bridge run access');

    const event = (body.event && typeof body.event === 'object' ? body.event : body) as AgentRunEvent;
    if (!event || typeof event.type !== 'string') {
      throw new Error('Invalid bridge run event');
    }

    await run.onEvent(event);
    if (event.type === 'turn.completed') {
      run.resolve();
    } else if (event.type === 'turn.failed') {
      run.reject(new Error(event.error || 'Remote Agent turn failed'));
    }
    return { ok: true };
  }

  async handleBridgeToolCall(token: StoredBridgeToken, body: any): Promise<AgentToolCallResponse> {
    if (!body || typeof body !== 'object') {
      throw new Error('Invalid bridge tool-call payload');
    }
    const runId = typeof body.runId === 'string' ? body.runId : '';
    const run = this.activeBridgeRuns.get(runId);
    if (!run) throw new Error('Active bridge run not found');
    if (run.tokenId !== token.id) throw new Error('Forbidden bridge run access');

    const callId = typeof body.callId === 'string' ? body.callId : randomUUID();
    const tool = typeof body.tool === 'string' ? body.tool : '';
    const args = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};
    return run.onToolCall({ runId, callId, tool, arguments: args });
  }

  async createService(input: CustomAgentServiceInput): Promise<AgentRuntimeInfo> {
    const name = normalizeRuntimeLabel(input?.name, 'Custom Agent Service');
    const endpoint = validateServiceEndpoint(input?.endpoint);
    const authType: RemoteServiceAuthType =
      input?.authType === 'bearer' || input?.authType === 'api-key' ? input.authType : 'none';
    const headerName = authType === 'api-key' ? validateHeaderName(input?.headerName) : undefined;
    const secret = authType !== 'none' && typeof input?.apiKey === 'string' && input.apiKey.trim()
      ? input.apiKey.trim().slice(0, 1024)
      : undefined;
    const enabled = input?.enabled !== false;

    const probe = await probeRemoteAgentService({ endpoint, authType, secret, headerName });
    const now = new Date().toISOString();

    return this.mutate(state => {
      if (state.services.length >= 50) throw new Error('Maximum number of custom Agent services reached');
      const service: StoredAgentService = {
        id: `service:${randomUUID()}`,
        name,
        endpoint,
        authType,
        ...(headerName ? { headerName } : {}),
        ...(secret ? { secret } : {}),
        enabled,
        status: probe.ok ? 'online' : 'offline',
        ...(probe.protocol ? { protocol: probe.protocol } : {}),
        createdAt: now,
        ...(probe.ok ? { lastSeenAt: now } : {}),
        ...(probe.error ? { error: probe.error } : {}),
        agents: probe.agents,
      };
      state.services.push(service);
      return this.buildServiceRuntimeInfo(service);
    });
  }

  async updateService(
    id: string,
    patch: Partial<CustomAgentServiceInput>,
  ): Promise<AgentRuntimeInfo> {
    if (!isServiceRuntimeId(id)) throw new Error('Invalid Agent service ID');
    const currentState = await this.loadState();
    const existing = currentState.services.find(s => s.id === id);
    if (!existing) throw new Error('Agent service not found');

    const name = patch.name !== undefined ? normalizeRuntimeLabel(patch.name, existing.name) : existing.name;
    const endpoint = patch.endpoint !== undefined ? validateServiceEndpoint(patch.endpoint) : existing.endpoint;
    const authType: RemoteServiceAuthType =
      patch.authType === 'none' || patch.authType === 'bearer' || patch.authType === 'api-key'
        ? patch.authType
        : existing.authType;
    const headerName = authType === 'api-key' ? validateHeaderName(patch.headerName ?? existing.headerName) : undefined;
    let secret = existing.secret;
    if (authType === 'none') secret = undefined;
    else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) secret = patch.apiKey.trim().slice(0, 1024);
    const enabled = patch.enabled !== undefined ? Boolean(patch.enabled) : existing.enabled;

    let probe: AgentServiceProbeResult | undefined;
    if (
      patch.endpoint !== undefined
      || patch.authType !== undefined
      || patch.apiKey !== undefined
      || patch.headerName !== undefined
      || (patch.enabled === true && !existing.enabled)
    ) {
      probe = await probeRemoteAgentService({ endpoint, authType, secret, headerName });
    }

    return this.mutate(state => {
      const target = state.services.find(s => s.id === id);
      if (!target) throw new Error('Agent service not found');
      target.name = name;
      target.endpoint = endpoint;
      target.authType = authType;
      target.headerName = headerName;
      target.secret = secret;
      target.enabled = enabled;
      if (probe) {
        target.status = probe.ok ? 'online' : 'offline';
        target.protocol = probe.protocol ?? target.protocol;
        target.error = probe.error;
        target.agents = probe.agents;
        if (probe.ok) target.lastSeenAt = new Date().toISOString();
      }
      return this.buildServiceRuntimeInfo(target);
    });
  }

  async removeService(id: string): Promise<{ deleted: true }> {
    if (!isServiceRuntimeId(id)) throw new Error('Invalid Agent service ID');
    return this.mutate(state => {
      const before = state.services.length;
      state.services = state.services.filter(s => s.id !== id);
      if (state.services.length === before) throw new Error('Agent service not found');
      if (state.defaultRuntimeId === id) state.defaultRuntimeId = null;
      return { deleted: true };
    });
  }

  async testService(
    idOrDraft: string | Partial<CustomAgentServiceInput>,
  ): Promise<AgentServiceProbeResult & { runtime?: AgentRuntimeInfo }> {
    if (typeof idOrDraft === 'string') {
      if (!isServiceRuntimeId(idOrDraft)) throw new Error('Invalid Agent service ID');
      const currentState = await this.loadState();
      const target = currentState.services.find(s => s.id === idOrDraft);
      if (!target) throw new Error('Agent service not found');
      const probe = await probeRemoteAgentService({
        endpoint: target.endpoint,
        authType: target.authType,
        secret: target.secret,
        headerName: target.headerName,
      });
      const updated = await this.mutate(state => {
        const stored = state.services.find(s => s.id === idOrDraft);
        if (!stored) return undefined;
        stored.status = probe.ok ? 'online' : 'offline';
        stored.protocol = probe.protocol ?? stored.protocol;
        stored.error = probe.error;
        if (probe.ok) {
          stored.lastSeenAt = new Date().toISOString();
          stored.agents = probe.agents;
        }
        return this.buildServiceRuntimeInfo(stored);
      });
      return { ...probe, ...(updated ? { runtime: updated } : {}) };
    }

    try {
      const endpoint = validateServiceEndpoint(idOrDraft?.endpoint);
      const authType: RemoteServiceAuthType =
        idOrDraft?.authType === 'bearer' || idOrDraft?.authType === 'api-key' ? idOrDraft.authType : 'none';
      const headerName = authType === 'api-key' ? validateHeaderName(idOrDraft?.headerName) : undefined;
      const secret = authType !== 'none' && typeof idOrDraft?.apiKey === 'string' && idOrDraft.apiKey.trim()
        ? idOrDraft.apiKey.trim().slice(0, 1024)
        : undefined;
      return await probeRemoteAgentService({ endpoint, authType, secret, headerName });
    } catch (error) {
      return { ok: false, agents: [], error: sanitizeServiceError(error) };
    }
  }

  async close(): Promise<void> {
    for (const [requestId, pending] of this.pendingInspects) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Agent runtime registry closed'));
      this.pendingInspects.delete(requestId);
    }
    for (const [runId, run] of this.activeBridgeRuns) {
      this.activeBridgeRuns.delete(runId);
      run.reject(new Error('Agent runtime registry closed'));
    }
    for (const streams of this.bridgeStreams.values()) {
      for (const res of streams) {
        if (!res.destroyed) res.end();
      }
    }
    this.bridgeStreams.clear();
    for (const [key, registry] of registries) {
      if (registry === this) registries.delete(key);
    }
    await this.queue.catch(() => {});
  }
}

const registries = new Map<string, AgentRuntimeRegistry>();
export function agentRuntimesFor(directory: string): AgentRuntimeRegistry {
  const key = path.resolve(directory);
  let registry = registries.get(key);
  if (!registry) {
    registry = new AgentRuntimeRegistry(key);
    registries.set(key, registry);
  }
  return registry;
}
