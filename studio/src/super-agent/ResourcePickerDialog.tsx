import { Button } from 'open-design-ui/button';
import { useEffect, useRef, useState } from 'react';
import type { SuperAgentResourceAttachment, SuperAgentResourceCatalog, SuperAgentResourceKind } from '../../../shared/super-agent';
import { Skeleton } from '../components/ui/Skeleton';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { uploadLibraryAsset } from '../motion/assetClient';
import { assetMediaUrl, assetVersion } from '../../../shared/asset-library';
import { fetchWorkspaceResources } from './superAgentClient';

export type ResourceCategoryTab =
  | 'all'
  | 'asset'
  | 'brand-kit'
  | 'motion-template'
  | 'design-template'
  | 'skills'
  | 'projects'
  | 'workflow'
  | 'model';

const CATEGORY_TABS: { id: ResourceCategoryTab; label: string; icon: string }[] = [
  { id: 'all', label: 'All resources', icon: 'apps-2-line' },
  { id: 'asset', label: 'Assets', icon: 'folder-open-line' },
  { id: 'brand-kit', label: 'Brand Kits', icon: 'palette-line' },
  { id: 'motion-template', label: 'Motion templates', icon: 'movie-line' },
  { id: 'design-template', label: 'Design templates', icon: 'layout-line' },
  { id: 'skills', label: 'Skills', icon: 'sparkling-line' },
  { id: 'projects', label: 'Projects', icon: 'stack-line' },
  { id: 'workflow', label: 'Workflows', icon: 'route-line' },
  { id: 'model', label: 'Models', icon: 'robot-line' },
];

export function resourceKey(item: Pick<SuperAgentResourceAttachment, 'kind' | 'id' | 'versionId'>): string {
  return `${item.kind}:${item.id}:${item.versionId ?? ''}`;
}

export function resourceIcon(item: Pick<SuperAgentResourceAttachment, 'kind' | 'modality' | 'annotation'>): string {
  if (item.kind === 'browser-annotation') {
    if (item.annotation?.mode === 'screenshot') return 'camera-line';
    if (item.annotation?.mode === 'console') return 'terminal-box-fill';
    return 'focus-3-line';
  }
  if (item.kind === 'asset' || item.kind === 'model') {
    if (item.modality === 'video') return 'movie-line';
    if (item.modality === 'audio') return 'music-2-line';
    return item.kind === 'model' ? 'robot-line' : 'image-line';
  }
  if (item.kind === 'brand-kit') return 'palette-line';
  if (item.kind === 'motion-template') return 'film-line';
  if (item.kind === 'design-template') return 'layout-line';
  if (item.kind === 'skill' || item.kind === 'design-skill') return 'sparkling-line';
  if (item.kind === 'motion-project') return 'clapperboard-line';
  if (item.kind === 'game-project') return 'gamepad-line';
  if (item.kind === 'workflow') return 'route-line';
  return 'code-s-slash-line';
}

export function resourceKindLabel(kind: SuperAgentResourceKind): string {
  switch (kind) {
    case 'asset': return 'Asset';
    case 'brand-kit': return 'Brand Kit';
    case 'motion-template': return 'Motion template';
    case 'design-template': return 'Design template';
    case 'skill': return 'Creative skill';
    case 'design-skill': return 'Design skill';
    case 'design-project': return 'Design project';
    case 'motion-project': return 'Motion project';
    case 'workflow': return 'Workflow';
    case 'model': return 'Model';
    case 'game-project': return 'Game project';
    case 'browser-annotation': return 'Browser annotation';
    default: return 'Resource';
  }
}

