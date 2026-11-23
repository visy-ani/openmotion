import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import type {
  SuperAgentArtifact,
  SuperAgentChat,
  SuperAgentFileOperation,
  SuperAgentMessage,
  SuperAgentResourceAttachment,
  SuperAgentToolCategory,
  SuperAgentToolEvent,
} from '../../../shared/super-agent';
import { Tooltip } from '../components/ui/Tooltip';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { WorkingIndicator } from '../motion/AssetCreationVisuals';
import { resourceIcon, resourceKey } from './ResourcePickerDialog';
import { SimpleMarkdown } from './SimpleMarkdown';

type TurnGroup = {
  id: string;
  user?: SuperAgentMessage;
  workItems: SuperAgentMessage[];
  assistantItems: SuperAgentMessage[];
  changedFiles: SuperAgentFileOperation[];
  artifacts: SuperAgentArtifact[];
  hasRunning: boolean;
  hasFailure: boolean;
  durationMs?: number;
};

export function formatElapsedDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.max(10, Math.round(ms))}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.round(secs % 60);
  return `${mins}m ${remSecs}s`;
}

function useLiveElapsedMs(startedAt: number | undefined, active: boolean, intervalMs = 500): number {
  const [elapsedMs, setElapsedMs] = useState(() =>
    active && typeof startedAt === 'number' ? Math.max(0, Date.now() - startedAt) : 0,
  );
  useEffect(() => {
    if (!active || typeof startedAt !== 'number') {
      setElapsedMs(0);
      return;
    }
    const tick = () => setElapsedMs(Math.max(0, Date.now() - startedAt));
    tick();
    const timer = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, startedAt, intervalMs]);
  return elapsedMs;
}

function countCompletedWorkItems(workItems: SuperAgentMessage[]): number {
  let completed = 0;
  for (const item of workItems) {
    if (item.role === 'tool') {
      if (item.toolEvent?.status && item.toolEvent.status !== 'running') completed += 1;
    } else if (item.status !== 'streaming') {
      completed += 1;
    }
  }
  return completed;
}

function resolveLiveTurnStatusText(
  t: (key: string, vars?: Record<string, string | number>) => string,
  options: { chat: SuperAgentChat | null; sending?: boolean; engineLabel?: string },
): string {
  if (options.sending && options.chat?.state !== 'running' && options.chat?.state !== 'waiting') {
    return t('Sending…');
  }
  const activity = options.chat?.turnActivity;
  const phase = activity?.phase ?? 'thinking';
  const targetLabel = activity?.label || options.engineLabel || 'Super Agent';
  if (phase === 'connecting') return t('Connecting to {agent}…', { agent: targetLabel });
  if (phase === 'tool') return t(activity?.label || 'Running {tool}…', { tool: activity?.activeToolName || 'tool' });
  if (phase === 'streaming') return t('Writing response…');
  if (phase === 'waiting_approval') return t('Waiting for approval…');
  return t('Thinking…');
}

function categoryIcon(category: SuperAgentToolCategory | undefined, status: SuperAgentToolEvent['status']): string {
  if (status === 'running') return 'loader-4-line';
  if (status === 'failed') return 'error-warning-line';
  switch (category) {
    case 'command':
      return 'terminal-box-fill';
    case 'file_read':
      return 'file-text-line';
    case 'file_write':
      return 'file-add-line';
    case 'file_edit':
      return 'file-code-line';
    case 'file_delete':
      return 'delete-bin-line';
    case 'search':
      return 'search-line';
    case 'web':
      return 'global-line';
    case 'mcp':
      return 'apps-2-line';
    case 'agent':
      return 'robot-fill';
    default:
      return 'code-s-slash-line';
  }
}

function artifactDeliverableMeta(artifact: SuperAgentArtifact): {
  icon: string;
  tone: 'coding' | 'image' | 'video' | 'audio' | 'agent';
  typeLabel: string;
} {
  switch (artifact.kind) {
    case 'design-project':
      if (artifact.scenario === 'deck' || artifact.scenario === 'document') {
        return { icon: 'slideshow-line', tone: 'audio', typeLabel: 'Slides & Docs' };
      }
      return { icon: 'layout-line', tone: 'agent', typeLabel: 'Interactive Prototype' };
    case 'motion-project':
      return { icon: 'movie-line', tone: 'video', typeLabel: 'Motion Video' };
    case 'motion-export':
      return { icon: 'clapperboard-line', tone: 'video', typeLabel: 'Motion Video' };
    case 'asset-image':
      return { icon: 'image-line', tone: 'image', typeLabel: 'Image Artwork' };
    case 'asset-video':
      return { icon: 'film-line', tone: 'video', typeLabel: 'Video Asset' };
    case 'asset-audio':
      return { icon: 'music-2-line', tone: 'audio', typeLabel: 'Audio Track' };
    case 'brand-kit':
      return { icon: 'palette-line', tone: 'image', typeLabel: 'Brand Kit' };
    case 'game-project':
      return { icon: 'sparkling-line', tone: 'agent', typeLabel: 'HTML Game' };
    case 'web':
      return { icon: 'global-line', tone: 'coding', typeLabel: 'Web Page' };
    default:
      return { icon: 'file-line', tone: 'agent', typeLabel: 'Artifact' };
  }
}

