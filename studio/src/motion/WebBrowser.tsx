import { Button } from 'open-design-ui/button';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type {
  BrowserCommandAction,
  BrowserConsoleEntry,
  BrowserInput,
  BrowserInspectResult,
  BrowserRect,
  BrowserScreenshotResult,
  WebPageState,
} from '../../../shared/browser';
import { Skeleton } from '../components/ui/Skeleton';
import { useI18n } from '../i18n/I18n';

export type WebBrowserHandle = {
  command: (action: BrowserCommandAction, value?: unknown) => Promise<WebPageState>;
  inspectAt: (x: number, y: number) => Promise<BrowserInspectResult>;
  screenshot: (clip?: BrowserRect) => Promise<BrowserScreenshotResult>;
  getViewport: () => { width: number; height: number };
  getRenderedImage: () => HTMLImageElement | null;
  clearConsole: () => Promise<void>;
};

export const browserEndpoint = (session: string, tab: string) => `/design-api/sessions/${encodeURIComponent(session)}/browser/${encodeURIComponent(tab)}`;

export async function browserJsonRequest<T>(endpoint: string, data?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value as T;
}

export async function browserRequest(endpoint: string, data?: unknown, method = 'POST') {
  return browserJsonRequest<WebPageState>(endpoint, data, method);
}

