import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { clearEditorStaticCache, serveEditorFile } from '../editor-server.ts';
import { clearLocalAgentResolveCache, resolveLocalAgent } from '../gateway/local-agents.ts';
import { AdaptivePoller, BoundedLruCache, DisposableStack } from '../shared/lifecycle.ts';

function requestRaw(
  port: number,
  reqPath: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method: 'GET',
        headers,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('BoundedLruCache enforces entry count, byte budgets, recency order, and safe eviction', () => {
  const evicted: Array<[string, string]> = [];
  const cache = new BoundedLruCache<string, string>({
    maxEntries: 2,
    maxBytes: 10,
    sizeOf: value => value.length,
    onEvict: (value, key) => {
      evicted.push([key, value]);
      if (key === 'thrower') throw new Error('evict callback error');
    },
  });

  // Oversized entry is rejected and triggers onEvict immediately.
  cache.set('huge', '12345678901');
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
  assert.deepEqual(evicted, [['huge', '12345678901']]);

  cache.set('a', '1234');
  cache.set('b', '5678');
  assert.equal(cache.size, 2);
  assert.equal(cache.bytes, 8);

  // Accessing 'a' refreshes it so 'b' becomes LRU and gets evicted on insert of 'c'.
  assert.equal(cache.get('a'), '1234');
  cache.set('c', '9012');
  assert.equal(cache.has('b'), false);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.bytes, 8);

  // Byte budget evicts 'a' even though entry count is only 2.
  cache.set('d', '123456');
  assert.equal(cache.has('a'), false);
  assert.equal(cache.has('c'), true);
  assert.equal(cache.has('d'), true);
  assert.equal(cache.bytes, 10);

  // Overwriting key with new value evicts prior value; throwing callback is isolated.
  cache.set('thrower', 'ab');
  cache.set('thrower', 'cd');
  assert.equal(cache.get('thrower'), 'cd');

  assert.equal(cache.delete('thrower'), true);
  assert.equal(cache.delete('missing'), false);

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});

test('DisposableStack disposes cleanups in LIFO order and remains idempotent', async () => {
  const events: string[] = [];
  const stack = new DisposableStack();

  stack.add(() => {
    events.push('first');
  });
  stack.add(() => {
    events.push('throws');
    throw new Error('boom');
  });
  stack.add(async () => {
    await Promise.resolve();
    events.push('last');
  });

  await stack.dispose();
  assert.equal(stack.isDisposed, true);
  assert.deepEqual(events, ['last', 'throws', 'first']);

  // Second dispose is a no-op; late additions execute immediately.
  await stack.dispose();
  assert.deepEqual(events, ['last', 'throws', 'first']);
  stack.add(() => {
    events.push('late');
  });
  assert.deepEqual(events, ['last', 'throws', 'first', 'late']);

  const syncEvents: number[] = [];
  const syncStack = new DisposableStack();
  syncStack.add(() => syncEvents.push(1));
  syncStack.add(() => syncEvents.push(2));
  syncStack.disposeSync();
  assert.deepEqual(syncEvents, [2, 1]);
});

test('AdaptivePoller adjusts cadence between active work, idle backoff, nudge, and stop', async () => {
  let step = 0;
  const stamps: number[] = [];
  let releaseInFlight: (() => void) | null = null;

  const poller = new AdaptivePoller({
    activeIntervalMs: 25,
    idleIntervalsMs: [80, 160],
    unref: true,
    run: async () => {
      step += 1;
      stamps.push(Date.now());
      if (step === 1) return true; // stay on fast cadence (25ms)
      if (step === 2) return false; // back off to 80ms
      if (step === 3) {
        // Hold in-flight to verify nudge() during execution schedules immediate re-run.
        await new Promise<void>(resolve => {
          releaseInFlight = resolve;
        });
      }
      return false;
    },
  });

  poller.start();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(step >= 2);
  const firstGap = stamps[1]! - stamps[0]!;
  assert.ok(firstGap < 75, `expected fast active interval, got ${firstGap}ms`);

  // Wait for step 3 to enter in-flight gate, then trigger nudge() before releasing it.
  const waitStart = Date.now();
  while (step < 3 && Date.now() - waitStart < 1_000) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(step >= 3);
  poller.nudge();
  releaseInFlight?.();

  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(step >= 4, `expected nudge to trigger step 4 immediately, step=${step}`);

  const countBeforeStop = step;
  poller.stop();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(step, countBeforeStop);
});

