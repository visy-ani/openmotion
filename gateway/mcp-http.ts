import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { rpc, releaseRegistry } from '../mcp.ts';
import {
  MCP_HTTP_PATH,
  MCP_TOKEN_PREFIX,
  buildRemoteMcpConfigs,
  normalizeMcpTokenLabel,
  normalizeMcpTokenScope,
  type CreatedMcpToken,
  type McpHttpStatus,
  type McpTokenScope,
  type McpTokenSummary,
} from '../shared/mcp-http.ts';
import { createMcpClientState, type McpClientState } from '../shared/mcp-template-recommendations.ts';
import type { HostContext } from '../tracking/host.ts';
import type { WorkspaceStore } from '../workspace.ts';
import { allowedHosts, deploymentMode, resolvePublicOrigin } from './agent-runtimes.ts';
import { readSettings, writeSettings } from './settings-storage.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 128;
const SESSION_TTL_MS = 30 * 60_000;
const VALID_MCP_TOKEN = /^om_mcp_[a-f0-9]{16,128}$/;
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

type StoredMcpToken = {
  id: string;
  label: string;
  prefix: string;
  scope: McpTokenScope;
  tokenHash: string;
  createdAt: string;
  lastUsedAt?: string;
  revoked?: boolean;
};

type StoredTokensState = {
  tokens: StoredMcpToken[];
};

type McpHttpSession = {
  id: string;
  createdAt: number;
  lastActiveAt: number;
  connection: { selection: { sessionId?: string; projectId?: string } };
  clientState: McpClientState;
  streams: Set<ServerResponse>;
};

export type McpPhase1Invoker = (payload: {
  name: string;
  arguments: any;
  trackingHost: HostContext;
  trackingContext?: string;
}) => Promise<any>;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

async function readJsonPayload(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error('MCP request body exceeds 2 MiB limit'), { statusCode: 413 });
    }
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

export class McpTokenStore {
  readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();
  private statePromise: Promise<StoredTokensState> | null = null;
  private lastTouch = new Map<string, number>();

  constructor(directoryPath: string) {
    this.file = path.join(directoryPath, 'agents/mcp-tokens.json');
  }

  private load(): Promise<StoredTokensState> {
    if (!this.statePromise) {
      this.statePromise = readSettings<Partial<StoredTokensState>>(this.file, { tokens: [] }).then(raw => ({
        tokens: Array.isArray(raw.tokens) ? structuredClone(raw.tokens) : [],
      }));
    }
    return this.statePromise;
  }

