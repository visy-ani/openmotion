import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '..');
const buildDir = path.join(desktopDir, 'build');

function extractBrandSymbolPaths(sourceSvgPath) {
  const raw = readFileSync(sourceSvgPath, 'utf8');
  const matches = [...raw.matchAll(/<path[^>]*d="([^"]+)"/g)].map(m => m[1]);
  if (matches.length < 2) {
    throw new Error(`Expected 2 symbol paths in ${sourceSvgPath}, found ${matches.length}`);
  }
  return { ringPath: matches[0], arrowPath: matches[1] };
}

export function buildAppIconSvg(sourceSvgPath) {
  const { ringPath, arrowPath } = extractBrandSymbolPaths(sourceSvgPath);
  // 291x291 symbol scaled by 1.62 -> ~471px centered inside 824x824 squircle on 1024x1024 canvas.
  const symbolScale = 1.62;
  const symbolSize = 291 * symbolScale;
  const offset = (1024 - symbolSize) / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none">
  <defs>
    <linearGradient id="squircle-bg" x1="180" y1="100" x2="860" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#25272b"/>
      <stop offset="55%" stop-color="#18191c"/>
      <stop offset="100%" stop-color="#0f1012"/>
    </linearGradient>
    <radialGradient id="emerald-aura" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(568 456) rotate(130) scale(410)">
      <stop offset="0%" stop-color="#00ff08" stop-opacity="0.22"/>
      <stop offset="58%" stop-color="#007106" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#007106" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim-highlight" x1="512" y1="100" x2="512" y2="924" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.24"/>
      <stop offset="35%" stop-color="#ffffff" stop-opacity="0.07"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.03"/>
    </linearGradient>
    <linearGradient id="ring-ink" x1="0" y1="0" x2="291" y2="291" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#e6e8e4"/>
    </linearGradient>
    <linearGradient id="arrow-ink" x1="88" y1="90" x2="220" y2="220" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#58ff5e"/>
      <stop offset="100%" stop-color="#00e608"/>
    </linearGradient>
    <filter id="drop-shadow" x="60" y="72" width="904" height="912" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="22" stdDeviation="20" flood-color="#000000" flood-opacity="0.42"/>
    </filter>
  </defs>
  <g filter="url(#drop-shadow)">
    <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#squircle-bg)"/>
    <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#emerald-aura)"/>
    <rect x="101.5" y="101.5" width="821" height="821" rx="184.5" stroke="url(#rim-highlight)" stroke-width="3"/>
  </g>
  <g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${symbolScale})">
    <path fill-rule="evenodd" clip-rule="evenodd" d="${ringPath}" fill="url(#ring-ink)"/>
    <path d="${arrowPath}" fill="url(#arrow-ink)"/>
  </g>
</svg>
`;
}

function resolveElectronBinary() {
  const electronPkgDir = path.join(desktopDir, 'node_modules', 'electron');
  const pathTxt = path.join(electronPkgDir, 'path.txt');
  if (!existsSync(pathTxt)) return null;
  const rel = readFileSync(pathTxt, 'utf8').trim();
  const full = path.join(electronPkgDir, 'dist', rel);
  return existsSync(full) ? full : null;
}

function rasterizeSvgViaElectron(svgPath, outPngPath, size = 1024) {
  const electronBin = resolveElectronBinary();
  if (!electronBin) return false;

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'om-icon-render-'));
  try {
    const svgBase64 = readFileSync(svgPath).toString('base64');
    const runnerPath = path.join(tempDir, 'render-icon.cjs');
    const runnerSource = `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
