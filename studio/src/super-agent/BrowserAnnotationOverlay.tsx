import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  BrowserInspectResult,
  BrowserPickedElement,
  BrowserRect,
} from '../../../shared/browser';
import type { SuperAgentArtifactKind } from '../../../shared/super-agent';
import { Tooltip } from '../components/ui/Tooltip';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';

export type AnnotationOverlayTool = 'select' | 'region' | 'draw' | 'erase';

export type AnnotationContentBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
  vpWidth: number;
  vpHeight: number;
};

type StrokeItem = {
  id: string;
  points: { x: number; y: number }[];
};

export type BrowserAnnotationSubmitPayload = {
  mode: 'select' | 'region' | 'draw';
  comment: string;
  element?: BrowserPickedElement;
  region?: BrowserRect;
  viewport?: { width: number; height: number };
  strokeCount?: number;
  strokeBounds?: BrowserRect;
  compositedDataUrl?: string | null;
  pageUrl: string;
  pageTitle?: string;
  artifactId?: string;
  artifactKind?: SuperAgentArtifactKind;
  projectId?: string;
};

async function compositeAnnotationScreenshot(
  baseDataUrl: string,
  vpWidth: number,
  vpHeight: number,
  element: BrowserPickedElement | null,
  region: BrowserRect | null,
  strokes: StrokeItem[],
  accentColor: string,
  onActionColor: string,
): Promise<string | null> {
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to load screenshot for compositing'));
      el.src = baseDataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || Math.max(1, Math.round(vpWidth));
    canvas.height = img.naturalHeight || Math.max(1, Math.round(vpHeight));
    const ctx = canvas.getContext('2d');
    if (!ctx) return baseDataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const sx = canvas.width / Math.max(1, vpWidth);
    const sy = canvas.height / Math.max(1, vpHeight);
    ctx.save();
    ctx.scale(sx, sy);

    const box = element?.rect ?? region;
    if (box && box.width > 0 && box.height > 0) {
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 2;
      ctx.fillStyle = accentColor;
      ctx.globalAlpha = 0.14;
      ctx.fillRect(box.x, box.y, box.width, box.height);
      ctx.globalAlpha = 1;
      ctx.strokeRect(box.x, box.y, box.width, box.height);

      if (element) {
        const tagLabel = element.componentName
          ? `${element.componentName} · ${element.tagName}`
          : element.selector.slice(0, 48);
        ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, monospace';
        const metrics = ctx.measureText(tagLabel);
        const padX = 8;
        const badgeW = Math.min(vpWidth - 8, metrics.width + padX * 2);
        const badgeH = 22;
        const badgeX = Math.max(4, Math.min(vpWidth - badgeW - 4, box.x));
        const badgeY = box.y >= badgeH + 6
          ? box.y - badgeH - 4
          : box.y + box.height + badgeH + 6 <= vpHeight
            ? box.y + box.height + 4
            : Math.max(4, box.y + 4);
        ctx.fillStyle = accentColor;
        ctx.beginPath();
        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
        ctx.fill();
        ctx.fillStyle = onActionColor;
        ctx.textBaseline = 'middle';
        ctx.fillText(tagLabel, badgeX + padX, badgeY + badgeH / 2, badgeW - padX * 2);
      }
    }

    if (strokes.length > 0) {
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const stroke of strokes) {
        if (stroke.points.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i += 1) {
          ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
        ctx.stroke();
      }
    }

    ctx.restore();
    return canvas.toDataURL('image/png');
  } catch {
    return baseDataUrl;
  }
}

