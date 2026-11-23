import { useEffect, useState } from 'react';
import { isIntegrationInfo, type IntegrationInfo } from '../../../shared/integration';

const INTEGRATION_CACHE_TTL_MS = 10_000;
const cacheEnabled = typeof process === 'undefined' || (!process.env?.VITEST && process.env?.NODE_ENV !== 'test');

let cachedIntegration: { value: IntegrationInfo; expiresAt: number } | null = null;
let inflightIntegration: { promise: Promise<IntegrationInfo>; controller: AbortController; subscribers: number } | null = null;

function subscribeIntegration(forceRefresh: boolean): { promise: Promise<IntegrationInfo>; cancel: () => void } {
  if (!cacheEnabled) {
    const controller = new AbortController();
    const promise = (async () => {
      const response = await fetch('/motion-api/integration', { signal: controller.signal });
      if (!response.ok) throw new Error('Unavailable');
      const value = await response.json() as IntegrationInfo;
      if (!isIntegrationInfo(value)) throw new Error('Invalid integration');
      return value;
    })();
    return { promise, cancel: () => controller.abort() };
  }
  if (!forceRefresh && cachedIntegration && cachedIntegration.expiresAt > Date.now()) {
    return { promise: Promise.resolve(cachedIntegration.value), cancel: () => {} };
  }
  if (forceRefresh || !inflightIntegration) {
    const controller = new AbortController();
    const entry = {
      controller,
      subscribers: 0,
      promise: (async () => {
        const response = await fetch('/motion-api/integration', { signal: controller.signal });
        if (!response.ok) throw new Error('Unavailable');
        const value = await response.json() as IntegrationInfo;
        if (!isIntegrationInfo(value)) throw new Error('Invalid integration');
        cachedIntegration = { value, expiresAt: Date.now() + INTEGRATION_CACHE_TTL_MS };
        return value;
      })(),
    };
    inflightIntegration = entry;
    void entry.promise.finally(() => {
      if (inflightIntegration === entry) inflightIntegration = null;
    });
  }
  const active = inflightIntegration!;
  active.subscribers++;
  let cancelled = false;
  return {
    promise: active.promise,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      active.subscribers = Math.max(0, active.subscribers - 1);
      if (active.subscribers === 0 && inflightIntegration === active) {
        inflightIntegration = null;
        active.controller.abort();
      }
    },
  };
}

export function useIntegrationInfo() {
  const [info, setInfo] = useState<IntegrationInfo | null>(() =>
    cacheEnabled && cachedIntegration && cachedIntegration.expiresAt > Date.now()
      ? cachedIntegration.value
      : null,
  );
  const [failed, setFailed] = useState(false), [attempt, retry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const forceRefresh = attempt > 0;
    if (forceRefresh || !cacheEnabled || !cachedIntegration || cachedIntegration.expiresAt <= Date.now()) {
      setInfo(null);
    }
    setFailed(false);
    const sub = subscribeIntegration(forceRefresh);
    void sub.promise
      .then(value => { if (!cancelled) setInfo(value); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      sub.cancel();
    };
  }, [attempt]);
  return { info, failed, retry: () => retry(value => value + 1) };
}
