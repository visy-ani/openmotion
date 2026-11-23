import { Button } from 'open-design-ui/button';
import { useCallback, useEffect, useState } from 'react';
import {
  MCP_STATUS_API,
  MCP_TOKENS_API,
  type CreatedMcpToken,
  type McpHttpStatus,
  type McpTokenScope,
} from '../../../shared/mcp-http';
import { Select } from '../components/ui/Select';
import type { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';

export function AgentMcpTokensCard({
  showToast,
}: {
  showToast: ReturnType<typeof useToast>['showToast'];
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<McpHttpStatus | null>(null);
  const [label, setLabel] = useState('');
  const [scope, setScope] = useState<McpTokenScope>('write');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedMcpToken | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch(MCP_STATUS_API);
      if (!response.ok) return;
      const data = (await response.json()) as Partial<McpHttpStatus>;
      if (data && typeof data.publicEndpoint === 'string' && Array.isArray(data.tokens)) {
        setStatus(data as McpHttpStatus);
      }
    } catch {
      // Optional status card stays quiet when offline or unmocked.
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('Copied to clipboard'), 'info');
    } catch {
      showToast(t('Could not copy. Select and copy the text manually.'), 'error');
    }
  }

  async function handleCreateToken() {
    setCreating(true);
    try {
      const response = await fetch(MCP_TOKENS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label.trim() || 'Remote MCP Client',
          scope,
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error || 'Could not create MCP token');
      }
      const next = (await response.json()) as CreatedMcpToken;
      setCreated(next);
      setLabel('');
      showToast(t('MCP access token ready. Copy it now — it is shown once.'), 'info');
      void loadStatus();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not create MCP token'), 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleRevokeToken(id: string) {
    setRevokingId(id);
    try {
      const response = await fetch(`${MCP_TOKENS_API}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error('Could not revoke MCP token');
      }
      if (created?.summary.id === id) {
        setCreated(null);
      }
      showToast(t('MCP access token revoked'), 'info');
      void loadStatus();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not revoke MCP token'), 'error');
    } finally {
      setRevokingId(null);
    }
  }

  const tokens = status?.tokens ?? [];
  const activeTokens = tokens.filter(item => !item.revoked);

  return (
    <section className="om-card om-runtime-card">
      <div className="om-runtime-card-head">
        <div className="om-runtime-row-title">
          <h2 className="om-subtitle">{t('Remote MCP Server')}</h2>
          <span className="om-badge">
            {t(status?.authRequired ? 'Bearer token required' : 'Local & Bearer')}
          </span>
        </div>
        {status?.publicEndpoint && (
          <Button
            variant="ghost"
            className="om-button"
            onClick={() => void copyText(status.publicEndpoint)}
          >
            <RemixIcon name="file-copy-line" size={14} />
            {t('Copy MCP URL')}
          </Button>
        )}
      </div>

      {status?.publicEndpoint && (
        <p className="om-muted">
          <code>{status.publicEndpoint}</code> · {t('{count} active sessions', { count: status.activeSessions ?? 0 })}
        </p>
      )}

      <div className="om-runtime-inline-form">
        <label className="om-field om-runtime-label-input">
          <RemixIcon name="shield-check-line" size={15} />
          <input
            type="text"
            maxLength={80}
            value={label}
            onChange={event => setLabel(event.target.value)}
            placeholder={t('Client label (e.g. Cloud Agent)')}
            aria-label={t('MCP token label')}
          />
        </label>
        <Select
          label={t('Scope')}
          value={scope}
          onCommit={value => setScope(value as McpTokenScope)}
          options={[
            { value: 'read', label: t('Read only') },
            { value: 'write', label: t('Read & write') },
            { value: 'admin', label: t('Admin') },
          ]}
        />
        <Button
          variant="ghost"
          className="om-button"
          data-primary
          disabled={creating}
          onClick={() => void handleCreateToken()}
        >
          <RemixIcon name="plug-line" size={14} />
          {t(creating ? 'Creating…' : 'Issue MCP token')}
        </Button>
      </div>

      {created && (
        <div className="om-runtime-bundle">
          <div className="om-runtime-card-head">
            <span className="om-muted">{t('Token created ({label})', { label: created.summary.label })}</span>
            <div className="om-runtime-row-actions">
              <Button
                variant="ghost"
                className="om-button"
                data-primary
                onClick={() => void copyText(created.configs.streamableHttpJson)}
              >
                <RemixIcon name="file-copy-line" size={14} />
                {t('Copy MCP JSON')}
              </Button>
              <Button
                variant="ghost"
                className="om-button"
                onClick={() => void copyText(created.configs.claudeCli)}
              >
                <RemixIcon name="terminal-box-line" size={14} />
                {t('Copy Claude CLI')}
              </Button>
            </div>
          </div>
          <pre className="om-code-block">{created.configs.streamableHttpJson}</pre>
        </div>
      )}

      {activeTokens.length > 0 && (
        <div className="om-runtime-list">
          {activeTokens.map(token => (
            <div key={token.id} className="om-runtime-row">
              <div className="om-runtime-row-lead">
                <span className="om-runtime-row-icon" aria-hidden="true">
                  <RemixIcon name="shield-check-line" size={15} />
                </span>
                <div className="om-runtime-row-main">
                  <div className="om-runtime-row-title">
                    <strong>{token.label}</strong>
                    <span className="om-badge">{token.scope}</span>
                    <code>{token.prefix}…</code>
                  </div>
                </div>
              </div>
              <div className="om-runtime-row-actions">
                <Button
                  variant="ghost"
                  className="om-button"
                  disabled={revokingId === token.id}
                  onClick={() => void handleRevokeToken(token.id)}
                >
                  <RemixIcon name="delete-bin-line" size={14} />
                  {t('Revoke token')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
