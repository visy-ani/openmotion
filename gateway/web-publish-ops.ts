import { createHash } from 'node:crypto';
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { DesignError, designProjectsFor } from '../design-projects.ts';
import { GameError, GameProjects } from '../game-projects.ts';
import {
  webPublishTargetKinds,
  type WebPublishMode,
  type WebPublishTarget,
  type WebPublishTargetKind,
} from '../shared/web-publish.ts';
import type { WorkspaceStore } from '../workspace.ts';
import { webPublishFor, type WebPublishService } from './web-publish.ts';

const SENSITIVE_PATH_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.azure',
  '.docker',
  '.git-credentials',
  '.netrc',
  '.pypirc',
]);

function isValidTargetKind(value: unknown): value is WebPublishTargetKind {
  return typeof value === 'string' && (webPublishTargetKinds as readonly string[]).includes(value);
}

function slugifyIdPart(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/\.html?$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'page'
  );
}

function assertSafeLocalSourcePath(resolved: string): void {
  const segments = resolved.split(path.sep).filter(Boolean);
  if (segments.some(seg => SENSITIVE_PATH_SEGMENTS.has(seg))) {
    throw new Error('INVALID_ARGUMENT: Source path points inside a restricted credential directory');
  }
}

export async function resolveWebPublishTarget(
  store: WorkspaceStore,
  input: {
    targetKind: WebPublishTargetKind;
    targetId?: string;
    sourcePath?: string;
    filePath?: string;
    title?: string;
  },
  origin: string,
): Promise<WebPublishTarget> {
  const rootStore = store.workspaceStore ?? store;
  const rootDir = rootStore.directory;

  if (input.targetKind === 'design') {
    const targetId = input.targetId?.trim();
    if (!targetId) {
      throw new Error('INVALID_ARGUMENT: targetId is required for design targets');
    }
    const project = await designProjectsFor(rootDir).get(targetId, origin);
    return {
      kind: 'design',
      id: project.id,
      title: input.title?.trim() || project.title || project.id,
      entryPath: input.filePath?.trim() || project.entry || 'index.html',
      sourceRevision: project.revision,
      sourcePath: project.path,
    };
  }

  if (input.targetKind === 'game') {
    const targetId = input.targetId?.trim();
    if (!targetId) {
      throw new Error('INVALID_ARGUMENT: targetId is required for game targets');
    }
    const games = new GameProjects(rootDir);
    const [{ dir }, card] = await Promise.all([games.locate(targetId), games.get(targetId)]);
    if (card.external) {
      throw new Error('INVALID_ARGUMENT: External games cannot be published from local workspace files');
    }
    const entryPath = input.filePath?.trim() || 'index.html';
    const entryStat = await stat(path.join(dir, entryPath)).catch(() => null);
    const sourceRevision = `${card.updatedAt}:${entryStat?.size ?? 0}:${entryStat?.mtimeMs ?? 0}`;
    return {
      kind: 'game',
      id: card.id,
      title: input.title?.trim() || card.title || card.id,
      entryPath,
      sourceRevision,
      sourcePath: dir,
      multiplayer: card.multiplayer,
    };
  }

  if (input.targetKind === 'motion') {
    const targetId = input.targetId?.trim();
    if (!targetId) {
      throw new Error('INVALID_ARGUMENT: targetId is required for motion targets');
    }
    const project = rootStore.projectCatalog().projects.find(item => item.id === targetId && !item.trashedAt);
    if (!project) {
      throw new Error(`NOT_FOUND: Motion project "${targetId}" was not found`);
    }
    const scoped = rootStore.forProject(targetId);
    const entryPath = input.filePath?.trim() || 'index.html';
    const entryStat = await stat(path.join(scoped.directory, entryPath)).catch(() => null);
    const sourceRevision = `${project.openedAt ?? project.createdAt ?? 1}:${entryStat?.size ?? 0}:${entryStat?.mtimeMs ?? 0}`;
    return {
      kind: 'motion',
      id: project.id,
      title: input.title?.trim() || project.title || project.id,
      entryPath,
      sourceRevision,
      sourcePath: scoped.directory,
    };
  }

  // targetKind === 'html' (arbitrary HTML directory or standalone .html/.htm file)
  const rawSourcePath = input.sourcePath?.trim();
  const explicitId = input.targetId?.trim();
  if (!rawSourcePath) {
    throw new Error('INVALID_ARGUMENT: sourcePath is required when publishing html targets');
  }
  const resolved = path.resolve(rawSourcePath);
  assertSafeLocalSourcePath(resolved);

  const info = await lstat(resolved).catch(() => null);
  if (!info) {
    throw new Error(`NOT_FOUND: Publish source "${rawSourcePath}" does not exist`);
  }
  if (info.isSymbolicLink()) {
    throw new Error(`INVALID_ARGUMENT: Symlinks cannot be published (${rawSourcePath})`);
  }
  if (!info.isFile() && !info.isDirectory()) {
    throw new Error(`INVALID_ARGUMENT: Publish source must be a directory or HTML file (${rawSourcePath})`);
  }
  if (info.isFile() && !/\.html?$/i.test(resolved)) {
    throw new Error('INVALID_ARGUMENT: Single-file web publishing requires an .html or .htm file');
  }

  const derivedId =
    explicitId
    || `${slugifyIdPart(path.basename(resolved))}-${createHash('sha256').update(resolved, 'utf8').digest('hex').slice(0, 8)}`;

  return {
    kind: 'html',
    id: derivedId,
    title: input.title?.trim() || path.basename(resolved, path.extname(resolved)) || 'HTML Publication',
    entryPath: input.filePath?.trim() || 'index.html',
    sourceRevision: `${info.mtimeMs}:${info.size}`,
    sourcePath: resolved,
  };
}