export function ResourcePickerPanel({
  open,
  initialCategory = 'all',
  selected,
  onToggle,
  onClear,
  onAddItems,
  onUploaded,
  onError,
}: {
  open: boolean;
  initialCategory?: ResourceCategoryTab;
  selected: SuperAgentResourceAttachment[];
  onToggle: (item: SuperAgentResourceAttachment) => void;
  onClear: () => void;
  onAddItems: (items: SuperAgentResourceAttachment[]) => void;
  onUploaded?: () => void;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const [category, setCategory] = useState<ResourceCategoryTab>(initialCategory);
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<SuperAgentResourceCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setCategory(initialCategory);
  }, [open, initialCategory]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    const timer = setTimeout(() => {
      void fetchWorkspaceResources({ kind: category, query, limit: 200 })
        .then(result => {
          if (!cancelled) setCatalog(result);
        })
        .catch(() => {
          if (!cancelled) setLoadFailed(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, query ? 150 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, category, query, retryToken]);

  const selectedKeys = new Set(selected.map(resourceKey));

  const handleUploadFiles = async (files: FileList | null) => {
    if (!files?.length || uploading) return;
    setUploading(true);
    try {
      const added: SuperAgentResourceAttachment[] = [];
      for (const file of Array.from(files)) {
        const asset = await uploadLibraryAsset(file);
        const current = assetVersion(asset);
        added.push({
          id: asset.id,
          kind: 'asset',
          title: asset.name,
          subtitle: current?.model || current?.source || asset.modality,
          modality: asset.modality,
          versionId: asset.currentVersionId,
          previewUrl: assetMediaUrl(asset.id, asset.currentVersionId),
        });
      }
      onAddItems(added);
      setRetryToken(value => value + 1);
      onUploaded?.();
    } catch (error) {
      onError(error instanceof Error ? error.message : t('Could not upload file'));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="om-sa-resource-popover-body" onKeyDown={event => event.stopPropagation()}>
      <div className="om-sa-resource-popover-toolbar">
        <label className="om-sa-resource-search">
          <RemixIcon name="search-line" size={14} />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('Search assets, Brand Kits, templates, skills…')}
            aria-label={t('Search workspace resources')}
          />
        </label>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={event => void handleUploadFiles(event.target.files)}
        />
        <Button
          variant="plain"
          type="button"
          className="om-sa-resource-upload-btn"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          <RemixIcon name={uploading ? 'loader-4-line' : 'upload-2-line'} size={14} />
          <span>{t(uploading ? 'Uploading…' : 'Upload')}</span>
        </Button>
      </div>

      <div className="om-sa-resource-tabs" role="tablist" aria-label={t('Resource categories')}>
        {CATEGORY_TABS.map(tab => (
          <Button
            key={tab.id}
            variant="plain"
            type="button"
            role="tab"
            aria-selected={category === tab.id}
            className="om-sa-resource-tab"
            onClick={() => setCategory(tab.id)}
          >
            <RemixIcon name={tab.icon} size={13} />
            <span>{t(tab.label)}</span>
          </Button>
        ))}
      </div>

      <div className="om-sa-resource-popover-list" aria-busy={loading}>
        {loading && !catalog ? (
          Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="om-sa-resource-skeleton">
              <Skeleton style={{ width: '100%', height: 42 }} />
            </div>
          ))
        ) : loadFailed ? (
          <div className="om-empty om-sa-resource-empty">
            <RemixIcon name="error-warning-line" size={20} />
            <p>{t('Could not load workspace resources')}</p>
            <Button variant="ghost" className="om-button h-auto" onClick={() => setRetryToken(value => value + 1)}>
              {t('Retry')}
            </Button>
          </div>
        ) : !catalog?.items.length ? (
          <div className="om-empty om-sa-resource-empty">
            <RemixIcon name="folder-open-line" size={20} />
            <p>{t('No matching resources found')}</p>
          </div>
        ) : (
          catalog.items.map(item => {
            const isSelected = selectedKeys.has(resourceKey(item));
            const showThumb = item.previewUrl && (item.kind === 'motion-template' || item.kind === 'brand-kit' || (item.kind === 'asset' && item.modality === 'image'));
            return (
              <Button
                key={resourceKey(item)}
                variant="plain"
                type="button"
                className="om-sa-resource-row"
                data-selected={isSelected || undefined}
                aria-pressed={isSelected}
                onClick={() => onToggle(item)}
              >
                <div className="om-sa-resource-thumb" aria-hidden="true">
                  {showThumb ? (
                    <img src={item.previewUrl} alt="" loading="lazy" decoding="async" />
                  ) : item.swatches?.length ? (
                    <div className="om-sa-resource-swatches">
                      {item.swatches.slice(0, 4).map((swatch, idx) => (
                        <span key={idx} style={{ background: swatch }} />
                      ))}
                    </div>
                  ) : (
                    <RemixIcon name={resourceIcon(item)} size={15} />
                  )}
                </div>
                <div className="om-sa-resource-meta">
                  <strong>{item.title}</strong>
                  <small>{t(resourceKindLabel(item.kind))}{item.subtitle ? ` · ${item.subtitle}` : ''}</small>
                </div>
                <span className="om-sa-resource-check" aria-hidden="true">
                  {isSelected && <RemixIcon name="check-line" size={14} />}
                </span>
              </Button>
            );
          })
        )}
      </div>

      <footer className="om-sa-resource-popover-foot">
        <span className="om-muted">
          {catalog ? t('{count} matching', { count: catalog.items.length }) : ''}
          {selected.length > 0 ? ` · ${t('{count} selected', { count: selected.length })}` : ''}
        </span>
        {selected.length > 0 && (
          <Button variant="plain" type="button" className="om-sa-chip-clear" onClick={onClear}>
            {t('Clear')}
          </Button>
        )}
      </footer>
    </div>
  );
}
