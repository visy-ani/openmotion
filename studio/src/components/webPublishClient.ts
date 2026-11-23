import {
  webPublishRoutes,
  type WebPublicationRecord,
  type WebPublishListResponse,
  type WebPublishMode,
  type WebPublishStatusResponse,
  type WebPublishTargetKind,
} from '../../../shared/web-publish';

export class WebPublishApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'WebPublishApiError';
    this.code = code;
    this.status = status;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let code = 'REQUEST_FAILED';
    let message = `Request failed (${res.status})`;
    try {
      const payload = await res.json();
      if (payload?.error?.code) code = String(payload.error.code);
      else if (payload?.code) code = String(payload.code);
      if (payload?.error?.message) message = String(payload.error.message);
      else if (typeof payload?.error === 'string') message = payload.error;
    } catch {
      // Non-JSON error response
    }
    throw new WebPublishApiError(code, message, res.status);
  }
  return res.json() as Promise<T>;
}

export const webPublishClient = {
  list: () => requestJson<WebPublishListResponse>(webPublishRoutes.list),

  getStatus: (
    targetKind: WebPublishTargetKind,
    targetId: string,
    options?: { filePath?: string; refresh?: boolean; sourcePath?: string },
  ) => {
    const query = new URLSearchParams();
    if (options?.filePath) query.set('filePath', options.filePath);
    if (options?.refresh) query.set('refresh', '1');
    if (options?.sourcePath) query.set('sourcePath', options.sourcePath);
    const suffix = query.toString();
    const base = webPublishRoutes.target(targetKind, targetId);
    return requestJson<WebPublishStatusResponse>(suffix ? `${base}?${suffix}` : base);
  },

  publish: (
    targetKind: WebPublishTargetKind,
    targetId: string,
    payload: {
      filePath?: string;
      workspaceId?: string;
      deployMode?: WebPublishMode;
      name?: string;
      sourcePath?: string;
    } = {},
  ) =>
    requestJson<{
      publication: WebPublicationRecord;
      deployment: WebPublicationRecord;
      url: string | null;
      updated: boolean;
    }>(webPublishRoutes.target(targetKind, targetId), {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  unpublish: (
    targetKind: WebPublishTargetKind,
    targetId: string,
    payload: { filePath?: string; sourcePath?: string } = {},
  ) =>
    requestJson<{
      publication: WebPublicationRecord;
      deployment: WebPublicationRecord;
    }>(webPublishRoutes.target(targetKind, targetId), {
      method: 'DELETE',
      body: JSON.stringify(payload),
    }),
};