app.commandLine.appendSwitch('headless');
app.dock?.hide?.();
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 128,
      height: 128,
      show: false,
      transparent: true,
      webPreferences: { offscreen: true, contextIsolation: true },
    });
    const html = \`<!doctype html><html><body style="margin:0;background:transparent">
      <script>
        window.__renderSvg = async (b64, size) => {
          const img = new Image();
          img.src = 'data:image/svg+xml;base64,' + b64;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, size, size);
          ctx.drawImage(img, 0, 0, size, size);
          return canvas.toDataURL('image/png');
        };
      </script></body></html>\`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const dataUrl = await win.webContents.executeJavaScript(
      'window.__renderSvg(' + JSON.stringify(${JSON.stringify(svgBase64)}) + ', ' + ${size} + ')'
    );
    const pngBase64 = dataUrl.replace(/^data:image\\/png;base64,/, '');
    fs.writeFileSync(${JSON.stringify(outPngPath)}, Buffer.from(pngBase64, 'base64'));
    win.destroy();
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
`;
    writeFileSync(runnerPath, runnerSource, 'utf8');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const res = spawnSync(electronBin, [runnerPath], { env, stdio: 'pipe', timeout: 20_000 });
    return res.status === 0 && existsSync(outPngPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function packPngFramesAsIco(frames) {
  const count = frames.length;
  const headerSize = 6;
  const entrySize = 16;
  let offset = headerSize + count * entrySize;
  const directory = [];
  for (const frame of frames) {
    const entry = Buffer.alloc(entrySize);
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 0);
    entry.writeUInt8(frame.size >= 256 ? 0 : frame.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(frame.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    directory.push(entry);
    offset += frame.data.length;
  }
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  return Buffer.concat([header, ...directory, ...frames.map(f => f.data)]);
}

function buildIcnsAndIcoFromPng(masterPngPath, outDir) {
  const icnsPath = path.join(outDir, 'icon.icns');
  const icoPath = path.join(outDir, 'icon.ico');
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'om-icon-pack-'));

  try {
    if (process.platform === 'darwin') {
      const iconsetDir = path.join(tempDir, 'icon.iconset');
      mkdirSync(iconsetDir, { recursive: true });
      const specs = [
        [16, 'icon_16x16.png'],
        [32, 'icon_16x16@2x.png'],
        [32, 'icon_32x32.png'],
        [64, 'icon_32x32@2x.png'],
        [128, 'icon_128x128.png'],
        [256, 'icon_128x128@2x.png'],
        [256, 'icon_256x256.png'],
        [512, 'icon_256x256@2x.png'],
        [512, 'icon_512x512.png'],
        [1024, 'icon_512x512@2x.png'],
      ];
      for (const [px, filename] of specs) {
        spawnSync('sips', ['-z', String(px), String(px), masterPngPath, '--out', path.join(iconsetDir, filename)], {
          stdio: 'ignore',
        });
      }
      const icnsRes = spawnSync('iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath], {
        stdio: 'ignore',
      });
      if (icnsRes.status !== 0 && existsSync(icnsPath)) {
        rmSync(icnsPath, { force: true });
      }

      const icoSizes = [16, 32, 48, 64, 128, 256];
      const frames = [];
      for (const px of icoSizes) {
        const framePath = path.join(tempDir, `ico-${px}.png`);
        const res = spawnSync('sips', ['-z', String(px), String(px), masterPngPath, '--out', framePath], {
          stdio: 'ignore',
        });
        if (res.status === 0 && existsSync(framePath)) {
          frames.push({ size: px, data: readFileSync(framePath) });
        }
      }
      if (frames.length > 0) {
        writeFileSync(icoPath, packPngFramesAsIco(frames));
      }
    } else {
      const pngData = readFileSync(masterPngPath);
      writeFileSync(icoPath, packPngFramesAsIco([{ size: 256, data: pngData }]));
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    iconIcns: existsSync(icnsPath) ? icnsPath : null,
    iconIco: existsSync(icoPath) ? icoPath : null,
  };
}

export function buildDesktopIcons({
  sourceDir = path.join(repoRoot, 'packages', 'design-system', 'brand'),
  outDir = buildDir,
} = {}) {
  mkdirSync(outDir, { recursive: true });
  const sourceMarkSvg = path.join(sourceDir, 'loading-mark.svg');
  const fallbackPng = path.join(sourceDir, 'apple-touch-icon.png');
  const targetPng = path.join(outDir, 'icon.png');
  const targetSvg = path.join(outDir, 'icon.svg');

  if (existsSync(sourceMarkSvg)) {
    writeFileSync(targetSvg, buildAppIconSvg(sourceMarkSvg), 'utf8');
  }

  const rasterized = existsSync(targetSvg) ? rasterizeSvgViaElectron(targetSvg, targetPng, 1024) : false;
  if (!rasterized) {
    if (!existsSync(fallbackPng)) {
      throw new Error(`Missing source icon: ${fallbackPng}`);
    }
    copyFileSync(fallbackPng, targetPng);
    if (process.platform === 'darwin') {
      spawnSync('sips', ['-z', '1024', '1024', targetPng, '--out', targetPng], {
        stdio: 'ignore',
      });
    }
  }

  const { iconIcns, iconIco } = buildIcnsAndIcoFromPng(targetPng, outDir);

  return { iconPng: targetPng, iconSvg: targetSvg, iconIcns, iconIco };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildDesktopIcons();
  console.log(`Prepared desktop icons: png=${result.iconPng} icns=${result.iconIcns ?? 'n/a'} ico=${result.iconIco ?? 'n/a'}`);
}
