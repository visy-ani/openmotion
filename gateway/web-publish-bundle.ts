import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WebPublishTargetKind } from '../shared/web-publish.ts';
import { WorkspaceStore } from '../workspace.ts';
import { AssetLibrary } from './asset-library.ts';

export const MAX_PUBLISH_FILES = 500;
export const MAX_PUBLISH_BYTES = 50 * 1024 * 1024;

const EXCLUDED_NAMES = new Set([
  'node_modules',
  '.git',
  '.file-versions',
  '.live-artifacts',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.aws',
  '.ssh',
  '.azure',
  '.docker',
  '.gnupg',
  '.kube',
  '.pulumi',
  '.terraform',
  '.git-credentials',
  '.netrc',
  '.pypirc',
]);

const REWRITABLE_TEXT_FILE = /\.(?:html?|css|m?js|cjs|json|svg|webmanifest)$/i;
const ASSET_MEDIA_REF = /(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)?\/(?:motion-api|api)\/assets\/([A-Za-z0-9_-]+)\/versions\/([A-Za-z0-9_-]+)\/(?:file|media)(?:\?[^"'`\s)\\]*)?/g;
const GAME_PLAY_REF = /(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)?\/(?:motion-api|api)\/games\/([^/]+)\/play\/([^"'`\s)\\?#]+(?:\?[^"'`\s)\\#]*)?(?:#[^"'`\s)\\]*)?)/g;
const DESIGN_RAW_REF = /(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?)?\/(?:motion-api|api)\/design\/raw\/([^/]+)\/([^"'`\s)\\?#]+(?:\?[^"'`\s)\\#]*)?(?:#[^"'`\s)\\]*)?)/g;

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
};

export interface StagedPublishFile {
  file: string;
  data: Buffer;
}

export interface PublishBundle {
  kind: WebPublishTargetKind;
  targetId: string;
  entryPath: string;
  files: StagedPublishFile[];
  fileCount: number;
  totalBytes: number;
  bundledAssetCount: number;
  contentFingerprint: string;
}

function relativePosixPath(fromFilePath: string, targetFilePath: string): string {
  const dir = path.posix.dirname(fromFilePath);
  const rel = path.posix.relative(dir === '.' ? '' : dir, targetFilePath);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

async function collectSourceFiles(
  sourcePath: string,
  entryPath: string,
  kind: WebPublishTargetKind,
): Promise<Array<{ path: string; data: Buffer }>> {
  const resolvedRoot = path.resolve(sourcePath);
  const rootInfo = await lstat(resolvedRoot).catch(() => null);
  if (!rootInfo) {
    throw new Error(`NOT_FOUND: Publish source "${sourcePath}" does not exist`);
  }
  if (rootInfo.isSymbolicLink()) {
    throw new Error(`INVALID_ARGUMENT: Symlinks cannot be published (${sourcePath})`);
  }

  if (rootInfo.isFile()) {
    if (!/\.html?$/i.test(resolvedRoot)) {
      throw new Error('INVALID_ARGUMENT: Single-file web publishing requires an .html or .htm file');
    }
    if (rootInfo.size > MAX_PUBLISH_BYTES) {
      throw new Error(`INVALID_ARGUMENT: Publication exceeds ${MAX_PUBLISH_BYTES / (1024 * 1024)} MiB limit`);
    }
    return [{ path: entryPath, data: await readFile(resolvedRoot) }];
  }

  if (!rootInfo.isDirectory()) {
    throw new Error(`INVALID_ARGUMENT: Publish source must be a directory or HTML file (${sourcePath})`);
  }

  const results: Array<{ path: string; data: Buffer }> = [];
  let totalBytes = 0;

  async function walk(relDir: string): Promise<void> {
    const absDir = relDir ? path.join(resolvedRoot, relDir) : resolvedRoot;
    const entries = (await readdir(absDir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (EXCLUDED_NAMES.has(entry.name) || entry.name.startsWith('.env') || entry.name.startsWith('.')) {
        continue;
      }
      const relPosix = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (kind === 'game' && (relPosix.toLowerCase() === 'game.json' || relPosix.toLowerCase().startsWith('trailer/'))) {
        continue;
      }
      const absPath = path.join(resolvedRoot, relPosix);
      const info = await lstat(absPath);
      if (info.isSymbolicLink()) {
        throw new Error(`INVALID_ARGUMENT: Symlinks cannot be published (${relPosix})`);
      }
      if (info.isDirectory()) {
        await walk(relPosix);
        continue;
      }
      if (!info.isFile()) continue;

      if (results.length >= MAX_PUBLISH_FILES) {
        throw new Error(`INVALID_ARGUMENT: Publication exceeds ${MAX_PUBLISH_FILES} files limit`);
      }
      totalBytes += info.size;
      if (totalBytes > MAX_PUBLISH_BYTES) {
        throw new Error(`INVALID_ARGUMENT: Publication exceeds ${MAX_PUBLISH_BYTES / (1024 * 1024)} MiB limit`);
      }
      results.push({ path: relPosix, data: await readFile(absPath) });
    }
  }

  await walk('');
  if (!results.some(item => item.path === entryPath)) {
    throw new Error(`NOT_FOUND: Entry HTML file "${entryPath}" does not exist in source`);
  }
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/**
 * Builds an in-memory self-contained bundle for web publishing:
 * - Rewrites `/motion-api/assets/<id>/versions/<vid>/media` URLs into `_shared-assets/...`
 *   using bytes from Workspace `AssetLibrary` without mutating source files on disk.
 * - Rewrites same-project `/motion-api/games/<id>/play/...` and `/motion-api/design/raw/<id>/...`
 *   URLs into relative POSIX paths.
 * - Computes a deterministic SHA-256 content fingerprint over the final bundle tree.
 */
export async function buildPublishBundle(input: {
  dataDirectory: string;
  kind: WebPublishTargetKind;
  targetId: string;
  sourcePath: string;
  entryPath: string;
}): Promise<PublishBundle> {
  const rawFiles = await collectSourceFiles(input.sourcePath, input.entryPath, input.kind);

  let assetLibrary: AssetLibrary | null = null;
  const getAssetLibrary = () => {
    if (!assetLibrary) {
      assetLibrary = new AssetLibrary(new WorkspaceStore(input.dataDirectory));
    }
    return assetLibrary;
  };

  const bundledAssets = new Map<string, StagedPublishFile>();
  const knownPaths = new Set(rawFiles.map(f => f.path));
  let totalBytes = rawFiles.reduce((sum, f) => sum + f.data.length, 0);

  const resolveBundledAssetPath = async (assetId: string, versionId: string): Promise<string | null> => {
    const key = `${assetId}/${versionId}`;
    const existing = bundledAssets.get(key);
    if (existing) return existing.file;

    let resolved;
    try {
      resolved = await getAssetLibrary().resolve({ assetId, versionId });
    } catch {
      return null;
    }
    const bytes = await readFile(resolved.filename).catch(() => null);
    if (!bytes) return null;

    totalBytes += bytes.length;
    if (rawFiles.length + bundledAssets.size >= MAX_PUBLISH_FILES || totalBytes > MAX_PUBLISH_BYTES) {
      throw new Error(`INVALID_ARGUMENT: Bundled publication exceeds ${MAX_PUBLISH_BYTES / (1024 * 1024)} MiB limit`);
    }

    const rawExt = path.extname(resolved.version.filename || '') || MIME_EXTENSIONS[resolved.version.mimeType || ''] || '';
    const safeExt = /^\.[A-Za-z0-9]{1,10}$/.test(rawExt) ? rawExt.toLowerCase() : '';
    let targetPath = `_shared-assets/${assetId}-${versionId}${safeExt}`;
    let collisionIndex = 1;
    while (knownPaths.has(targetPath)) {
      targetPath = `_shared-assets/${assetId}-${versionId}-${collisionIndex++}${safeExt}`;
    }
    knownPaths.add(targetPath);
    bundledAssets.set(key, { file: targetPath, data: bytes });
    return targetPath;
  };

  const stagedFiles: StagedPublishFile[] = [];
  for (const file of rawFiles) {
    if (!REWRITABLE_TEXT_FILE.test(file.path)) {
      stagedFiles.push({ file: file.path, data: file.data });
      continue;
    }
    let text = file.data.toString('utf8');

    const assetMatches = [...text.matchAll(ASSET_MEDIA_REF)];
    if (assetMatches.length > 0) {
      const replacements = new Map<string, string>();
      for (const match of assetMatches) {
        const full = match[0];
        if (replacements.has(full)) continue;
        const bundledPath = await resolveBundledAssetPath(match[1], match[2]);
        if (bundledPath) {
          replacements.set(full, relativePosixPath(file.path, bundledPath));
        }
      }
      if (replacements.size > 0) {
        text = text.replace(ASSET_MEDIA_REF, matched => replacements.get(matched) ?? matched);
      }
    }

    if (input.kind === 'game') {
      text = text.replace(GAME_PLAY_REF, (matched, rawGameId: string, relSuffix: string) => {
        try {
          if (decodeURIComponent(rawGameId) !== input.targetId) return matched;
        } catch {
          return matched;
        }
        const cleanTarget = relSuffix.replace(/[?#].*$/, '');
        const suffix = relSuffix.slice(cleanTarget.length);
        return `${relativePosixPath(file.path, cleanTarget)}${suffix}`;
      });
    } else if (input.kind === 'design') {
      text = text.replace(DESIGN_RAW_REF, (matched, rawDesignId: string, relSuffix: string) => {
        try {
          if (decodeURIComponent(rawDesignId) !== input.targetId) return matched;
        } catch {
          return matched;
        }
        const cleanTarget = relSuffix.replace(/[?#].*$/, '');
        const suffix = relSuffix.slice(cleanTarget.length);
        return `${relativePosixPath(file.path, cleanTarget)}${suffix}`;
      });
    }

    const nextBuf = Buffer.from(text, 'utf8');
    totalBytes += nextBuf.length - file.data.length;
    if (totalBytes > MAX_PUBLISH_BYTES) {
      throw new Error(`INVALID_ARGUMENT: Publication exceeds ${MAX_PUBLISH_BYTES / (1024 * 1024)} MiB limit`);
    }
    stagedFiles.push({ file: file.path, data: nextBuf });
  }

  for (const bundled of bundledAssets.values()) {
    stagedFiles.push(bundled);
  }
  stagedFiles.sort((a, b) => a.file.localeCompare(b.file));

  const hash = createHash('sha256');
  for (const file of stagedFiles) {
    const digest = createHash('sha256').update(file.data).digest('hex');
    hash.update(`${file.file}:${digest}\n`);
  }

  return {
    kind: input.kind,
    targetId: input.targetId,
    entryPath: input.entryPath,
    files: stagedFiles,
    fileCount: stagedFiles.length,
    totalBytes,
    bundledAssetCount: bundledAssets.size,
    contentFingerprint: hash.digest('hex'),
  };
}

/**
 * Stages files into a fresh temporary directory using exclusive (`wx`) writes
 * and verifies filesystem inode identity to reject path escapes or symlink aliasing.
 */
export async function stagePublishFiles(directory: string, files: readonly StagedPublishFile[]): Promise<void> {
  const directories = new Map<string, string>();
  const checkedPaths = new Set<string>();
  for (const file of files) {
    const target = path.resolve(directory, file.file);
    const relative = path.relative(directory, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('INVALID_ARGUMENT: Staged publish file escapes temporary directory');
    }
    const parts = relative.split(path.sep);
    let parent = directory;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      if (checkedPaths.has(parent)) continue;
      await mkdir(parent, { recursive: true });
      const identity = await stat(parent);
      const key = `${identity.dev}:${identity.ino}`;
      const previous = directories.get(key);
      if (previous !== undefined && previous !== parent) {
        throw new Error('DEPLOY_FAILED: Filesystem could not preserve distinct publish paths');
      }
      directories.set(key, parent);
      checkedPaths.add(parent);
    }
    await writeFile(target, file.data, { flag: 'wx' });
  }
}