export function BrowserAnnotationOverlay({
  mode,
  pageUrl,
  pageTitle,
  artifactId,
  artifactKind,
  projectId,
  canSelectElement,
  inspectAt,
  externalPickedElement,
  onToolChange,
  getContentBounds,
  captureBaseScreenshot,
  onSubmitAnnotation,
  onClose,
}: {
  mode: 'web' | 'design-iframe' | 'game-iframe';
  pageUrl: string;
  pageTitle?: string;
  artifactId?: string;
  artifactKind?: SuperAgentArtifactKind;
  projectId?: string;
  canSelectElement: boolean;
  inspectAt?: (x: number, y: number) => Promise<BrowserInspectResult | null>;
  externalPickedElement?: BrowserPickedElement | null;
  onToolChange?: (tool: AnnotationOverlayTool) => void;
  getContentBounds: () => AnnotationContentBounds | null;
  captureBaseScreenshot: () => Promise<string | null>;
  onSubmitAnnotation: (payload: BrowserAnnotationSubmitPayload, sendImmediately: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tool, setTool] = useState<AnnotationOverlayTool>(canSelectElement ? 'select' : 'region');
  const [hoverElement, setHoverElement] = useState<BrowserPickedElement | null>(null);
  const [pinnedElement, setPinnedElement] = useState<BrowserPickedElement | null>(null);
  const [pinnedRegion, setPinnedRegion] = useState<BrowserRect | null>(null);
  const [dragRegion, setDragRegion] = useState<BrowserRect | null>(null);
  const [strokes, setStrokes] = useState<StrokeItem[]>([]);
  const [activeStroke, setActiveStroke] = useState<StrokeItem | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [layoutTick, setLayoutTick] = useState(0);

  const layerRef = useRef<HTMLDivElement>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastInspectAtRef = useRef(0);
  const inspectInFlightRef = useRef(false);
  const inspectSeqRef = useRef(0);
  const pointerDownClientRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setTool(canSelectElement ? 'select' : 'region');
    setHoverElement(null);
    setPinnedElement(null);
    setPinnedRegion(null);
    setDragRegion(null);
    setStrokes([]);
    setActiveStroke(null);
    setComment('');
  }, [canSelectElement, mode]);

  useEffect(() => {
    if (!externalPickedElement) return;
    setPinnedElement(externalPickedElement);
    setPinnedRegion(null);
    setHoverElement(null);
  }, [externalPickedElement]);

  const hasDraft = Boolean(pinnedElement || pinnedRegion || strokes.length > 0);
  const bubbleVisible = hasDraft;

  useEffect(() => {
    if (!bubbleVisible) return;
    const raf = requestAnimationFrame(() => commentInputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, [bubbleVisible, pinnedElement?.selector, pinnedRegion?.x, pinnedRegion?.y]);

  const clientToViewport = (clientX: number, clientY: number) => {
    const bounds = getContentBounds();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
    const vx = Math.max(0, Math.min(bounds.vpWidth, ((clientX - bounds.left) / bounds.width) * bounds.vpWidth));
    const vy = Math.max(0, Math.min(bounds.vpHeight, ((clientY - bounds.top) / bounds.height) * bounds.vpHeight));
    return { x: vx, y: vy, bounds };
  };

  const viewportRectToLayerBox = (rect: BrowserRect | null | undefined) => {
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const bounds = getContentBounds();
    const layerRect = layerRef.current?.getBoundingClientRect();
    if (!bounds || !layerRect || bounds.vpWidth <= 0 || bounds.vpHeight <= 0) return null;
    const sx = bounds.width / bounds.vpWidth;
    const sy = bounds.height / bounds.vpHeight;
    return {
      left: bounds.left - layerRect.left + rect.x * sx,
      top: bounds.top - layerRect.top + rect.y * sy,
      width: Math.max(4, rect.width * sx),
      height: Math.max(4, rect.height * sy),
    };
  };

  const clearDraft = () => {
    setHoverElement(null);
    setPinnedElement(null);
    setPinnedRegion(null);
    setDragRegion(null);
    setStrokes([]);
    setActiveStroke(null);
    setComment('');
  };

  useEffect(() => {
    onToolChange?.(tool);
  }, [tool, onToolChange]);

  useEffect(() => {
    const node = layerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setLayoutTick(v => v + 1));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        const activeTag = document.activeElement?.tagName;
        if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA' && strokes.length > 0 && !submitting) {
          event.preventDefault();
          setStrokes(prev => prev.slice(0, -1));
        }
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (hasDraft) clearDraft();
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasDraft, onClose, strokes.length, submitting]);

  const handleSubmit = async (sendImmediately: boolean) => {
    if (submitting || !hasDraft) return;
    setSubmitting(true);
    try {
      const bounds = getContentBounds();
      const vpWidth = pinnedElement?.viewport.width || bounds?.vpWidth || 1280;
      const vpHeight = pinnedElement?.viewport.height || bounds?.vpHeight || 800;
      const baseShot = await captureBaseScreenshot().catch(() => null);
      let compositedDataUrl: string | null = baseShot;
      if (baseShot && layerRef.current) {
        const computed = getComputedStyle(layerRef.current);
        const computedAccent = computed.getPropertyValue('--motion-accent').trim() || computed.color || 'currentColor';
        const computedOnAction = computed.getPropertyValue('--motion-on-action').trim() || computed.backgroundColor || 'CanvasText';
        compositedDataUrl = await compositeAnnotationScreenshot(
          baseShot,
          vpWidth,
          vpHeight,
          pinnedElement,
          pinnedRegion,
          strokes,
          computedAccent,
          computedOnAction,
        );
      }
      const annotationMode: 'select' | 'region' | 'draw' = pinnedElement
        ? 'select'
        : pinnedRegion
          ? 'region'
          : 'draw';
      let strokeBounds: BrowserRect | undefined;
      if (strokes.length > 0) {
        const pts = strokes.flatMap(stroke => stroke.points);
        if (pts.length > 0) {
          const minX = Math.max(0, Math.floor(Math.min(...pts.map(p => p.x))));
          const minY = Math.max(0, Math.floor(Math.min(...pts.map(p => p.y))));
          const maxX = Math.min(vpWidth, Math.ceil(Math.max(...pts.map(p => p.x))));
          const maxY = Math.min(vpHeight, Math.ceil(Math.max(...pts.map(p => p.y))));
          strokeBounds = {
            x: minX,
            y: minY,
            width: Math.max(1, maxX - minX),
            height: Math.max(1, maxY - minY),
          };
        }
      }

      await onSubmitAnnotation(
        {
          mode: annotationMode,
          comment: comment.trim(),
          ...(pinnedElement ? { element: pinnedElement } : {}),
          ...(pinnedRegion ? { region: pinnedRegion } : {}),
          viewport: { width: vpWidth, height: vpHeight },
          ...(strokes.length > 0 ? { strokeCount: strokes.length } : {}),
          ...(strokeBounds ? { strokeBounds } : {}),
          compositedDataUrl,
          pageUrl: pinnedElement?.pageUrl || pageUrl,
          pageTitle: pinnedElement?.pageTitle || pageTitle,
          artifactId,
          artifactKind,
          projectId,
        },
        sendImmediately,
      );
      clearDraft();
    } finally {
      setSubmitting(false);
    }
  };

  const runHoverInspect = (vx: number, vy: number) => {
    if (mode !== 'web' || !inspectAt || inspectInFlightRef.current) return;
    const now = Date.now();
    if (now - lastInspectAtRef.current < 110) return;
    lastInspectAtRef.current = now;
    inspectInFlightRef.current = true;
    const seq = ++inspectSeqRef.current;
    void inspectAt(vx, vy)
      .then(result => {
        if (seq !== inspectSeqRef.current) return;
        setHoverElement(result?.element ?? null);
      })
      .catch(() => {
        if (seq === inspectSeqRef.current) setHoverElement(null);
      })
      .finally(() => {
        inspectInFlightRef.current = false;
      });
  };

  const eraseAt = (vx: number, vy: number) => {
    if (pinnedElement) {
      const r = pinnedElement.rect;
      if (vx >= r.x && vx <= r.x + r.width && vy >= r.y && vy <= r.y + r.height) {
        setPinnedElement(null);
        return;
      }
    }
    if (pinnedRegion) {
      const r = pinnedRegion;
      if (vx >= r.x && vx <= r.x + r.width && vy >= r.y && vy <= r.y + r.height) {
        setPinnedRegion(null);
        return;
      }
    }
    if (strokes.length > 0) {
      const hitIdx = strokes.findIndex(stroke =>
        stroke.points.some(pt => Math.hypot(pt.x - vx, pt.y - vy) <= 16),
      );
      if (hitIdx !== -1) {
        setStrokes(prev => prev.filter((_, idx) => idx !== hitIdx));
      }
    }
  };

  const handleBackdropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const mapped = clientToViewport(event.clientX, event.clientY);
    if (!mapped) return;
    pointerDownClientRef.current = { x: event.clientX, y: event.clientY };

    if (tool === 'erase') {
      event.preventDefault();
      eraseAt(mapped.x, mapped.y);
      return;
    }
    if (tool === 'region') {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStartRef.current = { x: mapped.x, y: mapped.y };
      setDragRegion({ x: mapped.x, y: mapped.y, width: 0, height: 0 });
      return;
    }
    if (tool === 'draw') {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setActiveStroke({ id: `s-${Date.now()}`, points: [{ x: mapped.x, y: mapped.y }] });
      return;
    }
    if (tool === 'select' && mode === 'web') {
      event.preventDefault();
    }
  };

  const handleBackdropPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const mapped = clientToViewport(event.clientX, event.clientY);
    if (!mapped) return;
    if (tool === 'select' && mode === 'web') {
      runHoverInspect(mapped.x, mapped.y);
      return;
    }
    if (tool === 'region' && dragStartRef.current) {
      const start = dragStartRef.current;
      setDragRegion({
        x: Math.min(start.x, mapped.x),
        y: Math.min(start.y, mapped.y),
        width: Math.abs(mapped.x - start.x),
        height: Math.abs(mapped.y - start.y),
      });
      return;
    }
    if (tool === 'draw' && activeStroke) {
      const last = activeStroke.points.at(-1);
      if (!last || Math.hypot(mapped.x - last.x, mapped.y - last.y) >= 2.5) {
        setActiveStroke(prev => (prev ? { ...prev, points: [...prev.points, { x: mapped.x, y: mapped.y }] } : null));
      }
    }
  };

  const handleBackdropPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const mapped = clientToViewport(event.clientX, event.clientY);
    if (tool === 'region' && dragStartRef.current) {
      const finalRect = dragRegion;
      dragStartRef.current = null;
      setDragRegion(null);
      if (finalRect && finalRect.width >= 8 && finalRect.height >= 8) {
        setPinnedRegion({
          x: Math.round(finalRect.x),
          y: Math.round(finalRect.y),
          width: Math.round(finalRect.width),
          height: Math.round(finalRect.height),
        });
        setPinnedElement(null);
      }
      return;
    }
    if (tool === 'draw' && activeStroke) {
      const finished = activeStroke;
      setActiveStroke(null);
      if (finished.points.length >= 2) {
        setStrokes(prev => [...prev, finished]);
      }
      return;
    }
    if (tool === 'select' && mode === 'web' && inspectAt && mapped) {
      const down = pointerDownClientRef.current;
      pointerDownClientRef.current = null;
      if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8) return;
      const seq = ++inspectSeqRef.current;
      void inspectAt(mapped.x, mapped.y)
        .then(result => {
          if (seq !== inspectSeqRef.current || !result?.element) return;
          setPinnedElement(result.element);
          setPinnedRegion(null);
          setHoverElement(null);
        })
        .catch(() => {});
    }
  };

  const layerSize = useMemo(() => {
    const rect = layerRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  }, [hoverElement, pinnedElement, pinnedRegion, dragRegion, strokes.length, tool, layoutTick]);

  const hoverBox = viewportRectToLayerBox(hoverElement?.rect);
  const pinnedBox = viewportRectToLayerBox(pinnedElement?.rect ?? pinnedRegion);
  const activeRegionBox = viewportRectToLayerBox(dragRegion);

  const badgePlacement = (box: { top: number; height: number } | null): 'above' | 'below' | 'inside' => {
    if (!box) return 'above';
    if (box.top >= 28) return 'above';
    const layerHeight = layerSize.height || 480;
    if (box.top + box.height + 28 <= layerHeight) return 'below';
    return 'inside';
  };

  const badgeAlign = (box: { left: number } | null): 'start' | 'end' => {
    if (!box) return 'start';
    const layerWidth = layerSize.width || 640;
    return box.left + 190 > layerWidth ? 'end' : 'start';
  };

  const allStrokes = activeStroke ? [...strokes, activeStroke] : strokes;
  const contentBounds = getContentBounds();
  const layerRect = layerRef.current?.getBoundingClientRect();

  const renderSvgStrokes = () => {
    if (!allStrokes.length || !contentBounds || !layerRect || contentBounds.vpWidth <= 0 || contentBounds.vpHeight <= 0) {
      return null;
    }
    const sx = contentBounds.width / contentBounds.vpWidth;
    const sy = contentBounds.height / contentBounds.vpHeight;
    const ox = contentBounds.left - layerRect.left;
    const oy = contentBounds.top - layerRect.top;
    return (
      <svg className="om-sa-annot-svg" aria-hidden="true">
        {allStrokes.map(stroke => (
          <polyline
            key={stroke.id}
            fill="none"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            points={stroke.points.map(pt => `${(ox + pt.x * sx).toFixed(1)},${(oy + pt.y * sy).toFixed(1)}`).join(' ')}
          />
        ))}
      </svg>
    );
  };

  const bubblePosition = useMemo(() => {
    const w = layerSize.width || 640;
    const h = layerSize.height || 480;
    const bubbleWidth = Math.min(360, Math.max(240, w - 24));
    if (pinnedBox) {
      const left = Math.max(12, Math.min(w - bubbleWidth - 12, pinnedBox.left));
      const badgePlace = pinnedElement ? badgePlacement(pinnedBox) : 'above';
      const belowTop = pinnedBox.top + pinnedBox.height + (pinnedElement && badgePlace === 'below' ? 36 : 10);
      const aboveTop = pinnedBox.top - (pinnedElement && badgePlace === 'above' ? 82 : 58);
      const minClearTop = 62;
      const top = belowTop + 60 <= h
        ? Math.max(minClearTop, belowTop)
        : Math.max(minClearTop, aboveTop);
      return { left, top, width: bubbleWidth };
    }
    return {
      left: Math.max(12, Math.round((w - bubbleWidth) / 2)),
      top: Math.max(56, h - 68),
      width: bubbleWidth,
    };
  }, [pinnedBox?.left, pinnedBox?.top, pinnedBox?.height, layerSize.width, layerSize.height]);

  const backdropPassThrough = (mode === 'design-iframe' || mode === 'game-iframe') && tool === 'select';

  return (
    <div
      ref={layerRef}
      className="om-sa-annot-layer"
      data-tool={tool}
      data-passthrough={backdropPassThrough || undefined}
      aria-label={t('Annotation overlay')}
    >
      <div
        className="om-sa-annot-backdrop"
        style={backdropPassThrough ? { pointerEvents: 'none' } : undefined}
        onPointerDown={handleBackdropPointerDown}
        onPointerMove={handleBackdropPointerMove}
        onPointerUp={handleBackdropPointerUp}
        onPointerLeave={() => { if (!pinnedElement) setHoverElement(null); }}
      />

      {hoverBox && hoverElement && (!pinnedElement || hoverElement.selector !== pinnedElement.selector) && (
        <div
          className="om-sa-annot-hover-box"
          data-badge-place={badgePlacement(hoverBox)}
          data-badge-align={badgeAlign(hoverBox)}
          style={{ left: hoverBox.left, top: hoverBox.top, width: hoverBox.width, height: hoverBox.height }}
        >
          <span className="om-sa-annot-badge">
            {hoverElement.componentName ? `${hoverElement.componentName} · ` : ''}
            {hoverElement.selector}
          </span>
        </div>
      )}

      {pinnedBox && (
        <div
          className="om-sa-annot-pinned-box"
          data-badge-place={badgePlacement(pinnedBox)}
          data-badge-align={badgeAlign(pinnedBox)}
          style={{ left: pinnedBox.left, top: pinnedBox.top, width: pinnedBox.width, height: pinnedBox.height }}
        >
          {pinnedElement && (
            <span className="om-sa-annot-badge">
              {pinnedElement.componentName ? `${pinnedElement.componentName} · ` : ''}
              {pinnedElement.selector}
              {pinnedElement.sourceFile && typeof pinnedElement.sourceLine === 'number'
                ? ` (${pinnedElement.sourceFile.split('/').pop()}:${pinnedElement.sourceLine})`
                : ''}
            </span>
          )}
        </div>
      )}

      {activeRegionBox && (
        <div
          className="om-sa-annot-region-box"
          style={{
            left: activeRegionBox.left,
            top: activeRegionBox.top,
            width: activeRegionBox.width,
            height: activeRegionBox.height,
          }}
        />
      )}

      {renderSvgStrokes()}

      <div className="om-sa-annot-toolbar" role="toolbar" aria-label={t('Annotation tools')}>
        {canSelectElement && (
          <Button
            variant="plain"
            type="button"
            aria-label={t('Select')}
            title={t('Select')}
            className="om-sa-annot-tool-btn"
            data-active={tool === 'select' || undefined}
            onClick={() => setTool('select')}
          >
            <RemixIcon name="cursor-fill" size={14} />
            <span>{t('Select')}</span>
          </Button>
        )}
        <Button
          variant="plain"
          type="button"
          aria-label={t('Region')}
          title={t('Region')}
          className="om-sa-annot-tool-btn"
          data-active={tool === 'region' || undefined}
          onClick={() => setTool('region')}
        >
          <RemixIcon name="layout-2-line" size={14} />
          <span>{t('Region')}</span>
        </Button>
        <Button
          variant="plain"
          type="button"
          aria-label={t('Draw')}
          title={t('Draw')}
          className="om-sa-annot-tool-btn"
          data-active={tool === 'draw' || undefined}
          onClick={() => setTool('draw')}
        >
          <RemixIcon name="pen-nib-line" size={14} />
          <span>{t('Draw')}</span>
        </Button>
        <Button
          variant="plain"
          type="button"
          aria-label={t('Erase')}
          title={t('Erase')}
          className="om-sa-annot-tool-btn"
          data-active={tool === 'erase' || undefined}
          onClick={() => setTool('erase')}
        >
          <RemixIcon name="delete-bin-line" size={14} />
          <span>{t('Erase')}</span>
        </Button>
        {hasDraft && (
          <Button
            variant="plain"
            type="button"
            aria-label={t('Clear')}
            className="om-sa-annot-tool-btn"
            onClick={clearDraft}
          >
            <span>{t('Clear')}</span>
          </Button>
        )}
        <IconButton
          variant="plain"
          className="om-sa-annot-close-btn"
          aria-label={t('Close annotation mode')}
          onClick={onClose}
          icon={<RemixIcon name="close-line" size={14} />}
        />
      </div>

      {bubbleVisible && (
        <div
          className="om-sa-annot-bubble"
          style={{ left: bubblePosition.left, top: bubblePosition.top, width: bubblePosition.width }}
        >
          <RemixIcon name="sparkling-line" size={14} />
          <input
            ref={commentInputRef}
            type="text"
            className="om-sa-annot-input"
            value={comment}
            disabled={submitting}
            placeholder={t('Describe what to change…')}
            aria-label={t('Describe what to change…')}
            onChange={event => setComment(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleSubmit(Boolean(event.metaKey || event.ctrlKey));
              } else if (event.key === 'Escape') {
                event.preventDefault();
                clearDraft();
              }
            }}
          />
          <Tooltip label={t('Attach annotation and screenshot (Enter). Send with Cmd/Ctrl+Enter.')}>
            <Button
              variant="primary"
              type="button"
              className="om-sa-annot-attach-btn"
              disabled={submitting}
              onClick={() => void handleSubmit(false)}
            >
              {t('Attach')}
            </Button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
