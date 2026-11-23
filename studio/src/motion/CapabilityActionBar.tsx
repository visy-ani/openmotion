import { Button } from 'open-design-ui/button';
import {
  buildResourceMcpPrompt,
  buildSuperAgentHandoff,
  type CapabilityResourceRef,
} from '../../../shared/capability-hub';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { queueSuperAgentHandoff } from './superAgentHandoff';
import { useOptionalWorkspaceChrome } from './WorkspaceChromeContext';

export function CapabilityActionBar({
  resource,
  mcpPrompt,
  agentPrompt,
  directAction,
  variant = 'buttons',
  showCopyMcp = true,
  showRunAgent = true,
  onBeforeNavigate,
  onNotify,
  onCopied,
  className,
}: {
  resource: CapabilityResourceRef;
  mcpPrompt?: string;
  agentPrompt?: string;
  directAction?: {
    label: string;
    icon?: string;
    onClick: () => void;
    primary?: boolean;
    disabled?: boolean;
  };
  variant?: 'buttons' | 'compact';
  showCopyMcp?: boolean;
  showRunAgent?: boolean;
  onBeforeNavigate?: () => void;
  onNotify?: (message: string, kind?: 'info' | 'error') => void;
  onCopied?: (promptText: string) => void;
  className?: string;
}) {
  const { t, locale } = useI18n();
  const chrome = useOptionalWorkspaceChrome();
  const { toasts, showToast, dismissToast } = useToast();

  const notify = (message: string, kind: 'info' | 'error' = 'info') => {
    if (onNotify) onNotify(message, kind);
    else showToast(message, kind, 'feedback');
  };

  const handleCopyMcp = async () => {
    const text = mcpPrompt?.trim() || buildResourceMcpPrompt(resource, { prompt: agentPrompt, locale });
    try {
      await navigator.clipboard.writeText(text);
      onCopied?.(text);
      notify(t('Copied. Paste into your Agent.'), 'info');
    } catch {
      notify(t('Could not copy. Select and copy the text manually.'), 'error');
    }
  };

  const handleRunInSuperAgent = () => {
    const handoff = buildSuperAgentHandoff(resource, { prompt: agentPrompt, locale });
    onBeforeNavigate?.();
    if (chrome?.openInSuperAgent) {
      chrome.openInSuperAgent(handoff);
    } else {
      queueSuperAgentHandoff(handoff);
      notify(t('Loaded into Super Agent'), 'info');
    }
  };

  const compact = variant === 'compact';

  return (
    <div
      className={className ? `om-capability-action-bar ${className}` : 'om-capability-action-bar'}
      data-variant={variant}
    >
      {!onNotify && <StudioToastViewport toasts={toasts} dismissToast={dismissToast} />}

      {directAction && (
        <Button
          variant="ghost"
          size={compact ? 'sm' : 'md'}
          type="button"
          className="om-button h-auto"
          data-primary={directAction.primary || undefined}
          disabled={directAction.disabled}
          onClick={directAction.onClick}
        >
          {directAction.icon && <RemixIcon name={directAction.icon} size={compact ? 14 : 16} />}
          <span>{t(directAction.label)}</span>
        </Button>
      )}

      {showRunAgent && (
        <Button
          variant="ghost"
          size={compact ? 'sm' : 'md'}
          type="button"
          className="om-button h-auto"
          data-primary={!directAction?.primary && !showCopyMcp ? true : undefined}
          onClick={handleRunInSuperAgent}
        >
          <RemixIcon name="sparkling-line" size={compact ? 14 : 16} />
          <span>{t('Run in Super Agent')}</span>
        </Button>
      )}

      {showCopyMcp && (
        <Button
          variant="ghost"
          size={compact ? 'sm' : 'md'}
          type="button"
          className="om-button h-auto"
          onClick={() => void handleCopyMcp()}
        >
          <RemixIcon name="file-copy-line" size={compact ? 14 : 16} />
          <span>{t('Copy for MCP')}</span>
        </Button>
      )}
    </div>
  );
}
