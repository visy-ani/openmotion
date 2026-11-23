import type { BrowserScreenshotResult } from '../../../shared/browser';
import {
  SUPER_AGENT_API,
  type SuperAgentArtifact,
  type SuperAgentChat,
  type SuperAgentChatSummary,
  type SuperAgentEngine,
  type SuperAgentIntent,
  type SuperAgentPermissionMode,
  type SuperAgentResourceCatalog,
  type SuperAgentTurnInput,
} from '../../../shared/super-agent';

async function saRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${SUPER_AGENT_API}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : `Request failed (${response.status})`);
  }
  return data as T;
}

export async function fetchWorkspaceResources(params: { kind?: string; query?: string; limit?: number } = {}) {
  const search = new URLSearchParams();
  if (params.kind && params.kind !== 'all') search.set('kind', params.kind);
  if (params.query?.trim()) search.set('query', params.query.trim());
  if (params.limit) search.set('limit', String(params.limit));
  const qs = search.toString();
  return saRequest<SuperAgentResourceCatalog>(`/resources${qs ? `?${qs}` : ''}`);
}

export async function listSuperAgentChats() {
  return saRequest<{ conversations: SuperAgentChatSummary[] }>('/chats');
}

export async function createSuperAgentChat(body: {
  title?: string;
  intent?: SuperAgentIntent;
  initialArtifact?: Partial<SuperAgentArtifact>;
  runtimeId?: string;
  engine?: SuperAgentEngine;
  model?: string;
  permissionMode?: SuperAgentPermissionMode;
} = {}) {
  return saRequest<{ conversation: SuperAgentChat }>('/chats', 'POST', body);
}

export async function getSuperAgentChat(id: string) {
  return saRequest<{ conversation: SuperAgentChat }>(`/chats/${encodeURIComponent(id)}`);
}

export async function updateSuperAgentChat(
  id: string,
  patch: {
    title?: string;
    pinned?: boolean;
    activeArtifactId?: string | null;
    permissionMode?: SuperAgentPermissionMode;
    addArtifact?: Partial<SuperAgentArtifact>;
    removeArtifactId?: string;
  },
) {
  return saRequest<{ conversation: SuperAgentChat }>(`/chats/${encodeURIComponent(id)}`, 'PATCH', patch);
}

export async function deleteSuperAgentChat(id: string) {
  return saRequest<{ deleted: boolean }>(`/chats/${encodeURIComponent(id)}`, 'DELETE');
}

export async function startSuperAgentTurn(id: string, input: SuperAgentTurnInput) {
  return saRequest<{ conversation: SuperAgentChat }>(`/chats/${encodeURIComponent(id)}/turn`, 'POST', input);
}

export async function stopSuperAgentChat(id: string) {
  return saRequest<{ conversation: SuperAgentChat }>(`/chats/${encodeURIComponent(id)}/stop`, 'POST', {});
}

export async function approveSuperAgentAction(id: string, approvalId: string, accepted: boolean) {
  return saRequest<{ conversation: SuperAgentChat }>(`/chats/${encodeURIComponent(id)}/approve`, 'POST', {
    approvalId,
    accepted,
  });
}

export function subscribeSuperAgentChat(
  id: string,
  onChat: (chat: SuperAgentChat) => void,
  onError?: () => void,
): () => void {
  if (typeof EventSource === 'undefined') return () => {};
  const source = new EventSource(`${SUPER_AGENT_API}/chats/${encodeURIComponent(id)}/events`);
  source.addEventListener('chat', event => {
    try {
      const next = JSON.parse((event as MessageEvent).data) as SuperAgentChat;
      onChat(next);
    } catch {
      /* ignore malformed frame */
    }
  });
  source.onerror = () => {
    onError?.();
  };
  return () => source.close();
}

export function superAgentBrowserEndpoint(chatId: string, tabId: string) {
  return `${SUPER_AGENT_API}/chats/${encodeURIComponent(chatId)}/browser/${encodeURIComponent(tabId)}`;
}

/** Releases the server-side headless browser tab when the viewer closes or deletes a web tab. */
export function closeSuperAgentBrowserTab(chatId: string, tabId: string): Promise<void> {
  return fetch(superAgentBrowserEndpoint(chatId, tabId), { method: 'DELETE' }).then(
    () => undefined,
    () => undefined,
  );
}

/** Uploads a PNG annotation screenshot for a Super Agent conversation and returns its serving URL + workspace path. */
export async function uploadSuperAgentAnnotationImage(
  chatId: string,
  dataUrl: string,
): Promise<{ id: string; screenshotUrl: string; screenshotPath: string }> {
  const response = await fetch(`${SUPER_AGENT_API}/chats/${encodeURIComponent(chatId)}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error || `HTTP ${response.status}`);
  return value as { id: string; screenshotUrl: string; screenshotPath: string };
}

/** Captures a server-rendered PNG snapshot of a same-origin Design or Game HTML preview. */
export async function captureSuperAgentPreviewSnapshot(
  chatId: string,
  previewPath: string,
  width?: number,
  height?: number,
): Promise<BrowserScreenshotResult> {
  const response = await fetch(`${SUPER_AGENT_API}/chats/${encodeURIComponent(chatId)}/preview-snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: previewPath,
      ...(typeof width === 'number' ? { width } : {}),
      ...(typeof height === 'number' ? { height } : {}),
    }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error || `HTTP ${response.status}`);
  return value as BrowserScreenshotResult;
}
