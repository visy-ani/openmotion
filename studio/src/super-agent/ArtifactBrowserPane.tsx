import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { menuClasses } from '../components/ui/menuStyle';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { brandCatalogFile, type BrandCatalogEntry } from '../../../shared/brand-catalog';
import type { BrandKit } from '../../../shared/brand-kit';
import type { GameCard } from '../../../shared/game-contract';
import type {
  BrowserColorScheme,
  BrowserConsoleEntry,
  BrowserPickedElement,
  WebPageState,
} from '../../../shared/browser';
import {
  designRoutes,
  designViewports,
  type DesignFile,
  type DesignProjectDetail,
  type DesignViewportId,
} from '../../../shared/design-project';
import {
  NEW_VIEWER_TAB_ID,
  artifactCanonicalAddress,
  safeBrowserTabId,
  type SuperAgentArtifact,
  type SuperAgentArtifactKind,
  type SuperAgentResourceAttachment,
} from '../../../shared/super-agent';
import { Popover } from '../components/ui/Popover';
import { WebPublishPopover } from '../components/WebPublishPopover';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { Tooltip } from '../components/ui/Tooltip';
import { designClient } from '../design/designClient';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import type { WebBrowserHandle } from '../motion/WebBrowser';
import {
  bundledGames,
  communityGames,
  coverUrl,
  gameApi,
  playableUrl,
  rememberInstruction,
  storedInstruction,
} from '../motion/game/gameCatalog';
import { lazyWithChunkReload, preloadableLazyWithChunkReload } from '../utils/chunkReload';
import { releaseMediaElement } from '../utils/releaseMediaElement';
import {
  BrowserAnnotationOverlay,
  type AnnotationContentBounds,
  type AnnotationOverlayTool,
  type BrowserAnnotationSubmitPayload,
} from './BrowserAnnotationOverlay';
import { resourceIcon } from './ResourcePickerDialog';
import {
  captureSuperAgentPreviewSnapshot,
  superAgentBrowserEndpoint,
  uploadSuperAgentAnnotationImage,
} from './superAgentClient';

type WebDevicePresetId = 'responsive' | 'desktop' | 'tablet' | 'mobile';

const WEB_DEVICE_PRESETS: { id: WebDevicePresetId; label: string; icon: string; width?: number; height?: number }[] = [
  { id: 'responsive', label: 'Responsive', icon: 'fullscreen-line' },
  { id: 'desktop', label: 'Desktop', icon: 'computer-line', width: 1280, height: 800 },
  { id: 'tablet', label: 'Tablet', icon: 'tablet-line', width: 768, height: 1024 },
  { id: 'mobile', label: 'Mobile', icon: 'smartphone-line', width: 390, height: 844 },
];

export { NEW_VIEWER_TAB_ID, safeBrowserTabId };

const CodeViewer = preloadableLazyWithChunkReload(() =>
  import('../design/CodeViewer').then(m => ({ default: m.CodeViewer })),
);
const WebBrowser = lazyWithChunkReload(() =>
  import('../motion/WebBrowser').then(m => ({ default: m.WebBrowser })),
);

function artifactTabIcon(kind: SuperAgentArtifactKind): string {
  switch (kind) {
    case 'design-project':
      return 'layout-line';
    case 'motion-project':
      return 'movie-line';
    case 'motion-export':
      return 'clapperboard-line';
    case 'asset-image':
      return 'image-line';
    case 'asset-video':
      return 'film-line';
    case 'asset-audio':
      return 'music-2-line';
    case 'brand-kit':
      return 'palette-line';
    case 'game-project':
      return 'gamepad-line';
    case 'web':
      return 'global-line';
    default:
      return 'file-line';
  }
}

function normalizeBrowserAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^0\.0\.0\.0(?::\d+)?(?:\/.*)?$/.test(trimmed)) {
    return `http://127.0.0.1${trimmed.slice('0.0.0.0'.length)}`;
  }
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/.*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  if (/^localhost(?::\d+)?(?:\/.*)?$/i.test(trimmed) || /^127\.0\.0\.1(?::\d+)?(?:\/.*)?$/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return null;
}

function searchWebUrl(query: string): string {
  return `https://www.bing.com/search?q=${encodeURIComponent(query.trim())}`;
}

function ManagedMediaElement({ kind, src }: { kind: 'video' | 'audio'; src: string }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    return () => releaseMediaElement(element);
  }, [src, kind]);
  return kind === 'video'
    ? <video ref={ref} controls playsInline src={src} />
    : <audio ref={ref} controls src={src} />;
}

function isInspectableCodeFile(file: DesignFile): boolean {
  return ['html', 'css', 'js', 'json', 'markdown', 'text'].includes(file.kind);
}

function isInspectableGameFile(filePath: string): boolean {
  return /\.(?:html?|css|m?js|cjs|tsx?|jsx?|json|md|txt|svg|glsl|wgsl)$/i.test(filePath);
}

