// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AGENT_RUNTIMES_API, AGENT_SERVICE_PROTOCOL, type AgentRuntimeDirectory } from '../../../shared/agent-runtimes';
import { I18nProvider } from '../i18n/I18n';
import { AgentSettings } from './AgentSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 10));
  });
}

function findButton(label: string) {
  const el = [...document.querySelectorAll('button')].find(btn => btn.textContent?.includes(label));
  expect(el).toBeTruthy();
  return el!;
}

it('manages Bridge connect scripts, connected local machines, and Custom Agent Services in Settings', async () => {
  let directoryState: AgentRuntimeDirectory = {
    deploymentMode: 'cloud',
    publicOrigin: 'https://cloud.openmotion.example',
    localDirectAvailable: false,
    defaultRuntimeId: null,
    tokens: [
      {
        id: 'tok-existing',
        label: 'Old Laptop',
        prefix: 'om_brg_old1234',
        createdAt: '2026-11-21T10:00:00Z',
        runtimeId: 'bridge:b1',
      },
    ],
    runtimes: [
      {
        id: 'bridge:b1',
        kind: 'local-bridge',
        name: 'Old Laptop',
        status: 'online',
        platform: 'darwin',
        arch: 'arm64',
        tokenId: 'tok-existing',
        agents: [
          {
            id: 'codex',
            label: 'Codex',
            bin: 'codex',
            icon: 'codex',
            website: '',
            installed: true,
            auth: 'signed-in',
            models: [],
          },
        ],
        runnableAgentIds: ['codex'],
      },
    ],
  };

  const calls: { url: string; method: string; body?: any }[] = [];

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.includes('/settings/agents')) {
      return Response.json({
        agents: [
          {
            id: 'codex',
            label: 'Codex',
            bin: 'codex',
            icon: 'codex',
            website: 'https://github.com/openai/codex',
            installed: false,
            auth: 'unknown',
            models: [],
          },
        ],
        default: null,
      });
    }

    if (url === `${AGENT_RUNTIMES_API}` && method === 'GET') {
      return Response.json(directoryState);
    }

    if (url === `${AGENT_RUNTIMES_API}/bridge/tokens` && method === 'POST') {
      directoryState = {
        ...directoryState,
        tokens: [
          ...directoryState.tokens,
          { id: 'tok-new', label: body?.label || 'Studio Mac', prefix: 'om_brg_new999', createdAt: '2026-11-21T12:00:00Z' },
        ],
      };
      const demoBridgeValue = ['om', 'brg', 'demo', 'fixture'].join('_');
      return Response.json({
        tokenId: 'tok-new',
        label: body?.label || 'Studio Mac',
        token: demoBridgeValue,
        serverUrl: 'https://cloud.openmotion.example',
        scriptUrl: 'https://cloud.openmotion.example/motion-api/agent-runtimes/bridge/script',
        installScriptUrl: `https://cloud.openmotion.example/motion-api/agent-runtimes/bridge/install.sh?token=${demoBridgeValue}`,
        installPs1Url: `https://cloud.openmotion.example/motion-api/agent-runtimes/bridge/install.ps1?token=${demoBridgeValue}`,
        curlCommand: `curl -fsSL 'https://cloud.openmotion.example/motion-api/agent-runtimes/bridge/install.sh?token=${demoBridgeValue}' | bash`,
        powershellCommand: `irm 'https://cloud.openmotion.example/motion-api/agent-runtimes/bridge/install.ps1?token=${demoBridgeValue}' | iex`,
        nodeCommand: `node openmotion-agent-bridge.mjs --token ${demoBridgeValue}`,
        localCommand: `node --experimental-strip-types gateway/agent-bridge.ts --token ${demoBridgeValue}`,
      });
    }

    if (url === `${AGENT_RUNTIMES_API}/services/test` && method === 'POST') {
      return Response.json({
        ok: true,
        protocol: AGENT_SERVICE_PROTOCOL,
        agents: [
          {
            id: 'team-agent',
            label: 'Team Agent',
            bin: 'team-agent',
            icon: 'robot',
            website: body.endpoint,
            installed: true,
            auth: 'signed-in',
            models: [],
          },
        ],
      });
    }

    if (url === `${AGENT_RUNTIMES_API}/services` && method === 'POST') {
      const created = {
        id: 'service:s1',
        kind: 'remote-service' as const,
        name: body.name,
        status: 'online' as const,
        endpoint: body.endpoint,
        authType: body.authType,
        hasCredentials: Boolean(body.apiKey),
        enabled: true,
        agents: [
          {
            id: 'team-agent',
            label: 'Team Agent',
            bin: 'team-agent',
            icon: 'robot',
            website: body.endpoint,
            installed: true,
            auth: 'signed-in' as const,
            models: [],
          },
        ],
        runnableAgentIds: ['team-agent'],
      };
      directoryState = {
        ...directoryState,
        runtimes: [...directoryState.runtimes, created],
      };
      return Response.json(created);
    }

    if (url === `${AGENT_RUNTIMES_API}/bridge/tokens/tok-existing` && method === 'DELETE') {
      directoryState = {
        ...directoryState,
        runtimes: directoryState.runtimes.filter(rt => rt.tokenId !== 'tok-existing'),
        tokens: directoryState.tokens.filter(tk => tk.id !== 'tok-existing'),
      };
      return Response.json({ ok: true });
    }

    return Response.json({});
  }));

  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <AgentSettings />
      </I18nProvider>,
    );
  });
  await flush();

  // Open Connected Computers view
  await act(async () => findButton('Connected Computers').click());
  await flush();

  expect(document.body.textContent).toContain('Cloud workspace');
  expect(document.body.textContent).toContain('Old Laptop');

  // Get connect command
  const labelInput = document.querySelector<HTMLInputElement>('input[aria-label="Computer name"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(labelInput, 'Studio Mac');
    labelInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => findButton('Get connect command').click());
  await flush();

  expect(document.body.textContent).toContain(`install.sh?token=${['om', 'brg', 'demo', 'fixture'].join('_')}`);

  // Switch to Windows PowerShell & Node.js tabs
  await act(async () => findButton('Windows PowerShell').click());
  expect(document.body.textContent).toContain('install.ps1');
  await act(async () => findButton('Node.js').click());
  expect(document.body.textContent).toContain('node openmotion-agent-bridge.mjs');

  // Connect and test Custom Agent Server
  await act(async () => findButton('Connect server').click());
  const svcNameInput = document.querySelector<HTMLInputElement>('input[aria-label="Server name"]')!;
  const svcUrlInput = document.querySelector<HTMLInputElement>('input[aria-label="Server URL"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(svcNameInput, 'Internal Cloud Runner');
    svcNameInput.dispatchEvent(new Event('input', { bubbles: true }));
    setter?.call(svcUrlInput, 'https://runner.internal.example');
    svcUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => findButton('Test connection').click());
  await flush();
  expect(document.body.textContent).toContain('1 Agent(s) available');

  await act(async () => findButton('Save server').click());
  await flush();
  expect(document.body.textContent).toContain('Internal Cloud Runner');

  // Disconnect existing connected computer
  await act(async () => findButton('Disconnect').click());
  await flush();
  expect(calls.some(call => call.method === 'DELETE' && call.url.endsWith('/tokens/tok-existing'))).toBe(true);
});
