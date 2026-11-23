import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDesktopIcons } from './build-icons.mjs';

const __filename = fileURLToPath(import.meta.url);
const desktopDir = path.resolve(path.dirname(__filename), '..');
const repoRoot = path.resolve(desktopDir, '..');
const require = createRequire(import.meta.url);

async function loadEsbuild() {
  const candidates = [
    path.join(repoRoot, 'node_modules', 'esbuild', 'lib', 'main.js'),
    path.join(desktopDir, 'node_modules', 'esbuild', 'lib', 'main.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return await import(pathToFileURL(candidate).href);
    }
  }
  return await import(require.resolve('esbuild', { paths: [repoRoot, desktopDir] }));
}

export async function buildDesktop() {
  const esbuild = await loadEsbuild();
  const distDir = path.join(desktopDir, 'dist');
  const distBrandDir = path.join(distDir, 'brand');
  mkdirSync(distDir, { recursive: true });
  mkdirSync(distBrandDir, { recursive: true });

  await Promise.all([
    esbuild.build({
      entryPoints: [path.join(desktopDir, 'src', 'main.ts')],
      outfile: path.join(distDir, 'main.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: true,
      external: ['electron', 'electron-updater'],
      banner: {
        js: "import { createRequire as __desktopCreateRequire } from 'node:module'; const require = __desktopCreateRequire(import.meta.url);",
      },
    }),
    esbuild.build({
      entryPoints: [path.join(desktopDir, 'src', 'preload.ts')],
      outfile: path.join(distDir, 'preload.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      sourcemap: true,
      external: ['electron'],
    }),
  ]);

  copyFileSync(
    path.join(desktopDir, 'src', 'splash.html'),
    path.join(distDir, 'splash.html'),
  );

  const brandSourceDir = path.join(repoRoot, 'packages', 'design-system', 'brand');
  for (const asset of ['loading-mark.svg', 'loading-wordmark.svg', 'openmotion-logo.svg', 'apple-touch-icon.png']) {
    const src = path.join(brandSourceDir, asset);
    if (existsSync(src)) {
      copyFileSync(src, path.join(distBrandDir, asset));
    }
  }

  const icons = buildDesktopIcons({
    sourceDir: brandSourceDir,
    outDir: path.join(desktopDir, 'build'),
  });
  if (existsSync(icons.iconPng)) {
    copyFileSync(icons.iconPng, path.join(distBrandDir, 'app-icon.png'));
  }

  return { distDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  await buildDesktop();
  console.log('Built desktop main and preload bundles into desktop/dist');
}
