import {
  AGENT_SERVICE_PROTOCOL,
  type AgentRunDispatch,
  type AgentRunEvent,
  type AgentServiceProbeResult,
  type AgentToolCallRequest,
  type AgentToolCallResponse,
  type RemoteServiceAuthType,
} from '../shared/agent-runtimes.ts';
import type { AgentAuth, LocalAgent } from '../shared/local-agents.ts';
import { normalizeAgentModels } from './agent-discovery.ts';

const PROBE_TIMEOUT_MS = 8_000;
const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024;
const VALID_AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const VALID_HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

export type RemoteServiceConnectionConfig = {
  endpoint: string;
  authType: RemoteServiceAuthType;
  secret?: string;
  headerName?: string;
};

export function validateServiceEndpoint(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024) {
    throw new Error('Agent service endpoint must be a valid http:// or https:// URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('Agent service endpoint must be a valid http:// or https:// URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Agent service endpoint must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Agent service endpoint must not include embedded credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Agent service endpoint must not include query strings or URL fragments');
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath === '/' ? '' : cleanPath}`;
}

export function validateHeaderName(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return 'X-API-Key';
  if (typeof raw !== 'string' || !VALID_HEADER_NAME.test(raw.trim())) {
    throw new Error('Invalid authentication header name');
  }
  return raw.trim();
}

export function sanitizeServiceError(error: unknown, fallback = 'Agent service request failed'): string {
  const message = error instanceof Error ? error.message : String(error || fallback);
  return (
    message
      .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
      .replace(/((?:api[_-]?key|token|authorization|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400) || fallback
  );
}

export function buildServiceHeaders(
  authType: RemoteServiceAuthType,
  secret?: string,
  headerName?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (secret && authType === 'bearer') {
    headers.Authorization = `Bearer ${secret}`;
  } else if (secret && authType === 'api-key') {
    headers[validateHeaderName(headerName)] = secret;
  }
  return headers;
}

function normalizeRemoteAgent(raw: any, endpoint: string): LocalAgent | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!VALID_AGENT_ID.test(id)) return null;
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 80) : id;
  const auth: AgentAuth = raw.auth === 'signed-out' || raw.auth === 'unknown' ? raw.auth : 'signed-in';
  const icon = typeof raw.icon === 'string' && /^[a-z0-9-]+$/i.test(raw.icon) ? raw.icon : 'robot';
  const version = typeof raw.version === 'string' ? raw.version.slice(0, 60) : undefined;
  return {
    id,
    label,
    bin: id,
    icon,
    website: endpoint,
    installed: raw.installed !== false,
    auth,
    ...(version ? { version } : {}),
    models: Array.isArray(raw.models) ? normalizeAgentModels(raw.models, 'cli') : [],
    checkedAt: new Date().toISOString(),
  };
}

async function fetchServiceJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<any> {
  const response = await fetch(url, { method: 'GET', headers, signal });
  const text = await response.text();
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.error === 'string' && parsed.error.trim()) message = parsed.error.trim();
    } catch {
      if (text.trim()) message = `${message}: ${text.trim().slice(0, 160)}`;
    }
    throw new Error(message);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error('Remote Agent service returned invalid JSON');
  }
}

export async function probeRemoteAgentService(
  config: RemoteServiceConnectionConfig,
): Promise<AgentServiceProbeResult> {
  const endpoint = validateServiceEndpoint(config.endpoint);
  const headers = buildServiceHeaders(config.authType, config.secret, config.headerName, {
    Accept: 'application/json',
  });

  try {
    const health = await fetchServiceJson(
      `${endpoint}/health`,
      headers,
      AbortSignal.timeout(PROBE_TIMEOUT_MS),
    );
    const catalog = await fetchServiceJson(
      `${endpoint}/v1/agents`,
      headers,
      AbortSignal.timeout(PROBE_TIMEOUT_MS),
    );
    const rawList = Array.isArray(catalog?.agents)
      ? catalog.agents
      : Array.isArray(catalog)
        ? catalog
        : [];
    const agents = rawList
      .map((item: unknown) => normalizeRemoteAgent(item, endpoint))
      .filter((item: LocalAgent | null): item is LocalAgent => item !== null)
      .slice(0, 100);
    const protocol = typeof health?.protocol === 'string' ? health.protocol : AGENT_SERVICE_PROTOCOL;
    const version = typeof health?.version === 'string' ? health.version.slice(0, 60) : undefined;
    return { ok: true, protocol, ...(version ? { version } : {}), agents };
  } catch (error) {
    return {
      ok: false,
      agents: [],
      error: sanitizeServiceError(error, 'Could not reach Agent service'),
    };
  }
}

export async function consumeSseFrames(
  stream: ReadableStream<Uint8Array>,
  onFrame: (eventType: string, dataText: string) => Promise<void> | void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatchBlock = async (block: string) => {
    const lines = block.split(/\r?\n/);
    let eventType = 'message';
    const dataParts: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon >= 0 ? line.slice(0, colon) : line;
      const rawValue = colon >= 0 ? line.slice(colon + 1) : '';
      const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
      if (field === 'event') eventType = value || 'message';
      else if (field === 'data') dataParts.push(value);
    }
    if (!dataParts.length) return;
    await onFrame(eventType, dataParts.join('\n'));
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER_BYTES) {
        throw new Error('Agent event stream exceeded buffer limit');
      }
      for (;;) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (block.trim()) await dispatchBlock(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      await dispatchBlock(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function executeRemoteServiceRun(
  config: RemoteServiceConnectionConfig,
  dispatch: AgentRunDispatch,
  handlers: {
    onEvent: (event: AgentRunEvent) => Promise<void> | void;
    onToolCall: (req: AgentToolCallRequest) => Promise<AgentToolCallResponse>;
    signal: AbortSignal;
  },
): Promise<void> {
  const endpoint = validateServiceEndpoint(config.endpoint);
  const jsonHeaders = buildServiceHeaders(config.authType, config.secret, config.headerName, {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });
  const sseHeaders = buildServiceHeaders(config.authType, config.secret, config.headerName, {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  });

  const controller = new AbortController();
  let cancelRequested = false;
  const sendBestEffortCancel = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    void fetch(`${endpoint}/v1/runs/${encodeURIComponent(dispatch.runId)}/cancel`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ runId: dispatch.runId }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  };
  const onAbort = () => {
    sendBestEffortCancel();
    controller.abort();
  };
  handlers.signal.addEventListener('abort', onAbort, { once: true });
  if (handlers.signal.aborted) {
    onAbort();
    throw new Error('Agent conversation stopped');
  }

  let sawTerminal = false;
  try {
    const response = await fetch(`${endpoint}/v1/runs`, {
      method: 'POST',
      headers: sseHeaders,
      body: JSON.stringify({ protocol: AGENT_SERVICE_PROTOCOL, ...dispatch }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        sanitizeServiceError(detail || `Remote Agent service failed (${response.status})`),
      );
    }

    const postToolResult = async (callId: string, result: AgentToolCallResponse) => {
      const postRes = await fetch(
        `${endpoint}/v1/runs/${encodeURIComponent(dispatch.runId)}/tool-results`,
        {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ callId, ...result }),
          signal: controller.signal,
        },
      );
      if (!postRes.ok) {
        throw new Error(`Could not deliver tool result (${postRes.status})`);
      }
    };

    const pendingToolCalls: Promise<void>[] = [];

    await consumeSseFrames(response.body, async (eventType, dataText) => {
      let payload: any;
      try {
        payload = JSON.parse(dataText);
      } catch {
        return;
      }
      const kind = typeof payload?.type === 'string' ? payload.type : eventType;
      if (kind === 'tool.call') {
        const callId = String(payload.callId || '');
        const tool = String(payload.tool || '');
        const args = payload.arguments && typeof payload.arguments === 'object' ? payload.arguments : {};
        const task = (async () => {
          const result = await handlers.onToolCall({ runId: dispatch.runId, callId, tool, arguments: args });
          if (!handlers.signal.aborted) {
            await postToolResult(callId, result);
          }
        })();
        pendingToolCalls.push(task);
        await task;
        return;
      }

      const event: AgentRunEvent = payload?.type ? payload : { ...payload, type: kind };
      if (event.type === 'turn.completed' || event.type === 'turn.failed') {
        sawTerminal = true;
      }
      await handlers.onEvent(event);
    });

    await Promise.all(pendingToolCalls);
    if (!sawTerminal && !handlers.signal.aborted) {
      await handlers.onEvent({ type: 'turn.completed' });
    }
  } catch (error) {
    if (handlers.signal.aborted) {
      throw new Error('Agent conversation stopped');
    }
    throw new Error(sanitizeServiceError(error));
  } finally {
    handlers.signal.removeEventListener('abort', onAbort);
  }
}
