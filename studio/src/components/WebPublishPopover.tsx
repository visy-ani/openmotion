import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountSummary } from '../../../shared/provider-directory';
import type {
  WebPublicationRecord,
  WebPublishMode,
  WebPublishStatusResponse,
  WebPublishTargetKind,
} from '../../../shared/web-publish';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { useAccountSummary } from '../motion/AccountSettings';
import { gatewayRequest } from '../motion/gatewayClient';
import { notifyProvidersChanged } from '../motion/useProviderDirectory';
import { Popover } from './ui/Popover';
import { WebPublishApiError, webPublishClient } from './webPublishClient';
import './webPublishPopover.css';

export interface WebPublishPopoverProps {
  targetKind: WebPublishTargetKind;
  targetId: string;
  filePath?: string;
  sourcePath?: string;
  title?: string;
  revisionKey?: string;
  compact?: boolean;
  disabled?: boolean;
  triggerLabel?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  onNotify?: (message: string, variant?: 'info' | 'error') => void;
  onCopyUrl?: (url: string) => void | Promise<void>;
  onOpenAccount?: () => void;
}

type ActiveOp = WebPublishMode | 'stop' | null;

function mergePublicationStatus(
  prev: WebPublishStatusResponse | null,
  targetKind: WebPublishTargetKind,
  targetId: string,
  publication: WebPublicationRecord,
  freshness: WebPublishStatusResponse['freshness'],
): WebPublishStatusResponse {
  const previousList = prev?.publications ?? [];
  const nextList = [publication, ...previousList.filter(item => item.filePath !== publication.filePath)];
  return {
    ...(prev ?? {}),
    targetKind: prev?.targetKind ?? targetKind,
    targetId: prev?.targetId ?? targetId,
    projectId: prev?.projectId ?? targetId,
    accountSignedIn: true,
    accountState: 'signed-in',
    freshness,
    fileCount: publication.fileCount,
    totalBytes: publication.totalBytes,
    bundledAssetCount: publication.bundledAssetCount ?? prev?.bundledAssetCount ?? 0,
    publications: nextList,
    deployments: nextList,
    active: publication,
  };
}

/**
 * Unified cloud-publishing popover used across Design Studio, Game Studio,
 * and Super Agent's Artifact Browser Pane. Handles all four publish target
 * kinds (`design`, `game`, `motion`, `html`), automatic local media bundling,
 * SHA-256 freshness detection, in-popover OpenDesign sign-in, and link access
 * lifecycle (`publish`, `resume`, `new_link`, `unpublish`).
 */
