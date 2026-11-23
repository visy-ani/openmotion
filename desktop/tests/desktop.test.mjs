import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveDesktopChrome } from '../../shared/platform-host.ts';
import { buildAppIconSvg, packPngFramesAsIco } from '../scripts/build-icons.mjs';
import { stageDesktopApp } from '../scripts/stage-app.mjs';
import { DesktopLogger, redactDesktopText } from '../src/logger.ts';
import { buildDesktopMenuTemplate, DOCS_URL, RELEASES_URL, REPORT_ISSUE_URL } from '../src/menu.ts';
import { augmentDesktopPath, resolveSidecarRuntimeBinary } from '../src/sidecar.ts';
import {
  buildMainWindowOptions,
  getWindowsTitleBarOverlay,
  normalizeDesktopPlatform,
} from '../src/platform.ts';
import { compareSemver, DesktopUpdaterController, resolveElectronAutoUpdater } from '../src/updater.ts';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('resolveDesktopChrome computes safe insets across macOS, Windows, and Linux', () => {
  const macWindowed = resolveDesktopChrome({ platform: 'darwin', fullscreen: false });
  assert.equal(macWindowed.titleBarStyle, 'hiddenInset');
  assert.equal(macWindowed.insetLeft, 78);
  assert.equal(macWindowed.insetRight, 0);
  assert.equal(macWindowed.customWindowControls, false);

  const macFullscreen = resolveDesktopChrome({ platform: 'darwin', fullscreen: true });
  assert.equal(macFullscreen.insetLeft, 0);

  const winWindowed = resolveDesktopChrome({ platform: 'win32', fullscreen: false, maximized: true });
  assert.equal(winWindowed.titleBarStyle, 'hiddenOverlay');
  assert.equal(winWindowed.insetLeft, 0);
  assert.equal(winWindowed.insetRight, 138);
  assert.equal(winWindowed.maximized, true);

  const winFullscreen = resolveDesktopChrome({ platform: 'win32', fullscreen: true });
  assert.equal(winFullscreen.insetRight, 0);

  const linuxCustom = resolveDesktopChrome({ platform: 'linux', fullscreen: false });
  assert.equal(linuxCustom.titleBarStyle, 'custom');
  assert.equal(linuxCustom.customWindowControls, true);
  assert.equal(linuxCustom.insetRight, 132);

  const linuxNative = resolveDesktopChrome({ platform: 'linux', linuxCustomTitleBar: false });
  assert.equal(linuxNative.titleBarStyle, 'native');
  assert.equal(linuxNative.customWindowControls, false);
  assert.equal(linuxNative.insetRight, 0);
});

test('buildMainWindowOptions enforces hardened preload and OS title bar chrome', () => {
  const mac = buildMainWindowOptions({
    platform: 'darwin',
    theme: 'dark',
    preloadPath: '/app/preload.cjs',
  });
  assert.equal(mac.titleBarStyle, 'hiddenInset');
  assert.deepEqual(mac.trafficLightPosition, { x: 16, y: 15 });
  assert.equal(mac.webPreferences?.contextIsolation, true);
  assert.equal(mac.webPreferences?.nodeIntegration, false);
  assert.equal(mac.webPreferences?.sandbox, true);

  const winLight = buildMainWindowOptions({
    platform: 'win32',
    theme: 'light',
    preloadPath: '/app/preload.cjs',
  });
  assert.equal(winLight.titleBarStyle, 'hidden');
  assert.deepEqual(winLight.titleBarOverlay, getWindowsTitleBarOverlay('light'));

  const linux = buildMainWindowOptions({
    platform: 'linux',
    linuxCustomTitleBar: true,
    preloadPath: '/app/preload.cjs',
  });
  assert.equal(linux.frame, false);
  assert.equal(normalizeDesktopPlatform('freebsd'), 'linux');
});

