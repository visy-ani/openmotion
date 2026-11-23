import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { WorkspaceBrowser } from '../browser.ts';
import { webAddress } from '../shared/browser.ts';
import { injectPreviewBridgeHtml } from '../shared/preview-bridge.ts';

test('browser addresses accept bare domains and local ports but reject executable and credential URLs', () => {
  assert.equal(webAddress('baidu.com'), 'https://baidu.com/');
  assert.equal(webAddress('localhost:48263/page'), 'https://localhost:48263/page');
  for (const url of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hello', 'https://user:pass@example.com']) assert.throws(() => webAddress(url));
});

test('real browser handles frame-denying sites, navigation, input, history, reload and isolated sessions', { timeout: 60_000 }, async () => {
  let visits = 0;
  const site = createServer((req, res) => {
    const url = new URL(req.url!, 'http://local');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
    res.end(`<title>${url.pathname}</title><a href="/next">Next</a><form action="/search"><input name="q" autofocus><button>Search</button></form><p id="query">${url.searchParams.get('q') || ''}</p><p id="visit">${++visits}</p>`);
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const browser = new WorkspaceBrowser(process.cwd());
  try {
    const tab = await browser.open('session-one', 'tab-one', `${base}/first`);
    await tab.page.waitForSelector('input');
    // Autofocus is scheduled after DOM readiness; explicitly focus before testing input delivery.
    await tab.page.focus('input');
    await tab.page.waitForFunction(() => document.activeElement?.tagName === 'INPUT');
    await tab.input({ type: 'text', text: 'OpenDesign 中文' });
    await Promise.all([tab.page.waitForNavigation(), tab.input({ type: 'key', key: 'Enter', modifiers: 0 })]);
    assert.equal(new URL(tab.page.url()).searchParams.get('q'), 'OpenDesign 中文');
    const link = await tab.page.$eval('a', element => { const r = element.getBoundingClientRect(); return { x: r.x + 5, y: r.y + 5 }; });
    await tab.input({ type: 'pointer', event: 'down', button: 'left', ...link });
    await Promise.all([tab.page.waitForNavigation(), tab.input({ type: 'pointer', event: 'up', button: 'left', ...link })]);
    assert.equal(tab.page.url(), `${base}/next`);
    await Promise.all([tab.page.waitForNavigation(), tab.command('back')]);
    assert.equal(new URL(tab.page.url()).pathname, '/search');
    await Promise.all([tab.page.waitForNavigation(), tab.command('forward')]);
    assert.equal(tab.page.url(), `${base}/next`);
    const before = await tab.page.$eval('#visit', el => el.textContent);
    await Promise.all([tab.page.waitForNavigation(), tab.command('reload')]);
    assert.notEqual(await tab.page.$eval('#visit', el => el.textContent), before);
    await assert.rejects(tab.command('navigate', 'file:///tmp/private'), /HTTP/);
    await tab.page.evaluate(() => { localStorage.setItem('isolation', 'one'); });
    const other = await browser.open('session-two', 'tab-one', `${base}/first`);
    await other.page.waitForSelector('input');
    assert.equal(await other.page.evaluate(() => localStorage.getItem('isolation')), null);
    const sibling = await browser.open('session-one', 'tab-two', `${base}/first`);
    await sibling.page.waitForSelector('input');
    assert.equal(await sibling.page.evaluate(() => localStorage.getItem('isolation')), 'one');
    let frames = '';
    const stream = Object.assign(new Writable({ write(chunk, _encoding, done) { frames += chunk.toString(); done(); } }), { writeHead() {} });
    await tab.watch(stream as unknown as ServerResponse);
    const deadline = Date.now() + 5000;
    while (!frames.includes('event: frame') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(frames, /event: frame/); assert.match(frames, /"canGoBack":true/);
    stream.destroy();
    assert.equal(await browser.open('session-one', 'tab-one', `${base}/first`), tab, 'reattaching preserves browser history');
    await browser.remove('session-one', 'tab-one');
    assert.equal(tab.page.isClosed(), true);
    await assert.rejects(browser.get('session-one', 'tab-one'), /关闭/);
    await other.page.browser().close();
    const recovered = await browser.open('session-two', 'tab-one', `${base}/recovered`);
    await recovered.page.waitForSelector('input');
    assert.equal(recovered.page.url(), `${base}/recovered`, 'a disconnected engine can be relaunched on retry');
  } finally { await browser.close(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve())); }
});

test('browser supports inspectAt, screenshot, color scheme, zoom, clear cache/cookies and console capture', { timeout: 60_000 }, async () => {
  const site = createServer((req, res) => {
    const url = new URL(req.url!, 'http://local');
    if (url.pathname === '/missing-asset') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
      <html>
        <head><title>Inspect Test</title></head>
        <body style="margin:0">
          <button id="cta" class="hero-btn" style="position:fixed;left:20px;top:20px;width:160px;height:48px">Launch App</button>
          <script>
            console.error('boom-console-msg');
            fetch('/missing-asset');
          </script>
        </body>
      </html>`);
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const browser = new WorkspaceBrowser(process.cwd());
  try {
    const tab = await browser.open('session-inspect', 'tab-inspect', `${base}/`, { width: 800, height: 600, dpr: 1 });
    await tab.page.waitForSelector('#cta');

    const picked = await tab.inspectAt(60, 44);
    assert.ok(picked.element);
    assert.equal(picked.element.tagName, 'button');
    assert.equal(picked.element.selector, '#cta');
    assert.ok(picked.element.htmlPreview.includes('Launch App'));
    assert.ok(picked.element.rect.width >= 150);
    assert.ok(picked.element.styles.display);

    const shot = await tab.screenshot();
    assert.equal(shot.mimeType, 'image/png');
    assert.ok(shot.dataUrl.startsWith('data:image/png;base64,'));
    assert.ok(shot.width > 0 && shot.height > 0);

    await tab.command('set-color-scheme', 'dark');
    assert.equal(tab.state.colorScheme, 'dark');
    await tab.command('set-zoom', 1.25);
    assert.equal(tab.state.zoom, 1.25);

    const zoomedPicked = await tab.inspectAt(32, 32);
    assert.ok(zoomedPicked.element);
    assert.equal(zoomedPicked.element.selector, '#cta');
    assert.ok(zoomedPicked.element.rect.width >= 190, `Expected zoomed width >= 190, got ${zoomedPicked.element.rect.width}`);

    await tab.command('clear-cookies');
    await tab.command('clear-cache');
    await Promise.all([tab.page.waitForNavigation({ waitUntil: 'domcontentloaded' }), tab.command('hard-reload')]);

    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline
      && !tab.getConsoleEntries().some(entry => entry.text.includes('boom-console-msg'))
    ) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const entries = tab.getConsoleEntries();
    assert.ok(entries.some(entry => entry.level === 'error' && entry.text.includes('boom-console-msg')));

    await tab.page.evaluate(() => {
      void fetch('http://127.0.0.1:9/fail-network').catch(() => {});
    });
    const netDeadline = Date.now() + 3000;
    while (
      Date.now() < netDeadline
      && !tab.getConsoleEntries().some(entry => entry.level === 'network' && entry.text.includes('Network failed'))
    ) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(tab.getConsoleEntries().some(entry => entry.level === 'network' && entry.text.includes('Network failed')));

    tab.clearConsoleEntries();
    assert.equal(tab.getConsoleEntries().length, 0);
    assert.equal(tab.state.errorCount, 0);

    const snap = await browser.snapshot(`${base}/`, { width: 640, height: 480 });
    assert.equal(snap.mimeType, 'image/png');
    assert.equal(snap.width, 640);
    assert.equal(snap.height, 480);
    assert.ok(snap.dataUrl.startsWith('data:image/png;base64,'));
  } finally {
    await browser.close();
    site.closeAllConnections();
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});

test('real Chromium sandboxed ?omBridge= iframes deliver om:preview-pick, om:preview-console, and om:preview-capture under CSP', { timeout: 60_000 }, async () => {
  const DESIGN_TOKEN = ['omb', 'design', 'fixture'].join('_');
  const GAME_TOKEN = ['omb', 'game', 'fixture'].join('_');
  const BLANK_TOKEN = ['omb', 'blank', 'fixture'].join('_');
  const site = createServer((req, res) => {
    const url = new URL(req.url!, 'http://local');
    if (url.pathname === '/host') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
        <html>
          <body style="margin:0">
            <iframe id="f-design" sandbox="allow-scripts allow-pointer-lock allow-popups allow-modals" src="/design.html?omBridge=${DESIGN_TOKEN}" style="position:fixed;left:0;top:0;width:400px;height:250px;border:0"></iframe>
            <iframe id="f-drawn" sandbox="allow-scripts allow-pointer-lock allow-popups allow-modals" src="/game-drawn.html?omBridge=${GAME_TOKEN}" style="position:fixed;left:0;top:260px;width:240px;height:180px;border:0"></iframe>
            <iframe id="f-blank" sandbox="allow-scripts allow-pointer-lock allow-popups allow-modals" src="/game-blank.html?omBridge=${BLANK_TOKEN}" style="position:fixed;left:260px;top:260px;width:240px;height:180px;border:0"></iframe>
            <script>
              window.__picked = [];
              window.__console = [];
              window.__captures = {};
              window.addEventListener('message', function(e) {
                var d = e.data;
                if (!d || typeof d !== 'object') return;
                if (d.type === 'om:preview-pick') window.__picked.push(d);
                if (d.type === 'om:preview-console') window.__console.push(d);
                if (d.type === 'om:preview-capture-result') window.__captures[d.requestId] = d;
              });
            </script>
          </body>
        </html>`);
      return;
    }
    if (url.pathname === '/design.html') {
      const html = `<!doctype html><html><body style="margin:0">
        <button id="play-cta" data-component="HeroCard" data-source-file="src/Hero.tsx" style="position:fixed;left:20px;top:10px;width:140px;height:40px">Play</button>
        <script>console.error('iframe-err'); console.warn('iframe-warn');</script>
      </body></html>`;
      const out = injectPreviewBridgeHtml(html, url.searchParams.get('omBridge') || '');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads',
      });
      res.end(out);
      return;
    }
    if (url.pathname === '/game-drawn.html') {
      const html = `<!doctype html><html><body style="margin:0">
        <canvas id="c" width="200" height="150"></canvas>
        <script>
          const ctx = document.getElementById('c').getContext('2d');
          ctx.fillStyle = '#e11d48';
          ctx.fillRect(0, 0, 200, 150);
        </script>
      </body></html>`;
      const out = injectPreviewBridgeHtml(html, url.searchParams.get('omBridge') || '');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "sandbox allow-scripts allow-pointer-lock allow-popups allow-modals; worker-src 'none'",
      });
      res.end(out);
      return;
    }
    if (url.pathname === '/game-blank.html') {
      const html = `<!doctype html><html><body style="margin:0"><canvas id="blank" width="200" height="150"></canvas></body></html>`;
      const out = injectPreviewBridgeHtml(html, url.searchParams.get('omBridge') || '');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "sandbox allow-scripts allow-pointer-lock allow-popups allow-modals; worker-src 'none'",
      });
      res.end(out);
      return;
    }
    res.writeHead(404).end('Not found');
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const browser = new WorkspaceBrowser(process.cwd());
  try {
    const tab = await browser.open('session-bridge-e2e', 'tab-bridge', `${base}/host`, { width: 800, height: 600, dpr: 1 });
    await tab.page.waitForFunction(() => {
      const logs = (window as any).__console || [];
      return logs.some((e: any) => e.level === 'error' && String(e.text).includes('iframe-err'))
        && logs.some((e: any) => e.level === 'warn' && String(e.text).includes('iframe-warn'));
    }, { timeout: 10_000 });

    await tab.page.evaluate(token => {
      const frame = document.getElementById('f-design') as HTMLIFrameElement;
      frame.contentWindow?.postMessage({ type: 'om:preview-mode', token, pick: true }, '*');
    }, DESIGN_TOKEN);

    await tab.page.mouse.move(60, 25);
    await tab.page.mouse.click(60, 25);

    await tab.page.waitForFunction(() => ((window as any).__picked || []).length > 0, { timeout: 5_000 });
    const pickedMsg = await tab.page.evaluate(() => (window as any).__picked[0]);
    assert.equal(pickedMsg.element.selector, '#play-cta');
    assert.equal(pickedMsg.element.componentName, 'HeroCard');
    assert.equal(pickedMsg.element.sourceFile, 'src/Hero.tsx');
    assert.ok(pickedMsg.element.styles.display);
    assert.ok(pickedMsg.rect.width >= 130);

    await tab.page.evaluate(([gameToken, blankToken]) => {
      (document.getElementById('f-drawn') as HTMLIFrameElement).contentWindow?.postMessage(
        { type: 'om:preview-capture', token: gameToken, requestId: 'cap-drawn' },
        '*',
      );
      (document.getElementById('f-blank') as HTMLIFrameElement).contentWindow?.postMessage(
        { type: 'om:preview-capture', token: blankToken, requestId: 'cap-blank' },
        '*',
      );
    }, [GAME_TOKEN, BLANK_TOKEN]);

    await tab.page.waitForFunction(() => {
      const c = (window as any).__captures || {};
      return 'cap-drawn' in c && 'cap-blank' in c;
    }, { timeout: 5_000 });
    const captures = await tab.page.evaluate(() => (window as any).__captures);
    assert.ok(String(captures['cap-drawn'].dataUrl).startsWith('data:image/png;base64,'));
    assert.equal(captures['cap-blank'].dataUrl, null);
  } finally {
    await browser.close();
    site.closeAllConnections();
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});
