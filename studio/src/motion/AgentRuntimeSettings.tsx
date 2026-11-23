import { Button } from 'open-design-ui/button';
import { useState } from 'react';
import {
  AGENT_SERVICE_PROTOCOL,
  type AgentRuntimeDirectory,
  type AgentRuntimeInfo,
  type AgentServiceProbeResult,
  type BridgeSetupBundle,
  type RemoteServiceAuthType,
} from '../../../shared/agent-runtimes';
import { Select } from '../components/ui/Select';
import type { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { AgentAutomationCard } from './AgentAutomationCard';
import { AgentMcpTokensCard } from './AgentMcpTokensCard';
import { SettingsError, SettingsLoading } from './settingsPrimitives';
import {
  createAgentService,
  createBridgeToken,
  deleteAgentService,
  inspectBridgeAgent,
  revokeBridgeToken,
  setDefaultRuntime,
  testAgentService,
  updateAgentService,
} from './useAgentRuntimes';

type ScriptTab = 'curl' | 'powershell' | 'node' | 'local';

export function AgentRuntimeSettings({
  directory,
  error,
  onRefresh,
  showToast,
}: {
  directory: AgentRuntimeDirectory | null;
  error?: boolean;
  onRefresh: () => void;
  showToast: ReturnType<typeof useToast>['showToast'];
}) {
  const { t } = useI18n();
  const [machineLabel, setMachineLabel] = useState('');
  const [generating, setGenerating] = useState(false);
  const [bundle, setBundle] = useState<BridgeSetupBundle | null>(null);
  const [scriptTab, setScriptTab] = useState<ScriptTab>('curl');
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [addingService, setAddingService] = useState(false);
  const [svcName, setSvcName] = useState('');
  const [svcEndpoint, setSvcEndpoint] = useState('');
  const [svcAuthType, setSvcAuthType] = useState<RemoteServiceAuthType>('bearer');
  const [svcHeaderName, setSvcHeaderName] = useState('X-API-Key');
  const [svcSecret, setSvcSecret] = useState('');
  const [testingDraft, setTestingDraft] = useState(false);
  const [savingService, setSavingService] = useState(false);
  const [probePreview, setProbePreview] = useState<AgentServiceProbeResult | null>(null);

  if (error) return <SettingsError retry={onRefresh} />;
  if (!directory) return <SettingsLoading />;

  const bridgeRuntimes = directory.runtimes.filter(item => item.kind === 'local-bridge');
  const onlineCount = directory.runtimes.filter(item => item.status === 'online').length;
  const unusedTokens = directory.tokens.filter(
    token => !bridgeRuntimes.some(bridge => bridge.tokenId === token.id),
  );

  const modeBadgeLabel =
    directory.deploymentMode === 'cloud'
      ? 'Cloud workspace'
      : directory.deploymentMode === 'hybrid'
        ? 'Cloud + Local'
        : 'Running locally';

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCommand(true);
      window.setTimeout(() => setCopiedCommand(false), 1800);
      showToast(t('Copied to clipboard'), 'info');
    } catch {
      showToast(t('Could not copy. Select and copy the text manually.'), 'error');
    }
  }

  async function handleGenerateBundle() {
    setGenerating(true);
    try {
      const next = await createBridgeToken(machineLabel.trim() || undefined);
      setBundle(next);
      setMachineLabel('');
      showToast(t('Command ready. Copy and run it in Terminal.'), 'info');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not generate connect command'), 'error');
    } finally {
      setGenerating(false);
    }
  }

  async function handleRevokeToken(tokenId: string) {
    setBusyId(tokenId);
    try {
      await revokeBridgeToken(tokenId);
      if (bundle?.tokenId === tokenId) setBundle(null);
      showToast(t('Computer disconnected'), 'info');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not disconnect computer'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRescanBridge(runtime: AgentRuntimeInfo) {
    const targetAgent =
      runtime.agents.find(a => a.installed && (a.id === 'codex' || a.id === 'claude'))
      ?? runtime.agents.find(a => a.installed)
      ?? runtime.agents[0];
    if (!targetAgent) return;
    setBusyId(runtime.id);
    try {
      await inspectBridgeAgent(runtime.id, targetAgent.id);
      showToast(t('Refreshed Agents on {name}', { name: runtime.name }), 'info');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not refresh computer'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleSetDefault(runtimeId: string | null) {
    setBusyId(runtimeId || 'clear-default');
    try {
      await setDefaultRuntime(runtimeId);
      showToast(t('Default computer updated'), 'info');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not update default computer'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleTestDraft() {
    setTestingDraft(true);
    setProbePreview(null);
    try {
      const result = await testAgentService({
        endpoint: svcEndpoint,
        authType: svcAuthType,
        ...(svcAuthType === 'api-key' ? { headerName: svcHeaderName } : {}),
        ...(svcAuthType !== 'none' && svcSecret.trim() ? { apiKey: svcSecret.trim() } : {}),
      });
      setProbePreview(result);
    } catch (err) {
      setProbePreview({
        ok: false,
        agents: [],
        error: err instanceof Error ? err.message : t('Could not reach Agent server'),
      });
    } finally {
      setTestingDraft(false);
    }
  }

  async function handleSaveService() {
    setSavingService(true);
    try {
      await createAgentService({
        name: svcName.trim() || 'Custom Agent Server',
        endpoint: svcEndpoint.trim(),
        authType: svcAuthType,
        ...(svcAuthType === 'api-key' ? { headerName: svcHeaderName.trim() || 'X-API-Key' } : {}),
        ...(svcAuthType !== 'none' && svcSecret.trim() ? { apiKey: svcSecret.trim() } : {}),
      });
      setAddingService(false);
      setSvcName('');
      setSvcEndpoint('');
      setSvcSecret('');
      setProbePreview(null);
      showToast(t('Custom Agent server connected'), 'info');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not save Agent server'), 'error');
    } finally {
      setSavingService(false);
    }
  }

  async function handleTestSavedService(runtime: AgentRuntimeInfo) {
    setBusyId(runtime.id);
    try {
      const result = await testAgentService(runtime.id);
      if (result.ok) {
        showToast(
          t('Server online · {count} Agent(s) available', { count: result.agents.length }),
          'info',
        );
      } else {
        showToast(result.error || t('Agent server unreachable'), 'error');
      }
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not test Agent server'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleService(runtime: AgentRuntimeInfo) {
    setBusyId(runtime.id);
    try {
      await updateAgentService(runtime.id, { enabled: runtime.enabled === false });
      showToast(
        t(runtime.enabled === false ? 'Agent server enabled' : 'Agent server paused'),
        'info',
      );
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not update Agent server'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemoveService(runtime: AgentRuntimeInfo) {
    setBusyId(runtime.id);
    try {
      await deleteAgentService(runtime.id);
      showToast(t('Agent server removed'), 'info');
      onRefresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('Could not remove Agent server'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  const activeCommand = bundle
    ? scriptTab === 'curl'
      ? bundle.curlCommand
      : scriptTab === 'powershell'
        ? bundle.powershellCommand || `irm '${bundle.installPs1Url || `${bundle.serverUrl}/motion-api/agent-runtimes/bridge/install.ps1?token=${bundle.token}`}' | iex`
        : scriptTab === 'node'
          ? bundle.nodeCommand
          : bundle.localCommand
    : '';

  const formatRuntimeSummary = (runtime: AgentRuntimeInfo) => {
    const readyAgents = runtime.agents
      .filter(a => a.installed && a.auth !== 'signed-out')
      .map(a => a.label);
    const previewNames = readyAgents.slice(0, 3).join(', ');
    const parts: string[] = [t('{count} Agents ready', { count: runtime.runnableAgentIds.length })];
    if (previewNames) {
      parts.push(readyAgents.length > 3 ? `${previewNames}…` : previewNames);
    }
    if (runtime.kind === 'remote-service' && runtime.endpoint) {
      parts.push(runtime.endpoint);
    }
    if (runtime.error) {
      parts.push(runtime.error);
    }
    return parts.join(' · ');
  };

  return (
    <div className="om-provider-detail-inner om-runtime-page">
      {/* Compact Header */}
      <header className="om-runtime-head">
        <div className="om-provider-heading om-runtime-head-copy">
          <span className="om-creation-icon" data-tone="agent" aria-hidden="true">
            <RemixIcon name="computer-line" size={18} />
          </span>
          <div className="om-runtime-head-text">
            <h1 className="om-title">{t('Connected Computers')}</h1>
          </div>
        </div>
        <div className="om-runtime-head-actions">
          <span className="om-badge" data-active={onlineCount > 0 || undefined}>
            {t(modeBadgeLabel)}
          </span>
          <Button variant="ghost" className="om-button" onClick={onRefresh}>
            <RemixIcon name="refresh-line" size={14} />
            {t('Refresh')}
          </Button>
        </div>
      </header>

      {/* Active Devices */}
      <section className="om-card om-runtime-card">
        <div className="om-runtime-card-head">
          <h2 className="om-subtitle">{t('Devices')}</h2>
          {directory.defaultRuntimeId && (
            <Button
              variant="ghost"
              className="om-button"
              disabled={busyId === 'clear-default'}
              onClick={() => void handleSetDefault(null)}
            >
              {t('Use automatic')}
            </Button>
          )}
        </div>

        {directory.runtimes.length === 0 ? (
          <p className="om-muted om-runtime-empty-hint">
            {t('No computer connected yet.')}
          </p>
        ) : (
          <div className="om-runtime-list">
            {directory.runtimes.map(runtime => {
              const isDefault = directory.defaultRuntimeId === runtime.id;
              const isOnline = runtime.status === 'online';
              return (
                <div key={runtime.id} className="om-runtime-row">
                  <div className="om-runtime-row-lead">
                    <span className="om-runtime-row-icon" aria-hidden="true">
                      <RemixIcon
                        name={
                          runtime.kind === 'local-bridge'
                            ? 'link-line'
                            : runtime.kind === 'remote-service'
                              ? 'plug-line'
                              : 'computer-line'
                        }
                        size={16}
                      />
                    </span>
                    <div className="om-runtime-row-main">
                      <div className="om-runtime-row-title">
                        <span
                          className="om-runtime-dot"
                          data-online={isOnline || undefined}
                          aria-hidden="true"
                        />
                        <strong>{t(runtime.name)}</strong>
                        <span className="om-badge" data-active={isOnline || undefined}>
                          {t(isOnline ? 'Ready' : runtime.status === 'disabled' ? 'Paused' : 'Offline')}
                        </span>
                        {isDefault && (
                          <span className="om-badge" data-active>{t('Default')}</span>
                        )}
                      </div>
                      <small className="om-muted">{formatRuntimeSummary(runtime)}</small>
                    </div>
                  </div>
                  <div className="om-runtime-row-actions">
                    {isOnline && !isDefault && runtime.enabled !== false && (
                      <Button
                        variant="ghost"
                        className="om-button"
                        disabled={busyId === runtime.id}
                        onClick={() => void handleSetDefault(runtime.id)}
                      >
                        {t('Use by default')}
                      </Button>
                    )}
                    {runtime.kind === 'local-bridge' && isOnline && (
                      <Button
                        variant="ghost"
                        className="om-button"
                        disabled={busyId === runtime.id}
                        onClick={() => void handleRescanBridge(runtime)}
                      >
                        <RemixIcon name="refresh-line" size={14} />
                        {t('Refresh')}
                      </Button>
                    )}
                    {runtime.kind === 'local-bridge' && runtime.tokenId && (
                      <Button
                        variant="ghost"
                        className="om-button"
                        disabled={busyId === runtime.tokenId}
                        onClick={() => void handleRevokeToken(runtime.tokenId!)}
                      >
                        <RemixIcon name="delete-bin-line" size={14} />
                        {t('Disconnect')}
                      </Button>
                    )}
                    {runtime.kind === 'remote-service' && (
                      <>
                        <Button
                          variant="ghost"
                          className="om-button"
                          disabled={busyId === runtime.id}
                          onClick={() => void handleTestSavedService(runtime)}
                        >
                          <RemixIcon name="refresh-line" size={14} />
                          {t('Test')}
                        </Button>
                        <Button
                          variant="ghost"
                          className="om-button"
                          disabled={busyId === runtime.id}
                          onClick={() => void handleToggleService(runtime)}
                        >
                          {t(runtime.enabled === false ? 'Enable' : 'Pause')}
                        </Button>
                        <Button
                          variant="ghost"
                          className="om-button"
                          disabled={busyId === runtime.id}
                          onClick={() => void handleRemoveService(runtime)}
                        >
                          <RemixIcon name="delete-bin-line" size={14} />
                          {t('Remove')}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Connect a Computer: 2 clicks (Generate -> Copy) */}
      <section className="om-card om-runtime-card">
        <div className="om-runtime-card-head">
          <h2 className="om-subtitle">{t('Connect a Computer')}</h2>
        </div>

        <div className="om-control-row om-runtime-generate-row">
          <label className="om-field om-runtime-label-input">
            <RemixIcon name="computer-line" size={15} />
            <input
              type="text"
              maxLength={80}
              value={machineLabel}
              onChange={event => setMachineLabel(event.target.value)}
              placeholder={t('Computer name (optional)')}
              aria-label={t('Computer name')}
            />
          </label>
          <Button
            variant="ghost"
            className="om-button"
            data-primary
            disabled={generating}
            onClick={() => void handleGenerateBundle()}
          >
            <RemixIcon name="terminal-box-line" size={15} />
            {t(generating ? 'Creating…' : 'Get connect command')}
          </Button>
        </div>

        {bundle && (
          <div className="om-runtime-bundle">
            <div className="om-runtime-card-head">
              <div className="om-runtime-script-tabs" role="tablist" aria-label={t('Command format')}>
                {([
                  ['curl', 'Quick command'],
                  ['powershell', 'Windows PowerShell'],
                  ['node', 'Node.js'],
                  ['local', 'Local source'],
                ] as const).map(([id, label]) => (
                  <Button
                    key={id}
                    variant="plain"
                    type="button"
                    role="tab"
                    aria-selected={scriptTab === id}
                    className="om-nav-item om-runtime-script-tab"
                    onClick={() => setScriptTab(id)}
                  >
                    {t(label)}
                  </Button>
                ))}
              </div>
              <div className="om-runtime-row-actions">
                <Button
                  variant="ghost"
                  className="om-button"
                  data-primary
                  onClick={() => void handleCopy(activeCommand)}
                >
                  <RemixIcon name={copiedCommand ? 'check-line' : 'copy-line'} size={14} />
                  {t(copiedCommand ? 'Copied' : 'Copy command')}
                </Button>
                <a
                  className="om-button"
                  href={bundle.scriptUrl}
                  download="openmotion-agent-bridge.mjs"
                >
                  <RemixIcon name="external-link-line" size={14} />
                  {t('Download .mjs')}
                </a>
              </div>
            </div>

            <pre className="om-code-block">{activeCommand}</pre>
          </div>
        )}

        {unusedTokens.length > 0 && (
          <div className="om-runtime-list">
            {unusedTokens.map(token => (
              <div key={token.id} className="om-runtime-row">
                <div className="om-runtime-row-lead">
                  <span className="om-runtime-row-icon" aria-hidden="true">
                    <RemixIcon name="terminal-box-line" size={15} />
                  </span>
                  <div className="om-runtime-row-main">
                    <div className="om-runtime-row-title">
                      <span className="om-runtime-dot" aria-hidden="true" />
                      <strong>{token.label}</strong>
                      <span className="om-badge">{t('Waiting for Terminal')}</span>
                    </div>
                  </div>
                </div>
                <div className="om-runtime-row-actions">
                  <Button
                    variant="ghost"
                    className="om-button"
                    disabled={busyId === token.id}
                    onClick={() => void handleRevokeToken(token.id)}
                  >
                    <RemixIcon name="delete-bin-line" size={14} />
                    {t('Cancel')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <details className="om-runtime-protocol-doc">
          <summary className="om-muted">
            {t('How it works')}
          </summary>
          <p className="om-muted om-runtime-help-text">
            {t('Click "Get connect command", copy it, and paste it into Terminal on your Mac, Windows, or Linux computer. Local Agents (Codex, Claude Code, etc.) appear above automatically and your logins stay on your device.')}
          </p>
        </details>
      </section>

      {/* Custom Agent Server (compact toggle) */}
      <section className="om-card om-runtime-card">
        <div className="om-runtime-card-head">
          <div className="om-runtime-row-title">
            <h2 className="om-subtitle">{t('Custom Agent Server')}</h2>
            <span className="om-badge">{t('Optional')}</span>
          </div>
          <Button
            variant="ghost"
            className="om-button"
            onClick={() => {
              setAddingService(value => !value);
              setProbePreview(null);
            }}
          >
            <RemixIcon name={addingService ? 'close-line' : 'add-line'} size={14} />
            {t(addingService ? 'Cancel' : 'Connect server')}
          </Button>
        </div>

        {addingService && (
          <form
            className="om-runtime-service-form"
            onSubmit={event => {
              event.preventDefault();
              void handleSaveService();
            }}
          >
            <div className="om-runtime-form-grid">
              <label className="om-label">
                <span>{t('Server name')}</span>
                <span className="om-field">
                  <input
                    type="text"
                    required
                    maxLength={80}
                    value={svcName}
                    onChange={event => setSvcName(event.target.value)}
                    placeholder={t('e.g. Team Cloud Runner')}
                    aria-label={t('Server name')}
                  />
                </span>
              </label>
              <label className="om-label">
                <span>{t('Server URL')}</span>
                <span className="om-field">
                  <input
                    type="url"
                    required
                    value={svcEndpoint}
                    onChange={event => setSvcEndpoint(event.target.value)}
                    placeholder="https://agent.example.com"
                    aria-label={t('Server URL')}
                  />
                </span>
              </label>
              <div className="om-label">
                <span>{t('Authentication')}</span>
                <Select
                  label={t('Authentication')}
                  value={svcAuthType}
                  onCommit={value => setSvcAuthType(value as RemoteServiceAuthType)}
                  options={[
                    { value: 'bearer', label: t('Bearer token') },
                    { value: 'api-key', label: t('API key header') },
                    { value: 'none', label: t('None (trusted network)') },
                  ]}
                />
              </div>
              {svcAuthType !== 'none' && (
                <label className="om-label">
                  <span>{t('API key / Token')}</span>
                  <span className="om-field">
                    <input
                      type="password"
                      value={svcSecret}
                      onChange={event => setSvcSecret(event.target.value)}
                      placeholder={t('Stored privately on the server')}
                      aria-label={t('API key / Token')}
                    />
                  </span>
                </label>
              )}
              {svcAuthType === 'api-key' && (
                <label className="om-label">
                  <span>{t('Header name')}</span>
                  <span className="om-field">
                    <input
                      type="text"
                      value={svcHeaderName}
                      onChange={event => setSvcHeaderName(event.target.value)}
                      placeholder="X-API-Key"
                      aria-label={t('Header name')}
                    />
                  </span>
                </label>
              )}
            </div>

            {probePreview && (
              <div className="om-runtime-probe-result" data-ok={probePreview.ok || undefined}>
                <RemixIcon name={probePreview.ok ? 'check-line' : 'close-line'} size={15} />
                <span>
                  {probePreview.ok
                    ? t('Connected · {count} Agent(s) available', {
                        count: probePreview.agents.length,
                      })
                    : probePreview.error || t('Connection failed')}
                </span>
              </div>
            )}

            <div className="om-runtime-form-footer">
              <Button
                variant="ghost"
                type="button"
                className="om-button"
                disabled={testingDraft || !svcEndpoint.trim()}
                onClick={() => void handleTestDraft()}
              >
                <RemixIcon name="refresh-line" size={14} />
                {t(testingDraft ? 'Testing…' : 'Test connection')}
              </Button>
              <Button
                variant="ghost"
                type="submit"
                className="om-button"
                data-primary
                disabled={savingService || !svcEndpoint.trim()}
              >
                <RemixIcon name="check-line" size={14} />
                {t(savingService ? 'Saving…' : 'Save server')}
              </Button>
            </div>
          </form>
        )}

        <details className="om-runtime-protocol-doc">
          <summary className="om-muted">
            <RemixIcon name="code-s-slash-line" size={14} />{' '}
            {t('API protocol ({protocol})', { protocol: AGENT_SERVICE_PROTOCOL })}
          </summary>
          <pre className="om-code-block">{`GET  /health                     -> { ok: true, protocol: "${AGENT_SERVICE_PROTOCOL}", version }
GET  /v1/agents                  -> { agents: [{ id, label, models: [{ id, label, reasoning? }] }] }
POST /v1/runs                    -> SSE stream: thread.started | message.delta | tool.call | artifact.upsert | turn.completed | turn.failed
POST /v1/runs/:runId/tool-results -> { callId, ok, contentItems, structuredContent }
POST /v1/runs/:runId/cancel      -> { ok: true }`}</pre>
        </details>
      </section>

      <AgentMcpTokensCard showToast={showToast} />
      <AgentAutomationCard showToast={showToast} />
    </div>
  );
}