export function WebPublishPopover({
  targetKind,
  targetId,
  filePath,
  sourcePath,
  title,
  revisionKey,
  compact = false,
  disabled = false,
  triggerLabel,
  side = 'bottom',
  align = 'end',
  onNotify,
  onCopyUrl,
  onOpenAccount,
}: WebPublishPopoverProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { account, refresh: refreshAccount, setAccount } = useAccountSummary();
  const [status, setStatus] = useState<WebPublishStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeOp, setActiveOp] = useState<ActiveOp>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [prepublishEnabled, setPrepublishEnabled] = useState(true);
  const deployAfterSignInRef = useRef(false);
  const prevAccountStateRef = useRef<AccountSummary['state'] | undefined>(undefined);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setOpen(false);
    setStatus(null);
    setError(null);
    setPrepublishEnabled(true);
    setCopied(false);
  }, [targetKind, targetId, filePath]);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const refreshStatus = useCallback(async (refreshRemote = false) => {
    if (!targetId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await webPublishClient.getStatus(targetKind, targetId, {
        filePath,
        sourcePath,
        refresh: refreshRemote,
      });
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Could not check share status'));
    } finally {
      setLoading(false);
    }
  }, [filePath, sourcePath, t, targetId, targetKind]);

  useEffect(() => {
    if (!open) return;
    void refreshAccount();
    void refreshStatus(false);
  }, [open, targetId, filePath, revisionKey, refreshAccount, refreshStatus]);

  const copyUrl = useCallback(async (url: string, notifyUser = true) => {
    try {
      if (notifyUser && onCopyUrl) {
        await onCopyUrl(url);
      } else {
        await navigator.clipboard.writeText(url);
        if (notifyUser) onNotify?.(t('Share link copied'), 'info');
      }
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
      return true;
    } catch {
      if (notifyUser) onNotify?.(t('Could not copy share link'), 'error');
      return false;
    }
  }, [onCopyUrl, onNotify, t]);

  const runMutation = useCallback(async (op: Exclude<ActiveOp, null>, copyOnSuccess = false) => {
    if (activeOp) return;
    setActiveOp(op);
    setError(null);
    try {
      if (op === 'stop') {
        const stopped = await webPublishClient.unpublish(targetKind, targetId, { filePath, sourcePath });
        setStatus(prev => mergePublicationStatus(prev, targetKind, targetId, stopped.publication, prev?.freshness ?? 'unknown'));
        onNotify?.(t('Share link disabled'), 'info');
        return;
      }

      const published = await webPublishClient.publish(targetKind, targetId, {
        filePath,
        sourcePath,
        deployMode: op,
        name: title,
      });
      setStatus(prev =>
        mergePublicationStatus(
          prev,
          targetKind,
          targetId,
          published.publication,
          published.publication.contentFingerprint ? 'fresh' : (prev?.freshness ?? 'unknown'),
        ),
      );

      if (published.url && copyOnSuccess) {
        await copyUrl(published.url, false);
        onNotify?.(t('Deployed and copied share link'), 'info');
      } else if (op === 'resume') {
        onNotify?.(t('Share link reopened'), 'info');
      } else {
        onNotify?.(t('Cloud preview link updated'), 'info');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('Cloud share operation failed');
      setError(msg);
      if (err instanceof WebPublishApiError && (err.status === 401 || err.code === 'AUTH_REQUIRED')) {
        void refreshAccount();
      }
      if (err instanceof WebPublishApiError && err.status === 409) {
        void refreshStatus(false);
      }
    } finally {
      setActiveOp(null);
    }
  }, [activeOp, copyUrl, filePath, onNotify, refreshAccount, refreshStatus, sourcePath, t, targetId, targetKind, title]);

  // Automatically continue deploying as soon as an in-popover OpenDesign sign-in completes.
  useEffect(() => {
    const nextState = account?.state;
    const prevState = prevAccountStateRef.current;
    prevAccountStateRef.current = nextState;
    if (nextState === 'signed-in' && prevState && prevState !== 'signed-in') {
      notifyProvidersChanged();
      window.dispatchEvent(new Event('motion:account-changed'));
      if (deployAfterSignInRef.current) {
        deployAfterSignInRef.current = false;
        void runMutation('publish', true);
      } else if (open) {
        void refreshStatus(false);
      }
    }
  }, [account?.state, open, refreshStatus, runMutation]);

  const handleAccountAction = async (action: 'login' | 'cancel') => {
    setAuthBusy(true);
    setError(null);
    deployAfterSignInRef.current = action === 'login';
    try {
      const next = await gatewayRequest<AccountSummary>(`settings/account/${action}`, 'POST', {});
      setAccount(next);
      notifyProvidersChanged();
      window.dispatchEvent(new Event('motion:account-changed'));
      if (action === 'login' && next.state === 'signed-in') {
        deployAfterSignInRef.current = false;
        void runMutation('publish', true);
      }
    } catch (err) {
      deployAfterSignInRef.current = false;
      setError(err instanceof Error ? err.message : t('Could not connect OpenDesign account'));
    } finally {
      setAuthBusy(false);
    }
  };

  const accountState = account?.state ?? status?.accountState ?? (status?.accountSignedIn ? 'signed-in' : 'signed-out');
  const signedIn = accountState === 'signed-in';
  const authorizing = accountState === 'authorizing';
  const mutating = activeOp !== null;
  const pub = status?.active ?? null;
  const linkStatus = pub?.status ?? 'none';
  const isPublished = linkStatus === 'published';
  const isStopped = linkStatus === 'stopped';
  const linkAccessOn = isPublished || (linkStatus === 'none' && prepublishEnabled);

  const handleToggleLinkAccess = () => {
    if (!signedIn || mutating) return;
    if (isPublished) void runMutation('stop');
    else if (isStopped) void runMutation('resume');
    else setPrepublishEnabled(v => !v);
  };

  const fileCount = status?.fileCount ?? pub?.fileCount ?? 0;
  const bundledAssetCount = status?.bundledAssetCount ?? pub?.bundledAssetCount ?? 0;

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side={side}
      align={align}
      initialFocus={false}
      aria-label={t('Cloud share')}
      className="om-web-publish-popover"
      trigger={
        <Button
          variant={compact ? 'plain' : 'ghost'}
          type="button"
          disabled={disabled}
          className={compact ? 'om-web-publish-trigger om-web-publish-trigger--compact' : 'om-button om-web-publish-trigger'}
          data-primary={compact ? undefined : true}
          data-active={open || undefined}
          data-live={isPublished || undefined}
          aria-label={triggerLabel ?? t('Share')}
          title={triggerLabel ?? t('Share')}
          aria-expanded={open}
        >
          <RemixIcon name="share-forward-line" size={compact ? 14 : 14} />
          <span className="om-web-publish-trigger-label">{triggerLabel ?? t('Share')}</span>
          {isPublished && <span className="om-web-publish-dot" aria-hidden="true" />}
        </Button>
      }
    >
      <div className="om-web-publish-head">
        <div className="om-web-publish-head-title">
          <strong>{t('Share')}</strong>
          <span className="om-web-publish-tag">
            <RemixIcon name="cloud-line" size={12} />
            <span>{t('Cloud deploy')}</span>
          </span>
          {isPublished && status?.freshness === 'outdated' && (
            <span className="om-web-publish-freshness" data-state="outdated">
              {t('Changes pending')}
            </span>
          )}
          {isPublished && status?.freshness === 'fresh' && (
            <span className="om-web-publish-freshness" data-state="fresh">
              {t('Up to date')}
            </span>
          )}
        </div>
        <div className="om-web-publish-head-actions">
          <IconButton
            variant="plain"
            className="om-web-publish-head-btn"
            aria-label={t('Refresh status')}
            title={t('Refresh status')}
            disabled={loading || mutating}
            onClick={() => void refreshStatus(true)}
            icon={<RemixIcon name="refresh-line" size={15} className={loading ? 'om-web-publish-spin' : undefined} />}
          />
          <IconButton
            variant="plain"
            className="om-web-publish-head-btn"
            aria-label={t('Close')}
            title={t('Close')}
            onClick={() => setOpen(false)}
            icon={<RemixIcon name="close-line" size={15} />}
          />
        </div>
      </div>

      {signedIn ? (
        <>
          {isStopped && (
            <p className="om-web-publish-banner" role="status">
              {t('The link is disabled. Turn Link access back on to reopen this preview.')}
            </p>
          )}

          <div className="om-web-publish-row">
            <div className="om-web-publish-row-text">
              <strong>{t('Link access')}</strong>
              <span>{t('Recipients can view and play this live preview — not your conversation or code.')}</span>
            </div>
            <Button
              variant="plain"
              type="button"
              role="switch"
              aria-checked={linkAccessOn}
              aria-label={t('Link access')}
              disabled={mutating || (loading && !status)}
              className="om-web-publish-switch"
              onClick={handleToggleLinkAccess}
            >
              <span className="om-web-publish-switch-thumb" aria-hidden="true" />
            </Button>
          </div>

          {isPublished && pub?.url && (
            <div className="om-web-publish-url-row">
              <RemixIcon name="link" size={13} />
              <span className="om-web-publish-url-text" title={pub.url}>{pub.url}</span>
              <a
                className="om-web-publish-url-open"
                href={pub.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('Open in new window')}
              >
                <RemixIcon name="external-link-line" size={13} />
              </a>
            </div>
          )}

          {error && (
            <div className="om-web-publish-error" role="alert">
              <RemixIcon name="error-warning-line" size={14} />
              <span>{error}</span>
            </div>
          )}

          <div className="om-web-publish-actions">
            {isPublished && pub?.url ? (
              <>
                <Button
                  variant="ghost"
                  type="button"
                  className="om-button om-web-publish-full"
                  data-primary
                  disabled={mutating}
                  onClick={() => void copyUrl(pub.url!)}
                >
                  <RemixIcon name={copied ? 'check-line' : 'link'} size={15} />
                  <span>{t(copied ? 'Share link copied' : 'Copy share link')}</span>
                </Button>
                {status?.freshness === 'outdated' && (
                  <Button
                    variant="ghost"
                    type="button"
                    className="om-button om-web-publish-full"
                    disabled={mutating}
                    onClick={() => void runMutation('publish')}
                  >
                    <RemixIcon
                      name={activeOp === 'publish' ? 'loader-4-line' : 'refresh-line'}
                      size={15}
                      className={activeOp === 'publish' ? 'om-web-publish-spin' : undefined}
                    />
                    <span>{t(activeOp === 'publish' ? 'Deploying update…' : 'Update live link')}</span>
                  </Button>
                )}
              </>
            ) : isStopped ? (
              <>
                <Button
                  variant="ghost"
                  type="button"
                  className="om-button om-web-publish-full"
                  data-primary
                  disabled={mutating}
                  onClick={() => void runMutation('resume')}
                >
                  <RemixIcon
                    name={activeOp === 'resume' ? 'loader-4-line' : 'refresh-line'}
                    size={15}
                    className={activeOp === 'resume' ? 'om-web-publish-spin' : undefined}
                  />
                  <span>{t(activeOp === 'resume' ? 'Reopening link…' : 'Reopen share link')}</span>
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  className="om-button om-web-publish-full"
                  disabled={mutating}
                  onClick={() => void runMutation('new_link', true)}
                >
                  <RemixIcon
                    name={activeOp === 'new_link' ? 'loader-4-line' : 'upload-line'}
                    size={15}
                    className={activeOp === 'new_link' ? 'om-web-publish-spin' : undefined}
                  />
                  <span>{t('Publish new link')}</span>
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                type="button"
                className="om-button om-web-publish-full"
                data-primary
                disabled={mutating || loading || !prepublishEnabled}
                onClick={() => void runMutation('publish', true)}
              >
                <RemixIcon
                  name={activeOp === 'publish' ? 'loader-4-line' : 'upload-line'}
                  size={15}
                  className={activeOp === 'publish' ? 'om-web-publish-spin' : undefined}
                />
                <span>{t(activeOp === 'publish' ? 'Deploying to OpenDesign Cloud…' : 'Deploy & copy link')}</span>
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="om-web-publish-row-text">
            <strong>{t('Link access')}</strong>
            <span>
              {t('Sign in with your OpenDesign account to deploy this interactive preview and generate a shareable cloud link.')}
            </span>
          </div>

          {isPublished && pub?.url && (
            <>
              <div className="om-web-publish-url-row">
                <RemixIcon name="link" size={13} />
                <span className="om-web-publish-url-text" title={pub.url}>{pub.url}</span>
                <a
                  className="om-web-publish-url-open"
                  href={pub.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t('Open in new window')}
                >
                  <RemixIcon name="external-link-line" size={13} />
                </a>
              </div>
              <Button
                variant="ghost"
                type="button"
                className="om-button om-web-publish-full"
                onClick={() => void copyUrl(pub.url!)}
              >
                <RemixIcon name={copied ? 'check-line' : 'link'} size={15} />
                <span>{t(copied ? 'Share link copied' : 'Copy share link')}</span>
              </Button>
            </>
          )}

          {authorizing && (
            <div className="om-web-publish-auth-box" role="status">
              <div className="om-web-publish-auth-row">
                <RemixIcon name="loader-4-line" size={14} className="om-web-publish-spin" />
                <span>{t('Complete OpenDesign sign-in in your browser…')}</span>
              </div>
              {account?.userCode && (
                <code className="om-web-publish-auth-code">{account.userCode}</code>
              )}
              {account?.authorizationUrl && (
                <a
                  className="om-web-publish-auth-link"
                  href={account.authorizationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <span>{t('Open sign-in page')}</span>
                  <RemixIcon name="external-link-line" size={13} />
                </a>
              )}
            </div>
          )}

          {error && (
            <div className="om-web-publish-error" role="alert">
              <RemixIcon name="error-warning-line" size={14} />
              <span>{error}</span>
            </div>
          )}

          <div className="om-web-publish-actions">
            {authorizing ? (
              <Button
                variant="ghost"
                type="button"
                className="om-button om-web-publish-full"
                disabled={authBusy}
                onClick={() => void handleAccountAction('cancel')}
              >
                <span>{t('Cancel sign-in')}</span>
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  type="button"
                  className="om-button om-web-publish-full"
                  data-primary={!(isPublished && pub?.url) || undefined}
                  disabled={authBusy}
                  onClick={() => void handleAccountAction('login')}
                >
                  <span className="om-opendesign-mark" aria-hidden="true" />
                  <span>
                    {t(accountState === 'reauth-required' ? 'Sign in again with OpenDesign' : 'Sign in with OpenDesign')}
                  </span>
                </Button>
                {onOpenAccount && (
                  <Button
                    variant="plain"
                    type="button"
                    className="om-button om-web-publish-full"
                    onClick={() => {
                      setOpen(false);
                      onOpenAccount();
                    }}
                  >
                    <span>{t('Open account settings')}</span>
                  </Button>
                )}
              </>
            )}
          </div>
        </>
      )}

      {status && (
        <div className="om-web-publish-meta">
          <span>
            {pub?.workspaceName || status.accountEmail || account?.user?.email || t('OpenDesign Cloud')}
            {pub?.version ? ` · v${pub.version}` : ''}
          </span>
          <span>
            {t('{count} files', { count: fileCount })}
            {bundledAssetCount > 0 ? ` · +${bundledAssetCount}` : ''}
          </span>
        </div>
      )}
    </Popover>
  );
}
