import type { GatewayStatus, Model, GenerationJob, GenerateInput } from '../../../shared/gateway';
export type { GatewayStatus, Model, GenerationJob, GenerateInput, Modality, GeneratedAsset } from '../../../shared/gateway';

const GATEWAY_CACHE_TTL_MS = 5_000;
const cacheEnabled = typeof process === 'undefined' || (!process.env?.VITEST && process.env?.NODE_ENV !== 'test');

let cacheGeneration = 0;
let cachedGateway: { value: { status: GatewayStatus; models: Model[] }; expiresAt: number } | null = null;
let inflightModels: Promise<Model[]> | null = null;
let inflightGateway: Promise<{ status: GatewayStatus; models: Model[] }> | null = null;
let gatewayListenerRegistered = false;

export function invalidateGatewayCache(): void {
  cacheGeneration++;
  cachedGateway = null;
  inflightModels = null;
  inflightGateway = null;
}

function ensureGatewayInvalidationListener(): void {
  if (gatewayListenerRegistered || typeof window === 'undefined') return;
  gatewayListenerRegistered = true;
  window.addEventListener('motion:gateway-changed', invalidateGatewayCache);
}

export async function gatewayRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (method !== 'GET') invalidateGatewayCache();
  const response = await fetch('/motion-api/' + path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Model gateway request failed'), data.applied === false ? { applied: false } : {});
  return data as T;
}

export async function loadModels(): Promise<Model[]> {
  ensureGatewayInvalidationListener();
  if (inflightModels) return inflightModels;
  const run = (async () => {
    const models: Model[] = []; let offset: number | null = 0;
    do {
      const page: { models: Model[]; nextOffset: number | null } = await gatewayRequest(`models?offset=${offset}&limit=100`);
      models.push(...page.models); offset = page.nextOffset;
    } while (offset !== null && models.length < 5000);
    return models;
  })();
  inflightModels = run;
  return run.finally(() => {
    if (inflightModels === run) inflightModels = null;
  });
}

export async function loadGateway() {
  ensureGatewayInvalidationListener();
  if (cacheEnabled && cachedGateway && cachedGateway.expiresAt > Date.now()) {
    return cachedGateway.value;
  }
  if (inflightGateway) return inflightGateway;
  const generation = cacheGeneration;
  const run = Promise.all([gatewayRequest<GatewayStatus>('models/capabilities'), loadModels()]).then(
    ([status, models]) => {
      const result = { status, models };
      if (cacheEnabled && generation === cacheGeneration) {
        cachedGateway = { value: result, expiresAt: Date.now() + GATEWAY_CACHE_TTL_MS };
      }
      return result;
    },
  );
  inflightGateway = run;
  return run.finally(() => {
    if (inflightGateway === run) inflightGateway = null;
  });
}

/** Shared entry point for future property panels and other editor consumers. */
export function generateAsset(input: GenerateInput) {
  return gatewayRequest<{ job: GenerationJob }>('generations', 'POST', input);
}