function useInspectableCodeFiles({
  enabled,
  sourceKey,
  defaultPath,
  revisionKey,
  loadErrorFallback,
  loadFiles,
  readFile,
}: {
  enabled: boolean;
  sourceKey: string;
  defaultPath: string;
  revisionKey: string;
  loadErrorFallback: string;
  loadFiles: () => Promise<{ preferred: string; files: string[] }>;
  readFile: (path: string) => Promise<string>;
}) {
  const { t } = useI18n();
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>(defaultPath);
  const [fileContent, setFileContent] = useState<string>('');
  const [loadingCode, setLoadingCode] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const selectedRef = useRef(selectedFile);
  selectedRef.current = selectedFile;
  const loadFilesRef = useRef(loadFiles);
  loadFilesRef.current = loadFiles;
  const readFileRef = useRef(readFile);
  readFileRef.current = readFile;

  useEffect(() => {
    if (!enabled || !sourceKey) return;
    let cancelled = false;
    setLoadingCode(true);
    setCodeError(null);
    void loadFilesRef.current()
      .then(({ preferred, files: nextFiles }) => {
        if (cancelled) return;
        setFiles(nextFiles);
        const resolved = nextFiles.includes(selectedRef.current) ? selectedRef.current : preferred;
        setSelectedFile(resolved);
        if (!resolved) {
          setFileContent('');
          setLoadingCode(false);
        }
      })
      .catch(error => {
        if (!cancelled) {
          setCodeError(error instanceof Error ? error.message : loadErrorFallback);
          setLoadingCode(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, sourceKey, revisionKey, loadErrorFallback]);

  useEffect(() => {
    if (!enabled || !sourceKey || !selectedFile) return;
    let cancelled = false;
    setLoadingCode(true);
    setCodeError(null);
    void readFileRef.current(selectedFile)
      .then(content => {
        if (!cancelled) setFileContent(content);
      })
      .catch(error => {
        if (!cancelled) setCodeError(error instanceof Error ? error.message : t('Could not read file'));
      })
      .finally(() => {
        if (!cancelled) setLoadingCode(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, sourceKey, selectedFile, revisionKey, t]);

  return { files, selectedFile, setSelectedFile, fileContent, loadingCode, codeError };
}

type CodeFileMeta = {
  icon: string;
  tone: 'html' | 'css' | 'js' | 'ts' | 'json' | 'doc' | 'asset' | 'plain';
  lang: string;
};

function codeFileMeta(filePath: string): CodeFileMeta {
  const lower = filePath.toLowerCase();
  if (/\.(?:html?|xml)$/.test(lower)) return { icon: 'code-s-slash-line', tone: 'html', lang: lower.endsWith('.xml') ? 'XML' : 'HTML' };
  if (/\.(?:css|scss|less)$/.test(lower)) return { icon: 'palette-line', tone: 'css', lang: 'CSS' };
  if (/\.(?:m?js|cjs|jsx)$/.test(lower)) return { icon: 'braces-line', tone: 'js', lang: 'JavaScript' };
  if (/\.tsx?$/.test(lower)) return { icon: 'braces-line', tone: 'ts', lang: 'TypeScript' };
  if (/\.json$/.test(lower)) return { icon: 'braces-line', tone: 'json', lang: 'JSON' };
  if (/\.(?:glsl|wgsl)$/.test(lower)) return { icon: 'file-code-line', tone: 'ts', lang: 'Shader' };
  if (/\.md$/.test(lower)) return { icon: 'markdown-line', tone: 'doc', lang: 'Markdown' };
  if (/\.txt$/.test(lower)) return { icon: 'file-text-line', tone: 'plain', lang: 'Text' };
  if (/\.svg$/.test(lower)) return { icon: 'file-image-line', tone: 'asset', lang: 'SVG' };
  return { icon: 'file-code-line', tone: 'plain', lang: 'Code' };
}

const PRIORITY_CODE_FILES = ['index.html', 'client.js', 'logic.js', 'main.js', 'game.js', 'app.js', 'style.css', 'styles.css'];
const COLLAPSED_FOLDERS = new Set(['vendor', 'node_modules', 'lib', 'third-party']);

function groupProjectFiles(files: string[]) {
  const rootFiles: string[] = [];
  const folderMap = new Map<string, string[]>();
  for (const filePath of files) {
    const slash = filePath.indexOf('/');
    if (slash === -1) {
      rootFiles.push(filePath);
    } else {
      const folder = filePath.slice(0, slash);
      const list = folderMap.get(folder) ?? [];
      list.push(filePath);
      folderMap.set(folder, list);
    }
  }
  rootFiles.sort((a, b) => {
    const ai = PRIORITY_CODE_FILES.indexOf(a);
    const bi = PRIORITY_CODE_FILES.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.localeCompare(b);
  });
  const folders = [...folderMap.entries()]
    .sort(([a], [b]) => {
      const ac = COLLAPSED_FOLDERS.has(a.toLowerCase()) ? 1 : 0;
      const bc = COLLAPSED_FOLDERS.has(b.toLowerCase()) ? 1 : 0;
      if (ac !== bc) return ac - bc;
      return a.localeCompare(b);
    })
    .map(([name, list]) => ({
      name,
      files: list.sort((a, b) => a.localeCompare(b)),
      collapsedByDefault: COLLAPSED_FOLDERS.has(name.toLowerCase()),
    }));
  return { rootFiles, folders };
}

function ProjectPreviewCodeView({
  frameKey,
  title,
  previewUrl,
  srcDoc,
  sandbox,
  allow,
  mode,
  viewport,
  files,
  selectedFile,
  onSelectFile,
  fileContent,
  loadingCode,
  codeError,
  onNotify,
  frameRef,
  iframeRef,
  onIframeLoad,
  overlay,
}: {
  frameKey: string;
  title: string;
  previewUrl: string;
  srcDoc?: string | null;
  sandbox: string;
  allow?: string;
  mode: 'preview' | 'code';
  viewport: DesignViewportId;
  files: string[];
  selectedFile: string;
  onSelectFile: (path: string) => void;
  fileContent: string;
  loadingCode: boolean;
  codeError: string | null;
  onNotify?: (message: string, tone?: 'info' | 'error') => void;
  frameRef?: RefObject<HTMLDivElement | null>;
  iframeRef?: RefObject<HTMLIFrameElement | null>;
  onIframeLoad?: () => void;
  overlay?: ReactNode;
}) {
  const { t } = useI18n();
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    setFrameLoaded(false);
  }, [previewUrl, srcDoc]);

  useEffect(() => {
    setCopiedCode(false);
  }, [selectedFile]);

  const grouped = useMemo(() => groupProjectFiles(files), [files]);
  const selectOptions = useMemo(() => {
    const ordered = [
      ...grouped.rootFiles,
      ...grouped.folders.flatMap(folder => folder.files),
    ];
    return ordered.map(filePath => ({
      value: filePath,
      label: filePath,
    }));
  }, [grouped]);
  const lineCount = useMemo(() => (fileContent ? fileContent.split('\n').length : 0), [fileContent]);
  const activeMeta = useMemo(() => codeFileMeta(selectedFile), [selectedFile]);

  if (mode === 'code') {
    const handleCopyCode = async () => {
      if (!fileContent) return;
      try {
        await navigator.clipboard.writeText(fileContent);
        setCopiedCode(true);
        window.setTimeout(() => setCopiedCode(false), 1600);
        onNotify?.(t('Copied to clipboard'), 'info');
      } catch {
        onNotify?.(t('Could not copy to clipboard'), 'error');
      }
    };

    return (
      <div className="om-sa-code-view" data-sidebar-open={sidebarOpen || undefined}>
        {sidebarOpen && (
          <aside className="om-sa-code-sidebar" role="tablist" aria-label={t('Project files')}>
            <div className="om-sa-code-sidebar-head">
              <span>{t('Files')}</span>
              <small>{files.length}</small>
            </div>
            {grouped.rootFiles.map(filePath => {
              const meta = codeFileMeta(filePath);
              return (
                <Button
                  key={filePath}
                  variant="plain"
                  type="button"
                  role="tab"
                  aria-selected={selectedFile === filePath}
                  data-active={selectedFile === filePath || undefined}
                  title={filePath}
                  className="om-sa-code-file-row"
                  onClick={() => onSelectFile(filePath)}
                >
                  <RemixIcon name={meta.icon} size={13} className="om-sa-code-file-icon" data-tone={meta.tone} />
                  <span>{filePath}</span>
                </Button>
              );
            })}
            {grouped.folders.map(folder => {
              const containsActive = folder.files.includes(selectedFile);
              return (
                <details
                  key={folder.name}
                  className="om-sa-code-folder"
                  open={!folder.collapsedByDefault || containsActive || undefined}
                >
                  <summary className="om-sa-code-folder-head">
                    <RemixIcon name="arrow-right-s-line" size={12} className="om-sa-code-folder-chevron" />
                    <RemixIcon name="folder-line" size={13} className="om-sa-code-folder-icon om-sa-code-folder-icon-closed" />
                    <RemixIcon name="folder-open-line" size={13} className="om-sa-code-folder-icon om-sa-code-folder-icon-open" />
                    <span className="om-sa-code-folder-name">{folder.name}</span>
                    <small className="om-sa-code-folder-count">{folder.files.length}</small>
                  </summary>
                  <div className="om-sa-code-folder-list">
                    {folder.files.map(filePath => {
                      const base = filePath.slice(folder.name.length + 1);
                      const meta = codeFileMeta(filePath);
                      return (
                        <Button
                          key={filePath}
                          variant="plain"
                          type="button"
                          role="tab"
                          aria-selected={selectedFile === filePath}
                          data-active={selectedFile === filePath || undefined}
                          title={filePath}
                          className="om-sa-code-file-row om-sa-code-file-nested"
                          onClick={() => onSelectFile(filePath)}
                        >
                          <RemixIcon name={meta.icon} size={13} className="om-sa-code-file-icon" data-tone={meta.tone} />
                          <span>{base}</span>
                        </Button>
                      );
                    })}
                  </div>
                </details>
              );
            })}
          </aside>
        )}

        <div className="om-sa-code-main">
          <div className="om-sa-code-header">
            <div className="om-sa-code-header-left">
              <Tooltip label={t('Project files')}>
                <IconButton
                  variant="ghost"
                  className="motion-icon-button om-sa-code-sidebar-toggle"
                  data-active={sidebarOpen || undefined}
                  aria-label={t('Project files')}
                  onClick={() => setSidebarOpen(v => !v)}
                  icon={<RemixIcon name="side-bar-line" size={14} />}
                />
              </Tooltip>
              {selectedFile && (
                <span className="om-sa-code-active-path" title={selectedFile}>
                  <RemixIcon name={activeMeta.icon} size={13} className="om-sa-code-file-icon" data-tone={activeMeta.tone} />
                  <span>{selectedFile}</span>
                </span>
              )}
              {selectOptions.length > 0 && (
                <div className="om-sa-code-file-select">
                  <Select
                    label={t('Project files')}
                    value={selectedFile || selectOptions[0].value}
                    options={selectOptions}
                    onCommit={onSelectFile}
                  />
                </div>
              )}
            </div>
            <div className="om-sa-code-header-right">
              {selectedFile && !loadingCode && !codeError && (
                <span className="om-sa-code-lang" data-tone={activeMeta.tone}>{activeMeta.lang}</span>
              )}
              {lineCount > 0 && !loadingCode && !codeError && (
                <span className="om-sa-code-meta">{t('{count} lines', { count: lineCount })}</span>
              )}
              <Tooltip label={t('Copy')}>
                <IconButton
                  variant="ghost"
                  className="motion-icon-button om-sa-code-copy-btn"
                  data-copied={copiedCode || undefined}
                  aria-label={t('Copy')}
                  disabled={!fileContent || loadingCode}
                  onClick={() => void handleCopyCode()}
                  icon={<RemixIcon name={copiedCode ? 'check-line' : 'file-copy-line'} size={14} />}
                />
              </Tooltip>
            </div>
          </div>

          <div className="om-sa-code-panel">
            {loadingCode ? (
              <div className="om-sa-viewer-loading">
                <Skeleton style={{ width: '60%', height: 18 }} />
                <Skeleton style={{ width: '100%', height: 180 }} />
              </div>
            ) : codeError ? (
              <div className="om-empty om-sa-viewer-empty" role="alert">
                <RemixIcon name="error-warning-line" size={24} />
                <p>{codeError}</p>
              </div>
            ) : (
              <Suspense fallback={<div className="om-sa-viewer-loading"><Skeleton style={{ width: '100%', height: 180 }} /></div>}>
                <CodeViewer content={fileContent} />
              </Suspense>
            )}
          </div>
        </div>
      </div>
    );
  }

  const preset = designViewports.find(item => item.id === viewport) ?? designViewports[0];
  const frameStyle = preset.width && preset.height
    ? { width: preset.width, height: preset.height, maxWidth: '100%', maxHeight: '100%' }
    : undefined;

  return (
    <div className="om-sa-iframe-stage" data-viewport={viewport}>
      <div className="om-sa-iframe-frame" ref={frameRef} style={frameStyle}>
        {!frameLoaded && (previewUrl || srcDoc) && (
          <div className="om-sa-frame-skeleton" aria-hidden="true">
            <Skeleton style={{ width: '100%', height: '100%' }} />
          </div>
        )}
        <iframe
          ref={iframeRef}
          key={frameKey}
          title={title}
          {...(srcDoc ? { srcDoc } : { src: previewUrl })}
          sandbox={sandbox}
          {...(allow ? { allow } : {})}
          onLoad={() => {
            setFrameLoaded(true);
            onIframeLoad?.();
          }}
        />
        {overlay}
      </div>
    </div>
  );
}

type PreviewConsoleFilter = 'all' | 'errors' | 'warnings';

function PreviewConsoleDrawer({
  entries,
  errorCount,
  filter,
  onChangeFilter,
  onAttachErrors,
  onFixWithAgent,
  onClear,
  onClose,
}: {
  entries: BrowserConsoleEntry[];
  errorCount: number;
  filter: PreviewConsoleFilter;
  onChangeFilter: (next: PreviewConsoleFilter) => void;
  onAttachErrors: () => void;
  onFixWithAgent: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const visibleEntries = useMemo(() => {
    if (filter === 'errors') return entries.filter(e => e.level === 'error' || e.level === 'network');
    if (filter === 'warnings') return entries.filter(e => e.level === 'warn');
    return entries;
  }, [entries, filter]);

  return (
    <div className="om-sa-console-drawer" role="region" aria-label={t('Console & errors')}>
      <div className="om-sa-console-head">
        <div className="om-sa-console-title">
          <RemixIcon name="terminal-box-fill" size={14} />
          <span>{t('Console')}</span>
          {errorCount > 0 && (
            <span className="om-sa-console-badge">{errorCount}</span>
          )}
          <div className="om-sa-console-filters" role="group" aria-label={t('Console & errors')}>
            {(['all', 'errors', 'warnings'] as PreviewConsoleFilter[]).map(tab => (
              <Button
                key={tab}
                variant="plain"
                type="button"
                className="om-sa-console-filter-btn"
                data-active={filter === tab || undefined}
                onClick={() => onChangeFilter(tab)}
              >
                {t(tab === 'all' ? 'All' : tab === 'errors' ? 'Errors' : 'Warnings')}
              </Button>
            ))}
          </div>
        </div>
        <div className="om-sa-console-actions">
          <Button
            variant="plain"
            type="button"
            className="om-sa-toolbar-btn"
            disabled={!entries.length}
            onClick={onAttachErrors}
          >
            <RemixIcon name="add-line" size={13} />
            <span>{t('Attach errors')}</span>
          </Button>
          <Button
            variant="plain"
            type="button"
            className="om-sa-toolbar-btn om-sa-console-fix-btn"
            disabled={!entries.length}
            onClick={onFixWithAgent}
          >
            <RemixIcon name="sparkling-line" size={13} />
            <span>{t('Fix with Agent')}</span>
          </Button>
          <Button
            variant="plain"
            type="button"
            className="om-sa-toolbar-btn"
            disabled={!entries.length}
            onClick={onClear}
          >
            <span>{t('Clear')}</span>
          </Button>
          <IconButton
            variant="plain"
            className="om-sa-annot-close-btn"
            aria-label={t('Close console')}
            onClick={onClose}
            icon={<RemixIcon name="close-line" size={14} />}
          />
        </div>
      </div>
      <div className="om-sa-console-list">
        {visibleEntries.length === 0 ? (
          <div className="om-sa-console-empty">{t('No console messages or failed requests yet.')}</div>
        ) : (
          visibleEntries.map(entry => (
            <div key={entry.id} className="om-sa-console-row" data-level={entry.level}>
              <span className="om-sa-console-level">
                {(entry.level === 'error' || entry.level === 'network') && (
                  <RemixIcon name="alert-line" size={12} />
                )}
                {entry.level}
              </span>
              <span className="om-sa-console-text">{entry.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function useIframePreviewBridge({
  enabled,
  pickEnabled,
  rawPreviewPath,
  chatId,
  pageTitle,
  onConsoleEntry,
  captureRef,
}: {
  enabled: boolean;
  pickEnabled: boolean;
  rawPreviewPath: string;
  chatId: string | null;
  pageTitle: string;
  onConsoleEntry: (entry: BrowserConsoleEntry) => void;
  captureRef?: RefObject<(() => Promise<string | null>) | null>;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeTokenRef = useRef(`omb_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`);
  const [pickedElement, setPickedElement] = useState<BrowserPickedElement | null>(null);
  const onConsoleEntryRef = useRef(onConsoleEntry);
  onConsoleEntryRef.current = onConsoleEntry;
  const captureResolversRef = useRef<Map<string, (dataUrl: string | null) => void>>(new Map());
  const consoleSeqRef = useRef(0);

  const bridgedPreviewUrl = useMemo(() => {
    if (!rawPreviewPath) return '';
    const sep = rawPreviewPath.includes('?') ? '&' : '?';
    return `${rawPreviewPath}${sep}omBridge=${encodeURIComponent(bridgeTokenRef.current)}`;
  }, [rawPreviewPath]);

  const syncPickMode = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const msg = { type: 'om:preview-mode', token: bridgeTokenRef.current, pick: enabled && pickEnabled };
    try {
      win.postMessage(msg, '*');
    } catch { /* ignore detached frame */ }
  }, [enabled, pickEnabled]);

  useEffect(() => {
    syncPickMode();
  }, [syncPickMode]);

  useEffect(() => {
    if (!pickEnabled) setPickedElement(null);
  }, [pickEnabled, rawPreviewPath]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object' || msg.token !== bridgeTokenRef.current) return;

      if ((msg.type === 'om:preview-pick' || msg.type === 'om:design-pick') && msg.element) {
        const raw = msg.element as Record<string, unknown>;
        const r = msg.rect as { x?: number; y?: number; width?: number; height?: number } | undefined;
        const vp = msg.viewport as { width?: number; height?: number } | undefined;
        const tagName = String(raw.tagName || raw.tag || 'div').toLowerCase();
        const rectObj = (raw.rect as { x?: number; y?: number; width?: number; height?: number } | undefined) ?? r;
        const vpObj = (raw.viewport as { width?: number; height?: number } | undefined) ?? vp;
        const selector = String(raw.selector || tagName);
        const rawText = typeof raw.text === 'string' ? raw.text : undefined;
        const classes = Array.isArray(raw.classes) ? raw.classes.map(String) : undefined;
        setPickedElement({
          tagName,
          selector,
          ...(typeof raw.id === 'string' && raw.id ? { id: raw.id } : typeof raw.elementId === 'string' && raw.elementId ? { id: raw.elementId } : {}),
          ...(classes?.length ? { classes } : {}),
          label: String(raw.label || rawText?.slice(0, 48) || selector),
          ...(rawText ? { text: rawText } : {}),
          htmlPreview: String(raw.htmlPreview || raw.html || raw.htmlHint || ''),
          styles: (raw.styles && typeof raw.styles === 'object' ? raw.styles : {}) as Record<string, string>,
          rect: {
            x: Math.round(rectObj?.x ?? 0),
            y: Math.round(rectObj?.y ?? 0),
            width: Math.round(rectObj?.width ?? 40),
            height: Math.round(rectObj?.height ?? 24),
          },
          viewport: {
            width: Math.max(1, Math.round(vpObj?.width ?? frameRef.current?.clientWidth ?? 1280)),
            height: Math.max(1, Math.round(vpObj?.height ?? frameRef.current?.clientHeight ?? 800)),
          },
          pageUrl: typeof raw.pageUrl === 'string' && raw.pageUrl ? raw.pageUrl : rawPreviewPath,
          pageTitle: typeof raw.pageTitle === 'string' && raw.pageTitle ? raw.pageTitle : pageTitle,
          ...(typeof raw.componentName === 'string' && raw.componentName ? { componentName: raw.componentName } : {}),
          ...(typeof raw.sourceFile === 'string' && raw.sourceFile ? { sourceFile: raw.sourceFile } : {}),
          ...(typeof raw.sourceLine === 'number' ? { sourceLine: raw.sourceLine } : {}),
          ...(typeof raw.sourceColumn === 'number' ? { sourceColumn: raw.sourceColumn } : {}),
        });
        return;
      }

      if (msg.type === 'om:preview-console' && typeof msg.text === 'string') {
        const level = msg.level === 'warn' ? 'warn' : msg.level === 'log' ? 'log' : 'error';
        onConsoleEntryRef.current({
          id: `pv-${++consoleSeqRef.current}-${Date.now()}`,
          level,
          text: msg.text.slice(0, 600),
          ...(typeof msg.url === 'string' ? { url: msg.url } : {}),
          ...(typeof msg.line === 'number' ? { line: msg.line } : {}),
          timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
        });
        return;
      }

      if (msg.type === 'om:preview-capture-result') {
        const requestId = String(msg.requestId || '');
        const resolver = captureResolversRef.current.get(requestId);
        if (resolver) {
          captureResolversRef.current.delete(requestId);
          resolver(typeof msg.dataUrl === 'string' && msg.dataUrl.startsWith('data:image/png;base64,') ? msg.dataUrl : null);
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [rawPreviewPath, pageTitle]);

  const captureCanvasOrSnapshot = useCallback(async (): Promise<string | null> => {
    const win = iframeRef.current?.contentWindow;
    if (win) {
      const requestId = `cap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const canvasUrl = await new Promise<string | null>(resolve => {
        const timer = setTimeout(() => {
          captureResolversRef.current.delete(requestId);
          resolve(null);
        }, 450);
        captureResolversRef.current.set(requestId, dataUrl => {
          clearTimeout(timer);
          resolve(dataUrl);
        });
        try {
          win.postMessage({ type: 'om:preview-capture', token: bridgeTokenRef.current, requestId }, '*');
        } catch {
          clearTimeout(timer);
          captureResolversRef.current.delete(requestId);
          resolve(null);
        }
      });
      if (canvasUrl) return canvasUrl;
    }

    if (chatId && rawPreviewPath) {
      const cleanPath = rawPreviewPath.split('?')[0];
      const w = Math.max(240, Math.round(frameRef.current?.clientWidth ?? 1280));
      const h = Math.max(240, Math.round(frameRef.current?.clientHeight ?? 800));
      try {
        const shot = await captureSuperAgentPreviewSnapshot(chatId, cleanPath, w, h);
        return shot.dataUrl || null;
      } catch {
        return null;
      }
    }
    return null;
  }, [chatId, rawPreviewPath]);

  useEffect(() => {
    if (!captureRef) return;
    if (enabled) {
      captureRef.current = captureCanvasOrSnapshot;
      return () => {
        if (captureRef.current === captureCanvasOrSnapshot) captureRef.current = null;
      };
    }
    return undefined;
  }, [enabled, captureRef, captureCanvasOrSnapshot]);

  const getContentBounds = useCallback((): AnnotationContentBounds | null => {
    const el = frameRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      vpWidth: pickedElement?.viewport.width || Math.round(rect.width),
      vpHeight: pickedElement?.viewport.height || Math.round(rect.height),
    };
  }, [pickedElement?.viewport.width, pickedElement?.viewport.height]);

  return {
    frameRef,
    iframeRef,
    bridgedPreviewUrl,
    pickedElement,
    syncPickMode,
    getContentBounds,
    captureCanvasOrSnapshot,
  };
}

function DesignProjectArtifactView({
  artifact,
  chatId,
  mode,
  viewport,
  reloadKey,
  annotateActive,
  annotTool,
  onToolChange,
  onConsoleEntry,
  captureRef,
  onSubmitAnnotation,
  onCloseAnnotate,
  onNotify,
}: {
  artifact: SuperAgentArtifact;
  chatId: string | null;
  mode: 'preview' | 'code';
  viewport: DesignViewportId;
  reloadKey: number;
  annotateActive: boolean;
  annotTool: AnnotationOverlayTool;
  onToolChange: (tool: AnnotationOverlayTool) => void;
  onConsoleEntry: (entry: BrowserConsoleEntry) => void;
  captureRef: RefObject<(() => Promise<string | null>) | null>;
  onSubmitAnnotation: (payload: BrowserAnnotationSubmitPayload, sendImmediately: boolean) => Promise<void>;
  onCloseAnnotate: () => void;
  onNotify?: (message: string, tone?: 'info' | 'error') => void;
}) {
  const { t } = useI18n();
  const projectId = artifact.projectId || '';
  const entry = artifact.entry || 'index.html';
  const presentedKey = artifact.presentedAt ?? '';
  const revisionKey = `${artifact.revision ?? ''}:${presentedKey}:${reloadKey}`;

  const previewUrl = useMemo(() => {
    if (!projectId) return '';
    const presentedParam = artifact.presentedAt ? `&p=${artifact.presentedAt}` : '';
    return `${designRoutes.raw(projectId, entry)}?rev=${encodeURIComponent(artifact.revision || String(reloadKey))}${presentedParam}&r=${reloadKey}`;
  }, [projectId, entry, artifact.revision, artifact.presentedAt, reloadKey]);

  const bridge = useIframePreviewBridge({
    enabled: mode === 'preview' && Boolean(previewUrl),
    pickEnabled: annotateActive && mode === 'preview' && annotTool === 'select',
    rawPreviewPath: previewUrl,
    chatId,
    pageTitle: artifact.title,
    onConsoleEntry,
    captureRef,
  });

  const code = useInspectableCodeFiles({
    enabled: mode === 'code',
    sourceKey: projectId,
    defaultPath: entry,
    revisionKey,
    loadErrorFallback: t('Could not load project files'),
    loadFiles: async () => {
      const result = await designClient.getProject(projectId);
      const codeFiles = (result.project as DesignProjectDetail).files.filter(isInspectableCodeFile).map(item => item.path);
      const preferred = codeFiles.includes(result.project.entry) ? result.project.entry : (codeFiles[0] ?? '');
      return { preferred, files: codeFiles };
    },
    readFile: async filePath => (await designClient.readFile(projectId, filePath)).content,
  });

  return (
    <ProjectPreviewCodeView
      frameKey={`${projectId}:${artifact.revision ?? ''}:${presentedKey}:${reloadKey}`}
      title={artifact.title}
      previewUrl={bridge.bridgedPreviewUrl || previewUrl}
      sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads"
      mode={mode}
      viewport={viewport}
      files={code.files}
      selectedFile={code.selectedFile}
      onSelectFile={code.setSelectedFile}
      fileContent={code.fileContent}
      loadingCode={code.loadingCode}
      codeError={code.codeError}
      onNotify={onNotify}
      frameRef={bridge.frameRef}
      iframeRef={bridge.iframeRef}
      onIframeLoad={bridge.syncPickMode}
      overlay={annotateActive && mode === 'preview' ? (
        <BrowserAnnotationOverlay
          mode="design-iframe"
          pageUrl={previewUrl}
          pageTitle={artifact.title}
          artifactId={artifact.id}
          artifactKind={artifact.kind}
          projectId={projectId}
          canSelectElement
          externalPickedElement={bridge.pickedElement}
          onToolChange={onToolChange}
          getContentBounds={bridge.getContentBounds}
          captureBaseScreenshot={bridge.captureCanvasOrSnapshot}
          onSubmitAnnotation={onSubmitAnnotation}
          onClose={onCloseAnnotate}
        />
      ) : null}
    />
  );
}

function GameProjectArtifactView({
  artifact,
  chatId,
  mode,
  viewport,
  reloadKey,
  annotateActive,
  annotTool,
  onToolChange,
  onConsoleEntry,
  captureRef,
  onSubmitAnnotation,
  onCloseAnnotate,
  onNotify,
  onGameMeta,
}: {
  artifact: SuperAgentArtifact;
  chatId: string | null;
  mode: 'preview' | 'code' | 'trailer';
  viewport: DesignViewportId;
  reloadKey: number;
  annotateActive: boolean;
  annotTool: AnnotationOverlayTool;
  onToolChange: (tool: AnnotationOverlayTool) => void;
  onConsoleEntry: (entry: BrowserConsoleEntry) => void;
  captureRef: RefObject<(() => Promise<string | null>) | null>;
  onSubmitAnnotation: (payload: BrowserAnnotationSubmitPayload, sendImmediately: boolean) => Promise<void>;
  onCloseAnnotate: () => void;
  onNotify?: (message: string, tone?: 'info' | 'error') => void;
  onGameMeta?: (meta: { trailerUrl: string | null; source: GameCard['source'] | null }) => void;
}) {
  const { t } = useI18n();
  const projectId = artifact.projectId || '';
  const artifactGameId = projectId || (artifact.id.startsWith('game:') ? artifact.id.slice('game:'.length) : '');
  const presentedKey = artifact.presentedAt ?? '';
  const revisionKey = `${artifact.revision ?? ''}:${presentedKey}:${reloadKey}`;

  const communityMatch = useMemo<GameCard | null>(
    () => (!projectId && artifactGameId ? communityGames.find(item => item.id === artifactGameId) ?? null : null),
    [projectId, artifactGameId],
  );
  const bundledMatch = useMemo<GameCard | null>(
    () => (projectId ? bundledGames.find(item => item.id === projectId) ?? null : null),
    [projectId],
  );
  const [gameMeta, setGameMeta] = useState<GameCard | null>(null);
  const [bundledBlobUrl, setBundledBlobUrl] = useState<string | null>(null);
  const [handoffText, setHandoffText] = useState<string | null>(() => (projectId ? storedInstruction(projectId) : null));
  const [copiedHandoff, setCopiedHandoff] = useState(false);

  useEffect(() => {
    setGameMeta(null);
    setBundledBlobUrl(null);
    setCopiedHandoff(false);
    setHandoffText(projectId ? storedInstruction(projectId) : null);
    if (!projectId) {
      onGameMeta?.({ trailerUrl: null, source: communityMatch ? 'community' : null });
      return;
    }
    let cancelled = false;
    let revoked: string | null = null;
    void gameApi.catalog()
      .then(res => {
        if (cancelled) return;
        const found = res.games?.find(item => item.id === projectId) ?? null;
        setGameMeta(found);
        const trailerUrl = found?.trailer?.status === 'ready' && found.trailer.videoUrl
          ? found.trailer.videoUrl.replace(/^\/api\//, '/motion-api/')
          : null;
        onGameMeta?.({ trailerUrl, source: found?.source ?? (bundledMatch ? 'template' : 'mine') });
      })
      .catch(() => {
        if (cancelled) return;
        onGameMeta?.({ trailerUrl: null, source: bundledMatch ? 'template' : 'mine' });
        if (bundledMatch) {
          void playableUrl(bundledMatch).then(next => {
            if (cancelled) {
              if (next.startsWith('blob:')) URL.revokeObjectURL(next);
              return;
            }
            if (next.startsWith('blob:')) revoked = next;
            setBundledBlobUrl(next);
          }).catch(() => {});
        }
      });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [projectId, revisionKey, bundledMatch]);

  const isDraftOrFailed = Boolean(
    projectId
    && gameMeta?.source === 'mine'
    && (gameMeta.status === 'draft' || gameMeta.status === 'failed'),
  );
  const isBuilding = Boolean(projectId && gameMeta?.source === 'mine' && gameMeta.status === 'building');

  useEffect(() => {
    if (!projectId || !isDraftOrFailed) return;
    let cancelled = false;
    void gameApi.handoff(projectId)
      .then(res => {
        if (cancelled) return;
        setHandoffText(res.agentInstruction);
        rememberInstruction(projectId, res.agentInstruction);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, isDraftOrFailed]);

  const trailerUrl = gameMeta?.trailer?.status === 'ready' && gameMeta.trailer.videoUrl
    ? gameMeta.trailer.videoUrl.replace(/^\/api\//, '/motion-api/')
    : null;

  const isExternalGame = !projectId && Boolean(artifact.url && /^https?:\/\//i.test(artifact.url));
  const nonEmbeddableExternal = Boolean(communityMatch?.external && !communityMatch.external.embeddable);

  const previewUrl = useMemo(() => {
    if (bundledBlobUrl) return bundledBlobUrl;
    if (projectId) {
      const presentedParam = artifact.presentedAt ? `&p=${artifact.presentedAt}` : '';
      return `/motion-api/games/${encodeURIComponent(projectId)}/play/index.html?rev=${encodeURIComponent(artifact.revision || String(reloadKey))}${presentedParam}&r=${reloadKey}`;
    }
    return artifact.url || '';
  }, [bundledBlobUrl, projectId, artifact.url, artifact.revision, artifact.presentedAt, reloadKey]);

  const effectiveMode: 'preview' | 'code' = projectId && mode === 'code' ? 'code' : 'preview';
  const bridge = useIframePreviewBridge({
    enabled: Boolean(projectId) && !bundledBlobUrl && !isDraftOrFailed && !isBuilding && mode === 'preview' && Boolean(previewUrl),
    pickEnabled: annotateActive && Boolean(projectId) && mode === 'preview' && annotTool === 'select',
    rawPreviewPath: previewUrl,
    chatId,
    pageTitle: artifact.title,
    onConsoleEntry,
    captureRef,
  });

  const code = useInspectableCodeFiles({
    enabled: Boolean(projectId) && mode === 'code',
    sourceKey: projectId,
    defaultPath: 'index.html',
    revisionKey,
    loadErrorFallback: t('Could not load game files'),
    loadFiles: async () => {
      const res = await fetch(`/motion-api/games/${encodeURIComponent(projectId)}/files`);
      if (!res.ok) throw new Error(t('Could not load game files'));
      const data = (await res.json()) as { files?: Array<{ path: string; bytes?: number }> };
      const codeFiles = (data.files ?? []).map(item => item.path).filter(isInspectableGameFile);
      const preferred =
        ['index.html', 'game.js', 'main.js', 'logic.js'].find(candidate => codeFiles.includes(candidate))
        ?? codeFiles[0]
        ?? '';
      return { preferred, files: codeFiles };
    },
    readFile: async filePath => {
      const encoded = filePath.split('/').map(encodeURIComponent).join('/');
      const res = await fetch(`/motion-api/games/${encodeURIComponent(projectId)}/play/${encoded}?r=${reloadKey}`);
      if (!res.ok) throw new Error(t('Could not read file'));
      return res.text();
    },
  });

  if (mode === 'trailer' && trailerUrl) {
    return (
      <div className="om-sa-media-stage" data-kind="video">
        <ManagedMediaElement kind="video" src={trailerUrl} />
      </div>
    );
  }

  if (nonEmbeddableExternal && communityMatch?.external) {
    const cover = coverUrl(communityMatch);
    return (
      <div className="om-sa-game-external">
        {cover && <img src={cover} alt="" />}
        <div className="om-sa-game-external-card">
          <strong>{t('This game only runs on the creator’s site.')}</strong>
          <Button
            variant="ghost"
            className="om-button h-auto"
            data-primary
            onClick={() => window.open(communityMatch.external!.url, '_blank', 'noopener,noreferrer')}
          >
            <RemixIcon name="external-link-line" size={15} />
            <span>{t('Play on the creator’s page')}</span>
          </Button>
        </div>
      </div>
    );
  }

  if (isBuilding && mode === 'preview') {
    return (
      <div className="om-sa-game-draft-stage">
        <span className="om-sa-head-spinner" aria-hidden="true">
          <RemixIcon name="loader-4-line" size={24} />
        </span>
        <strong>{t('Agent is running…')}</strong>
        <p className="om-muted">{t('The game will load here when it is ready.')}</p>
      </div>
    );
  }

  if (isDraftOrFailed && mode === 'preview') {
    const stopped = gameMeta?.status === 'failed';
    const copyInstruction = async () => {
      if (!handoffText) return;
      try {
        await navigator.clipboard.writeText(handoffText);
        setCopiedHandoff(true);
        onNotify?.(t('Instruction copied'), 'info');
      } catch {
        onNotify?.(t('Could not copy to clipboard'), 'error');
      }
    };
    return (
      <div className="om-sa-game-draft-stage" data-tone={gameMeta?.status}>
        <RemixIcon name={stopped ? 'error-warning-line' : 'robot-line'} size={24} />
        <strong>{stopped ? t('The Agent stopped before finishing this game.') : t('Waiting for your Agent')}</strong>
        <p className="om-muted">{t('Send a prompt in Super Agent or copy the MCP instruction into Codex or Claude Code.')}</p>
        <div className="om-sa-game-draft-actions">
          <Button
            variant="ghost"
            className="om-button h-auto"
            disabled={!handoffText}
            onClick={() => void copyInstruction()}
          >
            <RemixIcon name={copiedHandoff ? 'check-line' : 'file-copy-line'} size={14} />
            <span>{copiedHandoff ? t('Instruction copied') : t('Copy instruction')}</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <ProjectPreviewCodeView
      frameKey={`${projectId || artifact.id}:${artifact.revision ?? ''}:${presentedKey}:${reloadKey}`}
      title={artifact.title}
      previewUrl={isExternalGame || bundledBlobUrl ? previewUrl : (bridge.bridgedPreviewUrl || previewUrl)}
      sandbox={
        isExternalGame
          ? 'allow-scripts allow-same-origin allow-pointer-lock allow-popups'
          : 'allow-scripts allow-pointer-lock allow-popups allow-modals'
      }
      allow="fullscreen; gamepad; autoplay; clipboard-write"
      mode={effectiveMode}
      viewport={viewport}
      files={code.files}
      selectedFile={code.selectedFile}
      onSelectFile={code.setSelectedFile}
      fileContent={code.fileContent}
      loadingCode={code.loadingCode}
      codeError={code.codeError}
      onNotify={onNotify}
      frameRef={bridge.frameRef}
      iframeRef={bridge.iframeRef}
      onIframeLoad={isExternalGame || bundledBlobUrl ? undefined : bridge.syncPickMode}
      overlay={annotateActive && Boolean(projectId) && effectiveMode === 'preview' ? (
        <BrowserAnnotationOverlay
          mode="game-iframe"
          pageUrl={previewUrl}
          pageTitle={artifact.title}
          artifactId={artifact.id}
          artifactKind={artifact.kind}
          projectId={projectId || undefined}
          canSelectElement
          externalPickedElement={bridge.pickedElement}
          onToolChange={onToolChange}
          getContentBounds={bridge.getContentBounds}
          captureBaseScreenshot={bridge.captureCanvasOrSnapshot}
          onSubmitAnnotation={onSubmitAnnotation}
          onClose={onCloseAnnotate}
        />
      ) : null}
    />
  );
}

function BrandKitArtifactView({
  artifact,
  reloadKey,
}: {
  artifact: SuperAgentArtifact;
  reloadKey: number;
}) {
  const { t } = useI18n();
  const kitId = artifact.kitId || '';
  const isCatalog = kitId.startsWith('catalog:');
  const catalogId = isCatalog ? kitId.slice('catalog:'.length) : '';
  const [savedKit, setSavedKit] = useState<BrandKit | null>(null);
  const [catalogEntry, setCatalogEntry] = useState<BrandCatalogEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!kitId) {
      setLoading(false);
      setError(t('Brand Kit identity is missing'));
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = async () => {
      if (isCatalog) {
        const res = await fetch('/motion-api/brand-kits/catalog');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { entries: BrandCatalogEntry[] };
        const found = data.entries.find(item => item.id === catalogId) ?? null;
        if (!found) throw new Error(t('Brand Kit could not be found'));
        if (!cancelled) {
          setCatalogEntry(found);
          setSavedKit(null);
        }
      } else {
        const res = await fetch(`/motion-api/brand-kits/${encodeURIComponent(kitId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { kit: BrandKit };
        if (!cancelled) {
          setSavedKit(data.kit);
          setCatalogEntry(null);
        }
      }
    };
    void load()
      .catch(err => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('Could not load Brand Kit'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kitId, isCatalog, catalogId, reloadKey, retryCount, t]);

  if (loading) {
    return (
      <div className="om-sa-viewer-loading">
        <Skeleton style={{ width: '48%', height: 24 }} />
        <Skeleton style={{ width: '100%', height: 220 }} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="om-empty om-sa-viewer-empty" role="alert">
        <RemixIcon name="error-warning-line" size={24} />
        <p>{error}</p>
        <Button variant="ghost" className="om-button h-auto" onClick={() => setRetryCount(v => v + 1)}>
          {t('Retry')}
        </Button>
      </div>
    );
  }

  const title = savedKit ? savedKit.nameOverride || savedKit.name : catalogEntry?.name || artifact.title;
  const subtitle = savedKit
    ? savedKit.websiteUrl || savedKit.url
    : catalogEntry?.description || catalogEntry?.category;
  const sample = savedKit?.sample ?? catalogEntry?.sample;
  const swatches = (sample?.colors?.length ? sample.colors : catalogEntry?.colors ?? []).slice(0, 10);
  const style = sample?.style;

  return (
    <div className="om-sa-brand-view">
      <div className="om-sa-brand-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="om-muted">{subtitle}</p>}
        </div>
        {catalogEntry && (
          <span className="om-badge">{catalogEntry.category}</span>
        )}
      </div>

      {isCatalog ? (
        <div className="om-sa-brand-showcase">
          <iframe
            title={`${title} showcase`}
            src={brandCatalogFile(catalogId, 'showcase')}
            sandbox="allow-scripts"
          />
        </div>
      ) : savedKit?.preview ? (
        <div className="om-sa-brand-showcase">
          <ManagedMediaElement kind="video" src={`/motion-api/brand-kits/${encodeURIComponent(savedKit.id)}/files/preview.mp4`} />
        </div>
      ) : savedKit?.poster ? (
        <div className="om-sa-brand-showcase">
          <img src={`/motion-api/brand-kits/${encodeURIComponent(savedKit.id)}/files/poster.png`} alt={title} />
        </div>
      ) : null}

      {swatches.length > 0 && (
        <section className="om-sa-brand-section">
          <span className="om-eyebrow">{t('Palette')}</span>
          <div className="om-sa-brand-swatches">
            {swatches.map((hex, idx) => (
              <div key={`${hex}-${idx}`} className="om-sa-brand-swatch">
                <span className="om-sa-brand-swatch-chip" style={{ background: hex }} aria-hidden="true" />
                <code>{hex}</code>
              </div>
            ))}
          </div>
        </section>
      )}

      {style && (
        <section className="om-sa-brand-section">
          <span className="om-eyebrow">{t('Typography & surface tokens')}</span>
          <div className="om-sa-brand-tokens">
            <div><small>{t('Heading font')}</small><strong>{style.headingFont}</strong></div>
            <div><small>{t('Body font')}</small><strong>{style.bodyFont}</strong></div>
            <div><small>{t('Radius')}</small><strong>{style.radius}</strong></div>
          </div>
        </section>
      )}
    </div>
  );
}

function ImageArtifactView({ url, title }: { url: string; title: string }) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    setZoom(1);
  }, [url]);

  return (
    <div className="om-sa-media-stage" data-kind="image">
      <div className="om-sa-zoom-bar">
        <IconButton
          variant="ghost"
          className="motion-icon-button"
          aria-label={t('Zoom out')}
          disabled={zoom <= 0.25}
          onClick={() => setZoom(v => Math.max(0.25, Number((v - 0.25).toFixed(2))))}
          icon={<RemixIcon name="zoom-out-line" size={15} />}
        />
        <Button
          variant="plain"
          type="button"
          className="om-sa-zoom-readout"
          onClick={() => setZoom(1)}
          title={t('Reset zoom')}
        >
          {Math.round(zoom * 100)}%
        </Button>
        <IconButton
          variant="ghost"
          className="motion-icon-button"
          aria-label={t('Zoom in')}
          disabled={zoom >= 3}
          onClick={() => setZoom(v => Math.min(3, Number((v + 0.25).toFixed(2))))}
          icon={<RemixIcon name="zoom-in-line" size={15} />}
        />
      </div>

      <div className="om-sa-image-checkerboard">
        {failed ? (
          <div className="om-empty om-sa-viewer-empty" role="alert">
            <RemixIcon name="error-warning-line" size={24} />
            <p>{t('Could not load image preview')}</p>
            <Button variant="ghost" className="om-button h-auto" onClick={() => setFailed(false)}>
              {t('Retry')}
            </Button>
          </div>
        ) : (
          <img
            src={url}
            alt={title}
            style={{ transform: `scale(${zoom})` }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}

export function ArtifactBrowserPane({
  active = true,
  chatId,
  artifacts,
  openTabIds,
  activeTabId,
  expanded,
  workspaceItems,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onOpenWebUrl,
  onOpenArtifact,
  onOpenResource,
  onToggleExpand,
  onClosePane,
  onAttachArtifact,
  onUseGameInAgent,
  onAttachBrowserAnnotation,
  onNotify,
  onOpenInDesignStudio,
  onOpenInMotionStudio,
  onOpenInGameStudio,
  onOpenInAssets,
  onOpenInBrandKit,
}: {
  active?: boolean;
  chatId: string | null;
  artifacts: SuperAgentArtifact[];
  openTabIds: string[];
  activeTabId: string;
  expanded: boolean;
  workspaceItems: SuperAgentResourceAttachment[];
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  onOpenWebUrl: (url: string) => void;
  onOpenArtifact: (artifactId: string) => void;
  onOpenResource: (item: SuperAgentResourceAttachment) => void;
  onToggleExpand: () => void;
  onClosePane: () => void;
  onAttachArtifact: (artifact: SuperAgentArtifact) => void;
  onUseGameInAgent?: (artifact: SuperAgentArtifact) => void;
  onAttachBrowserAnnotation?: (attachment: SuperAgentResourceAttachment, sendImmediately?: boolean) => void;
  onNotify?: (message: string, tone?: 'info' | 'error') => void;
  onOpenInDesignStudio: (projectId: string) => void;
  onOpenInMotionStudio: (projectId: string) => void;
  onOpenInGameStudio?: (projectId: string) => void;
  onOpenInAssets: (assetId: string, versionId?: string) => void;
  onOpenInBrandKit: (kitId?: string) => void;
}) {
  const { t } = useI18n();
  const [viewMode, setViewMode] = useState<'preview' | 'code' | 'trailer'>('preview');
  const [gameTrailerUrl, setGameTrailerUrl] = useState<string | null>(null);
  const [gameSourceKind, setGameSourceKind] = useState<GameCard['source'] | null>(null);
  const [viewport, setViewport] = useState<DesignViewportId>('desktop');
  const [reloadKey, setReloadKey] = useState(0);
  const [webState, setWebState] = useState<WebPageState | null>(null);
  const [addressDraft, setAddressDraft] = useState('');
  const [addressEditing, setAddressEditing] = useState(false);
  const [newTabQuery, setNewTabQuery] = useState('');
  const [newTabFilter, setNewTabFilter] = useState<'all' | 'web-apps' | 'motion' | 'media' | 'brand-kit' | 'browser'>('all');
  const [pendingWebUrl, setPendingWebUrl] = useState<string | null>(null);
  const [annotateActive, setAnnotateActive] = useState(false);
  const [annotTool, setAnnotTool] = useState<AnnotationOverlayTool>('select');
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [webDevicePreset, setWebDevicePreset] = useState<WebDevicePresetId>('responsive');
  const [webDeviceRotated, setWebDeviceRotated] = useState(false);
  const [browserMenuOpen, setBrowserMenuOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleFilter, setConsoleFilter] = useState<PreviewConsoleFilter>('all');
  const [consoleEntries, setConsoleEntries] = useState<BrowserConsoleEntry[]>([]);
  const [capturingScreenshot, setCapturingScreenshot] = useState(false);
  const [webTabTitles, setWebTabTitles] = useState<Record<string, string>>({});
  const webRef = useRef<WebBrowserHandle>(null);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const previewCaptureRef = useRef<(() => Promise<string | null>) | null>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const newTabInputRef = useRef<HTMLInputElement>(null);

  const openTabs = useMemo(() => {
    const byId = new Map(artifacts.map(item => [item.id, item]));
    return openTabIds
      .map(id => byId.get(id))
      .filter((item): item is SuperAgentArtifact => Boolean(item));
  }, [artifacts, openTabIds]);

  const showNewTab = activeTabId === NEW_VIEWER_TAB_ID || !openTabs.length;
  const activeArtifact = showNewTab
    ? null
    : openTabs.find(item => item.id === activeTabId) ?? openTabs.at(-1) ?? null;

  useEffect(() => {
    setWebState(null);
    setAddressEditing(false);
    setPendingWebUrl(null);
    setAnnotateActive(false);
    setAnnotTool('select');
    setDeviceMenuOpen(false);
    setBrowserMenuOpen(false);
    setConsoleEntries([]);
    setConsoleFilter('all');
    setGameTrailerUrl(null);
    setGameSourceKind(null);
    if (!activeArtifact) {
      setAddressDraft('');
      setConsoleOpen(false);
      return;
    }
    if (!['web', 'design-project', 'game-project'].includes(activeArtifact.kind)) {
      setConsoleOpen(false);
    }
    setAddressDraft(artifactCanonicalAddress(activeArtifact));
    if (activeArtifact.kind === 'design-project') {
      setViewMode('preview');
      if (activeArtifact.scenario === 'mobile-app') setViewport('mobile');
      else setViewport('desktop');
    } else if (activeArtifact.kind === 'game-project') {
      setViewMode('preview');
      if (activeArtifact.scenario === 'portrait') setViewport('mobile');
      else setViewport('desktop');
    }
  }, [activeArtifact?.id]);

  useEffect(() => {
    if (!active) {
      setDeviceMenuOpen(false);
      setBrowserMenuOpen(false);
      setAddressEditing(false);
    }
  }, [active]);

  useEffect(() => {
    if (viewMode !== 'preview') {
      setAnnotateActive(false);
      setDeviceMenuOpen(false);
    }
  }, [viewMode]);

  useEffect(() => {
    if (activeArtifact?.kind !== 'web') return;
    const nextTitle = webState?.title?.trim();
    if (!nextTitle) return;
    setWebTabTitles(prev => (prev[activeArtifact.id] === nextTitle ? prev : { ...prev, [activeArtifact.id]: nextTitle }));
  }, [activeArtifact?.kind, activeArtifact?.id, webState?.title]);

  useEffect(() => {
    const activeEl = tabStripRef.current?.querySelector<HTMLElement>('.om-sa-viewer-tab[data-active]');
    activeEl?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeArtifact?.id, showNewTab, openTabs.length]);

  const fixedViewport = useMemo(() => {
    if (webDevicePreset === 'responsive') return null;
    const preset = WEB_DEVICE_PRESETS.find(item => item.id === webDevicePreset);
    if (!preset?.width || !preset?.height) return null;
    return webDeviceRotated
      ? { width: preset.height, height: preset.width }
      : { width: preset.width, height: preset.height };
  }, [webDevicePreset, webDeviceRotated]);

  useEffect(() => {
    if (activeArtifact?.kind !== 'web') return;
    const touch = webDevicePreset === 'mobile' || webDevicePreset === 'tablet';
    void webRef.current?.command('set-touch', touch).catch(() => {});
  }, [activeArtifact?.kind, activeArtifact?.id, webDevicePreset]);

  const supportsAnnotate = Boolean(
    activeArtifact && (
      activeArtifact.kind === 'web'
      || ((activeArtifact.kind === 'design-project' || activeArtifact.kind === 'game-project')
        && (viewMode === 'preview' || !activeArtifact.projectId))
    ),
  );

  const webColorScheme: BrowserColorScheme = webState?.colorScheme ?? 'auto';
  const webZoom = webState?.zoom ?? 1;
  const webErrorCount = activeArtifact?.kind === 'web'
    ? (webState?.errorCount ?? consoleEntries.filter(e => e.level === 'error' || e.level === 'network').length)
    : consoleEntries.filter(e => e.level === 'error' || e.level === 'network').length;

  const pushPreviewConsoleEntry = useCallback((entry: BrowserConsoleEntry) => {
    setConsoleEntries(prev => [...prev.slice(-79), entry]);
  }, []);

  const getWebContentBounds = useCallback((): AnnotationContentBounds | null => {
    const img = webRef.current?.getRenderedImage();
    if (!img) return null;
    const bounds = img.getBoundingClientRect();
    const vp = webRef.current?.getViewport() ?? { width: img.naturalWidth || bounds.width, height: img.naturalHeight || bounds.height };
    if (bounds.width <= 0 || bounds.height <= 0 || vp.width <= 0 || vp.height <= 0) return null;
    const scale = Math.min(bounds.width / vp.width, bounds.height / vp.height);
    return {
      left: bounds.left,
      top: bounds.top,
      width: Math.max(1, vp.width * scale),
      height: Math.max(1, vp.height * scale),
      vpWidth: vp.width,
      vpHeight: vp.height,
    };
  }, []);

  const captureWebBaseScreenshot = useCallback(async (): Promise<string | null> => {
    if (activeArtifact?.kind !== 'web' || !webRef.current) return null;
    try {
      const shot = await webRef.current.screenshot();
      return shot.dataUrl;
    } catch {
      return null;
    }
  }, [activeArtifact?.kind]);

  const handleSubmitBrowserAnnotation = useCallback(async (
    payload: BrowserAnnotationSubmitPayload,
    sendImmediately: boolean,
  ) => {
    if (!onAttachBrowserAnnotation) return;
    let screenshotUrl: string | undefined;
    let screenshotPath: string | undefined;
    if (payload.compositedDataUrl && chatId) {
      try {
        const uploaded = await uploadSuperAgentAnnotationImage(chatId, payload.compositedDataUrl);
        screenshotUrl = uploaded.screenshotUrl;
        screenshotPath = uploaded.screenshotPath;
      } catch {
        // Proceed with DOM/element/comment metadata even if screenshot upload fails.
      }
    }
    const labelPart = payload.comment
      ? payload.comment.slice(0, 48)
      : payload.element
        ? (payload.element.componentName || payload.element.selector)
        : payload.region
          ? `${payload.region.width}×${payload.region.height}`
          : t('Draw annotation');
    const attachment: SuperAgentResourceAttachment = {
      id: `annot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'browser-annotation',
      title: labelPart,
      subtitle: payload.element?.selector || payload.pageTitle || payload.pageUrl,
      ...(screenshotUrl ? { previewUrl: screenshotUrl } : {}),
      annotation: {
        mode: payload.mode,
        pageUrl: payload.pageUrl,
        ...(payload.pageTitle ? { pageTitle: payload.pageTitle } : {}),
        ...(payload.comment ? { comment: payload.comment } : {}),
        ...(payload.element ? { element: payload.element } : {}),
        ...(payload.region ? { region: payload.region } : {}),
        ...(payload.viewport ? { viewport: payload.viewport } : {}),
        ...(typeof payload.strokeCount === 'number' ? { strokeCount: payload.strokeCount } : {}),
        ...(payload.strokeBounds ? { strokeBounds: payload.strokeBounds } : {}),
        ...(screenshotUrl ? { screenshotUrl } : {}),
        ...(screenshotPath ? { screenshotPath } : {}),
        ...(payload.artifactId ? { artifactId: payload.artifactId } : {}),
        ...(payload.artifactKind ? { artifactKind: payload.artifactKind } : {}),
        ...(payload.projectId ? { projectId: payload.projectId } : {}),
      },
    };
    onAttachBrowserAnnotation(attachment, sendImmediately);
    setAnnotateActive(false);
  }, [onAttachBrowserAnnotation, chatId, t]);

  const handleCaptureScreenshot = async () => {
    if (!activeArtifact || capturingScreenshot || !onAttachBrowserAnnotation) return;
    setCapturingScreenshot(true);
    try {
      let dataUrl: string | null = null;
      let pageUrl = webState?.url || activeArtifact.url || artifactCanonicalAddress(activeArtifact);
      let pageTitle = webState?.title || activeArtifact.title;
      let vp = { width: 1280, height: 800 };

      if (activeArtifact.kind === 'web' && webRef.current) {
        const shot = await webRef.current.screenshot();
        dataUrl = shot.dataUrl;
        pageUrl = shot.pageUrl;
        pageTitle = shot.pageTitle || pageTitle;
        vp = { width: shot.width, height: shot.height };
      } else if (previewCaptureRef.current) {
        dataUrl = await previewCaptureRef.current();
      }
      if (!dataUrl) {
        throw new Error(t('Could not capture screenshot'));
      }

      let screenshotUrl: string | undefined;
      let screenshotPath: string | undefined;
      if (chatId) {
        const uploaded = await uploadSuperAgentAnnotationImage(chatId, dataUrl);
        screenshotUrl = uploaded.screenshotUrl;
        screenshotPath = uploaded.screenshotPath;
      }
      onAttachBrowserAnnotation({
        id: `shot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        kind: 'browser-annotation',
        title: pageTitle || t('Page screenshot'),
        subtitle: pageUrl,
        ...(screenshotUrl ? { previewUrl: screenshotUrl } : {}),
        annotation: {
          mode: 'screenshot',
          pageUrl,
          ...(pageTitle ? { pageTitle } : {}),
          viewport: vp,
          ...(screenshotUrl ? { screenshotUrl } : {}),
          ...(screenshotPath ? { screenshotPath } : {}),
          artifactId: activeArtifact.id,
          artifactKind: activeArtifact.kind,
          ...(activeArtifact.projectId ? { projectId: activeArtifact.projectId } : {}),
        },
      }, false);
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : t('Could not capture screenshot'), 'error');
    } finally {
      setCapturingScreenshot(false);
    }
  };

  const handleAttachConsoleErrors = (sendImmediately = false) => {
    if (!onAttachBrowserAnnotation || !activeArtifact) return;
    const errs = consoleEntries.filter(e => e.level === 'error' || e.level === 'network');
    const sourceList = errs.length > 0 ? errs : consoleEntries;
    if (!sourceList.length) return;
    const lines = sourceList.slice(-15).map(e => `[${e.level}] ${e.text}${e.url ? ` (${e.url}${typeof e.line === 'number' ? `:${e.line}` : ''})` : ''}`);
    const attachmentTitle = errs.length > 0
      ? t('{count} console errors', { count: errs.length })
      : `${t('Console')} (${sourceList.length})`;
    onAttachBrowserAnnotation({
      id: `console-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'browser-annotation',
      title: attachmentTitle,
      subtitle: webState?.url || activeArtifact.url || artifactCanonicalAddress(activeArtifact),
      annotation: {
        mode: 'console',
        pageUrl: webState?.url || activeArtifact.url || artifactCanonicalAddress(activeArtifact),
        pageTitle: webState?.title || activeArtifact.title,
        ...(sendImmediately ? { comment: t('Fix these runtime console/network errors from the preview.') } : {}),
        consoleErrors: lines,
        artifactId: activeArtifact.id,
        artifactKind: activeArtifact.kind,
        ...(activeArtifact.projectId ? { projectId: activeArtifact.projectId } : {}),
      },
    }, sendImmediately);
  };

  const handleClearConsole = () => {
    if (activeArtifact?.kind === 'web') void webRef.current?.clearConsole();
    else setConsoleEntries([]);
  };

  const handleBrowserCommand = async (
    action: Parameters<WebBrowserHandle['command']>[0],
    value?: unknown,
    toastMessage?: string,
  ) => {
    if (!webRef.current) return;
    try {
      await webRef.current.command(action, value);
      if (toastMessage) onNotify?.(toastMessage, 'info');
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : t('Browser command failed'), 'error');
    }
  };

  useEffect(() => {
    if (!pendingWebUrl) return;
    const timer = setTimeout(() => setPendingWebUrl(null), 10_000);
    return () => clearTimeout(timer);
  }, [pendingWebUrl]);

  const navigateWeb = (targetUrl: string) => {
    setPendingWebUrl(targetUrl);
    setAddressDraft(targetUrl);
    onOpenWebUrl(targetUrl);
  };

  const webLoading = Boolean(pendingWebUrl) || Boolean(activeArtifact?.kind === 'web' && webState?.loading);

  useEffect(() => {
    if (activeArtifact?.kind === 'web' && webState?.url && !addressEditing) {
      setAddressDraft(webState.url);
    }
  }, [activeArtifact?.kind, webState?.url, addressEditing]);

  const handleBack = () => {
    if (activeArtifact?.kind === 'web') void webRef.current?.command('back');
  };
  const handleForward = () => {
    if (activeArtifact?.kind === 'web') void webRef.current?.command('forward');
  };
  const handleReload = () => {
    if (activeArtifact?.kind === 'web') void webRef.current?.command('reload');
    else setReloadKey(v => v + 1);
  };

  const quickOpenItems = useMemo(
    () =>
      workspaceItems
        .filter(item => ['design-project', 'motion-project', 'game-project', 'asset', 'brand-kit'].includes(item.kind)),
    [workspaceItems],
  );

  const normalizedNewTabQuery = newTabQuery.trim().toLowerCase();

  const matchesFilterArtifact = (item: SuperAgentArtifact) => {
    if (newTabFilter === 'web-apps' && item.kind !== 'design-project' && item.kind !== 'game-project') return false;
    if (newTabFilter === 'motion' && item.kind !== 'motion-project' && item.kind !== 'motion-export') return false;
    if (newTabFilter === 'media' && !['asset-image', 'asset-video', 'asset-audio'].includes(item.kind)) return false;
    if (newTabFilter === 'brand-kit' && item.kind !== 'brand-kit') return false;
    if (newTabFilter === 'browser' && item.kind !== 'web') return false;
    if (!normalizedNewTabQuery) return true;
    return `${item.title} ${item.subtitle ?? ''} ${item.url ?? ''}`.toLowerCase().includes(normalizedNewTabQuery);
  };

  const matchesFilterResource = (item: SuperAgentResourceAttachment) => {
    if (newTabFilter === 'web-apps' && item.kind !== 'design-project' && item.kind !== 'game-project') return false;
    if (newTabFilter === 'motion' && item.kind !== 'motion-project') return false;
    if (newTabFilter === 'media' && item.kind !== 'asset') return false;
    if (newTabFilter === 'brand-kit' && item.kind !== 'brand-kit') return false;
    if (newTabFilter === 'browser') return false;
    if (!normalizedNewTabQuery) return true;
    return `${item.title} ${item.subtitle ?? ''} ${item.kind}`.toLowerCase().includes(normalizedNewTabQuery);
  };

  const filteredArtifacts = useMemo(
    () => artifacts.filter(matchesFilterArtifact),
    [artifacts, newTabFilter, normalizedNewTabQuery],
  );

  const filteredQuickOpen = useMemo(
    () => quickOpenItems.filter(matchesFilterResource).slice(0, 12),
    [quickOpenItems, newTabFilter, normalizedNewTabQuery],
  );

  const shortcutTypes: {
    id: 'all' | 'web-apps' | 'motion' | 'media' | 'brand-kit' | 'browser';
    label: string;
    icon: string;
    tone: 'image' | 'audio' | 'video' | 'agent';
  }[] = [
    { id: 'all', label: 'All resources', icon: 'apps-2-line', tone: 'agent' },
    { id: 'web-apps', label: 'Web & Games', icon: 'layout-line', tone: 'agent' },
    { id: 'motion', label: 'Motion', icon: 'movie-line', tone: 'video' },
    { id: 'media', label: 'Media', icon: 'image-line', tone: 'image' },
    { id: 'brand-kit', label: 'Brand Kits', icon: 'palette-line', tone: 'audio' },
    { id: 'browser', label: 'Browser', icon: 'global-line', tone: 'video' },
  ];

  const externalHref = activeArtifact
    ? activeArtifact.kind === 'design-project' && activeArtifact.projectId
      ? designRoutes.raw(activeArtifact.projectId, activeArtifact.entry || 'index.html')
      : activeArtifact.kind === 'game-project'
        ? activeArtifact.projectId
          ? `/motion-api/games/${encodeURIComponent(activeArtifact.projectId)}/play/index.html`
          : activeArtifact.url
        : activeArtifact.kind === 'web'
          ? (webState?.url || activeArtifact.url)
          : undefined
    : undefined;

  const downloadHref = activeArtifact?.downloadUrl
    ?? (activeArtifact && ['asset-image', 'asset-video', 'asset-audio'].includes(activeArtifact.kind) && activeArtifact.url
      ? `${activeArtifact.url}?download=1`
      : undefined);

  return (
    <aside className="om-sa-viewer" aria-label={t('Artifact Viewer')}>
      <div className="om-sa-viewer-tabs-bar">
        <div className="om-sa-viewer-tabs-group">
          <div ref={tabStripRef} className="om-sa-viewer-tabs" role="tablist" aria-label={t('Viewer tabs')}>
            {openTabs.map(tab => {
              const isActive = !showNewTab && activeArtifact?.id === tab.id;
              const tabTitle = tab.kind === 'web' ? (webTabTitles[tab.id] || tab.title) : tab.title;
              return (
                <div key={tab.id} className="om-sa-viewer-tab" data-active={isActive || undefined}>
                  <Button
                    variant="plain"
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    title={tabTitle}
                    className="om-sa-viewer-tab-btn"
                    onClick={() => onSelectTab(tab.id)}
                  >
                    <RemixIcon name={artifactTabIcon(tab.kind)} size={13} />
                    <span>{tabTitle}</span>
                  </Button>
                  <IconButton
                    variant="plain"
                    className="om-sa-viewer-tab-close"
                    aria-label={t('Close tab')}
                    onClick={() => onCloseTab(tab.id)}
                    icon={<RemixIcon name="close-line" size={12} />}
                  />
                </div>
              );
            })}
            {showNewTab && (
              <div className="om-sa-viewer-tab" data-active>
                <Button
                  variant="plain"
                  type="button"
                  role="tab"
                  aria-selected
                  className="om-sa-viewer-tab-btn"
                  onClick={onNewTab}
                >
                  <RemixIcon name="global-line" size={13} />
                  <span>{t('New tab')}</span>
                </Button>
              </div>
            )}
          </div>
          <Tooltip label={t('New tab')}>
            <IconButton
              variant="plain"
              className="om-sa-new-tab-btn"
              aria-label={t('New tab')}
              disabled={showNewTab}
              onClick={event => {
                event.currentTarget.blur();
                setPendingWebUrl(null);
                onNewTab();
                requestAnimationFrame(() => newTabInputRef.current?.focus());
              }}
              icon={<RemixIcon name="add-line" size={15} />}
            />
          </Tooltip>
        </div>

        <div className="om-sa-viewer-win-actions">
          <Tooltip label={t(expanded ? 'Restore viewer' : 'Expand viewer')}>
            <IconButton
              variant="ghost"
              className="motion-icon-button"
              aria-label={t(expanded ? 'Restore viewer' : 'Expand viewer')}
              onClick={onToggleExpand}
              icon={<RemixIcon name={expanded ? 'fullscreen-exit-line' : 'fullscreen-line'} size={15} />}
            />
          </Tooltip>
          <Tooltip label={t('Close viewer')}>
            <IconButton
              variant="ghost"
              className="motion-icon-button"
              aria-label={t('Close viewer')}
              onClick={onClosePane}
              icon={<RemixIcon name="close-line" size={16} />}
            />
          </Tooltip>
        </div>
      </div>

      <div className="om-sa-viewer-toolbar">
        <div className="om-sa-nav-btns">
          {(activeArtifact?.kind === 'web' || showNewTab) && (
            <>
              <Tooltip label={t('Back')}>
                <IconButton
                  variant="ghost"
                  className="motion-icon-button"
                  aria-label={t('Back')}
                  disabled={activeArtifact?.kind !== 'web' || !webState?.canGoBack}
                  onClick={handleBack}
                  icon={<RemixIcon name="arrow-left-line" size={15} />}
                />
              </Tooltip>
              <Tooltip label={t('Forward')}>
                <IconButton
                  variant="ghost"
                  className="motion-icon-button"
                  aria-label={t('Forward')}
                  disabled={activeArtifact?.kind !== 'web' || !webState?.canGoForward}
                  onClick={handleForward}
                  icon={<RemixIcon name="arrow-right-line" size={15} />}
                />
              </Tooltip>
            </>
          )}
          <Tooltip label={t('Reload')}>
            <IconButton
              variant="ghost"
              className="motion-icon-button"
              aria-label={t('Reload')}
              disabled={!activeArtifact}
              onClick={handleReload}
              icon={<RemixIcon name="refresh-line" size={15} />}
            />
          </Tooltip>
        </div>

        <div className="om-sa-address-wrap">
          <form
            className="om-sa-address-form"
            onSubmit={event => {
              event.preventDefault();
              const trimmed = addressDraft.trim();
              if (!trimmed || /^(?:design|motion|game|export|asset|brand):\/\//i.test(trimmed)) return;
              const normalized = normalizeBrowserAddress(trimmed);
              setAddressEditing(false);
              addressInputRef.current?.blur();
              navigateWeb(normalized ?? searchWebUrl(trimmed));
            }}
          >
            <RemixIcon name={activeArtifact ? artifactTabIcon(activeArtifact.kind) : 'search-line'} size={14} />
            <input
              ref={addressInputRef}
              value={addressDraft}
              placeholder={t('Search web, artifacts, or enter a URL')}
              aria-label={t('Artifact address bar')}
              onFocus={event => {
                setAddressEditing(true);
                event.currentTarget.select();
              }}
              onBlur={() => setAddressEditing(false)}
              onChange={event => setAddressDraft(event.target.value)}
            />
          </form>

          {addressEditing && addressDraft.trim() && !/^(?:design|motion|game|export|asset|brand):\/\//i.test(addressDraft.trim()) && (() => {
            const trimmed = addressDraft.trim();
            const normalized = normalizeBrowserAddress(trimmed);
            const q = trimmed.toLowerCase();
            const matchedResources = quickOpenItems
              .filter(item => `${item.title} ${item.subtitle ?? ''}`.toLowerCase().includes(q))
              .slice(0, 3);
            return (
              <div className="om-sa-address-suggest" role="listbox" aria-label={t('Suggestions')}>
                {normalized ? (
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-suggest-row"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      setAddressEditing(false);
                      addressInputRef.current?.blur();
                      navigateWeb(normalized);
                    }}
                  >
                    <RemixIcon name="global-line" size={15} />
                    <span className="om-sa-suggest-query">{normalized}</span>
                    <small>{t('Open URL')}</small>
                  </Button>
                ) : (
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-suggest-row"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      setAddressEditing(false);
                      addressInputRef.current?.blur();
                      navigateWeb(searchWebUrl(trimmed));
                    }}
                  >
                    <RemixIcon name="search-line" size={15} />
                    <span className="om-sa-suggest-query">{trimmed}</span>
                    <small>{t('Search the web')}</small>
                  </Button>
                )}
                {matchedResources.map(item => (
                  <Button
                    key={`suggest:${item.kind}:${item.id}`}
                    variant="plain"
                    type="button"
                    className="om-sa-suggest-row"
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      setAddressEditing(false);
                      addressInputRef.current?.blur();
                      onOpenResource(item);
                    }}
                  >
                    <RemixIcon name={resourceIcon(item)} size={15} />
                    <span className="om-sa-suggest-query">{item.title}</span>
                    <small>{item.subtitle || item.kind}</small>
                  </Button>
                ))}
              </div>
            );
          })()}
        </div>

        <div className="om-sa-context-actions">
          {(() => {
            const hasModeSwitch = activeArtifact?.kind === 'design-project' || (activeArtifact?.kind === 'game-project' && Boolean(activeArtifact.projectId));
            const canCloudShare = !showNewTab && Boolean(activeArtifact?.projectId) && (activeArtifact?.kind === 'game-project' || activeArtifact?.kind === 'design-project');
            const activeDeviceIcon = activeArtifact?.kind === 'web'
              ? (webDevicePreset === 'mobile' ? 'smartphone-line' : webDevicePreset === 'tablet' ? 'tablet-line' : 'computer-line')
              : (viewport === 'mobile' ? 'smartphone-line' : viewport === 'tablet' ? 'tablet-line' : 'computer-line');
            const isConstrainedViewport = activeArtifact?.kind === 'web'
              ? webDevicePreset !== 'responsive'
              : viewport !== 'desktop';
            return (
              <>
                {hasModeSwitch && (
                  <div className="om-sa-segmented" role="group" aria-label={t('View mode')}>
                    <Button
                      variant="plain"
                      type="button"
                      aria-label={t('Preview')}
                      title={t('Preview')}
                      data-active={viewMode === 'preview' || undefined}
                      onClick={() => setViewMode('preview')}
                    >
                      <RemixIcon name="eye-line" size={13} />
                      <span>{t('Preview')}</span>
                    </Button>
                    <Button
                      variant="plain"
                      type="button"
                      aria-label={t('Code')}
                      title={t('Code')}
                      data-active={viewMode === 'code' || undefined}
                      onClick={() => setViewMode('code')}
                    >
                      <RemixIcon name="code-s-slash-line" size={13} />
                      <span>{t('Code')}</span>
                    </Button>
                    {activeArtifact?.kind === 'game-project' && gameTrailerUrl && (
                      <Button
                        variant="plain"
                        type="button"
                        aria-label={t('Trailer')}
                        title={t('Trailer')}
                        data-active={viewMode === 'trailer' || undefined}
                        onClick={() => setViewMode('trailer')}
                      >
                        <RemixIcon name="film-line" size={13} />
                        <span>{t('Trailer')}</span>
                      </Button>
                    )}
                  </div>
                )}

                {hasModeSwitch && supportsAnnotate && (
                  <span className="om-sa-toolbar-divider" aria-hidden="true" />
                )}

                {supportsAnnotate && (
                  <div className="om-sa-tool-group">
                    <Tooltip label={t('Annotate elements, regions, and drawings')}>
                      <IconButton
                        variant="ghost"
                        className="motion-icon-button om-sa-annotate-btn"
                        data-active={annotateActive || undefined}
                        aria-label={t('Annotate elements, regions, and drawings')}
                        onClick={() => {
                          setAnnotateActive(v => {
                            const next = !v;
                            if (next) setAnnotTool('select');
                            return next;
                          });
                        }}
                        icon={<RemixIcon name="focus-3-line" size={15} />}
                      />
                    </Tooltip>

                    <Popover
                      open={deviceMenuOpen}
                      onOpenChange={setDeviceMenuOpen}
                      side="bottom"
                      align="end"
                      initialFocus={false}
                      aria-label={t('Viewport presets')}
                      tooltip={t('Viewport presets')}
                      className="om-sa-device-menu-popover"
                      trigger={
                        <Button
                          variant="plain"
                          type="button"
                          className="om-sa-device-trigger"
                          data-active={deviceMenuOpen || undefined}
                          data-constrained={isConstrainedViewport || undefined}
                          aria-label={t('Viewport presets')}
                          aria-expanded={deviceMenuOpen}
                        >
                          <RemixIcon name={activeDeviceIcon} size={15} />
                          <RemixIcon name="arrow-down-s-line" size={13} className="om-sa-device-caret" />
                        </Button>
                      }
                    >
                      <div className="om-sa-device-menu" role="menu" aria-label={t('Viewport presets')}>
                        {activeArtifact?.kind === 'web' ? (
                          <>
                            {WEB_DEVICE_PRESETS.map(preset => {
                              const isActive = webDevicePreset === preset.id;
                              const dims = preset.width && preset.height
                                ? (isActive && webDeviceRotated ? `${preset.height} × ${preset.width}` : `${preset.width} × ${preset.height}`)
                                : t('Auto');
                              return (
                                <Button
                                  key={preset.id}
                                  variant="plain"
                                  type="button"
                                  role="menuitemradio"
                                  aria-checked={isActive}
                                  className="om-sa-device-menu-item"
                                  data-active={isActive || undefined}
                                  onClick={() => {
                                    setWebDevicePreset(preset.id);
                                    if (preset.id === 'responsive') setWebDeviceRotated(false);
                                    setDeviceMenuOpen(false);
                                  }}
                                >
                                  <RemixIcon name={preset.icon} size={14} />
                                  <span className="om-sa-device-menu-label">{t(preset.label)}</span>
                                  <small className="om-sa-device-menu-dims">{dims}</small>
                                  <span className="om-sa-device-menu-check" aria-hidden="true">
                                    {isActive && <RemixIcon name="check-line" size={14} />}
                                  </span>
                                </Button>
                              );
                            })}
                            {fixedViewport && (
                              <>
                                <div className="om-sa-browser-menu-sep" role="separator" />
                                <Button
                                  variant="plain"
                                  type="button"
                                  role="menuitem"
                                  className="om-sa-device-menu-item"
                                  data-active={webDeviceRotated || undefined}
                                  onClick={() => setWebDeviceRotated(v => !v)}
                                >
                                  <RemixIcon name="clockwise-line" size={14} />
                                  <span className="om-sa-device-menu-label">{t('Rotate viewport')}</span>
                                  <small className="om-sa-device-menu-dims">
                                    {fixedViewport.width} × {fixedViewport.height}
                                  </small>
                                  <span className="om-sa-device-menu-check" aria-hidden="true" />
                                </Button>
                              </>
                            )}
                          </>
                        ) : (
                          (activeArtifact?.kind === 'game-project'
                            ? designViewports.filter(preset => preset.id === 'desktop' || preset.id === 'mobile')
                            : designViewports
                          ).map(preset => {
                            const isActive = viewport === preset.id;
                            const dims = preset.width && preset.height
                              ? `${preset.width} × ${preset.height}`
                              : t('Auto');
                            return (
                              <Button
                                key={preset.id}
                                variant="plain"
                                type="button"
                                role="menuitemradio"
                                aria-checked={isActive}
                                className="om-sa-device-menu-item"
                                data-active={isActive || undefined}
                                onClick={() => {
                                  setViewport(preset.id);
                                  setDeviceMenuOpen(false);
                                }}
                              >
                                <RemixIcon name={preset.icon} size={14} />
                                <span className="om-sa-device-menu-label">{t(preset.label)}</span>
                                <small className="om-sa-device-menu-dims">{dims}</small>
                                <span className="om-sa-device-menu-check" aria-hidden="true">
                                  {isActive && <RemixIcon name="check-line" size={14} />}
                                </span>
                              </Button>
                            );
                          })
                        )}
                      </div>
                    </Popover>

                    <Tooltip label={t('Capture screenshot to chat')}>
                      <IconButton
                        variant="ghost"
                        className="motion-icon-button om-sa-toolbar-secondary-tool"
                        aria-label={t('Capture screenshot to chat')}
                        disabled={capturingScreenshot}
                        onClick={() => void handleCaptureScreenshot()}
                        icon={<RemixIcon name={capturingScreenshot ? 'loader-4-line' : 'camera-line'} size={15} />}
                      />
                    </Tooltip>

                    {(webErrorCount > 0 || consoleOpen) && (
                      <Tooltip label={t('Console & errors')}>
                        <Button
                          variant="ghost"
                          type="button"
                          className="motion-icon-button om-sa-console-toggle-btn"
                          data-active={consoleOpen || undefined}
                          aria-label={t('Open console')}
                          onClick={() => setConsoleOpen(v => !v)}
                        >
                          <RemixIcon name="terminal-box-fill" size={15} />
                          {webErrorCount > 0 && (
                            <span className="om-sa-console-toolbar-badge">{webErrorCount > 99 ? '99+' : webErrorCount}</span>
                          )}
                        </Button>
                      </Tooltip>
                    )}
                  </div>
                )}

                {!showNewTab && activeArtifact?.kind === 'game-project' && onUseGameInAgent && (
                  <>
                    {(hasModeSwitch || supportsAnnotate) && (
                      <span className="om-sa-toolbar-divider" aria-hidden="true" />
                    )}
                    <Tooltip label={gameSourceKind === 'mine' ? t('Attach to Chat') : t('Make one like this')}>
                      <Button
                        variant="plain"
                        type="button"
                        className="om-sa-toolbar-btn om-sa-game-use-btn"
                        aria-label={gameSourceKind === 'mine' ? t('Attach to Chat') : t('Make one like this')}
                        onClick={() => onUseGameInAgent(activeArtifact)}
                      >
                        <RemixIcon name="sparkling-line" size={14} />
                        <span>{gameSourceKind === 'mine' ? t('Attach to Chat') : t('Make one like this')}</span>
                      </Button>
                    </Tooltip>
                  </>
                )}

                {canCloudShare && (hasModeSwitch || supportsAnnotate || (activeArtifact?.kind === 'game-project' && Boolean(onUseGameInAgent))) && (
                  <span className="om-sa-toolbar-divider" aria-hidden="true" />
                )}

                {canCloudShare && activeArtifact?.projectId && (activeArtifact.kind === 'game-project' || activeArtifact.kind === 'design-project') && (
                  <WebPublishPopover
                    compact
                    targetKind={activeArtifact.kind === 'game-project' ? 'game' : 'design'}
                    targetId={activeArtifact.projectId}
                    filePath={activeArtifact.entry}
                    title={activeArtifact.title}
                    revisionKey={activeArtifact.revision ?? String(activeArtifact.updatedAt)}
                    onNotify={onNotify}
                  />
                )}
              </>
            );
          })()}

          {activeArtifact && (
            <Popover
              open={browserMenuOpen}
              onOpenChange={setBrowserMenuOpen}
              side="bottom"
              align="end"
              initialFocus={false}
              aria-label={t('Browser options')}
              className="om-sa-browser-menu-popover"
              trigger={
                <IconButton
                  variant="ghost"
                  className="motion-icon-button"
                  data-active={browserMenuOpen || undefined}
                  aria-label={t('Browser options')}
                  icon={<RemixIcon name="more-line" size={15} />}
                />
              }
            >
              <div className={`${menuClasses.panel} om-sa-browser-menu`} role="menu" aria-label={t('Browser options')}>
                {activeArtifact.kind === 'web' && (
                  <Button
                    variant="plain"
                    type="button"
                    role="menuitem"
                    className="om-sa-browser-menu-item"
                    onClick={() => {
                      setBrowserMenuOpen(false);
                      void handleBrowserCommand('hard-reload');
                    }}
                  >
                    <RemixIcon name="refresh-line" size={14} />
                    <span>{t('Hard reload')}</span>
                  </Button>
                )}

                {supportsAnnotate && (
                  <>
                    <Button
                      variant="plain"
                      type="button"
                      role="menuitem"
                      className="om-sa-browser-menu-item"
                      disabled={capturingScreenshot}
                      onClick={() => {
                        setBrowserMenuOpen(false);
                        void handleCaptureScreenshot();
                      }}
                    >
                      <RemixIcon name="camera-line" size={14} />
                      <span>{t('Capture screenshot to chat')}</span>
                    </Button>
                    <Button
                      variant="plain"
                      type="button"
                      role="menuitem"
                      className="om-sa-browser-menu-item"
                      data-active={consoleOpen || undefined}
                      onClick={() => {
                        setBrowserMenuOpen(false);
                        setConsoleOpen(v => !v);
                      }}
                    >
                      <RemixIcon name="terminal-box-fill" size={14} />
                      <span>{t('Console & errors')}</span>
                      {(webErrorCount > 0 || consoleEntries.length > 0) && (
                        <small className="om-sa-browser-menu-count" data-error={webErrorCount > 0 || undefined}>
                          {webErrorCount > 0 ? webErrorCount : consoleEntries.length}
                        </small>
                      )}
                    </Button>
                  </>
                )}

                {externalHref && (
                  <Button
                    variant="plain"
                    type="button"
                    role="menuitem"
                    className="om-sa-browser-menu-item"
                    onClick={() => {
                      setBrowserMenuOpen(false);
                      window.open(externalHref, '_blank', 'noopener,noreferrer');
                    }}
                  >
                    <RemixIcon name="external-link-line" size={14} />
                    <span>{t('Open in new window')}</span>
                  </Button>
                )}

                {downloadHref && (
                  <a
                    href={downloadHref}
                    download
                    role="menuitem"
                    className="om-sa-browser-menu-item"
                    onClick={() => setBrowserMenuOpen(false)}
                  >
                    <RemixIcon name="download-2-line" size={14} />
                    <span>{t('Download')}</span>
                  </a>
                )}

                {activeArtifact.kind !== 'web' && (
                  <>
                    {(supportsAnnotate || externalHref || downloadHref) && (
                      <div className="om-sa-browser-menu-sep" role="separator" />
                    )}

                    {['game-project', 'asset-image', 'asset-video', 'asset-audio', 'brand-kit'].includes(activeArtifact.kind) && (
                      <Button
                        variant="plain"
                        type="button"
                        role="menuitem"
                        className="om-sa-browser-menu-item"
                        onClick={() => {
                          setBrowserMenuOpen(false);
                          if (activeArtifact.kind === 'game-project' && onUseGameInAgent) {
                            onUseGameInAgent(activeArtifact);
                          } else {
                            onAttachArtifact(activeArtifact);
                          }
                        }}
                      >
                        <RemixIcon name={activeArtifact.kind === 'game-project' && gameSourceKind !== 'mine' ? 'sparkling-line' : 'add-line'} size={14} />
                        <span>{activeArtifact.kind === 'game-project' && gameSourceKind !== 'mine' ? t('Make one like this') : t('Attach to Chat')}</span>
                      </Button>
                    )}

                    {activeArtifact.kind === 'design-project' && activeArtifact.projectId && (
                      <Button
                        variant="plain"
                        type="button"
                        role="menuitem"
                        className="om-sa-browser-menu-item"
                        onClick={() => {
                          setBrowserMenuOpen(false);
                          onOpenInDesignStudio(activeArtifact.projectId!);
                        }}
                      >
                        <RemixIcon name="layout-line" size={14} />
                        <span>{t('Open in Design Studio')}</span>
                      </Button>
                    )}

                    {activeArtifact.kind === 'motion-project' && activeArtifact.projectId && (
                      <Button
                        variant="plain"
                        type="button"
                        role="menuitem"
                        className="om-sa-browser-menu-item"
                        onClick={() => {
                          setBrowserMenuOpen(false);
                          onOpenInMotionStudio(activeArtifact.projectId!);
                        }}
                      >
                        <RemixIcon name="movie-line" size={14} />
                        <span>{t('Open in Motion Studio')}</span>
                      </Button>
                    )}

                    {activeArtifact.kind === 'game-project' && activeArtifact.projectId && onOpenInGameStudio && (
                      <Button
                        variant="plain"
                        type="button"
                        role="menuitem"
                        className="om-sa-browser-menu-item"
                        onClick={() => {
                          setBrowserMenuOpen(false);
                          onOpenInGameStudio(activeArtifact.projectId!);
                        }}
                      >
                        <RemixIcon name="gamepad-line" size={14} />
                        <span>{t('Open in Game Studio')}</span>
                      </Button>
                    )}

                    {['asset-image', 'asset-video', 'asset-audio'].includes(activeArtifact.kind) && activeArtifact.assetId && (
                      <Button
                        variant="plain"
                        type="button"
                        role="menuitem"
                        className="om-sa-browser-menu-item"
                        onClick={() => {
                          setBrowserMenuOpen(false);
                          onOpenInAssets(activeArtifact.assetId!, activeArtifact.versionId);
                        }}
                      >
                        <RemixIcon name="folder-open-line" size={14} />
                        <span>{t('Open in Assets')}</span>
                      </Button>
                    )}

                    {activeArtifact.kind === 'brand-kit' && (
                      <Button
                        variant="plain"
                        type="button"
                        role="menuitem"
                        className="om-sa-browser-menu-item"
                        onClick={() => {
                          setBrowserMenuOpen(false);
                          onOpenInBrandKit(activeArtifact.kitId);
                        }}
                      >
                        <RemixIcon name="palette-line" size={14} />
                        <span>{t('Open in Brand Kit')}</span>
                      </Button>
                    )}
                  </>
                )}

                {activeArtifact.kind === 'web' && (
                  <>
                    <div className="om-sa-browser-menu-sep" role="separator" />

                    <div className="om-sa-browser-menu-row">
                      <span className="om-sa-browser-menu-label">{t('Appearance')}</span>
                      <div className="om-sa-browser-menu-seg" role="group" aria-label={t('Appearance')}>
                        {(['auto', 'light', 'dark'] as BrowserColorScheme[]).map(scheme => (
                          <Button
                            key={scheme}
                            variant="plain"
                            type="button"
                            className="om-sa-browser-seg-btn"
                            data-active={webColorScheme === scheme || undefined}
                            onClick={() => void handleBrowserCommand('set-color-scheme', scheme)}
                          >
                            {scheme === 'light' && <RemixIcon name="sun-fill" size={12} />}
                            {scheme === 'dark' && <RemixIcon name="moon-fill" size={12} />}
                            <span>{t(scheme === 'auto' ? 'Auto' : scheme === 'light' ? 'Light' : 'Dark')}</span>
                          </Button>
                        ))}
                      </div>
                    </div>

                    <div className="om-sa-browser-menu-row">
                      <span className="om-sa-browser-menu-label">{t('Zoom')}</span>
                      <div className="om-sa-browser-menu-zoom">
                        <IconButton
                          variant="plain"
                          className="om-sa-browser-zoom-btn"
                          aria-label={t('Zoom out')}
                          disabled={webZoom <= 0.5}
                          onClick={() => void handleBrowserCommand('set-zoom', Number(Math.max(0.5, webZoom - 0.1).toFixed(2)))}
                          icon={<RemixIcon name="zoom-out-line" size={13} />}
                        />
                        <span className="om-sa-browser-zoom-val">{Math.round(webZoom * 100)}%</span>
                        <IconButton
                          variant="plain"
                          className="om-sa-browser-zoom-btn"
                          aria-label={t('Zoom in')}
                          disabled={webZoom >= 2}
                          onClick={() => void handleBrowserCommand('set-zoom', Number(Math.min(2, webZoom + 0.1).toFixed(2)))}
                          icon={<RemixIcon name="zoom-in-line" size={13} />}
                        />
                        <IconButton
                          variant="plain"
                          className="om-sa-browser-zoom-btn"
                          aria-label={t('Reset zoom')}
                          disabled={webZoom === 1}
                          onClick={() => void handleBrowserCommand('set-zoom', 1)}
                          icon={<RemixIcon name="refresh-line" size={12} />}
                        />
                      </div>
                    </div>

                    <div className="om-sa-browser-menu-sep" role="separator" />

                    <Button
                      variant="plain"
                      type="button"
                      role="menuitem"
                      className="om-sa-browser-menu-item"
                      onClick={() => {
                        setBrowserMenuOpen(false);
                        void handleBrowserCommand('clear-cookies', undefined, t('Cleared cookies'));
                      }}
                    >
                      <RemixIcon name="delete-bin-line" size={14} />
                      <span>{t('Clear cookies')}</span>
                    </Button>
                    <Button
                      variant="plain"
                      type="button"
                      role="menuitem"
                      className="om-sa-browser-menu-item"
                      onClick={() => {
                        setBrowserMenuOpen(false);
                        void handleBrowserCommand('clear-cache', undefined, t('Cleared cache'));
                      }}
                    >
                      <RemixIcon name="delete-bin-line" size={14} />
                      <span>{t('Clear cache')}</span>
                    </Button>
                  </>
                )}
              </div>
            </Popover>
          )}
        </div>
        {webLoading && <div className="om-sa-viewer-progress" role="progressbar" aria-label={t('Loading…')} />}
      </div>

      <div className="om-sa-viewer-stage" data-console={consoleOpen && supportsAnnotate ? 'true' : undefined}>
        <div className="om-sa-viewer-stage-body">
          {pendingWebUrl && (showNewTab || !activeArtifact) ? (
          <div className="om-sa-web-skeleton om-sa-web-skeleton-enter" role="status" aria-label={t('Loading…')}>
            <div className="om-sa-web-skeleton-head">
              <Skeleton style={{ width: 120, height: 18 }} />
              <Skeleton style={{ width: '42%', height: 28, borderRadius: 999 }} />
            </div>
            <Skeleton style={{ width: '100%', height: 180, borderRadius: 12 }} />
            <div className="om-sa-web-skeleton-grid">
              <Skeleton style={{ width: '100%', height: 96, borderRadius: 10 }} />
              <Skeleton style={{ width: '100%', height: 96, borderRadius: 10 }} />
            </div>
            <div className="om-sa-web-skeleton-lines">
              <Skeleton style={{ width: '68%', height: 14 }} />
              <Skeleton style={{ width: '88%', height: 14 }} />
              <Skeleton style={{ width: '54%', height: 14 }} />
            </div>
          </div>
        ) : showNewTab || !activeArtifact ? (
          <div className="om-sa-newtab">
            <div className="om-sa-newtab-hero">
              <form
                className="om-sa-newtab-search"
                onSubmit={event => {
                  event.preventDefault();
                  const trimmed = newTabQuery.trim();
                  if (!trimmed) return;
                  const normalized = normalizeBrowserAddress(trimmed);
                  setNewTabQuery('');
                  navigateWeb(normalized ?? searchWebUrl(trimmed));
                }}
              >
                <RemixIcon name="search-line" size={16} />
                <input
                  ref={newTabInputRef}
                  value={newTabQuery}
                  onChange={event => setNewTabQuery(event.target.value)}
                  placeholder={t('Search web, artifacts, or enter a URL')}
                  aria-label={t('Search web, artifacts, or enter a URL')}
                />
              </form>

              {newTabQuery.trim() && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-newtab-web-cta"
                  onClick={() => {
                    const trimmed = newTabQuery.trim();
                    const normalized = normalizeBrowserAddress(trimmed);
                    setNewTabQuery('');
                    navigateWeb(normalized ?? searchWebUrl(trimmed));
                  }}
                >
                  <RemixIcon name={normalizeBrowserAddress(newTabQuery) ? 'global-line' : 'search-line'} size={15} />
                  <span>{normalizeBrowserAddress(newTabQuery) ?? newTabQuery.trim()}</span>
                  <small>{t(normalizeBrowserAddress(newTabQuery) ? 'Open URL' : 'Search the web')}</small>
                </Button>
              )}

              <div className="om-sa-newtab-shortcuts" role="group" aria-label={t('Artifact types')}>
                {shortcutTypes.map(item => {
                  const isSelected = newTabFilter === item.id;
                  return (
                    <Button
                      key={item.id}
                      variant="plain"
                      type="button"
                      className="om-sa-shortcut-item"
                      aria-pressed={isSelected}
                      data-active={isSelected || undefined}
                      onClick={() => {
                        setNewTabFilter(item.id);
                        if (item.id === 'browser') {
                          addressInputRef.current?.focus();
                        }
                      }}
                    >
                      <span className="om-sa-shortcut-icon" data-tone={item.tone}>
                        <RemixIcon name={item.icon} size={18} />
                      </span>
                      <span className="om-sa-shortcut-label">{t(item.label)}</span>
                    </Button>
                  );
                })}
              </div>
            </div>

            {filteredArtifacts.length > 0 && (
              <section className="om-sa-newtab-section">
                <span className="om-eyebrow">{t('Session artifacts')}</span>
                <div className="om-sa-newtab-grid">
                  {filteredArtifacts.map(item => (
                    <Button
                      key={item.id}
                      variant="plain"
                      type="button"
                      className="om-sa-newtab-card"
                      onClick={() => onOpenArtifact(item.id)}
                    >
                      <RemixIcon name={artifactTabIcon(item.kind)} size={16} />
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.subtitle || artifactCanonicalAddress(item)}</small>
                      </span>
                    </Button>
                  ))}
                </div>
              </section>
            )}

            {filteredQuickOpen.length > 0 && (
              <section className="om-sa-newtab-section">
                <span className="om-eyebrow">{t('Workspace quick-open')}</span>
                <div className="om-sa-newtab-grid">
                  {filteredQuickOpen.map(item => (
                    <Button
                      key={`${item.kind}:${item.id}`}
                      variant="plain"
                      type="button"
                      className="om-sa-newtab-card"
                      onClick={() => onOpenResource(item)}
                    >
                      <RemixIcon name={resourceIcon(item)} size={16} />
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.subtitle || item.kind}</small>
                      </span>
                    </Button>
                  ))}
                </div>
              </section>
            )}

            {!filteredArtifacts.length && !filteredQuickOpen.length && (
              <p className="om-sa-newtab-hint">
                {t(newTabFilter === 'browser'
                  ? 'Type a URL above, or let Coding mode start a local dev server — it will open here automatically.'
                  : 'Preview generated HTML games, websites, Motion films, videos, images, Brand Kits, or enter any https:// URL above.')}
              </p>
            )}
          </div>
        ) : !active ? (
          <div className="om-sa-viewer-loading" aria-hidden="true">
            <Skeleton style={{ width: '48%', height: 24 }} />
            <Skeleton style={{ width: '100%', height: 220 }} />
          </div>
        ) : activeArtifact.kind === 'design-project' ? (
          <DesignProjectArtifactView
            artifact={activeArtifact}
            chatId={chatId}
            mode={viewMode === 'code' ? 'code' : 'preview'}
            viewport={viewport}
            reloadKey={reloadKey}
            annotateActive={annotateActive}
            annotTool={annotTool}
            onToolChange={setAnnotTool}
            onConsoleEntry={pushPreviewConsoleEntry}
            captureRef={previewCaptureRef}
            onSubmitAnnotation={handleSubmitBrowserAnnotation}
            onCloseAnnotate={() => setAnnotateActive(false)}
            onNotify={onNotify}
          />
        ) : activeArtifact.kind === 'motion-project' && activeArtifact.projectId ? (
          <div className="om-sa-iframe-stage" data-viewport="desktop">
            <div className="om-sa-iframe-frame">
              <iframe
                key={`${activeArtifact.projectId}:${activeArtifact.revision ?? ''}:${reloadKey}`}
                title={activeArtifact.title}
                src={`/?${activeArtifact.sessionId ? `session=${encodeURIComponent(activeArtifact.sessionId)}&` : ''}project=${encodeURIComponent(activeArtifact.projectId)}&embed=1&hostChrome=1#project/${encodeURIComponent(activeArtifact.projectId)}`}
              />
            </div>
          </div>
        ) : activeArtifact.kind === 'motion-export' && activeArtifact.downloadUrl ? (
          <div className="om-sa-media-stage" data-kind="video">
            <ManagedMediaElement kind="video" src={activeArtifact.downloadUrl} />
          </div>
        ) : activeArtifact.kind === 'asset-image' && activeArtifact.url ? (
          <ImageArtifactView url={activeArtifact.url} title={activeArtifact.title} />
        ) : activeArtifact.kind === 'asset-video' && activeArtifact.url ? (
          <div className="om-sa-media-stage" data-kind="video">
            <ManagedMediaElement kind="video" src={activeArtifact.url} />
          </div>
        ) : activeArtifact.kind === 'asset-audio' && activeArtifact.url ? (
          <div className="om-sa-media-stage" data-kind="audio">
            <span className="om-creation-icon" data-tone="audio">
              <RemixIcon name="music-2-line" size={26} />
            </span>
            <strong>{activeArtifact.title}</strong>
            <ManagedMediaElement kind="audio" src={activeArtifact.url} />
          </div>
        ) : activeArtifact.kind === 'brand-kit' ? (
          <BrandKitArtifactView artifact={activeArtifact} reloadKey={reloadKey} />
        ) : activeArtifact.kind === 'game-project' && (activeArtifact.projectId || activeArtifact.url) ? (
          <GameProjectArtifactView
            artifact={activeArtifact}
            chatId={chatId}
            mode={viewMode}
            viewport={viewport}
            reloadKey={reloadKey}
            annotateActive={annotateActive}
            annotTool={annotTool}
            onToolChange={setAnnotTool}
            onConsoleEntry={pushPreviewConsoleEntry}
            captureRef={previewCaptureRef}
            onSubmitAnnotation={handleSubmitBrowserAnnotation}
            onCloseAnnotate={() => setAnnotateActive(false)}
            onNotify={onNotify}
            onGameMeta={meta => {
              setGameTrailerUrl(meta.trailerUrl);
              setGameSourceKind(meta.source);
            }}
          />
        ) : activeArtifact.kind === 'web' && activeArtifact.url && chatId ? (
          <div className="om-sa-web-stage">
            <div className="om-sa-web-stage-main" data-framed={Boolean(fixedViewport) || undefined}>
              <div
                className="om-sa-web-viewport-frame"
                style={fixedViewport
                  ? { width: fixedViewport.width, height: fixedViewport.height, maxWidth: '100%', maxHeight: '100%' }
                  : undefined}
              >
                <Suspense
                  fallback={
                    <div className="om-sa-viewer-loading">
                      <Skeleton style={{ width: '48%', height: 24 }} />
                      <Skeleton style={{ width: '100%', height: 240 }} />
                    </div>
                  }
                >
                  <WebBrowser
                    ref={webRef}
                    sessionId={chatId}
                    tabId={safeBrowserTabId(activeArtifact.id)}
                    endpoint={superAgentBrowserEndpoint(chatId, safeBrowserTabId(activeArtifact.id))}
                    url={activeArtifact.url}
                    interactive={!annotateActive}
                    fixedViewport={fixedViewport}
                    onState={setWebState}
                    onConsoleSnapshot={entries => setConsoleEntries(entries)}
                    onConsoleEntry={pushPreviewConsoleEntry}
                  />
                </Suspense>
              </div>
              {annotateActive && (
                <BrowserAnnotationOverlay
                  mode="web"
                  pageUrl={webState?.url || activeArtifact.url}
                  pageTitle={webState?.title || activeArtifact.title}
                  artifactId={activeArtifact.id}
                  artifactKind={activeArtifact.kind}
                  canSelectElement
                  inspectAt={async (vx, vy) => (webRef.current ? webRef.current.inspectAt(vx, vy) : null)}
                  onToolChange={setAnnotTool}
                  getContentBounds={getWebContentBounds}
                  captureBaseScreenshot={captureWebBaseScreenshot}
                  onSubmitAnnotation={handleSubmitBrowserAnnotation}
                  onClose={() => setAnnotateActive(false)}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="om-empty om-sa-viewer-empty">
            <RemixIcon name="global-line" size={24} />
            <p>{t('Start or open a conversation to browse live web pages here.')}</p>
          </div>
        )}
        </div>
        {consoleOpen && supportsAnnotate && (
          <PreviewConsoleDrawer
            entries={consoleEntries}
            errorCount={webErrorCount}
            filter={consoleFilter}
            onChangeFilter={setConsoleFilter}
            onAttachErrors={() => handleAttachConsoleErrors(false)}
            onFixWithAgent={() => handleAttachConsoleErrors(true)}
            onClear={handleClearConsole}
            onClose={() => setConsoleOpen(false)}
          />
        )}
      </div>
    </aside>
  );
}
