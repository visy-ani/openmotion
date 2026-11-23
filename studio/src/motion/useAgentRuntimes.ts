import { useCallback, useEffect, useState } from 'react';
import type {
  AgentRuntimeDirectory,
  AgentRuntimeInfo,
  AgentServiceProbeResult,
  BridgeSetupBundle,
  CustomAgentServiceInput,
} from '../../../shared/agent-runtimes';
import type { LocalAgent } from '../../../shared/local-agents';
import { gatewayRequest } from './gatewayClient';

let pendingRuntimesView = false;

export const notifyRuntimesChanged = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('motion:runtimes-changed'));
  }
};

export const consumePendingRuntimesView = () => {
  const value = pendingRuntimesView;
  pendingRuntimesView = false;
  return value;
};

export const openAgentRuntimesSettings = () => {
  pendingRuntimesView = true;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('motion:agents-runtimes-open'));
    window.dispatchEvent(new Event('motion:agents-open'));
  }
};

export function useAgentRuntimes() {
  const [data, setData] = useState<AgentRuntimeDirectory | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    let active = true;
    setError(false);
    void gatewayRequest<AgentRuntimeDirectory>('agent-runtimes')
      .then(value => {
        if (!active) return;
        if (!value || !Array.isArray(value.runtimes)) {
          // Synthetic test fetch mocks without /agent-runtimes fall back gracefully.
          setData(null);
          setError(false);
          return;
        }
        setData(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('motion:runtimes-changed', refresh);
    window.addEventListener('motion:agents-changed', refresh);
    return () => {
      window.removeEventListener('motion:runtimes-changed', refresh);
      window.removeEventListener('motion:agents-changed', refresh);
    };
  }, [refresh]);

  return { data, error, refresh };
}

export async function createBridgeToken(label?: string): Promise<BridgeSetupBundle> {
  const bundle = await gatewayRequest<BridgeSetupBundle>('agent-runtimes/bridge/tokens', 'POST', { label });
  notifyRuntimesChanged();
  return bundle;
}

export async function revokeBridgeToken(tokenId: string): Promise<{ ok: boolean }> {
  const result = await gatewayRequest<{ ok: boolean }>(
    `agent-runtimes/bridge/tokens/${encodeURIComponent(tokenId)}`,
    'DELETE',
  );
  notifyRuntimesChanged();
  return result;
}

export async function inspectBridgeAgent(runtimeId: string, agentId: string): Promise<LocalAgent> {
  const bridgeId = runtimeId.startsWith('bridge:') ? runtimeId.slice('bridge:'.length) : runtimeId;
  const agent = await gatewayRequest<LocalAgent>(
    `agent-runtimes/bridge/${encodeURIComponent(bridgeId)}/inspect/${encodeURIComponent(agentId)}`,
    'POST',
    {},
  );
  notifyRuntimesChanged();
  return agent;
}

export async function createAgentService(input: CustomAgentServiceInput): Promise<AgentRuntimeInfo> {
  const runtime = await gatewayRequest<AgentRuntimeInfo>('agent-runtimes/services', 'POST', input);
  notifyRuntimesChanged();
  return runtime;
}

export async function updateAgentService(
  runtimeId: string,
  patch: Partial<CustomAgentServiceInput>,
): Promise<AgentRuntimeInfo> {
  const serviceId = runtimeId.startsWith('service:') ? runtimeId.slice('service:'.length) : runtimeId;
  const runtime = await gatewayRequest<AgentRuntimeInfo>(
    `agent-runtimes/services/${encodeURIComponent(serviceId)}`,
    'PATCH',
    patch,
  );
  notifyRuntimesChanged();
  return runtime;
}

export async function deleteAgentService(runtimeId: string): Promise<{ deleted: true }> {
  const serviceId = runtimeId.startsWith('service:') ? runtimeId.slice('service:'.length) : runtimeId;
  const result = await gatewayRequest<{ deleted: true }>(
    `agent-runtimes/services/${encodeURIComponent(serviceId)}`,
    'DELETE',
  );
  notifyRuntimesChanged();
  return result;
}

export async function testAgentService(
  idOrInput: string | Partial<CustomAgentServiceInput>,
): Promise<AgentServiceProbeResult & { runtime?: AgentRuntimeInfo }> {
  if (typeof idOrInput === 'string') {
    const serviceId = idOrInput.startsWith('service:') ? idOrInput.slice('service:'.length) : idOrInput;
    const res = await gatewayRequest<AgentServiceProbeResult & { runtime?: AgentRuntimeInfo }>(
      `agent-runtimes/services/${encodeURIComponent(serviceId)}/test`,
      'POST',
      {},
    );
    notifyRuntimesChanged();
    return res;
  }
  return gatewayRequest<AgentServiceProbeResult>('agent-runtimes/services/test', 'POST', idOrInput);
}

export async function setDefaultRuntime(runtimeId: string | null): Promise<{ defaultRuntimeId: string | null }> {
  const result = await gatewayRequest<{ defaultRuntimeId: string | null }>(
    'agent-runtimes/default',
    'PUT',
    { runtimeId },
  );
  notifyRuntimesChanged();
  return result;
}