/** Only pixels and whitelisted input cross this boundary; web documents never run in the workspace DOM. */
export const WebBrowser = forwardRef<WebBrowserHandle, {
  sessionId: string;
  tabId: string;
  url: string;
  endpoint?: string;
  interactive?: boolean;
  fixedViewport?: { width: number; height: number; dpr?: number } | null;
  onState: (state: WebPageState) => void;
  onConsoleSnapshot?: (entries: BrowserConsoleEntry[]) => void;
  onConsoleEntry?: (entry: BrowserConsoleEntry) => void;
}>(function WebBrowser({
  sessionId,
  tabId,
  url,
  endpoint: customEndpoint,
  interactive = true,
  fixedViewport = null,
  onState,
  onConsoleSnapshot,
  onConsoleEntry,
}, ref) {
  const { t } = useI18n();
  const endpoint = customEndpoint ?? browserEndpoint(sessionId, tabId);
  const surface = useRef<HTMLDivElement>(null), keyboard = useRef<HTMLTextAreaElement>(null);
  const picture = useRef<HTMLImageElement>(null), ready = useRef(false), queue = useRef(Promise.resolve());
  const report = useRef(onState), initialUrl = useRef(url), composing = useRef(false), pointerTime = useRef(0);
  const consoleSnapshotRef = useRef(onConsoleSnapshot), consoleEntryRef = useRef(onConsoleEntry);
  const interactiveRef = useRef(interactive), fixedViewportRef = useRef(fixedViewport);
  const frameViewport = useRef<{ width: number; height: number } | null>(null);
  const lastSentViewport = useRef<{ width: number; height: number; dpr: number } | null>(null);
  const hasFrameRef = useRef(false);
  report.current = onState;
  initialUrl.current = url;
  consoleSnapshotRef.current = onConsoleSnapshot;
  consoleEntryRef.current = onConsoleEntry;
  interactiveRef.current = interactive;
  fixedViewportRef.current = fixedViewport;
  const [error, setError] = useState(''), [hasFrame, setHasFrame] = useState(false), [attempt, setAttempt] = useState(0);
  const currentDpr = () => (typeof window !== 'undefined' ? Math.min(2, Math.max(1, Math.round((window.devicePixelRatio || 1) * 2) / 2)) : 1);
  const measureBounds = () => {
    const fixed = fixedViewportRef.current;
    if (fixed && fixed.width >= 20 && fixed.height >= 20) {
      return { width: Math.round(fixed.width), height: Math.round(fixed.height), dpr: fixed.dpr ?? currentDpr() };
    }
    const bounds = surface.current?.getBoundingClientRect();
    if (!bounds || bounds.width < 20 || bounds.height < 20) return null;
    return { width: Math.round(bounds.width), height: Math.round(bounds.height), dpr: currentDpr() };
  };
  useImperativeHandle(ref, () => ({
    command: async (action, value) => {
      if (!ready.current) throw new Error(t('Browser is connecting. Please try again.'));
      setError('');
      const state = await browserRequest(`${endpoint}/command`, {
        action,
        ...(action === 'navigate' && typeof value === 'string' ? { url: value } : {}),
        ...(value !== undefined ? { value } : {}),
      });
      report.current(state);
      return state;
    },
    inspectAt: async (x, y) => {
      if (!ready.current) throw new Error(t('Browser is connecting. Please try again.'));
      return browserJsonRequest<BrowserInspectResult>(`${endpoint}/inspect`, { x, y });
    },
    screenshot: async clip => {
      if (!ready.current) throw new Error(t('Browser is connecting. Please try again.'));
      return browserJsonRequest<BrowserScreenshotResult>(`${endpoint}/screenshot`, clip ? { clip } : {});
    },
    getViewport: () => {
      const vp = frameViewport.current ?? fixedViewportRef.current;
      if (vp) return { width: vp.width, height: vp.height };
      const img = picture.current;
      return {
        width: img?.naturalWidth || img?.clientWidth || surface.current?.clientWidth || 1280,
        height: img?.naturalHeight || img?.clientHeight || surface.current?.clientHeight || 800,
      };
    },
    getRenderedImage: () => picture.current,
    clearConsole: async () => {
      if (!ready.current) return;
      await browserJsonRequest<{ cleared: boolean }>(`${endpoint}/console`, undefined, 'DELETE');
      consoleSnapshotRef.current?.([]);
    },
  }), [endpoint, t]);
  function input(event: BrowserInput) {
    if (!ready.current) return;
    queue.current = queue.current.then(async () => { await browserRequest(`${endpoint}/input`, event); }).catch(reason => setError(reason.message));
  }
  useEffect(() => {
    let disposed = false, events: EventSource | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let observer: ResizeObserver | undefined;
    ready.current = false; hasFrameRef.current = false; frameViewport.current = null; lastSentViewport.current = null;
    setError(''); setHasFrame(false);

    const stopStream = () => {
      events?.close();
      events = undefined;
    };

    const startStream = () => {
      if (disposed || events || (typeof document !== 'undefined' && document.hidden)) return;
      events = new EventSource(`${endpoint}/events`);
      events.addEventListener('state', event => {
        if (disposed) return;
        const state: WebPageState = JSON.parse((event as MessageEvent).data);
        report.current(state); setError(state.error || '');
      });
      events.addEventListener('console_snapshot', event => {
        if (disposed) return;
        const entries = JSON.parse((event as MessageEvent).data) as BrowserConsoleEntry[];
        consoleSnapshotRef.current?.(entries);
      });
      events.addEventListener('console', event => {
        if (disposed) return;
        const entry = JSON.parse((event as MessageEvent).data) as BrowserConsoleEntry;
        consoleEntryRef.current?.(entry);
      });
      events.addEventListener('frame', event => {
        if (disposed || !picture.current) return;
        const payload = JSON.parse((event as MessageEvent).data) as { data: string; width?: number; height?: number; dpr?: number };
        const current = measureBounds();
        if (!hasFrameRef.current && current && payload.width && payload.height) {
          const widthRatio = Math.abs(payload.width - current.width) / Math.max(1, current.width);
          const heightRatio = Math.abs(payload.height - current.height) / Math.max(1, current.height);
          if (widthRatio > 0.2 || heightRatio > 0.2) return;
        }
        if (payload.width && payload.height) {
          frameViewport.current = { width: payload.width, height: payload.height };
        }
        const img = picture.current;
        img.src = `data:image/jpeg;base64,${payload.data}`;
        if (!hasFrameRef.current) {
          const reveal = () => {
            if (disposed) return;
            hasFrameRef.current = true;
            setHasFrame(true);
          };
          if (typeof img.decode === 'function') void img.decode().then(reveal, reveal);
          else reveal();
        }
      });
      events.onerror = () => { if (!disposed) setError(t('Browser connection interrupted. Retry to reconnect.')); };
    };

    const onVisibilityChange = () => {
      if (disposed) return;
      if (document.hidden) stopStream();
      else if (ready.current) startStream();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    void (async () => {
      let initial = measureBounds();
      if (!initial) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (disposed) return;
        initial = measureBounds();
      }
      if (initial) lastSentViewport.current = initial;
      await browserRequest(endpoint, {
        url: initialUrl.current,
        ...(initial ? { width: initial.width, height: initial.height, dpr: initial.dpr } : {}),
      });
      if (disposed) return;
      if (attempt > 0) await browserRequest(`${endpoint}/command`, { action: 'navigate', url: initialUrl.current });
      ready.current = true;
      startStream();
      const resize = () => {
        clearTimeout(timer); timer = setTimeout(() => {
          const next = measureBounds();
          if (!next || disposed) return;
          const prev = lastSentViewport.current;
          if (prev && prev.width === next.width && prev.height === next.height && prev.dpr === next.dpr) return;
          lastSentViewport.current = next;
          void browserRequest(`${endpoint}/resize`, next).catch(reason => setError(reason.message));
        }, 120);
      };
      observer = new ResizeObserver(resize); observer.observe(surface.current!);
    })().catch(reason => { if (!disposed) setError(reason.message); });
    return () => {
      disposed = true;
      ready.current = false;
      hasFrameRef.current = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopStream();
      observer?.disconnect();
      clearTimeout(timer);
      picture.current?.removeAttribute('src');
    };
  }, [endpoint, attempt, t]);
  useEffect(() => {
    if (!ready.current) return;
    const next = measureBounds();
    if (!next) return;
    const prev = lastSentViewport.current;
    if (prev && prev.width === next.width && prev.height === next.height && prev.dpr === next.dpr) return;
    lastSentViewport.current = next;
    void browserRequest(`${endpoint}/resize`, next).catch(reason => setError(reason.message));
  }, [endpoint, fixedViewport?.width, fixedViewport?.height, fixedViewport?.dpr]);
  const point = (x: number, y: number) => {
    const img = picture.current!;
    const bounds = img.getBoundingClientRect();
    const vp = frameViewport.current ?? { width: img.naturalWidth || bounds.width, height: img.naturalHeight || bounds.height };
    const scale = Math.min(bounds.width / Math.max(1, vp.width), bounds.height / Math.max(1, vp.height));
    const renderedW = Math.max(1, vp.width * scale);
    const renderedH = Math.max(1, vp.height * scale);
    return {
      x: Math.max(0, Math.min(vp.width, ((x - bounds.left) / renderedW) * vp.width)),
      y: Math.max(0, Math.min(vp.height, ((y - bounds.top) / renderedH) * vp.height)),
    };
  };
  useEffect(() => {
    const node = surface.current!;
    const wheel = (event: WheelEvent) => {
      if (!interactiveRef.current) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1;
      input({ type: 'wheel', ...point(event.clientX, event.clientY), deltaX: event.deltaX * unit, deltaY: event.deltaY * unit });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [endpoint]); // Input queue is scoped to this tab's mount.
  return <div className="motion-web-browser" ref={surface} aria-label={t('Web page')}>
    <img ref={picture} className="motion-web-page" data-loaded={hasFrame || undefined} alt={t('Web page')} draggable={false} hidden={!hasFrame}
      onContextMenu={event => event.preventDefault()}
      onPointerDown={event => { if (!interactive) return; event.preventDefault(); keyboard.current?.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); input({ type: 'pointer', event: 'down', ...point(event.clientX, event.clientY), button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left', clickCount: event.detail }); }}
      onPointerUp={event => { if (!interactive) return; input({ type: 'pointer', event: 'up', ...point(event.clientX, event.clientY), button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left', clickCount: event.detail }); }}
      onPointerMove={event => { if (!interactive || Date.now() - pointerTime.current < 60) return; pointerTime.current = Date.now(); input({ type: 'pointer', event: 'move', ...point(event.clientX, event.clientY), button: 'left' }); }} />
    <textarea ref={keyboard} className="motion-browser-keyboard" aria-label={t('Web page keyboard')} autoComplete="off" autoCapitalize="off" spellCheck={false}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; input({ type: 'text', text: event.currentTarget.value }); event.currentTarget.value = ''; }}
      onInput={event => { if (!composing.current && event.currentTarget.value) { input({ type: 'text', text: event.currentTarget.value }); event.currentTarget.value = ''; } }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing.current) return;
        if (['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) {
          event.preventDefault(); input({ type: 'key', key: event.key.toLowerCase() === 'a' ? 'a' : event.key, modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0) });
        }
      }} />
    {!hasFrame && !error && (
      <div className="om-sa-web-skeleton" role="status" aria-label={t('Loading…')}>
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
    )}
    {error && <div className="motion-browser-feedback" role="alert"><span>{t(error)}</span><Button variant="plain" className="motion-button" onClick={() => setAttempt(value => value + 1)}>{t('Retry')}</Button></div>}
  </div>;
});