const RAW_ARTIFACT_SUBTITLES = new Set([
  'prototype',
  'website',
  'deck',
  'document',
  'game',
  'motion',
  'video',
  'image',
  'audio',
  'brand-kit',
  'design-project',
  'motion-project',
  'game-project',
]);

function collectTurnFiles(workItems: SuperAgentMessage[]): SuperAgentFileOperation[] {
  const byPath = new Map<string, SuperAgentFileOperation>();
  for (const item of workItems) {
    if (item.role !== 'tool' || !item.toolEvent) continue;
    const ev = item.toolEvent;
    const candidates = ev.files?.length ? ev.files : ev.fileOp ? [ev.fileOp] : [];
    for (const op of candidates) {
      if (!op.path || op.action === 'read') continue;
      const existing = byPath.get(op.path);
      if (!existing) {
        byPath.set(op.path, { ...op });
      } else {
        byPath.set(op.path, {
          ...existing,
          action: existing.action === 'create' && op.action === 'edit' ? 'create' : op.action,
          addedLines: (existing.addedLines ?? 0) + (op.addedLines ?? 0) || existing.addedLines || op.addedLines,
          removedLines: (existing.removedLines ?? 0) + (op.removedLines ?? 0) || existing.removedLines || op.removedLines,
          diffPreview: op.diffPreview || existing.diffPreview,
        });
      }
    }
  }
  return [...byPath.values()];
}

function groupMessagesIntoTurns(chat: SuperAgentChat): TurnGroup[] {
  const artifactsById = new Map(chat.artifacts.map(a => [a.id, a]));
  const rawTurns: { user?: SuperAgentMessage; rest: SuperAgentMessage[] }[] = [];

  for (const msg of chat.messages) {
    if (msg.role === 'user') {
      rawTurns.push({ user: msg, rest: [] });
    } else {
      if (!rawTurns.length) rawTurns.push({ rest: [] });
      rawTurns[rawTurns.length - 1].rest.push(msg);
    }
  }

  const claimedArtifactIds = new Set<string>();
  return rawTurns.map((group, idx) => {
    const workItems = group.rest.filter(m => m.role === 'reasoning' || m.role === 'tool');
    const assistantItems = group.rest.filter(m => m.role === 'assistant');
    const artifactIds = new Set<string>();
    for (const m of group.rest) {
      if (m.toolEvent?.artifactId) {
        artifactIds.add(m.toolEvent.artifactId);
        claimedArtifactIds.add(m.toolEvent.artifactId);
      }
      if (m.artifactIds) {
        for (const id of m.artifactIds) {
          artifactIds.add(id);
          claimedArtifactIds.add(id);
        }
      }
    }
    const turnStart = group.user?.createdAt ?? group.rest[0]?.createdAt ?? 0;
    const nextTurnStart = rawTurns[idx + 1]?.user?.createdAt ?? rawTurns[idx + 1]?.rest[0]?.createdAt;
    for (const artifact of chat.artifacts) {
      if (claimedArtifactIds.has(artifact.id)) continue;
      const ts = artifact.updatedAt || artifact.createdAt;
      if (ts >= turnStart && (nextTurnStart === undefined || ts < nextTurnStart)) {
        artifactIds.add(artifact.id);
        claimedArtifactIds.add(artifact.id);
      }
    }
    const artifacts = [...artifactIds]
      .map(id => artifactsById.get(id))
      .filter((a): a is SuperAgentArtifact => Boolean(a));
    const changedFiles = collectTurnFiles(workItems);
    const hasRunning = workItems.some(
      m => m.status === 'streaming' || m.toolEvent?.status === 'running',
    );
    const hasFailure = workItems.some(m => m.toolEvent?.status === 'failed');

    let durationMs: number | undefined;
    if (idx === rawTurns.length - 1 && chat.lastTurnDurationMs !== undefined) {
      durationMs = chat.lastTurnDurationMs;
    } else if (group.user && group.rest.length > 0) {
      const last = group.rest[group.rest.length - 1];
      const endTs = last.toolEvent?.finishedAt ?? last.createdAt;
      if (endTs >= group.user.createdAt) {
        durationMs = endTs - group.user.createdAt;
      }
    }

    return {
      id: group.user?.id ?? `turn-${idx}`,
      user: group.user,
      workItems,
      assistantItems,
      changedFiles,
      artifacts,
      hasRunning,
      hasFailure,
      durationMs,
    };
  });
}

function UnifiedDiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.split('\n').slice(0, 120), [diff]);
  return (
    <pre className="om-sa-diff-pre">
      {lines.map((line, i) => {
        const kind = line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')
          ? 'meta'
          : line.startsWith('+')
            ? 'add'
            : line.startsWith('-')
              ? 'del'
              : 'ctx';
        return (
          <span key={i} className="om-sa-diff-line" data-kind={kind}>
            {line}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

function ToolStepRow({
  message,
  onOpenArtifactId,
}: {
  message: SuperAgentMessage;
  onOpenArtifactId: (artifactId: string) => void;
}) {
  const { t } = useI18n();
  const ev = message.toolEvent;
  const isRunning = ev?.status === 'running';
  const liveElapsedMs = useLiveElapsedMs(ev?.startedAt, isRunning);
  if (!ev) return null;
  const status = ev.status ?? 'completed';
  const fileOp = ev.fileOp ?? ev.files?.[0];
  const diffFiles = (ev.files ?? (fileOp ? [fileOp] : [])).filter(f => f.diffPreview);
  const hasBody = Boolean(ev.command || diffFiles.length > 0 || ev.inputPreview || ev.outputPreview);
  const displayDurationMs = status === 'running'
    ? (liveElapsedMs >= 1000 ? liveElapsedMs : undefined)
    : ev.durationMs;

  return (
    <details className="om-sa-tool-row" open={status === 'failed' || undefined}>
      <summary>
        <span
          className="om-sa-tool-status"
          data-status={status}
          data-category={ev.category || 'tool'}
        >
          <RemixIcon name={categoryIcon(ev.category, status)} size={15} />
        </span>
        <span className="om-sa-tool-label">{t(ev.label || message.text)}</span>
        {ev.summary && ev.summary !== ev.label && (
          <span className="om-sa-tool-summary" title={ev.summary}>{ev.summary}</span>
        )}
        <span className="om-sa-step-trail">
          {fileOp && (fileOp.addedLines !== undefined || fileOp.removedLines !== undefined) && (
            <span className="om-sa-diff-badges">
              {fileOp.addedLines !== undefined && fileOp.addedLines > 0 && (
                <span className="om-sa-diff-add">+{fileOp.addedLines}</span>
              )}
              {fileOp.removedLines !== undefined && fileOp.removedLines > 0 && (
                <span className="om-sa-diff-del">-{fileOp.removedLines}</span>
              )}
            </span>
          )}
          {ev.exitCode !== undefined && (
            <span className="om-sa-exit-pill" data-ok={ev.exitCode === 0 || undefined}>
              {ev.exitCode === 0 ? 'exit 0' : `exit ${ev.exitCode}`}
            </span>
          )}
          {displayDurationMs !== undefined && (
            <span className="om-sa-step-time">{formatElapsedDuration(displayDurationMs)}</span>
          )}
          {ev.artifactId && (
            <Button
              variant="plain"
              type="button"
              className="om-sa-tool-view-btn"
              onClick={event => {
                event.preventDefault();
                event.stopPropagation();
                onOpenArtifactId(ev.artifactId!);
              }}
            >
              <span>{t('View in Viewer')}</span>
              <RemixIcon name="arrow-right-up-line" size={13} />
            </Button>
          )}
          {hasBody && (
            <span className="om-sa-step-chevron" aria-hidden="true">
              <RemixIcon name="arrow-down-s-line" size={14} />
            </span>
          )}
        </span>
      </summary>
      {hasBody && (
        <div className="om-sa-tool-body">
          {ev.command && (
            <div className="om-sa-cmd-block">
              <span className="om-sa-cmd-prompt" aria-hidden="true">$</span>
              <code>{ev.command}</code>
            </div>
          )}
          {diffFiles.map((file, idx) => (
            <div key={`${file.path}-${idx}`} className="om-sa-diff-card">
              <div className="om-sa-diff-head">
                <span className="om-sa-diff-path">{file.path}</span>
                <span className="om-sa-diff-badges">
                  {file.addedLines !== undefined && <span className="om-sa-diff-add">+{file.addedLines}</span>}
                  {file.removedLines !== undefined && <span className="om-sa-diff-del">-{file.removedLines}</span>}
                </span>
              </div>
              {file.diffPreview && <UnifiedDiffView diff={file.diffPreview} />}
            </div>
          ))}
          {ev.inputPreview && ev.category !== 'command' && diffFiles.length === 0 && (
            <div className="om-sa-tool-section">
              <span className="om-sa-tool-section-label">{t('Input')}</span>
              <pre className="om-sa-tool-pre">{ev.inputPreview}</pre>
            </div>
          )}
          {ev.outputPreview && (
            <div className="om-sa-tool-section">
              <span className="om-sa-tool-section-label">{t('Output')}</span>
              <pre className="om-sa-tool-pre">{ev.outputPreview}</pre>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

function ReasoningStepRow({ message }: { message: SuperAgentMessage }) {
  const { t } = useI18n();
  const isStreaming = message.status === 'streaming';
  const liveElapsedMs = useLiveElapsedMs(message.createdAt, isStreaming);
  const durationLabel = !isStreaming && message.durationMs !== undefined
    ? t('Thought for {duration}', { duration: formatElapsedDuration(message.durationMs) })
    : isStreaming
      ? (liveElapsedMs >= 1000
          ? `${t('Thinking…')} · ${formatElapsedDuration(liveElapsedMs)}`
          : t('Thinking…'))
      : t('Reasoning');

  return (
    <details className="om-sa-reasoning-row" open={isStreaming || undefined}>
      <summary>
        <span className="om-sa-reasoning-icon" data-streaming={isStreaming || undefined}>
          <RemixIcon name={isStreaming ? 'loader-4-line' : 'sparkling-line'} size={14} />
        </span>
        <span className="om-sa-reasoning-label">{durationLabel}</span>
        {!isStreaming && message.text && (
          <span className="om-sa-tool-summary">{message.text.slice(0, 120)}</span>
        )}
        <span className="om-sa-step-trail">
          <span className="om-sa-step-chevron" aria-hidden="true">
            <RemixIcon name="arrow-down-s-line" size={14} />
          </span>
        </span>
      </summary>
      {message.text && (
        <div className="om-sa-reasoning-body">
          {message.text.trim().split(/\n{2,}/).map((para, idx) => (
            <p key={idx} className="om-sa-reasoning-para">{para.trim()}</p>
          ))}
        </div>
      )}
    </details>
  );
}

function displayChangedFilePath(raw: string): string {
  const scratchMatch = raw.match(/super-agent\/work\/[^/]+\/(.+)$/);
  if (scratchMatch?.[1]) return scratchMatch[1];
  return raw;
}

function FilesChangedCard({
  files,
  onCopyText,
}: {
  files: SuperAgentFileOperation[];
  onCopyText: (text: string) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [openDiffs, setOpenDiffs] = useState<Record<string, boolean>>({});
  if (!files.length) return null;

  const totalAdd = files.reduce((sum, f) => sum + (f.addedLines ?? 0), 0);
  const totalDel = files.reduce((sum, f) => sum + (f.removedLines ?? 0), 0);

  return (
    <div className="om-sa-files-changed">
      <Button
        variant="plain"
        type="button"
        className="om-sa-files-changed-head"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
      >
        <RemixIcon name="file-code-line" size={14} />
        <span className="om-sa-files-changed-title">
          {t('Files changed ({count})', { count: files.length })}
        </span>
        {(totalAdd > 0 || totalDel > 0) && (
          <span className="om-sa-diff-badges">
            {totalAdd > 0 && <span className="om-sa-diff-add">+{totalAdd}</span>}
            {totalDel > 0 && <span className="om-sa-diff-del">-{totalDel}</span>}
          </span>
        )}
        <span className="om-sa-files-changed-chevron" data-open={expanded || undefined}>
          <RemixIcon name="arrow-down-s-line" size={14} />
        </span>
      </Button>
      {expanded && (
        <div className="om-sa-files-changed-list">
          {files.map(file => {
            const hasDiff = Boolean(file.diffPreview);
            const diffOpen = Boolean(openDiffs[file.path]);
            const labelPath = displayChangedFilePath(file.path);
            return (
              <div key={file.path} className="om-sa-file-change-item">
                <div className="om-sa-file-change-row">
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-file-row-trigger"
                    aria-expanded={hasDiff ? diffOpen : undefined}
                    title={file.path}
                    onClick={() => {
                      if (hasDiff) {
                        setOpenDiffs(prev => ({ ...prev, [file.path]: !prev[file.path] }));
                      } else {
                        onCopyText(file.path);
                      }
                    }}
                  >
                    <span
                      className="om-sa-file-row-chevron"
                      data-open={diffOpen || undefined}
                      data-hidden={!hasDiff || undefined}
                      aria-hidden="true"
                    >
                      <RemixIcon name="arrow-down-s-line" size={13} />
                    </span>
                    <span className="om-sa-file-action-badge" data-action={file.action}>
                      {file.action === 'create' ? 'A' : file.action === 'delete' ? 'D' : 'M'}
                    </span>
                    <span className="om-sa-file-path-text">{labelPath}</span>
                    <span className="om-sa-file-row-trail">
                      {(file.addedLines !== undefined && file.addedLines > 0) || (file.removedLines !== undefined && file.removedLines > 0) ? (
                        <span className="om-sa-diff-badges">
                          {file.addedLines !== undefined && file.addedLines > 0 && (
                            <span className="om-sa-diff-add">+{file.addedLines}</span>
                          )}
                          {file.removedLines !== undefined && file.removedLines > 0 && (
                            <span className="om-sa-diff-del">-{file.removedLines}</span>
                          )}
                        </span>
                      ) : null}
                    </span>
                  </Button>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    className="om-sa-file-copy-btn"
                    aria-label={t('Copy path')}
                    title={t('Copy path')}
                    onClick={() => onCopyText(file.path)}
                    icon={<RemixIcon name="file-copy-line" size={12} />}
                  />
                </div>
                {hasDiff && diffOpen && file.diffPreview && (
                  <div className="om-sa-file-diff-drawer">
                    <UnifiedDiffView diff={file.diffPreview} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WorkLogSection({
  turn,
  isActiveTurn,
  onOpenArtifactId,
}: {
  turn: TurnGroup;
  isActiveTurn: boolean;
  onOpenArtifactId: (artifactId: string) => void;
}) {
  const { t } = useI18n();
  const isTurnFinished = !isActiveTurn && !turn.hasRunning && turn.assistantItems.length > 0;
  const shouldAutoExpand = !isTurnFinished;
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const isRunning = isActiveTurn || turn.hasRunning;
  const liveStart = turn.workItems[0]?.createdAt ?? turn.user?.createdAt;
  const liveRunningMs = useLiveElapsedMs(liveStart, isRunning);

  useEffect(() => {
    if (isTurnFinished) {
      setUserToggled(null);
    }
  }, [isTurnFinished]);

  const expanded = userToggled ?? shouldAutoExpand;

  if (!turn.workItems.length) return null;

  const toolCount = turn.workItems.filter(m => m.role === 'tool').length;
  const stepCount = turn.workItems.length;
  const completedCount = countCompletedWorkItems(turn.workItems);
  const durationStr = formatElapsedDuration(turn.durationMs);
  const summaryTitle = isRunning
    ? (completedCount > 0
        ? t('Running steps ({done}/{total})', { done: completedCount, total: stepCount })
        : t('Running steps ({count})', { count: stepCount }))
    : durationStr
      ? t('Worked for {duration} · {count} steps', { duration: durationStr, count: stepCount })
      : toolCount > 0
        ? t('Execution steps ({count})', { count: stepCount })
        : t('Thought');

  return (
    <div className="om-sa-work-log" data-active={isActiveTurn || undefined}>
      <Button
        variant="plain"
        type="button"
        className="om-sa-work-summary-btn"
        aria-expanded={expanded}
        onClick={() => setUserToggled(prev => !(prev ?? shouldAutoExpand))}
      >
        {isRunning && (
          <span className="om-sa-work-summary-spinner" aria-hidden="true">
            <RemixIcon name="loader-4-line" size={13} />
          </span>
        )}
        <span className="om-sa-work-summary-label">{summaryTitle}</span>
        {isRunning && liveRunningMs >= 1000 && (
          <span className="om-sa-work-summary-timer">{formatElapsedDuration(liveRunningMs)}</span>
        )}
        {!isTurnFinished && turn.hasFailure && (
          <span className="om-sa-work-pill" data-tone="danger">
            {t('Needs attention')}
          </span>
        )}
        <span className="om-sa-work-chevron" data-open={expanded || undefined}>
          <RemixIcon name="arrow-down-s-line" size={14} />
        </span>
      </Button>
      {expanded && (
        <div className="om-sa-work-items">
          {turn.workItems.map(item =>
            item.role === 'reasoning' ? (
              <ReasoningStepRow key={item.id} message={item} />
            ) : (
              <ToolStepRow
                key={item.id}
                message={item}
                onOpenArtifactId={onOpenArtifactId}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function LivePlanCard({ plan }: { plan: NonNullable<SuperAgentChat['turnActivity']>['plan'] }) {
  const { t } = useI18n();
  if (!plan || !plan.length) return null;
  return (
    <div className="om-sa-plan-card">
      <div className="om-sa-plan-head">{t('Plan')}</div>
      <ul className="om-sa-plan-list">
        {plan.map((entry, idx) => (
          <li key={idx} className="om-sa-plan-item" data-status={entry.status}>
            <RemixIcon
              name={
                entry.status === 'completed'
                  ? 'checkbox-circle-line'
                  : entry.status === 'in_progress'
                    ? 'loader-4-line'
                    : 'checkbox-blank-line'
              }
              size={14}
            />
            <span>{entry.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LiveTurnStatusBar({
  chat,
  engineLabel,
}: {
  chat: SuperAgentChat;
  engineLabel?: string;
}) {
  const { t } = useI18n();
  const startedAt = chat.turnActivity?.startedAt || chat.updatedAt;
  const elapsedMs = useLiveElapsedMs(startedAt, true, 200);
  const statusText = resolveLiveTurnStatusText(t, { chat, engineLabel });

  return (
    <div className="om-sa-live-status-wrap">
      <div className="om-creation-thinking om-sa-thinking om-sa-live-status" role="status">
        <WorkingIndicator />
        <span className="om-sa-live-status-label">{statusText}</span>
        <span className="om-sa-live-timer">{formatElapsedDuration(elapsedMs)}</span>
      </div>
      <LivePlanCard plan={chat.turnActivity?.plan} />
    </div>
  );
}

export function SuperAgentLiveProgressDock({
  chat,
  busy,
  sending,
  engineLabel,
}: {
  chat: SuperAgentChat | null;
  busy: boolean;
  sending: boolean;
  engineLabel?: string;
}) {
  const { t } = useI18n();
  const active = busy || sending;
  const [mountStartedAt] = useState(() => Date.now());
  const startedAt = busy ? (chat?.turnActivity?.startedAt || chat?.updatedAt || mountStartedAt) : mountStartedAt;
  const elapsedMs = useLiveElapsedMs(startedAt, active, 200);
  const lastTurnStats = useMemo(() => {
    if (!chat) return { total: 0, done: 0 };
    const workItems: SuperAgentMessage[] = [];
    for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
      const m = chat.messages[i];
      if (m.role === 'user') break;
      if (m.role === 'reasoning' || m.role === 'tool') workItems.push(m);
    }
    return { total: workItems.length, done: countCompletedWorkItems(workItems) };
  }, [chat]);

  if (!active || (chat?.approvals.length ?? 0) > 0) return null;

  const plan = chat?.turnActivity?.plan ?? [];
  const planTotal = plan.length;
  const planDone = plan.filter(item => item.status === 'completed').length;
  const determinatePct = planTotal > 0 ? Math.max(8, Math.min(100, Math.round((planDone / planTotal) * 100))) : undefined;
  const statusText = resolveLiveTurnStatusText(t, { chat, sending, engineLabel });
  const stepMeta = planTotal > 0
    ? t('{done}/{total} tasks', { done: planDone, total: planTotal })
    : lastTurnStats.total > 0
      ? t('{done}/{total} steps', { done: lastTurnStats.done, total: lastTurnStats.total })
      : '';

  return (
    <div className="om-sa-progress-dock" role="status" aria-live="polite">
      <div className="om-sa-progress-track" aria-hidden="true">
        <div
          className="om-sa-progress-bar"
          data-determinate={determinatePct !== undefined || undefined}
          style={determinatePct !== undefined ? { width: `${determinatePct}%` } : undefined}
        />
      </div>
      <div className="om-sa-progress-row">
        <div className="om-sa-progress-main">
          <WorkingIndicator />
          <span className="om-sa-live-status-label">{statusText}</span>
        </div>
        <div className="om-sa-progress-meta">
          {stepMeta && <span className="om-sa-progress-steps">{stepMeta}</span>}
          <span className="om-sa-live-timer">{formatElapsedDuration(elapsedMs)}</span>
        </div>
      </div>
    </div>
  );
}

function isLongUserQuery(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 260) return true;
  return trimmed.split(/\r?\n/).length > 4;
}

function UserMessageBubble({ text }: { text: string }) {
  const { t } = useI18n();
  const isLong = useMemo(() => isLongUserQuery(text), [text]);
  const lineCount = useMemo(() => text.trim().split(/\r?\n/).length, [text]);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [hoverExpanded, setHoverExpanded] = useState(false);
  const hoverTimerRef = useRef<number | null>(null);
  const suppressHoverRef = useRef(false);

  useEffect(() => () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
  }, []);

  if (!isLong) {
    return <div className="om-sa-user-bubble">{text}</div>;
  }

  const expanded = pinnedOpen || hoverExpanded;

  const clearHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const handleMouseEnter = () => {
    if (pinnedOpen || hoverExpanded || suppressHoverRef.current) return;
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      setHoverExpanded(true);
    }, 240);
  };

  const handleMouseLeave = () => {
    clearHoverTimer();
    suppressHoverRef.current = false;
    if (!pinnedOpen && hoverExpanded) {
      setHoverExpanded(false);
    }
  };

  const handleExpandClick = () => {
    clearHoverTimer();
    suppressHoverRef.current = false;
    setPinnedOpen(true);
    setHoverExpanded(false);
  };

  const handleCollapseClick = () => {
    clearHoverTimer();
    suppressHoverRef.current = true;
    setPinnedOpen(false);
    setHoverExpanded(false);
  };

  const metaHint = lineCount > 4
    ? t('{count} lines', { count: lineCount })
    : `${text.trim().length.toLocaleString()} chars`;

  return (
    <div
      className="om-sa-user-bubble om-sa-user-bubble-collapsible"
      data-expanded={expanded || undefined}
      data-collapsed={!expanded || undefined}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {expanded && (
        <div className="om-sa-user-bubble-bar">
          <span className="om-sa-user-bubble-meta">
            {t('Full prompt')} · {metaHint}
          </span>
          <Button
            variant="plain"
            type="button"
            className="om-sa-user-collapse-pill"
            aria-expanded="true"
            onClick={handleCollapseClick}
          >
            <span>{t('Collapse')}</span>
            <span className="om-sa-user-toggle-chevron" data-open aria-hidden="true">
              <RemixIcon name="arrow-down-s-line" size={14} />
            </span>
          </Button>
        </div>
      )}

      <div
        className="om-sa-user-bubble-text"
        onClick={!expanded ? handleExpandClick : undefined}
      >
        {text}
      </div>

      <Button
        variant="plain"
        type="button"
        className="om-sa-user-bubble-toggle"
        aria-expanded={expanded}
        onClick={expanded ? handleCollapseClick : handleExpandClick}
      >
        <span className="om-sa-user-toggle-hint">{metaHint}</span>
        <span className="om-sa-user-toggle-cta">
          <span>{expanded ? t('Collapse') : t('Show full prompt')}</span>
          <span className="om-sa-user-toggle-chevron" data-open={expanded || undefined} aria-hidden="true">
            <RemixIcon name="arrow-down-s-line" size={14} />
          </span>
        </span>
      </Button>
    </div>
  );
}

export function ExecutionTimeline({
  chat,
  busy,
  sending,
  hideInlineStatus,
  continueDisabled,
  engineLabel,
  onOpenArtifactId,
  onPreviewAttachment,
  onOpenWebUrl,
  onCopyText,
  onApprove,
  onContinue,
}: {
  chat: SuperAgentChat;
  busy: boolean;
  sending: boolean;
  hideInlineStatus?: boolean;
  continueDisabled?: boolean;
  engineLabel?: string;
  onOpenArtifactId: (artifactId: string) => void;
  onPreviewAttachment: (attachment: SuperAgentResourceAttachment) => void;
  onOpenWebUrl?: (url: string) => void;
  onCopyText: (text: string) => void;
  onApprove: (approvalId: string, accepted: boolean) => void;
  onContinue?: () => void;
}) {
  const { t } = useI18n();
  const turns = useMemo(() => groupMessagesIntoTurns(chat), [chat]);
  const lastTurn = turns[turns.length - 1];
  const showInterruptedCard = !busy && !sending && !chat.error && (
    chat.state === 'cancelled'
    || (chat.state === 'idle' && Boolean(lastTurn) && lastTurn.workItems.length > 0 && lastTurn.assistantItems.length === 0 && lastTurn.artifacts.length === 0)
  );
  const interruptedMeta = [
    lastTurn?.workItems.length ? t('{count} steps', { count: lastTurn.workItems.length }) : '',
    lastTurn?.durationMs !== undefined
      ? formatElapsedDuration(lastTurn.durationMs)
      : chat.lastTurnDurationMs !== undefined
        ? formatElapsedDuration(chat.lastTurnDurationMs)
        : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className="om-sa-message-list">
      {turns.map((turn, idx) => {
        const isLastTurn = idx === turns.length - 1;
        const isActiveTurn = busy && isLastTurn;
        const combinedAssistantText = turn.assistantItems.map(m => m.text).filter(Boolean).join('\n\n');

        return (
          <div key={turn.id} className="om-sa-turn" data-active={isActiveTurn || undefined}>
            {turn.user && (
              <article className="om-sa-message" data-role="user">
                <div className="om-sa-message-body">
                  {turn.user.attachments && turn.user.attachments.length > 0 && (
                    <div className="om-sa-msg-attachments">
                      {turn.user.attachments.map(att => {
                        const isBrowserAnnotation = att.kind === 'browser-annotation';
                        const chipTitle = isBrowserAnnotation
                          ? (att.annotation?.comment || att.title)
                          : att.title;
                        const tooltipLabel = isBrowserAnnotation
                          ? [
                              att.annotation?.element?.componentName,
                              att.annotation?.element?.selector,
                              att.annotation?.pageUrl || att.subtitle,
                            ].filter(Boolean).join(' · ')
                          : '';
                        const chip = (
                          <Button
                            key={resourceKey(att)}
                            variant="plain"
                            type="button"
                            className="om-sa-attachment-chip"
                            data-kind={isBrowserAnnotation ? 'browser-annotation' : undefined}
                            onClick={() => onPreviewAttachment(att)}
                          >
                            {isBrowserAnnotation && att.previewUrl ? (
                              <img className="om-sa-attachment-thumb" src={att.previewUrl} alt="" />
                            ) : (
                              <RemixIcon name={resourceIcon(att)} size={13} />
                            )}
                            <span>{chipTitle}</span>
                          </Button>
                        );
                        return isBrowserAnnotation && tooltipLabel ? (
                          <Tooltip key={resourceKey(att)} label={tooltipLabel}>{chip}</Tooltip>
                        ) : chip;
                      })}
                    </div>
                  )}
                  <UserMessageBubble text={turn.user.text} />
                </div>
              </article>
            )}

            <WorkLogSection
              turn={turn}
              isActiveTurn={isActiveTurn}
              onOpenArtifactId={onOpenArtifactId}
            />

            {turn.assistantItems.map(msg => (
              <article key={msg.id} className="om-sa-message" data-role="assistant">
                <div className="om-sa-message-body">
                  <div className="om-sa-assistant-content">
                    <SimpleMarkdown
                      content={msg.text}
                      onCopyCode={onCopyText}
                      onOpenWebUrl={onOpenWebUrl}
                    />
                  </div>
                </div>
              </article>
            ))}

            {turn.artifacts.length > 0 && (
              <div className="om-sa-deliverables" data-count={turn.artifacts.length === 1 ? 'single' : 'multi'}>
                {turn.artifacts.map(artifact => {
                  const meta = artifactDeliverableMeta(artifact);
                  const rawSub = (artifact.subtitle ?? '').trim();
                  const subDetail = rawSub && !RAW_ARTIFACT_SUBTITLES.has(rawSub.toLowerCase()) ? rawSub : '';
                  const subtitleText = subDetail ? `${t(meta.typeLabel)} · ${subDetail}` : t(meta.typeLabel);
                  return (
                    <Button
                      key={artifact.id}
                      variant="plain"
                      type="button"
                      className="om-sa-deliverable-card"
                      onClick={() => onOpenArtifactId(artifact.id)}
                    >
                      <span className="om-sa-deliverable-icon" data-tone={meta.tone} aria-hidden="true">
                        {artifact.kind === 'asset-image' && artifact.url ? (
                          <img className="om-sa-deliverable-thumb" src={artifact.url} alt="" />
                        ) : (
                          <RemixIcon name={meta.icon} size={20} />
                        )}
                      </span>
                      <span className="om-sa-deliverable-meta">
                        <strong>{artifact.title}</strong>
                        <small>{subtitleText}</small>
                      </span>
                      <span className="om-sa-deliverable-action" aria-hidden="true">
                        <span>{t('Open')}</span>
                        <RemixIcon name="arrow-right-up-line" size={14} />
                      </span>
                    </Button>
                  );
                })}
              </div>
            )}

            {!isActiveTurn && turn.changedFiles.length > 0 && (
              <FilesChangedCard files={turn.changedFiles} onCopyText={onCopyText} />
            )}

            {!isActiveTurn && turn.assistantItems.length > 0 && (
              <div className="om-sa-turn-footer">
                <span className="om-sa-turn-meta">
                  {engineLabel || chat.engine}
                  {turn.durationMs !== undefined ? ` · ${formatElapsedDuration(turn.durationMs)}` : ''}
                  {isLastTurn && chat.lastTurnUsage?.totalTokens
                    ? ` · ${chat.lastTurnUsage.totalTokens.toLocaleString()} ${t('tokens')}`
                    : ''}
                </span>
                {combinedAssistantText && (
                  <IconButton
                    variant="ghost"
                    className="motion-icon-button"
                    aria-label={t('Copy response')}
                    title={t('Copy response')}
                    onClick={() => onCopyText(combinedAssistantText)}
                    icon={<RemixIcon name="file-copy-line" size={13} />}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}

      {busy && !chat.approvals.length && (
        hideInlineStatus
          ? <LivePlanCard plan={chat.turnActivity?.plan} />
          : <LiveTurnStatusBar chat={chat} engineLabel={engineLabel} />
      )}

      {chat.error && (
        <div className="om-card om-sa-error-card" role="alert">
          <span className="om-sa-error-icon" aria-hidden="true">
            <RemixIcon name="error-warning-line" size={18} />
          </span>
          <div className="om-sa-error-copy">
            <strong>{t('Conversation paused')}</strong>
            <p className="om-muted">{chat.error}</p>
          </div>
          {onContinue && (
            <Button
              variant="secondary"
              className="om-button om-sa-continue-btn"
              disabled={continueDisabled || busy || sending}
              onClick={onContinue}
            >
              <RemixIcon name="play-fill" size={14} />
              <span>{t('Continue')}</span>
            </Button>
          )}
        </div>
      )}

      {showInterruptedCard && (
        <div className="om-card om-sa-interrupted-card" role="status">
          <span className="om-sa-interrupted-icon" aria-hidden="true">
            <RemixIcon name="pause-line" size={18} />
          </span>
          <div className="om-sa-interrupted-copy">
            <strong>{t(chat.state === 'cancelled' ? 'Stopped before finishing' : 'No final response yet')}</strong>
            <p className="om-muted">
              {interruptedMeta ? `${interruptedMeta} · ` : ''}
              {t('Resume from where it stopped, or send a new instruction below.')}
            </p>
          </div>
          {onContinue && (
            <Button
              variant="primary"
              className="om-button om-sa-continue-btn"
              disabled={continueDisabled}
              onClick={onContinue}
            >
              <RemixIcon name="play-fill" size={14} />
              <span>{t('Continue')}</span>
            </Button>
          )}
        </div>
      )}

      {chat.approvals.map(approval => (
        <section key={approval.id} className="om-creation-approval om-sa-approval">
          <div className="om-creation-row">
            <span className="om-creation-icon" data-tone="audio">
              <RemixIcon name="shield-check-line" size={18} />
            </span>
            <div>
              <h3 className="om-subtitle">{t(approval.title)}</h3>
              <p className="om-muted">{t('Review this action before it runs.')}</p>
            </div>
          </div>
          <pre className="om-code-block">{approval.detail}</pre>
          <div className="om-asset-actions">
            <Button
              variant="ghost"
              className="om-button h-auto"
              disabled={sending}
              onClick={() => onApprove(approval.id, false)}
            >
              {t('Decline')}
            </Button>
            <Button
              variant="ghost"
              className="om-button h-auto"
              data-primary
              disabled={sending}
              onClick={() => onApprove(approval.id, true)}
            >
              <RemixIcon name="check-line" size={15} />
              <span>{t('Approve')}</span>
            </Button>
          </div>
        </section>
      ))}
    </div>
  );
}
