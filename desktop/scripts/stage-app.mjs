import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesktopIcons } from './build-icons.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const defaultRepoRoot = path.resolve(desktopDir, '..');

export const RUNTIME_ROOT_FILES = [
  'package.json',
  'package-lock.json',
  'LICENSE',
  'server.ts',
  'mcp.ts',
  'mcp-tools.ts',
  'phase1.ts',
  'phase1-versions.ts',
  'workspace.ts',
  'preview.ts',
  'browser.ts',
  'editor-runtime.ts',
  'editor-server.ts',
  'hyperframes.ts',
  'project-archive.ts',
  'project-management.ts',
  'design-projects.ts',
  'game-projects.ts',
  'review-comments.ts',
  'project-asset-names.ts',
  'inline-video.ts',
  'template-library.ts',
  'template-catalog.ts',
  'prism-templates.ts',
  '.mcp.json',
  'docs/readme/opendesign-symbol.svg',
  'docs/readme/opendesign-symbol-dark.svg',
];

export const RUNTIME_DIRECTORIES = [
  'shared',
  'gateway',
  'tracking',
  'scripts',
  'skills',
  'library',
  'web',
  'templates',
  'template-library',
  'packages/design-system',
  'packages/motion-package',
  'mcp-ui/storyboard',
  'mcp-ui/template-recommendations/build',
  'mcp-ui/template-recommendations/assets',
  'mcp-ui/template-recommendations/project-previews',
  'studio/public',
  '.codex-plugin',
];

function shouldIncludePath(srcPath) {
  const base = path.basename(srcPath);
  if (base === 'node_modules' || base === '.git' || base === '__tests__') return false;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base)) return false;
  return true;
}

export function stageDesktopApp({
  repoRoot = defaultRepoRoot,
  targetDir = path.join(desktopDir, 'resources', 'app-server'),
  copyNodeModules = true,
  allowMissingStudioBuild = false,
} = {}) {
  const studioBuildSrc = path.join(repoRoot, 'studio', 'build');
  if (!allowMissingStudioBuild && !existsSync(path.join(studioBuildSrc, 'index.html'))) {
    throw new Error('studio/build/index.html is missing. Run `npm run build:studio` before staging desktop resources.');
  }

  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  const copied = [];

  for (const file of RUNTIME_ROOT_FILES) {
    const src = path.join(repoRoot, file);
    if (!existsSync(src)) continue;
    const dest = path.join(targetDir, file);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest);
    copied.push(file);
  }

  for (const dir of RUNTIME_DIRECTORIES) {
    const src = path.join(repoRoot, dir);
    if (!existsSync(src)) continue;
    const dest = path.join(targetDir, dir);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true, filter: shouldIncludePath });
    copied.push(dir);
  }

  if (existsSync(studioBuildSrc)) {
    const includeMaps = process.env.MOTION_DESKTOP_INCLUDE_MAPS === '1';
    const dest = path.join(targetDir, 'studio', 'build');
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(studioBuildSrc, dest, {
      recursive: true,
      filter: srcPath => includeMaps || !srcPath.endsWith('.map'),
    });
    copied.push('studio/build');
  }

  if (copyNodeModules) {
    const nmSrc = path.join(repoRoot, 'node_modules');
    const nmDest = path.join(targetDir, 'node_modules');
    if (existsSync(nmSrc)) {
      if (process.env.MOTION_DESKTOP_SYMLINK_NM === '1') {
        if (!existsSync(nmDest) || lstatSync(nmDest).isSymbolicLink()) {
          symlinkSync(nmSrc, nmDest, 'dir');
        }
      } else {
        cpSync(nmSrc, nmDest, {
          recursive: true,
          dereference: true,
          filter: entry => !entry.endsWith(`${path.sep}.cache`),
        });
      }
      copied.push('node_modules');
    }
  }

  buildDesktopIcons({
    sourceDir: path.join(repoRoot, 'packages', 'design-system', 'brand'),
    outDir: path.join(path.resolve(targetDir, '..', '..'), 'build'),
  });

  return { targetDir, copied };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const skipNm = process.argv.includes('--without-node-modules');
  const allowMissingStudio = process.argv.includes('--allow-missing-studio-build');
  const result = stageDesktopApp({
    copyNodeModules: !skipNm,
    allowMissingStudioBuild: allowMissingStudio,
  });
  console.log(`Staged ${result.copied.length} runtime entries into ${result.targetDir}`);
}
