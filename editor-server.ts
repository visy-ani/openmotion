import { renderFilenameStem } from './shared/render-name.ts';
import { BoundedLruCache } from './shared/lifecycle.ts';
import { attachmentDisposition } from './shared/http-header.ts';
import { request } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { pluginRoot } from './hyperframes.ts';
import { resolveDesignSystemFile } from './packages/design-system/index.js';
import { isSpaRoutePath } from './shared/spa-routes.ts';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

const mime: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.md': 'text/plain; charset=utf-8',
};

const HASHED_ASSET_RE = /^\/editor-assets\/.+-[A-Za-z0-9_-]{6,}\.(?:js|css|woff2?|ttf|svg|png|jpg|webp|json)$/;
const COMPRESSIBLE_EXTS = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt', '.md']);
const COMPRESS_MIN_BYTES = 1024;
const COMPRESSED_MAX_SOURCE_BYTES = 8 * 1024 * 1024;

type CachedResponsePayload = {
  encoding: 'br' | 'gzip';
  body: Buffer;
};

const staticCompressedCache = new BoundedLruCache<string, CachedResponsePayload>({
  maxEntries: 64,
  maxBytes: 24 * 1024 * 1024,
  sizeOf: item => item.body.length,
});

export function clearEditorStaticCache(): void {
  staticCompressedCache.clear();
}

function resolveCacheControl(pathname: string, designFile: string | undefined): string {
  if (HASHED_ASSET_RE.test(pathname)) {
    return 'public, max-age=31536000, immutable';
  }
  if (
    designFile
    || pathname === '/favicon.svg'
    || /^\/web\/catalog\/(?:template-frames|covers)\//.test(pathname)
  ) {
    return 'public, max-age=86400';
  }
  return 'no-store';
}

function negotiatedEncoding(req?: IncomingMessage): 'br' | 'gzip' | null {
  const header = req?.headers['accept-encoding'];
  const accept = Array.isArray(header) ? header.join(',').toLowerCase() : String(header ?? '').toLowerCase();
  if (!accept) return null;
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

async function compressPayload(raw: Buffer, encoding: 'br' | 'gzip'): Promise<Buffer> {
  if (encoding === 'br') {
    return await brotliAsync(raw, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
    });
  }
  return await gzipAsync(raw, { level: 6 });
}

/** Only application bundle and design-system files are exposed, never Studio source or project files. */
export async function serveEditorFile(url: URL, res: ServerResponse, req?: IncomingMessage): Promise<boolean> {
  let relative: string;
  const designFile = resolveDesignSystemFile(url.pathname);
  if (isSpaRoutePath(url.pathname)) relative = 'studio/build/index.html';
  else if (designFile) relative = 'packages/design-system/' + designFile;
  else if (url.pathname === '/favicon.svg') relative = 'packages/design-system/brand/favicon.svg';
  else if (/^\/editor-assets\/[a-zA-Z0-9_.-]+$/.test(url.pathname)) relative = 'studio/build' + url.pathname;
  else if (/^\/guide-assets\/viewer\.(js|css)$/.test(url.pathname)) relative = 'studio/build' + url.pathname;
  else if (
    /^\/web\/catalog\/(?:hyperframes|template-frames|provenance|covers)\.json$/.test(url.pathname)
    || /^\/web\/catalog\/(?:template-frames|covers)\/[a-f0-9]{24}\.(?:jpg|webp)$/.test(url.pathname)
  ) {
    relative = url.pathname.slice(1);
  } else {
    return false;
  }

  const ext = path.extname(relative);
  const type = mime[ext];
  if (!type) return false;

  const fullPath = path.join(pluginRoot, relative);
  try {
    const info = await stat(fullPath);
    if (!info.isFile()) return false;

    const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
    const cacheControl = resolveCacheControl(url.pathname, designFile);
    const baseHeaders: Record<string, string | number> = {
      'Content-Type': type,
      'Cache-Control': cacheControl,
      ETag: etag,
      Vary: 'Accept-Encoding',
      ...(designFile && /\.(?:ttf|woff2?)$/.test(designFile) ? { 'Access-Control-Allow-Origin': '*' } : {}),
    };

    const ifNoneMatch = req?.headers['if-none-match'];
    const matchValue = Array.isArray(ifNoneMatch) ? ifNoneMatch[0] : ifNoneMatch;
    if (matchValue && matchValue.split(',').some(tag => tag.trim() === etag || tag.trim() === '*')) {
      res.writeHead(304, {
        'Cache-Control': cacheControl,
        ETag: etag,
        Vary: 'Accept-Encoding',
      });
      res.end();
      return true;
    }

    const encoding =
      COMPRESSIBLE_EXTS.has(ext)
      && info.size >= COMPRESS_MIN_BYTES
      && info.size <= COMPRESSED_MAX_SOURCE_BYTES
        ? negotiatedEncoding(req)
        : null;

    if (encoding) {
      const cacheKey = `${fullPath}:${etag}:${encoding}`;
      let cached = staticCompressedCache.get(cacheKey);
      if (!cached) {
        const raw = await readFile(fullPath);
        const compressed = await compressPayload(raw, encoding);
        cached = { encoding, body: compressed };
        staticCompressedCache.set(cacheKey, cached);
      }
      res.writeHead(200, {
        ...baseHeaders,
        'Content-Encoding': cached.encoding,
        'Content-Length': cached.body.length,
      });
      res.end(cached.body);
      return true;
    }

    const data = await readFile(fullPath);
    res.writeHead(200, {
      ...baseHeaders,
      'Content-Length': data.length,
    });
    res.end(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(relative.endsWith('index.html') ? '编辑器尚未构建。请运行 npm run build:studio。' : '编辑器资源不存在，请刷新页面。');
  }
  return true;
}

/** Suggest a portable name without changing the immutable render's storage path. */
export function renderDownloadDisposition(title: string | undefined, extension: string): string {
  return attachmentDisposition(renderFilenameStem(title) + extension, `OpenMotion${extension}`);
}

/** Preserve native HTTP semantics (SSE, byte ranges, multipart uploads and optimistic file writes). */
export function proxyStudio(req: IncomingMessage, res: ServerResponse, url: URL, studioUrl: string, downloadDisposition?: string): Promise<void> {
  const target = new URL(studioUrl);
  target.pathname = url.pathname; target.search = url.search; target.hash = '';
  const headers = { ...req.headers, host: target.host };
  if (headers.origin) headers.origin = target.origin;
  if (headers.referer) headers.referer = target.origin + '/';
  delete headers.connection;
  return new Promise(resolve => {
    const upstream = request(target, { method: req.method, headers }, response => {
      const outgoing = { ...response.headers };
      delete outgoing.connection;
      if (downloadDisposition && response.statusCode === 200) outgoing['content-disposition'] = downloadDisposition;
      res.writeHead(response.statusCode || 502, outgoing);
      response.on('error', () => { res.destroy(); resolve(); });
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '原生编辑服务连接中断，请刷新重试' })); }
      else res.destroy();
      resolve();
    });
    res.on('close', () => { upstream.destroy(); resolve(); });
    res.on('finish', resolve);
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  });
}