  private mutate<T>(fn: (state: StoredTokensState) => Promise<T> | T): Promise<T> {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        const state = await this.load();
        const result = await fn(state);
        await writeSettings(this.file, state);
        return result;
      });
    this.queue = task.catch(() => {});
    return task;
  }

  async list(): Promise<McpTokenSummary[]> {
    const state = await this.load();
    return state.tokens
      .filter(token => !token.revoked)
      .map(token => ({
        id: token.id,
        label: token.label,
        prefix: token.prefix,
        scope: token.scope,
        createdAt: token.createdAt,
        ...(token.lastUsedAt ? { lastUsedAt: token.lastUsedAt } : {}),
      }));
  }

  async create(
    labelInput: unknown,
    scopeInput: unknown,
    endpoint: string,
  ): Promise<CreatedMcpToken> {
    const label = normalizeMcpTokenLabel(labelInput);
    const scope = normalizeMcpTokenScope(scopeInput);
    const rawToken = `${MCP_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const prefix = rawToken.slice(0, 14);

    await this.mutate(state => {
      state.tokens.unshift({
        id,
        label,
        prefix,
        scope,
        tokenHash: sha256Hex(rawToken),
        createdAt,
      });
      if (state.tokens.length > 100) {
        const active = state.tokens.filter(t => !t.revoked);
        const revoked = state.tokens.filter(t => t.revoked).slice(0, Math.max(0, 100 - active.length));
        state.tokens = [...active, ...revoked].slice(0, 100);
      }
    });

    return {
      token: rawToken,
      summary: { id, label, prefix, scope, createdAt },
      endpoint,
      configs: buildRemoteMcpConfigs(endpoint, rawToken),
    };
  }

  async revoke(tokenId: string): Promise<{ ok: true }> {
    await this.mutate(state => {
      const target = state.tokens.find(t => t.id === tokenId && !t.revoked);
      if (!target) throw new Error('MCP token not found');
      target.revoked = true;
    });
    this.lastTouch.delete(tokenId);
    return { ok: true };
  }

  async verify(authHeader: string | undefined): Promise<{ id: string; label: string; scope: McpTokenScope }> {
    const match = typeof authHeader === 'string' ? authHeader.match(/^Bearer\s+([^\s]+)$/i) : null;
    const raw = match?.[1]?.trim() ?? '';
    if (!VALID_MCP_TOKEN.test(raw)) {
      throw new Error('Invalid MCP Bearer token');
    }
    const candidateDigest = Buffer.from(sha256Hex(raw), 'hex');
    const state = await this.load();
    let matched: StoredMcpToken | undefined;
    for (const token of state.tokens) {
      if (token.revoked) continue;
      const storedDigest = Buffer.from(token.tokenHash, 'hex');
      if (storedDigest.length === candidateDigest.length && timingSafeEqual(storedDigest, candidateDigest)) {
        matched = token;
        break;
      }
    }
    if (!matched) {
      throw new Error('Invalid MCP Bearer token');
    }

    const nowMs = Date.now();
    if (nowMs - (this.lastTouch.get(matched.id) ?? 0) > 15_000) {
      this.lastTouch.set(matched.id, nowMs);
      const tokenId = matched.id;
      void this.mutate(st => {
        const entry = st.tokens.find(t => t.id === tokenId && !t.revoked);
        if (entry) entry.lastUsedAt = new Date(nowMs).toISOString();
      }).catch(() => {});
    }

    return { id: matched.id, label: matched.label, scope: matched.scope };
  }
}

export class McpHttpGateway {
  readonly store: WorkspaceStore;
  readonly tokenStore: McpTokenStore;
  readonly key: string;
  private sessions = new Map<string, McpHttpSession>();
  private openStreams = new Set<ServerResponse>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(store: WorkspaceStore) {
    this.store = store;
    this.key = path.resolve((store.workspaceStore ?? store).directory);
    this.tokenStore = new McpTokenStore(this.key);
    this.sweepTimer = setInterval(() => this.pruneExpiredSessions(), 5 * 60_000);
    this.sweepTimer.unref();
  }

  isAuthRequired(env: NodeJS.ProcessEnv = process.env): boolean {
    return deploymentMode(env) === 'cloud' || env.MOTION_MCP_REQUIRE_AUTH === '1';
  }

  async status(fallbackOrigin: string, env: NodeJS.ProcessEnv = process.env): Promise<McpHttpStatus> {
    this.pruneExpiredSessions();
    const publicOrigin = resolvePublicOrigin(fallbackOrigin, env);
    const publicEndpoint = `${publicOrigin}${MCP_HTTP_PATH}`;
    const tokens = await this.tokenStore.list();
    return {
      endpoint: `${fallbackOrigin}${MCP_HTTP_PATH}`,
      publicEndpoint,
      authRequired: this.isAuthRequired(env),
      activeSessions: this.sessions.size,
      protocolVersions: PROTOCOL_VERSIONS,
      tokens,
      configs: buildRemoteMcpConfigs(publicEndpoint),
    };
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActiveAt > SESSION_TTL_MS && session.streams.size === 0) {
        this.sessions.delete(id);
      }
    }
  }

  private createSession(): McpHttpSession {
    this.pruneExpiredSessions();
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey) {
        const evicted = this.sessions.get(oldestKey);
        if (evicted) {
          for (const stream of evicted.streams) {
            if (!stream.destroyed) stream.end();
          }
        }
        this.sessions.delete(oldestKey);
      }
    }
    const now = Date.now();
    const session: McpHttpSession = {
      id: randomUUID(),
      createdAt: now,
      lastActiveAt: now,
      connection: { selection: {} },
      clientState: createMcpClientState(),
      streams: new Set(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  private checkOrigin(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
    const originHeader = req.headers.origin;
    if (!originHeader) return true;
    try {
      const originUrl = new URL(originHeader);
      const allowed = allowedHosts(env);
      const hostName = originUrl.hostname.toLowerCase();
      if (allowed.has(hostName)) return true;
      const reqHost = req.headers.host;
      return Boolean(reqHost && originUrl.host.toLowerCase() === reqHost.toLowerCase());
    } catch {
      return false;
    }
  }

  private async authenticate(
    req: IncomingMessage,
    editorToken?: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ scope: McpTokenScope; tokenId?: string }> {
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.trim()) {
      if (editorToken && authHeader === `Bearer ${editorToken}`) {
        return { scope: 'admin' };
      }
      const verified = await this.tokenStore.verify(authHeader);
      return { scope: verified.scope, tokenId: verified.id };
    }
    if (this.isAuthRequired(env) || !isLoopbackHost(req.headers.host)) {
      throw new Error('MCP Bearer token required');
    }
    return { scope: 'write' };
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    options: { invokePhase1: McpPhase1Invoker; editorToken?: string; env?: NodeJS.ProcessEnv },
  ): Promise<void> {
    const env = options.env ?? process.env;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        Allow: 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Accept',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id',
      });
      res.end();
      return;
    }

    if (!this.checkOrigin(req, env)) {
      sendJson(res, 403, { error: 'Origin not allowed for MCP endpoint' });
      return;
    }

    let auth: { scope: McpTokenScope; tokenId?: string };
    try {
      auth = await this.authenticate(req, options.editorToken, env);
    } catch (error) {
      sendJson(
        res,
        401,
        { error: error instanceof Error ? error.message : 'Unauthorized' },
        { 'WWW-Authenticate': 'Bearer realm="OpenMotion MCP"' },
      );
      return;
    }

    const sessionHeader = req.headers['mcp-session-id'];
    const requestedSessionId = typeof sessionHeader === 'string' ? sessionHeader.trim() : '';

    if (req.method === 'DELETE') {
      if (!requestedSessionId || !this.sessions.has(requestedSessionId)) {
        sendJson(res, 404, { error: 'MCP session not found' });
        return;
      }
      const session = this.sessions.get(requestedSessionId)!;
      for (const stream of session.streams) {
        this.openStreams.delete(stream);
        if (!stream.destroyed) stream.end();
      }
      session.streams.clear();
      this.sessions.delete(requestedSessionId);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET') {
      let session: McpHttpSession | undefined;
      if (requestedSessionId) {
        session = this.sessions.get(requestedSessionId);
        if (!session) {
          sendJson(res, 404, { error: 'MCP session not found' });
          return;
        }
        session.lastActiveAt = Date.now();
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(session ? { 'Mcp-Session-Id': session.id } : {}),
      });
      this.openStreams.add(res);
      session?.streams.add(res);
      res.write(`event: ready\ndata: ${JSON.stringify({ sessionId: session?.id ?? null, transport: 'streamable-http' })}\n\n`);
      const timer = setInterval(() => {
        if (res.destroyed || res.writableEnded) {
          clearInterval(timer);
          return;
        }
        res.write(': ping\n\n');
      }, 20_000);
      timer.unref();
      const cleanupStream = () => {
        clearInterval(timer);
        this.openStreams.delete(res);
        session?.streams.delete(res);
      };
      res.once('close', cleanupStream);
      res.once('error', cleanupStream);
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed; use POST, GET, or DELETE' });
      return;
    }

    let payload: unknown;
    try {
      payload = await readJsonPayload(req);
    } catch (error: any) {
      if (error?.statusCode === 413) {
        sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32000, message: error.message } });
        return;
      }
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const isBatch = Array.isArray(payload);
    const messages: unknown[] = Array.isArray(payload) ? payload : [payload];
    if (isBatch && messages.length === 0) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }

    let session: McpHttpSession | undefined;
    if (requestedSessionId) {
      session = this.sessions.get(requestedSessionId);
      if (!session) {
        sendJson(res, 404, { error: 'MCP session not found' });
        return;
      }
      session.lastActiveAt = Date.now();
    } else if (messages.some(msg => msg && typeof msg === 'object' && (msg as any).method === 'initialize')) {
      session = this.createSession();
    }

    const responses: any[] = [];
    for (const msg of messages) {
      const reply = await rpc(
        msg,
        this.store,
        releaseRegistry,
        session?.connection,
        session?.clientState,
        {
          authorizeToolCall: tool => {
            if (auth.scope === 'read' && tool.annotations?.readOnlyHint !== true) {
              throw Object.assign(
                new Error(`MCP_SCOPE_FORBIDDEN: Token scope "read" cannot invoke "${tool.name}"`),
                { jsonRpcCode: -32003 },
              );
            }
          },
          callPhase1: options.invokePhase1,
        },
      );
      if (reply !== null) responses.push(reply);
    }

    const responseHeaders: Record<string, string> = session ? { 'Mcp-Session-Id': session.id } : {};
    if (responses.length === 0) {
      res.writeHead(202, responseHeaders);
      res.end();
      return;
    }

    const resultPayload = isBatch ? responses : responses[0];
    const accept = String(req.headers.accept || '');
    const prefersSse = accept.includes('text/event-stream') && !accept.includes('application/json');
    if (prefersSse) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        ...responseHeaders,
      });
      res.end(`event: message\ndata: ${JSON.stringify(resultPayload)}\n\n`);
      return;
    }

    sendJson(res, 200, resultPayload, responseHeaders);
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    for (const stream of this.openStreams) {
      if (!stream.destroyed) stream.end();
    }
    this.openStreams.clear();
    this.sessions.clear();
    if (gateways.get(this.key) === this) {
      gateways.delete(this.key);
    }
  }
}

const gateways = new Map<string, McpHttpGateway>();
export function mcpHttpFor(store: WorkspaceStore): McpHttpGateway {
  const rootStore = store.workspaceStore ?? store;
  const key = path.resolve(rootStore.directory);
  let gateway = gateways.get(key);
  if (!gateway) {
    gateway = new McpHttpGateway(rootStore);
    gateways.set(key, gateway);
  }
  return gateway;
}
