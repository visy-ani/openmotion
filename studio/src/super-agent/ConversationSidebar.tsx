import { Dialog } from '@base-ui/react/dialog';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useRef, useState } from 'react';
import { superAgentIntentMeta, type SuperAgentChatSummary } from '../../../shared/super-agent';
import { Menu, MenuItem, MenuSeparator } from '../components/ui/Menu';
import { Skeleton } from '../components/ui/Skeleton';
import { Tooltip } from '../components/ui/Tooltip';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';

export function ConversationSidebar({
  conversations,
  activeId,
  loading,
  agentStatus,
  onSelect,
  onCreate,
  onTogglePin,
  onRename,
  onDelete,
  onCollapse,
  onOpenAgentSettings,
}: {
  conversations: SuperAgentChatSummary[];
  activeId: string | null;
  loading: boolean;
  agentStatus: { label: string; detail?: string; ready: boolean; count: number; loading?: boolean };
  onSelect: (id: string) => void;
  onCreate: () => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onRename: (id: string, title: string) => Promise<void> | void;
  onDelete: (id: string) => void;
  onCollapse: () => void;
  onOpenAgentSettings: () => void;
}) {
  const { t } = useI18n();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const cancelRenameRef = useRef(false);

  const pinned = conversations.filter(item => item.pinned);
  const recent = conversations.filter(item => !item.pinned);

  const normalizedQuery = query.trim().toLowerCase();
  const searchResults = conversations.filter(item =>
    !normalizedQuery || item.title.toLowerCase().includes(normalizedQuery),
  );

  const commitRename = async (id: string) => {
    const next = draftTitle.trim();
    setEditingId(null);
    if (next) await onRename(id, next);
  };

  const renderRow = (item: SuperAgentChatSummary) => {
    const isActive = item.id === activeId;
    const isEditing = editingId === item.id;
    const statusTone =
      item.state === 'running'
        ? 'running'
        : item.state === 'waiting'
          ? 'waiting'
          : item.state === 'failed'
            ? 'failed'
            : 'idle';
    const intentMeta = superAgentIntentMeta(item.intent);

    if (isEditing) {
      return (
        <form
          key={item.id}
          className="om-sa-chat-rename"
          onSubmit={event => {
            event.preventDefault();
            void commitRename(item.id);
          }}
        >
          <input
            autoFocus
            maxLength={100}
            value={draftTitle}
            aria-label={t('Conversation name')}
            onFocus={event => event.currentTarget.select()}
            onChange={event => setDraftTitle(event.target.value)}
            onBlur={() => {
              if (cancelRenameRef.current) {
                cancelRenameRef.current = false;
                return;
              }
              if (editingId === item.id) void commitRename(item.id);
            }}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelRenameRef.current = true;
                setEditingId(null);
              }
            }}
          />
        </form>
      );
    }

    return (
      <div key={item.id} className="om-sa-chat-row" data-active={isActive || undefined}>
        <Button
          variant="plain"
          type="button"
          className="om-sa-chat-row-btn"
          aria-current={isActive ? 'page' : undefined}
          onClick={() => onSelect(item.id)}
        >
          <span className="om-sa-chat-icon-wrap" aria-hidden="true">
            <span
              className="om-sa-chat-icon"
              data-tone={intentMeta.tone}
              data-intent={item.intent ?? 'chat'}
              title={t(intentMeta.label)}
            >
              <RemixIcon name={intentMeta.icon} size={14} />
            </span>
            {statusTone !== 'idle' && (
              <span className="om-sa-chat-status-badge" data-state={statusTone} />
            )}
          </span>
          <span className="om-sa-chat-title">{item.title}</span>
          {item.artifactCount > 0 && (
            <span className="om-sa-chat-count" title={t('{count} artifacts', { count: item.artifactCount })}>
              {item.artifactCount}
            </span>
          )}
        </Button>
        <Menu
          modal={false}
          side="bottom"
          align="end"
          aria-label={t('Conversation actions')}
          className="om-selection-panel om-menu-panel"
          trigger={
            <IconButton
              variant="ghost"
              size="sm"
              className="om-sa-chat-more"
              aria-label={t('Conversation actions')}
              icon={<RemixIcon name="more-2-line" size={14} />}
            />
          }
        >
          <MenuItem onClick={() => onTogglePin(item.id, !item.pinned)}>
            <span className="om-menu-label">
              <RemixIcon name={item.pinned ? 'poker-diamonds-fill' : 'poker-diamonds-line'} size={15} />
              {t(item.pinned ? 'Unpin conversation' : 'Pin conversation')}
            </span>
          </MenuItem>
          <MenuItem
            onClick={() => {
              setDraftTitle(item.title);
              setEditingId(item.id);
            }}
          >
            <span className="om-menu-label">
              <RemixIcon name="edit-line" size={15} />
              {t('Rename')}
            </span>
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => onDelete(item.id)}>
            <span className="om-menu-label om-sa-danger-label">
              <RemixIcon name="delete-bin-line" size={15} />
              {t('Delete conversation')}
            </span>
          </MenuItem>
        </Menu>
      </div>
    );
  };

  return (
    <aside className="om-sa-sidebar" aria-label={t('Conversations')}>
      <div className="om-sa-sidebar-head">
        <div className="om-sa-sidebar-brand">
          <span className="om-creation-icon om-sa-brand-badge" data-tone="agent" aria-hidden="true">
            <RemixIcon name="sparkling-fill" size={14} />
          </span>
          <strong>{t('Super Agent')}</strong>
        </div>
        <div className="om-sa-sidebar-head-actions">
          <Tooltip label={t('Search conversations')}>
            <IconButton
              variant="ghost"
              className="motion-icon-button"
              aria-label={t('Search conversations')}
              onClick={() => {
                setQuery('');
                setSearchOpen(true);
              }}
              icon={<RemixIcon name="search-line" size={16} />}
            />
          </Tooltip>
          <Tooltip label={t('Collapse sidebar')}>
            <IconButton
              variant="ghost"
              className="motion-icon-button"
              aria-label={t('Collapse sidebar')}
              onClick={onCollapse}
              icon={<RemixIcon name="side-bar-line" size={16} />}
            />
          </Tooltip>
        </div>
      </div>

      <div className="om-sa-sidebar-new">
        <Button
          variant="plain"
          type="button"
          className="om-sa-new-chat-btn"
          onClick={onCreate}
        >
          <RemixIcon name="edit-line" size={15} />
          <span>{t('New task')}</span>
        </Button>
      </div>

      <div className="om-sa-chat-list" aria-busy={loading}>
        {pinned.length > 0 && (
          <section className="om-sa-chat-group" aria-label={t('Pinned')}>
            <h2 className="om-sa-chat-group-title">{t('Pinned')}</h2>
            {pinned.map(renderRow)}
          </section>
        )}

        <section className="om-sa-chat-group" aria-label={t('Tasks')}>
          <h2 className="om-sa-chat-group-title">{t('Tasks')}</h2>
          {loading && !conversations.length ? (
            <div className="om-sa-chat-skeletons" aria-hidden="true">
              <Skeleton style={{ width: '88%', height: 32 }} />
              <Skeleton style={{ width: '74%', height: 32 }} />
              <Skeleton style={{ width: '80%', height: 32 }} />
            </div>
          ) : !conversations.length ? (
            <p className="om-sa-chat-empty">
              {t('Start a new conversation to create sites, games, films, or media.')}
            </p>
          ) : (
            recent.map(renderRow)
          )}
        </section>
      </div>

      <Dialog.Root open={searchOpen} onOpenChange={setSearchOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="om-sa-dialog-backdrop" />
          <Dialog.Popup
            data-feedback-modal
            className="om-dialog om-sa-search-dialog"
            onKeyDown={event => event.stopPropagation()}
          >
            <Dialog.Title className="sr-only">{t('Search conversations')}</Dialog.Title>
            <div className="om-sa-search-modal-head">
              <RemixIcon name="search-line" size={16} />
              <input
                autoFocus
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={t('Search conversations…')}
                aria-label={t('Search conversations')}
              />
              {query && (
                <IconButton
                  variant="ghost"
                  className="motion-icon-button"
                  aria-label={t('Clear')}
                  onClick={() => setQuery('')}
                  icon={<RemixIcon name="close-line" size={14} />}
                />
              )}
              <IconButton
                variant="ghost"
                className="motion-icon-button"
                aria-label={t('Close')}
                onClick={() => setSearchOpen(false)}
                icon={<RemixIcon name="close-line" size={16} />}
              />
            </div>

            <div className="om-sa-search-modal-list">
              {!searchResults.length ? (
                <p className="om-sa-chat-empty">
                  {t(normalizedQuery ? 'No matching conversations' : 'Start a new conversation to create sites, games, films, or media.')}
                </p>
              ) : (
                searchResults.map(item => {
                  const isActive = item.id === activeId;
                  const statusTone =
                    item.state === 'running'
                      ? 'running'
                      : item.state === 'waiting'
                        ? 'waiting'
                        : item.state === 'failed'
                          ? 'failed'
                          : 'idle';
                  const intentMeta = superAgentIntentMeta(item.intent);
                  return (
                    <Button
                      key={item.id}
                      variant="plain"
                      type="button"
                      className="om-sa-search-modal-item"
                      data-active={isActive || undefined}
                      onClick={() => {
                        onSelect(item.id);
                        setSearchOpen(false);
                      }}
                    >
                      <span className="om-sa-chat-icon-wrap" aria-hidden="true">
                        <span
                          className="om-sa-chat-icon"
                          data-tone={intentMeta.tone}
                          data-intent={item.intent ?? 'chat'}
                          title={t(intentMeta.label)}
                        >
                          <RemixIcon name={intentMeta.icon} size={14} />
                        </span>
                        {statusTone !== 'idle' && (
                          <span className="om-sa-chat-status-badge" data-state={statusTone} />
                        )}
                      </span>
                      <span className="om-sa-chat-title">{item.title}</span>
                      {item.artifactCount > 0 && (
                        <span className="om-sa-chat-count">{item.artifactCount}</span>
                      )}
                    </Button>
                  );
                })
              )}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="om-sa-sidebar-foot">
        <Button
          variant="plain"
          type="button"
          className="om-nav-item om-sa-agent-status-btn"
          onClick={onOpenAgentSettings}
        >
          <span
            className="om-sa-status-dot"
            data-ready={agentStatus.ready || undefined}
            data-loading={agentStatus.loading || undefined}
            aria-hidden="true"
          />
          <span className="om-sa-agent-status-copy">
            {agentStatus.loading ? (
              <>
                <Skeleton style={{ width: 96, height: 12 }} />
                <Skeleton style={{ width: 124, height: 11, marginTop: 4 }} />
              </>
            ) : (
              <>
                <strong>{agentStatus.label}</strong>
                <small>{agentStatus.detail ?? t(agentStatus.ready ? 'Local Agent connected' : 'Configure Local Agent')}</small>
              </>
            )}
          </span>
          <RemixIcon name="settings-3-line" size={14} />
        </Button>
      </div>
    </aside>
  );
}
