import { Button } from 'open-design-ui/button';
import { useCallback, useEffect, useState } from 'react';
import {
  CONTENT_BATCH_API,
  type ContentBatchBundleReceipt,
  type ContentBatchSummary,
} from '../../../shared/content-batch';
import {
  TRIGGERS_API,
  type TriggerKind,
  type TriggerSummary,
} from '../../../shared/triggers';
import { Select } from '../components/ui/Select';
import type { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';

export function AgentAutomationCard({
  showToast,
}: {
  showToast: ReturnType<typeof useToast>['showToast'];
}) {
  const { t } = useI18n();
  const [batches, setBatches] = useState<ContentBatchSummary[]>([]);
  const [triggers, setTriggers] = useState<TriggerSummary[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [newBatchTitle, setNewBatchTitle] = useState('');
  const [newBatchTopics, setNewBatchTopics] = useState('');
  const [creatingBatch, setCreatingBatch] = useState(false);

  const [newTriggerName, setNewTriggerName] = useState('');
  const [newTriggerKind, setNewTriggerKind] = useState<TriggerKind>('manual');
  const [newTriggerTool, setNewTriggerTool] = useState('openmotion_get_project');
  const [creatingTrigger, setCreatingTrigger] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const refreshAll = useCallback(async () => {
    try {
      const [batchRes, triggerRes] = await Promise.all([
        fetch(CONTENT_BATCH_API),
        fetch(TRIGGERS_API),
      ]);
      if (batchRes.ok) {
        const data = await batchRes.json();
        if (Array.isArray(data?.batches)) setBatches(data.batches);
      }
      if (triggerRes.ok) {
        const data = await triggerRes.json();
        if (Array.isArray(data?.triggers)) setTriggers(data.triggers);
      }
    } catch {
      // Quiet fallback when offline or unmocked.
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  async function handleCreateBatch() {
    const lines = newBatchTopics
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .slice(0, 50);
    if (!lines.length) {
      showToast(t('Enter at least one item line to batch optimize.'), 'error');
      return;
    }
    setCreatingBatch(true);
    try {
      const response = await fetch(CONTENT_BATCH_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newBatchTitle.trim() || `Batch (${lines.length} items)`,
          mode: 'agent-optimize',
          concurrency: 2,
          autoStart: true,
          items: lines.map((label, idx) => ({
            id: `item-${idx + 1}`,
            label,
            variables: { topic: label },
          })),
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error || 'Could not create batch job');
      }
      setNewBatchTitle('');
      setNewBatchTopics('');
      showToast(t('Batch content optimization started'), 'info');
      void refreshAll();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not create batch job'), 'error');
    } finally {
      setCreatingBatch(false);
    }
  }

  async function handleBatchAction(
    id: string,
    action: 'start' | 'cancel' | 'retry' | 'export',
  ) {
    setBusyId(id);
    try {
      const response = await fetch(`${CONTENT_BATCH_API}/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error || 'Batch operation failed');
      }
      if (action === 'export') {
        const payload = (await response.json()) as { bundle?: ContentBatchBundleReceipt };
        if (payload.bundle?.downloadUrl) {
          window.open(payload.bundle.downloadUrl, '_blank', 'noopener,noreferrer');
        }
        showToast(t('Batch archive exported'), 'info');
      } else {
        showToast(t('Batch updated'), 'info');
      }
      void refreshAll();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Batch operation failed'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCreateTrigger() {
    setCreatingTrigger(true);
    setCreatedSecret(null);
    try {
      const response = await fetch(TRIGGERS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newTriggerName.trim() || 'MCP Automation Trigger',
          kind: newTriggerKind,
          enabled: true,
          ...(newTriggerKind === 'schedule' ? { intervalSeconds: 3600 } : {}),
          target: {
            kind: 'mcp-tool',
            tool: newTriggerTool.trim() || 'openmotion_get_project',
            arguments: {},
          },
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error || 'Could not create trigger');
      }
      const data = await response.json();
      if (typeof data?.webhookSecret === 'string') {
        setCreatedSecret(data.webhookSecret);
      }
      setNewTriggerName('');
      showToast(t('Automation trigger created'), 'info');
      void refreshAll();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not create trigger'), 'error');
    } finally {
      setCreatingTrigger(false);
    }
  }

  async function handleFireTrigger(id: string) {
    setBusyId(id);
    try {
      const response = await fetch(`${TRIGGERS_API}/${encodeURIComponent(id)}/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'studio' }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error || 'Could not run trigger');
      }
      showToast(t('Trigger executed'), 'info');
      void refreshAll();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not run trigger'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeleteTrigger(id: string) {
    setBusyId(id);
    try {
      const response = await fetch(`${TRIGGERS_API}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Could not delete trigger');
      showToast(t('Trigger removed'), 'info');
      void refreshAll();
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not remove trigger'), 'error');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="om-card om-runtime-card">
      <div className="om-runtime-card-head">
        <div className="om-runtime-row-title">
          <h2 className="om-subtitle">{t('Batch Optimization & Triggers')}</h2>
          <span className="om-badge">MCP · Agent</span>
        </div>
        <Button variant="ghost" className="om-button" onClick={() => void refreshAll()}>
          <RemixIcon name="refresh-line" size={14} />
          {t('Refresh')}
        </Button>
      </div>

      <p className="om-muted">
        {t('Run concurrent batch content jobs and automated webhook or scheduled triggers through the same MCP engine.')}
      </p>

      <details className="om-runtime-protocol-doc">
        <summary className="om-muted">
          <RemixIcon name="stack-line" size={14} /> {t('New batch optimization job')}
        </summary>
        <div className="om-runtime-stack">
          <label className="om-field om-runtime-label-input">
            <input
              type="text"
              value={newBatchTitle}
              onChange={event => setNewBatchTitle(event.target.value)}
              placeholder={t('Batch title (e.g. Launch variants)')}
              aria-label={t('Batch title')}
            />
          </label>
          <textarea
            className="om-field"
            rows={3}
            value={newBatchTopics}
            onChange={event => setNewBatchTopics(event.target.value)}
            placeholder={t('One item label or prompt brief per line (up to 50 items)')}
            aria-label={t('Batch items')}
          />
          <div>
            <Button
              variant="ghost"
              className="om-button"
              data-primary
              disabled={creatingBatch || !newBatchTopics.trim()}
              onClick={() => void handleCreateBatch()}
            >
              <RemixIcon name="play-fill" size={14} />
              {t(creatingBatch ? 'Starting…' : 'Start batch')}
            </Button>
          </div>
        </div>
      </details>

      {batches.length > 0 && (
        <div className="om-runtime-list">
          {batches.slice(0, 6).map(batch => (
            <div key={batch.id} className="om-runtime-row">
              <div className="om-runtime-row-lead">
                <span className="om-runtime-row-icon" aria-hidden="true">
                  <RemixIcon name="stack-line" size={15} />
                </span>
                <div className="om-runtime-row-main">
                  <div className="om-runtime-row-title">
                    <strong>{batch.title}</strong>
                    <span className="om-badge">{batch.state}</span>
                  </div>
                  <p className="om-muted">
                    {batch.mode} · {batch.counts.completed}/{batch.counts.total}
                    {batch.counts.failed > 0 ? ` · ${batch.counts.failed} failed` : ''}
                  </p>
                </div>
              </div>
              <div className="om-runtime-row-actions">
                {batch.state === 'running' ? (
                  <Button
                    variant="ghost"
                    className="om-button"
                    disabled={busyId === batch.id}
                    onClick={() => void handleBatchAction(batch.id, 'cancel')}
                  >
                    <RemixIcon name="stop-fill" size={14} />
                    {t('Stop')}
                  </Button>
                ) : (
                  <>
                    {batch.counts.failed > 0 && (
                      <Button
                        variant="ghost"
                        className="om-button"
                        disabled={busyId === batch.id}
                        onClick={() => void handleBatchAction(batch.id, 'retry')}
                      >
                        <RemixIcon name="refresh-line" size={14} />
                        {t('Retry failed')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      className="om-button"
                      disabled={busyId === batch.id}
                      onClick={() => void handleBatchAction(batch.id, 'export')}
                    >
                      <RemixIcon name="download-2-line" size={14} />
                      {t('Export ZIP')}
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <details className="om-runtime-protocol-doc">
        <summary className="om-muted">
          <RemixIcon name="flashlight-line" size={14} /> {t('New automation trigger')}
        </summary>
        <div className="om-runtime-stack">
          <div className="om-runtime-inline-form">
            <label className="om-field om-runtime-label-input">
              <input
                type="text"
                value={newTriggerName}
                onChange={event => setNewTriggerName(event.target.value)}
                placeholder={t('Trigger name')}
                aria-label={t('Trigger name')}
              />
            </label>
            <Select
              label={t('Trigger kind')}
              value={newTriggerKind}
              onCommit={value => setNewTriggerKind(value as TriggerKind)}
              options={[
                { value: 'manual', label: t('Manual') },
                { value: 'webhook', label: t('Webhook') },
                { value: 'schedule', label: t('Schedule (hourly)') },
              ]}
            />
            <label className="om-field om-runtime-label-input">
              <input
                type="text"
                value={newTriggerTool}
                onChange={event => setNewTriggerTool(event.target.value)}
                placeholder="openmotion_get_project"
                aria-label={t('Target MCP tool')}
              />
            </label>
            <Button
              variant="ghost"
              className="om-button"
              data-primary
              disabled={creatingTrigger}
              onClick={() => void handleCreateTrigger()}
            >
              <RemixIcon name="flashlight-line" size={14} />
              {t(creatingTrigger ? 'Creating…' : 'Create trigger')}
            </Button>
          </div>
          {createdSecret && (
            <pre className="om-code-block">{`Authorization: Bearer ${createdSecret}`}</pre>
          )}
        </div>
      </details>

      {triggers.length > 0 && (
        <div className="om-runtime-list">
          {triggers.slice(0, 6).map(trigger => (
            <div key={trigger.id} className="om-runtime-row">
              <div className="om-runtime-row-lead">
                <span className="om-runtime-row-icon" aria-hidden="true">
                  <RemixIcon name="flashlight-line" size={15} />
                </span>
                <div className="om-runtime-row-main">
                  <div className="om-runtime-row-title">
                    <strong>{trigger.name}</strong>
                    <span className="om-badge">{trigger.kind}</span>
                  </div>
                  <p className="om-muted">
                    {trigger.target.kind} · {trigger.runCount} {t('runs')}
                  </p>
                </div>
              </div>
              <div className="om-runtime-row-actions">
                <Button
                  variant="ghost"
                  className="om-button"
                  disabled={busyId === trigger.id}
                  onClick={() => void handleFireTrigger(trigger.id)}
                >
                  <RemixIcon name="play-fill" size={14} />
                  {t('Fire now')}
                </Button>
                <Button
                  variant="ghost"
                  className="om-button"
                  disabled={busyId === trigger.id}
                  onClick={() => void handleDeleteTrigger(trigger.id)}
                >
                  <RemixIcon name="delete-bin-line" size={14} />
                  {t('Delete trigger')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