export function mapWebPublishError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof DesignError) {
    const status =
      error.code === 'NOT_FOUND'
        ? 404
        : error.code === 'INVALID_ARGUMENT'
          ? 400
          : error.code === 'AUTH_REQUIRED'
            ? 401
            : error.code === 'DEPLOY_CONFLICT'
              ? 409
              : 500;
    return { status, code: error.code, message: error.message };
  }
  if (error instanceof GameError) {
    const code = error.status === 404 ? 'NOT_FOUND' : error.status === 400 ? 'INVALID_ARGUMENT' : 'DEPLOY_FAILED';
    return { status: error.status || 400, code, message: error.message };
  }

  const raw = error instanceof Error ? error.message : String(error);
  if (raw.startsWith('OPENDESIGN_SIGN_IN_REQUIRED')) {
    return {
      status: 401,
      code: 'AUTH_REQUIRED',
      message: raw.replace(/^OPENDESIGN_SIGN_IN_REQUIRED:\s*/, ''),
    };
  }
  if (raw.startsWith('SHARE_STOPPED_RESUME_REQUIRED')) {
    return {
      status: 409,
      code: 'DEPLOY_CONFLICT',
      message: raw.replace(/^SHARE_STOPPED_RESUME_REQUIRED:\s*/, ''),
    };
  }
  if (raw.startsWith('NOT_FOUND:')) {
    return { status: 404, code: 'NOT_FOUND', message: raw.replace(/^NOT_FOUND:\s*/, '') };
  }
  if (raw.startsWith('INVALID_ARGUMENT:')) {
    return { status: 400, code: 'INVALID_ARGUMENT', message: raw.replace(/^INVALID_ARGUMENT:\s*/, '') };
  }
  if (raw.startsWith('DEPLOY_FAILED:')) {
    return { status: 502, code: 'DEPLOY_FAILED', message: raw.replace(/^DEPLOY_FAILED:\s*/, '') };
  }
  return { status: 500, code: 'DEPLOY_FAILED', message: raw || 'Web publish failed' };
}

export async function webPublishOperation(
  store: WorkspaceStore,
  rawInput: Record<string, unknown> | undefined,
  origin: string,
  serviceOverride?: WebPublishService,
): Promise<unknown> {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const command = typeof input.command === 'string' ? input.command : '';
  const rootStore = store.workspaceStore ?? store;
  const service = serviceOverride ?? webPublishFor(rootStore.directory);

  if (command === 'list') {
    return await service.listAll();
  }

  if (!isValidTargetKind(input.targetKind)) {
    throw new Error(
      `INVALID_ARGUMENT: targetKind must be one of ${webPublishTargetKinds.join(', ')}`,
    );
  }
  const targetKind = input.targetKind;
  const targetId = typeof input.targetId === 'string' ? input.targetId.trim() : undefined;
  const sourcePath = typeof input.sourcePath === 'string' ? input.sourcePath.trim() : undefined;
  const filePath = typeof input.filePath === 'string' ? input.filePath.trim() : undefined;
  const title = typeof input.title === 'string' ? input.title.trim() : undefined;

  if (command === 'status') {
    if (targetKind === 'html' && targetId && !sourcePath) {
      return await service.status(
        { kind: 'html', id: targetId, entryPath: filePath || 'index.html' },
        { filePath, refresh: input.refresh === true },
      );
    }
    try {
      const resolved = await resolveWebPublishTarget(
        store,
        { targetKind, targetId, sourcePath, filePath, title },
        origin,
      );
      return await service.status(resolved, { filePath, refresh: input.refresh === true });
    } catch (error) {
      if (targetId && /NOT_FOUND|not found/i.test(error instanceof Error ? error.message : String(error))) {
        const storedEntry = await service.findStoredEntryPath(targetKind, targetId, filePath);
        if (storedEntry) {
          return await service.status(
            { kind: targetKind, id: targetId, entryPath: storedEntry },
            { filePath: filePath ?? storedEntry, refresh: input.refresh === true },
          );
        }
      }
      throw error;
    }
  }

  if (command === 'publish') {
    const resolved = await resolveWebPublishTarget(
      store,
      { targetKind, targetId, sourcePath, filePath, title },
      origin,
    );
    return await service.publish(resolved, {
      filePath,
      workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : undefined,
      mode: typeof input.deployMode === 'string' ? (input.deployMode as WebPublishMode) : undefined,
      name: title,
    });
  }

  if (command === 'unpublish') {
    if (targetKind === 'html' && targetId && !sourcePath) {
      return await service.unpublish(
        { kind: 'html', id: targetId, entryPath: filePath || 'index.html' },
        { filePath },
      );
    }
    if (targetId) {
      const storedEntry = await service.findStoredEntryPath(targetKind, targetId, filePath);
      if (storedEntry) {
        return await service.unpublish(
          { kind: targetKind, id: targetId, entryPath: storedEntry },
          { filePath: filePath ?? storedEntry },
        );
      }
    }
    const resolved = await resolveWebPublishTarget(
      store,
      { targetKind, targetId, sourcePath, filePath, title },
      origin,
    );
    return await service.unpublish(resolved, { filePath });
  }

  throw new Error('INVALID_ARGUMENT: webPublish.command must be publish, status, unpublish, or list');
}