test('DesktopLogger redacts credentials/paths, rotates logs, and records crash markers', () => {
  const logDir = path.join(os.tmpdir(), `om-desktop-log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  try {
    const sampleHome = path.join(os.tmpdir(), 'custom-user-home');
    const redacted = redactDesktopText(
      `Bearer secret-jwt-token-value om_mcp_1234567890abcdef ${path.join(sampleHome, 'project')}`,
      [sampleHome],
    );
    assert.equal(redacted.includes('secret-jwt-token-value'), false);
    assert.equal(redacted.includes('1234567890abcdef'), false);
    assert.equal(redacted.includes('custom-user-home'), false);
    assert.ok(redacted.includes('<REDACTED_PATH>'));

    const logger = new DesktopLogger({
      logDir,
      maxBytes: 180,
      maxFiles: 2,
      redactPaths: [sampleHome],
    });
    logger.markSessionStarted({ version: '1.2.3', platform: 'darwin', arch: 'arm64' });

    for (let i = 0; i < 12; i++) {
      logger.info('main', `Entry ${i} token=om_brg_abcdefghijklmnop`);
    }
    assert.ok(existsSync(path.join(logDir, 'main.log')));
    assert.ok(existsSync(path.join(logDir, 'main.log.1')));
    const mainContent = readFileSync(path.join(logDir, 'main.log'), 'utf8');
    assert.equal(mainContent.includes('abcdefghijklmnop'), false);

    // Simulating a second boot while active=true triggers crash-marker creation.
    logger.markSessionStarted({ version: '1.2.3', platform: 'darwin', arch: 'arm64' });
    assert.ok(existsSync(path.join(logDir, 'crash-marker.json')));
    const marker = JSON.parse(readFileSync(path.join(logDir, 'crash-marker.json'), 'utf8'));
    assert.equal(marker.reason, 'unclean-previous-exit');

    logger.markSessionEnded('clean-exit');
    const session = JSON.parse(readFileSync(path.join(logDir, 'session-state.json'), 'utf8'));
    assert.equal(session.active, false);
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('buildDesktopMenuTemplate wires Check Updates, Export Logs, Report Issue, and Community actions without restricted links', () => {
  const actions = [];
  const urls = [];

  for (const platform of ['darwin', 'win32', 'linux']) {
    actions.length = 0;
    urls.length = 0;
    const template = buildDesktopMenuTemplate({
      platform,
      appVersion: '0.1.0',
      onAction: action => actions.push(action),
      onOpenUrl: url => urls.push(url),
    });

    const flatItems = template.flatMap(group =>
      Array.isArray(group.submenu) ? group.submenu : [],
    );
    const findLabel = needle =>
      flatItems.find(item => typeof item.label === 'string' && item.label.includes(needle));

    assert.ok(findLabel('Check for Updates'), `Missing updates menu on ${platform}`);
    assert.ok(findLabel('Export Diagnostic Logs'), `Missing export logs menu on ${platform}`);
    assert.ok(findLabel('Report an Issue'), `Missing report issue menu on ${platform}`);
    assert.ok(findLabel('Feishu'), `Missing Feishu community menu on ${platform}`);
    assert.ok(findLabel('Discord'), `Missing Discord community menu on ${platform}`);

    findLabel('Check for Updates')?.click?.({}, undefined, {});
    findLabel('Export Diagnostic Logs')?.click?.({}, undefined, {});
    findLabel('Feishu')?.click?.({}, undefined, {});
    findLabel('Report an Issue')?.click?.({}, undefined, {});
    findLabel('Documentation')?.click?.({}, undefined, {});
    findLabel("What's New")?.click?.({}, undefined, {});

    assert.deepEqual(actions, ['check-updates', 'export-logs', 'join-community-feishu']);
    assert.deepEqual(urls, [REPORT_ISSUE_URL, DOCS_URL, RELEASES_URL]);
  }

  // Ensure desktop source never embeds external Feishu links directly.
  const menuSource = readFileSync(path.join(desktopRoot, 'src', 'menu.ts'), 'utf8');
  assert.equal(menuSource.includes('feishu.cn'), false);
});

test('buildDesktopMenuTemplate binds CmdOrCtrl+W minimize, CmdOrCtrl+M hide, and CmdOrCtrl+Q confirmed quit across platforms', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    let minimizeCount = 0;
    let hideCount = 0;
    let quitCount = 0;
    const template = buildDesktopMenuTemplate({
      platform,
      appVersion: '0.1.0',
      onAction: () => {},
      onOpenUrl: () => {},
      onMinimizeWindow: () => {
        minimizeCount += 1;
      },
      onHideApp: () => {
        hideCount += 1;
      },
      onRequestQuit: () => {
        quitCount += 1;
      },
    });

    const flatItems = template.flatMap(group =>
      Array.isArray(group.submenu) ? group.submenu : [],
    );

    const byAccel = accel => flatItems.filter(item => item.accelerator === accel);
    assert.equal(byAccel('CmdOrCtrl+W').length, 1, `Expected single CmdOrCtrl+W binding on ${platform}`);
    assert.equal(byAccel('CmdOrCtrl+M').length, 1, `Expected single CmdOrCtrl+M binding on ${platform}`);
    assert.equal(byAccel('CmdOrCtrl+Q').length, 1, `Expected single CmdOrCtrl+Q binding on ${platform}`);

    assert.equal(flatItems.some(item => item.role === 'close'), false, `Unexpected close role on ${platform}`);
    assert.equal(flatItems.some(item => item.role === 'minimize'), false, `Unexpected minimize role on ${platform}`);
    assert.equal(flatItems.some(item => item.role === 'quit'), false, `Unexpected quit role on ${platform}`);
    assert.equal(flatItems.some(item => item.role === 'hide'), false, `Unexpected hide role on ${platform}`);

    byAccel('CmdOrCtrl+W')[0].click?.({}, undefined, {});
    byAccel('CmdOrCtrl+M')[0].click?.({}, undefined, {});
    byAccel('CmdOrCtrl+Q')[0].click?.({}, undefined, {});

    assert.equal(minimizeCount, 1, `CmdOrCtrl+W should minimize on ${platform}`);
    assert.equal(hideCount, 1, `CmdOrCtrl+M should hide on ${platform}`);
    assert.equal(quitCount, 1, `CmdOrCtrl+Q should request confirmed quit on ${platform}`);
  }
});

test('DesktopUpdaterController transitions cleanly and stops sidecar before quitAndInstall', async () => {
  const unpackaged = new DesktopUpdaterController({ currentVersion: '0.1.0', isPackaged: false });
  const unsupported = await unpackaged.checkForUpdates();
  assert.equal(unsupported.status, 'unsupported');

  const handlers = new Map();
  let quitAndInstallCalled = false;
  let beforeQuitDone = false;

  const packaged = new DesktopUpdaterController({
    currentVersion: '0.1.0',
    isPackaged: true,
    loadAutoUpdater: async () => ({
      autoDownload: true,
      autoInstallOnAppQuit: true,
      on(event, fn) {
        handlers.set(event, fn);
      },
      async checkForUpdates() {
        handlers.get('checking-for-update')?.();
        handlers.get('update-available')?.({ version: '0.2.0' });
      },
      async downloadUpdate() {
        handlers.get('download-progress')?.({ percent: 55.4 });
        handlers.get('update-downloaded')?.({ version: '0.2.0' });
      },
      quitAndInstall() {
        assert.equal(beforeQuitDone, true, 'Sidecar must stop before quitAndInstall');
        quitAndInstallCalled = true;
      },
    }),
  });

  const avail = await packaged.checkForUpdates();
  assert.equal(avail.status, 'available');
  assert.equal(avail.availableVersion, '0.2.0');

  const downloaded = await packaged.downloadUpdate();
  assert.equal(downloaded.status, 'downloaded');
  assert.equal(downloaded.progress, 100);

  const installRes = await packaged.installUpdateNow(async () => {
    beforeQuitDone = true;
  });
  assert.equal(installRes.ok, true);
  assert.equal(quitAndInstallCalled, true);
});

test('DesktopUpdaterController resolves CJS default autoUpdater export and falls back to GitHub Releases when feed yml is absent', async () => {
  const fakeAutoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on() {},
    async checkForUpdates() {
      throw new Error('HttpError: 404 "Cannot find latest-mac.yml in the latest release artifacts"');
    },
    async downloadUpdate() {},
    quitAndInstall() {},
  };

  // ESM/CJS interop: electron-updater exposes autoUpdater under default when imported from ESM.
  assert.equal(resolveElectronAutoUpdater({ default: { autoUpdater: fakeAutoUpdater } }), fakeAutoUpdater);
  assert.equal(resolveElectronAutoUpdater({ autoUpdater: fakeAutoUpdater }), fakeAutoUpdater);

  assert.equal(compareSemver('v0.2.1', '0.2.1'), 0);
  assert.ok(compareSemver('0.2.2', '0.2.1') > 0);
  assert.ok(compareSemver('0.2.1', '0.2.1-beta.1') > 0);

  const upToDate = new DesktopUpdaterController({
    currentVersion: '0.2.1',
    isPackaged: true,
    loadAutoUpdater: async () => fakeAutoUpdater,
    fetchLatestRelease: async () => ({
      tag_name: 'v0.2.1',
      html_url: 'https://github.com/nexu-io/openmotion/releases/tag/v0.2.1',
    }),
  });
  const resSame = await upToDate.checkForUpdates();
  assert.equal(resSame.status, 'up-to-date');

  let openedUrl = '';
  const hasNewer = new DesktopUpdaterController({
    currentVersion: '0.2.1',
    isPackaged: true,
    loadAutoUpdater: async () => fakeAutoUpdater,
    fetchLatestRelease: async () => ({
      tag_name: 'v0.3.0',
      html_url: 'https://github.com/nexu-io/openmotion/releases/tag/v0.3.0',
    }),
    onOpenReleasePage: url => {
      openedUrl = url;
    },
  });
  const resNewer = await hasNewer.checkForUpdates();
  assert.equal(resNewer.status, 'available');
  assert.equal(resNewer.availableVersion, '0.3.0');
  await hasNewer.downloadUpdate();
  assert.equal(openedUrl, 'https://github.com/nexu-io/openmotion/releases/tag/v0.3.0');
});

test('splash.html contains retry, log export, and WebGL disposal controls and stageDesktopApp stages runtime allowlist', () => {
  const splashHtml = readFileSync(path.join(desktopRoot, 'src', 'splash.html'), 'utf8');
  assert.match(splashHtml, /id="retry-btn"/);
  assert.match(splashHtml, /id="export-logs-btn"/);
  assert.match(splashHtml, /prefers-reduced-motion/);
  assert.match(splashHtml, /function disposePixelScan/);
  assert.match(splashHtml, /WEBGL_lose_context/);
  assert.match(splashHtml, /function teardownSplashResources/);

  const tmpStage = path.join(os.tmpdir(), `om-stage-test-${Date.now()}`);
  const fakeRepo = path.join(tmpStage, 'repo');
  const targetDir = path.join(tmpStage, 'out', 'resources', 'app-server');
  try {
    mkdirSync(path.join(fakeRepo, 'packages', 'design-system', 'brand'), { recursive: true });
    mkdirSync(path.join(fakeRepo, 'studio', 'build', 'editor-assets'), { recursive: true });
    mkdirSync(path.join(fakeRepo, 'shared'), { recursive: true });
    mkdirSync(path.join(fakeRepo, 'gateway'), { recursive: true });
    writeFileSync(path.join(fakeRepo, 'server.ts'), '// server\n');
    writeFileSync(path.join(fakeRepo, 'package.json'), JSON.stringify({ name: 'openmotion' }));
    writeFileSync(path.join(fakeRepo, 'studio', 'build', 'index.html'), '<html></html>');
    writeFileSync(path.join(fakeRepo, 'studio', 'build', 'editor-assets', 'app.js'), 'console.log(1);\n');
    writeFileSync(path.join(fakeRepo, 'studio', 'build', 'editor-assets', 'app.js.map'), '{"version":3}');
    writeFileSync(path.join(fakeRepo, 'shared', 'sample.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(fakeRepo, 'shared', 'sample.test.ts'), 'export const skip = true;\n');
    const sourceIcon = path.resolve(desktopRoot, '..', 'packages', 'design-system', 'brand', 'apple-touch-icon.png');
    writeFileSync(
      path.join(fakeRepo, 'packages', 'design-system', 'brand', 'apple-touch-icon.png'),
      readFileSync(sourceIcon),
    );

    const staged = stageDesktopApp({
      repoRoot: fakeRepo,
      targetDir,
      copyNodeModules: false,
    });
    assert.ok(existsSync(path.join(staged.targetDir, 'server.ts')));
    assert.ok(existsSync(path.join(staged.targetDir, 'studio', 'build', 'index.html')));
    assert.ok(existsSync(path.join(staged.targetDir, 'studio', 'build', 'editor-assets', 'app.js')));
    assert.equal(existsSync(path.join(staged.targetDir, 'studio', 'build', 'editor-assets', 'app.js.map')), false);
    assert.ok(existsSync(path.join(staged.targetDir, 'shared', 'sample.ts')));
    assert.equal(existsSync(path.join(staged.targetDir, 'shared', 'sample.test.ts')), false);
  } finally {
    rmSync(tmpStage, { recursive: true, force: true });
  }
});

test('buildAppIconSvg, packPngFramesAsIco, and augmentDesktopPath produce valid multi-platform outputs', () => {
  const brandSvg = path.resolve(desktopRoot, '..', 'packages', 'design-system', 'brand', 'loading-mark.svg');
  const iconSvg = buildAppIconSvg(brandSvg);
  assert.match(iconSvg, /viewBox="0 0 1024 1024"/);
  assert.match(iconSvg, /#00e608|#58ff5e/);

  const fakePng16 = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]);
  const fakePng256 = Buffer.from([137, 80, 78, 71, 5, 6, 7, 8, 9]);
  const ico = packPngFramesAsIco([
    { size: 16, data: fakePng16 },
    { size: 256, data: fakePng256 },
  ]);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
  assert.equal(ico.readUInt8(6), 16);
  assert.equal(ico.readUInt8(6 + 16), 0);

  const augmented = augmentDesktopPath('/custom/bin');
  assert.ok(augmented.includes('/custom/bin'));
});

test('resolveSidecarRuntimeBinary uses LSUIElement Helper on macOS to prevent duplicate Dock icons', () => {
  const packagedExec = '/Applications/OpenMotion.app/Contents/MacOS/OpenMotion';
  const packagedHelper = '/Applications/OpenMotion.app/Contents/Frameworks/OpenMotion Helper.app/Contents/MacOS/OpenMotion Helper';
  assert.equal(
    resolveSidecarRuntimeBinary({
      platform: 'darwin',
      execPath: packagedExec,
      env: {},
      exists: candidate => candidate === packagedHelper,
    }),
    packagedHelper,
  );

  const devElectron = '/tmp/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
  const devHelper = '/tmp/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper';
  assert.equal(
    resolveSidecarRuntimeBinary({
      platform: 'darwin',
      execPath: devElectron,
      env: {},
      exists: candidate => candidate === devHelper,
    }),
    devHelper,
  );

  // Fallback when Helper binary is absent or running on Windows/Linux.
  assert.equal(
    resolveSidecarRuntimeBinary({
      platform: 'darwin',
      execPath: packagedExec,
      env: {},
      exists: () => false,
    }),
    packagedExec,
  );
  assert.equal(
    resolveSidecarRuntimeBinary({
      platform: 'win32',
      execPath: 'C:\\OpenMotion\\OpenMotion.exe',
      env: {},
      exists: () => true,
    }),
    'C:\\OpenMotion\\OpenMotion.exe',
  );

  // Explicit override wins across all platforms.
  assert.equal(
    resolveSidecarRuntimeBinary({
      platform: 'darwin',
      execPath: packagedExec,
      env: { MOTION_NODE_BINARY: '/usr/local/bin/node' },
      exists: () => true,
    }),
    '/usr/local/bin/node',
  );
});
