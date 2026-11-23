export type BrowserColorScheme = 'auto' | 'light' | 'dark';

export type WebPageState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  error?: string;
  colorScheme?: BrowserColorScheme;
  zoom?: number;
  consoleCount?: number;
  errorCount?: number;
};

export type BrowserCommandAction =
  | 'back'
  | 'forward'
  | 'reload'
  | 'hard-reload'
  | 'stop'
  | 'navigate'
  | 'clear-cookies'
  | 'clear-cache'
  | 'set-color-scheme'
  | 'set-zoom'
  | 'set-touch';

export type BrowserRect = { x: number; y: number; width: number; height: number };

export type BrowserPickedElement = {
  tagName: string;
  selector: string;
  id?: string;
  classes?: string[];
  label: string;
  text?: string;
  htmlPreview: string;
  styles: Record<string, string>;
  rect: BrowserRect;
  viewport: { width: number; height: number };
  pageUrl: string;
  pageTitle?: string;
  componentName?: string;
  sourceFile?: string;
  sourceLine?: number;
  sourceColumn?: number;
};

export type BrowserInspectResult = {
  element: BrowserPickedElement | null;
  viewport: { width: number; height: number };
  pageUrl: string;
  pageTitle?: string;
};

export type BrowserScreenshotResult = {
  dataUrl: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  pageUrl: string;
  pageTitle?: string;
};

export type BrowserConsoleEntry = {
  id: string;
  level: 'log' | 'warn' | 'error' | 'network';
  text: string;
  url?: string;
  line?: number;
  timestamp: number;
};

export type BrowserInput =
  | { type: 'pointer'; event: 'move' | 'down' | 'up'; x: number; y: number; button: 'left' | 'middle' | 'right'; clickCount?: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string; modifiers: number };

export function webAddress(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw new Error('请输入有效的 HTTP 或 HTTPS 网址');
  const input = value.trim();
  const url = new URL(/^https?:\/\//i.test(input) ? input : /^[a-z][\w+.-]*:/i.test(input) && !/^[\w.-]+:\d+(?:\/|$)/.test(input) ? input : `https://${input}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new Error('请输入有效的 HTTP 或 HTTPS 网址');
  return url.href;
}