test('serveEditorFile compresses static payloads (br/gzip), sets cache headers, and serves 304 on ETag match', async () => {
  clearEditorStaticCache();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const handled = await serveEditorFile(url, res, req);
      if (!handled) {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const cssDisk = readFileSync(path.resolve('packages/design-system/studio.css'));
    const brRes = await requestRaw(address.port, '/design-system/studio.css', {
      'Accept-Encoding': 'br, gzip',
    });
    assert.equal(brRes.statusCode, 200);
    assert.equal(brRes.headers['content-encoding'], 'br');
    assert.equal(brRes.headers.vary, 'Accept-Encoding');
    assert.equal(brRes.headers['cache-control'], 'public, max-age=86400');
    assert.ok(typeof brRes.headers.etag === 'string' && brRes.headers.etag.length > 0);
    assert.equal(brotliDecompressSync(brRes.body).equals(cssDisk), true);

    const gzRes = await requestRaw(address.port, '/design-system/studio.css', {
      'Accept-Encoding': 'gzip',
    });
    assert.equal(gzRes.statusCode, 200);
    assert.equal(gzRes.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(gzRes.body).equals(cssDisk), true);

    const notModified = await requestRaw(address.port, '/design-system/studio.css', {
      'Accept-Encoding': 'br, gzip',
      'If-None-Match': String(brRes.headers.etag),
    });
    assert.equal(notModified.statusCode, 304);
    assert.equal(notModified.body.length, 0);
    assert.equal(notModified.headers.etag, brRes.headers.etag);

    if (existsSync(path.resolve('studio/build/index.html'))) {
      const htmlRes = await requestRaw(address.port, '/', { 'Accept-Encoding': 'br, gzip' });
      assert.equal(htmlRes.statusCode, 200);
      assert.equal(htmlRes.headers['cache-control'], 'no-store');
    }

    const assetsDir = path.resolve('studio/build/editor-assets');
    if (existsSync(assetsDir)) {
      const jsFile = readdirSync(assetsDir).find(file => file.endsWith('.js'));
      if (jsFile) {
        const assetDisk = readFileSync(path.join(assetsDir, jsFile));
        const assetRes = await requestRaw(address.port, `/editor-assets/${jsFile}`, {
          'Accept-Encoding': 'br, gzip',
        });
        assert.equal(assetRes.statusCode, 200);
        assert.equal(assetRes.headers['cache-control'], 'public, max-age=31536000, immutable');
        assert.equal(assetRes.headers['content-encoding'], 'br');
        assert.ok(assetRes.body.length < assetDisk.length);
        assert.equal(brotliDecompressSync(assetRes.body).equals(assetDisk), true);
      }
    }
  } finally {
    clearEditorStaticCache();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('resolveLocalAgent caches lookups with TTL and resets cleanly via clearLocalAgentResolveCache', async () => {
  clearLocalAgentResolveCache();
  const nodeFirst = await resolveLocalAgent('node');
  const nodeSecond = await resolveLocalAgent('node');
  assert.equal(nodeSecond, nodeFirst);
  assert.ok(typeof nodeFirst === 'string' && nodeFirst.length > 0);

  const missingFirst = await resolveLocalAgent('openmotion-nonexistent-agent-binary-xyz');
  const missingSecond = await resolveLocalAgent('openmotion-nonexistent-agent-binary-xyz');
  assert.equal(missingFirst, null);
  assert.equal(missingSecond, null);

  clearLocalAgentResolveCache();
  const nodeAfterClear = await resolveLocalAgent('node');
  assert.equal(nodeAfterClear, nodeFirst);
});
