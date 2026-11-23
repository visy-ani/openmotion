import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, jsonFile } from '../phase1-versions.ts';
import { withProcessLock } from '../shared/process-lock.ts';
import type { AccountSummary } from '../shared/provider-directory.ts';
import type {
  WebPublicationRecord,
  WebPublishAccountState,
  WebPublishFreshness,
  WebPublishListResponse,
  WebPublishMode,
  WebPublishStatusResponse,
  WebPublishTarget,
  WebPublishTargetKind,
} from '../shared/web-publish.ts';
import { OpenDesignAccount, type OpenDesignWorkspaceInfo } from './account.ts';
import { buildPublishBundle, stagePublishFiles, type PublishBundle } from './web-publish-bundle.ts';

type ShareReservation = {
  slug: string;
  sourceFileId: string;
  sourceKey: string;
  workspaceId: string;
  ownerMemberId: string;
  cloudProjectId?: string;
};

type StoredPublishFile = {
  schemaVersion: 1;
  reservations: Record<string, ShareReservation>;
  publications: Record<string, WebPublicationRecord>;
  /** Legacy field preserved when migrating records from design-projects/deployments. */
  deployments?: Record<string, WebPublicationRecord>;
};

type LegacyCloudShareFile = {
  kind?: string;
  projectId?: string;
  cloudProjectId?: string;
  workspaceId?: string;
  ownerMemberId?: string;
  workspaceName?: string;
  slug?: string;
  sourceFileId?: string;
  sourceKey?: string;
  resourceId?: string;
  entryPath?: string;
  status?: 'none' | 'active' | 'stopped';
  url?: string | null;
  version?: number;
  versionId?: string;
  publishedAt?: number;
  contentFingerprint?: string;
  updatedAt?: number;
};

export interface WebPublishAccountClient {
  isSignedIn(): Promise<boolean>;
  listWorkspaces(): Promise<OpenDesignWorkspaceInfo[]>;
  runWithEnv(
    args: string[],
    extraEnv?: Record<string, string>,
    options?: { signal?: AbortSignal; timeoutMs?: number; maxBuffer?: number },
  ): Promise<string>;
  summary?: (refresh?: boolean) => Promise<AccountSummary>;
}

function normalizeEntryPath(raw?: string | null, fallback = 'index.html'): string {
  const value = (raw || fallback).replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!value || value.includes('\0')) {
    throw new Error('INVALID_ARGUMENT: Entry file path is required');
  }
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('INVALID_ARGUMENT: Entry file path contains invalid segments');
  }
  if (!/\.html?$/i.test(value)) {
    throw new Error('INVALID_ARGUMENT: Web publishing requires an .html or .htm entry file');
  }
  return value;
}

function storageKey(kind: WebPublishTargetKind, targetId: string): string {
  const cleanId = targetId.trim();
  const safeId = /^[a-zA-Z0-9._-]{1,120}$/.test(cleanId)
    ? cleanId
    : createHash('sha256').update(cleanId, 'utf8').digest('hex').slice(0, 32);
  return `${kind}--${safeId}`;
}

/**
 * Resolve the remote OpenDesign project ID associated with a published target.
 * Design targets preserve their native ID; non-Design HTML targets receive a
 * collision-free deterministic UUID derived from (kind, targetId).
 */
export function cloudProjectIdFor(kind: WebPublishTargetKind, targetId: string): string {
  if (kind === 'design') {
    return targetId;
  }
  const digest = createHash('sha256')
    .update(`openmotion:web-publish:${kind}:${targetId}`, 'utf8')
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function publicFileResourceIdFor(scope: {
  workspaceId: string;
  ownerMemberId: string;
  projectId: string;
  filePath: string;
}): string {
  const scoped = Buffer.from(
    JSON.stringify([scope.workspaceId, scope.ownerMemberId, scope.projectId, scope.filePath]),
    'utf8',
  ).toString('base64url');
  return `project-file-${scoped}`;
}

export function commentFileSourceKey(projectId: string, sourceFileId: string): string {
  if (!projectId.trim() || !sourceFileId.trim()) {
    throw new Error('INVALID_ARGUMENT: projectId and sourceFileId are required');
  }
  return `comment-file-v1:${Buffer.from(projectId, 'utf8').toString('base64url')}:${sourceFileId}`;
}

export function verifiedShareUrl(rawUrl: unknown, projectId: string, slug: string): string | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed.toLowerCase().startsWith('https://')) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return null;
    }
    const expectedPath = `/artifact/${encodeURIComponent(projectId)}/${encodeURIComponent(slug)}`;
    if (parsed.pathname !== expectedPath) {
      return null;
    }
    return `${parsed.origin}${expectedPath}`;
  } catch {
    return null;
  }
}

export function parseShareLinkFromRecord(
  record: Record<string, unknown>,
  projectId: string,
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates: unknown[] = [
    record.url,
    record.link && typeof record.link === 'object' ? (record.link as Record<string, unknown>).url : undefined,
  ];
  for (const candidate of candidates) {
    const verified = verifiedShareUrl(candidate, projectId, slug);
    if (verified) return verified;
  }
  const overrideOrigin = (env.OD_SHARE_VIEWER_URL || env.OM_CLOUD_SHARE_VIEWER_ORIGIN)?.trim();
  if (overrideOrigin && overrideOrigin.toLowerCase().startsWith('https://')) {
    try {
      const originUrl = new URL(overrideOrigin);
      if (originUrl.protocol === 'https:' && !originUrl.username && !originUrl.password) {
        return `${originUrl.origin}/artifact/${encodeURIComponent(projectId)}/${encodeURIComponent(slug)}`;
      }
    } catch {
      // Ignore invalid override origin.
    }
  }
  return null;
}

function selectTargetWorkspace(
  workspaces: OpenDesignWorkspaceInfo[],
  requestedWorkspaceId?: string,
): OpenDesignWorkspaceInfo {
  if (!workspaces.length) {
    throw new Error('DEPLOY_FAILED: No active OpenDesign workspace found for signed-in account');
  }
  if (requestedWorkspaceId?.trim()) {
    const exact = workspaces.find(w => w.workspaceId === requestedWorkspaceId.trim());
    if (!exact) {
      throw new Error(`INVALID_ARGUMENT: OpenDesign workspace "${requestedWorkspaceId}" not found for account`);
    }
    return exact;
  }
  return (
    workspaces.find(w => w.workspaceType === 'personal' && w.isDefault)
    ?? workspaces.find(w => w.workspaceType === 'personal')
    ?? workspaces[0]
  );
}

function normalizeStoredRecord(
  record: Partial<WebPublicationRecord>,
  fallbackKind: WebPublishTargetKind,
  fallbackId: string,
): WebPublicationRecord {
  const targetKind = record.targetKind ?? fallbackKind;
  const targetId = record.targetId ?? record.projectId ?? fallbackId;
  const cloudProjectId = record.cloudProjectId ?? cloudProjectIdFor(targetKind, targetId);
  return {
    ...(record as WebPublicationRecord),
    schemaVersion: 1,
    targetKind,
    targetId,
    cloudProjectId,
    projectId: record.projectId ?? targetId,
  };
}

function fromLegacyCloudShareRecord(raw: LegacyCloudShareFile): StoredPublishFile | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind !== 'game-project' && raw.kind !== 'design-project') return null;
  const targetKind: WebPublishTargetKind = raw.kind === 'game-project' ? 'game' : 'design';
  const targetId = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
  if (!targetId) return null;

  const entryPath = normalizeEntryPath(raw.entryPath, 'index.html');
  const cloudProjectId = typeof raw.cloudProjectId === 'string' && raw.cloudProjectId.trim()
    ? raw.cloudProjectId.trim()
    : cloudProjectIdFor(targetKind, targetId);

  const reservations: Record<string, ShareReservation> = {};
  if (raw.slug && raw.sourceFileId && raw.sourceKey && raw.workspaceId && raw.ownerMemberId) {
    reservations[entryPath] = {
      slug: raw.slug,
      sourceFileId: raw.sourceFileId,
      sourceKey: raw.sourceKey,
      workspaceId: raw.workspaceId,
      ownerMemberId: raw.ownerMemberId,
      cloudProjectId,
    };
  }

  const publications: Record<string, WebPublicationRecord> = {};
  if (raw.status === 'active' || raw.status === 'stopped') {
    publications[entryPath] = {
      schemaVersion: 1,
      targetKind,
      targetId,
      cloudProjectId,
      projectId: targetId,
      filePath: entryPath,
      entryPath,
      name: raw.workspaceName || targetId,
      workspaceId: raw.workspaceId || '',
      workspaceName: raw.workspaceName,
      ownerMemberId: raw.ownerMemberId || '',
      resourceId: raw.resourceId || '',
      sourceFileId: raw.sourceFileId || '',
      sourceKey: raw.sourceKey || '',
      slug: raw.slug || '',
      version: raw.version ?? 1,
      versionId: raw.versionId || '',
      status: raw.status === 'stopped' ? 'stopped' : 'published',
      url: raw.url ?? null,
      publishedAt: raw.publishedAt ?? raw.updatedAt ?? Date.now(),
      updatedAt: raw.updatedAt ?? Date.now(),
      fileCount: 1,
      totalBytes: 0,
      contentFingerprint: raw.contentFingerprint,
      sourceRevision: '',
    };
  }

  return {
    schemaVersion: 1,
    reservations,
    publications,
  };
}

export class WebPublishService {
  readonly dataDirectory: string;
  readonly storeRoot: string;
  readonly legacyDesignRoot: string;
  readonly legacyCloudShareRoot: string;
  private _account: WebPublishAccountClient;
  private hasExplicitAccount: boolean;

  constructor(dataDirectory: string, account?: WebPublishAccountClient) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.storeRoot = path.join(this.dataDirectory, 'web-publications');
    this.legacyDesignRoot = path.join(this.dataDirectory, 'design-projects', 'deployments');
    this.legacyCloudShareRoot = path.join(this.dataDirectory, 'cloud-shares');
    this.hasExplicitAccount = Boolean(account);
    this._account = account ?? new OpenDesignAccount(this.dataDirectory);
  }

  get account(): WebPublishAccountClient {
    return this._account;
  }

  bindAccount(account: WebPublishAccountClient): void {
    if (!this.hasExplicitAccount) {
      this._account = account;
      this.hasExplicitAccount = true;
    }
  }

  private stateFile(kind: WebPublishTargetKind, targetId: string): string {
    return path.join(this.storeRoot, `${storageKey(kind, targetId)}.json`);
  }

  private legacyStateFile(targetId: string): string {
    return path.join(this.legacyDesignRoot, `${targetId}.json`);
  }

  private legacyCloudShareFile(kind: WebPublishTargetKind, targetId: string): string | null {
    if (kind !== 'game' && kind !== 'design') return null;
    const legacyKind = kind === 'game' ? 'game-project' : 'design-project';
    const safeKey = Buffer.from(`${legacyKind}:${targetId}`, 'utf8').toString('base64url');
    return path.join(this.legacyCloudShareRoot, `${legacyKind}__${safeKey}.json`);
  }

  private lockFile(kind: WebPublishTargetKind, targetId: string): string {
    return path.join(this.storeRoot, `${storageKey(kind, targetId)}.lock`);
  }

  private async readState(kind: WebPublishTargetKind, targetId: string): Promise<StoredPublishFile> {
    const primary = this.stateFile(kind, targetId);
    if (!existsSync(primary)) {
      if (kind === 'design' && existsSync(this.legacyStateFile(targetId))) {
        const raw = await jsonFile<Partial<StoredPublishFile>>(this.legacyStateFile(targetId), {});
        return this.parseStoredPublishFile(raw, kind, targetId);
      }
      const legacyCloud = this.legacyCloudShareFile(kind, targetId);
      if (legacyCloud && existsSync(legacyCloud)) {
        const raw = await jsonFile<LegacyCloudShareFile>(legacyCloud, {});
        return fromLegacyCloudShareRecord(raw) ?? { schemaVersion: 1, reservations: {}, publications: {} };
      }
    }
    const raw = await jsonFile<Partial<StoredPublishFile>>(primary, {});
    return this.parseStoredPublishFile(raw, kind, targetId);
  }

  private parseStoredPublishFile(
    raw: Partial<StoredPublishFile>,
    kind: WebPublishTargetKind,
    targetId: string,
  ): StoredPublishFile {
    const mapSource =
      raw.publications && typeof raw.publications === 'object'
        ? raw.publications
        : raw.deployments && typeof raw.deployments === 'object'
          ? raw.deployments
          : {};
    const publications: Record<string, WebPublicationRecord> = {};
    for (const [entryKey, item] of Object.entries(mapSource)) {
      if (item && typeof item === 'object') {
        publications[entryKey] = normalizeStoredRecord(item, kind, targetId);
      }
    }
    return {
      schemaVersion: 1,
      reservations: raw.reservations && typeof raw.reservations === 'object' ? { ...raw.reservations } : {},
      publications,
    };
  }

  private async saveState(kind: WebPublishTargetKind, targetId: string, state: StoredPublishFile): Promise<void> {
    await mkdir(this.storeRoot, { recursive: true, mode: 0o700 });
    await atomicJson(this.stateFile(kind, targetId), {
      schemaVersion: 1,
      reservations: state.reservations,
      publications: state.publications,
    });
  }

  private async runVelaJson(
    args: string[],
    workspaceId: string,
  ): Promise<Record<string, unknown>> {
    const stdout = await this.account.runWithEnv(
      args,
      {
        VELA_INVOCATION_SOURCE: 'open-design',
        ...(workspaceId ? { VELA_WORKSPACE_ID: workspaceId } : {}),
      },
      { timeoutMs: 120_000 },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`DEPLOY_FAILED: OpenDesign CLI returned non-JSON output for "${args.slice(0, 2).join(' ')}"`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`DEPLOY_FAILED: Unexpected OpenDesign CLI response for "${args.slice(0, 2).join(' ')}"`);
    }
    return parsed as Record<string, unknown>;
  }

  private async admitCommentFileReceipt(params: {
    cloudProjectId: string;
    workspaceId: string;
    ownerMemberId: string;
    resourceId: string;
    versionId: string;
    filePath: string;
    sourceFileId: string;
  }): Promise<void> {
    const parseCommentFiles = (raw: unknown): { revision: number; files: Array<Record<string, unknown>> } => {
      if (raw === undefined || raw === null) {
        return { revision: 0, files: [] };
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('DEPLOY_FAILED: Invalid OpenDesign comment-files catalog state');
      }
      const state = raw as Record<string, unknown>;
      if (
        state.schemaVersion !== 1
        || typeof state.revision !== 'number'
        || !Number.isSafeInteger(state.revision)
        || state.revision < 0
        || !Array.isArray(state.files)
      ) {
        throw new Error('DEPLOY_FAILED: Invalid OpenDesign comment-files catalog state');
      }
      return {
        revision: state.revision,
        files: state.files.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object')),
      };
    };

    const readCatalog = async () => {
      const row = await this.runVelaJson(
        ['team-projects', 'get', params.cloudProjectId, '--json'],
        params.workspaceId,
      );
      const rootResourceId = typeof row.resourceId === 'string' ? row.resourceId.trim() : '';
      if (
        row.projectId !== params.cloudProjectId
        || row.workspaceId !== params.workspaceId
        || row.ownerMemberId !== params.ownerMemberId
        || !rootResourceId
      ) {
        throw new Error('DEPLOY_FAILED: OpenDesign project catalog ownership mismatch');
      }
      const metadata =
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};
      const state = parseCommentFiles(metadata._commentFiles);
      return { rootResourceId, metadata, state };
    };

    const matches = (files: Array<Record<string, unknown>>) =>
      files.some(
        fact =>
          fact.sourceFileId === params.sourceFileId
          && fact.sourceFilePath === params.filePath
          && fact.entryPath === params.filePath
          && fact.resourceId === params.resourceId
          && fact.versionId === params.versionId
          && fact.retired === false,
      );

    const { rootResourceId, metadata, state } = await readCatalog();
    if (matches(state.files)) {
      return;
    }

    const mutation = {
      schemaVersion: 1,
      baseRevision: state.revision,
      resourceId: params.resourceId,
      versionId: params.versionId,
      files: [
        {
          sourceFilePath: params.filePath,
          entryPath: params.filePath,
          sourceFileId: params.sourceFileId,
          retired: false,
        },
      ],
    };

    let failure: unknown;
    try {
      await this.account.runWithEnv(
        [
          'team-projects',
          'upsert',
          params.cloudProjectId,
          '--resource-id',
          rootResourceId,
          '--metadata-json',
          JSON.stringify({ ...metadata, _commentFiles: mutation }),
        ],
        {
          VELA_INVOCATION_SOURCE: 'open-design',
          VELA_WORKSPACE_ID: params.workspaceId,
        },
        { timeoutMs: 60_000 },
      );
    } catch (error) {
      failure = error;
    }

    const admitted = await readCatalog();
    if (!matches(admitted.state.files)) {
      if (failure instanceof Error) {
        throw failure;
      }
      throw new Error('DEPLOY_FAILED: OpenDesign file receipt admission failed');
    }
  }

  async status(
    target: Pick<WebPublishTarget, 'kind' | 'id' | 'entryPath'>
      & Partial<Pick<WebPublishTarget, 'sourcePath' | 'title' | 'multiplayer'>>,
    options: { filePath?: string; refresh?: boolean } = {},
  ): Promise<WebPublishStatusResponse> {
    const accountSignedIn = await this.account.isSignedIn();
    const accountSummary = this.account.summary ? await this.account.summary().catch(() => null) : null;
    const accountState: WebPublishAccountState =
      accountSummary?.state ?? (accountSignedIn ? 'signed-in' : 'signed-out');
    const accountEmail = accountSummary?.user?.email;

    const state = await this.readState(target.kind, target.id);
    const targetEntry = options.filePath
      ? normalizeEntryPath(options.filePath, target.entryPath)
      : normalizeEntryPath(target.entryPath, 'index.html');
    const defaultCloudProjectId = cloudProjectIdFor(target.kind, target.id);

    if (options.refresh && accountSignedIn) {
      const current = state.publications[targetEntry];
      if (current) {
        try {
          const remoteProjectId = current.cloudProjectId || defaultCloudProjectId;
          const remote = await this.runVelaJson(
            ['share', 'status', current.slug, '--project-id', remoteProjectId, '--json'],
            current.workspaceId,
          );
          if (remote.status === 'active' || remote.status === 'stopped') {
            const nextStatus = remote.status === 'stopped' ? 'stopped' : 'published';
            const refreshedUrl = parseShareLinkFromRecord(remote, remoteProjectId, current.slug) ?? current.url;
            await withProcessLock(this.lockFile(target.kind, target.id), async () => {
              const latest = await this.readState(target.kind, target.id);
              const entry = latest.publications[targetEntry];
              if (entry && entry.slug === current.slug) {
                entry.status = nextStatus;
                entry.url = refreshedUrl;
                entry.updatedAt = Date.now();
                await this.saveState(target.kind, target.id, latest);
              }
            });
          }
        } catch {
          // Non-fatal: preserve locally persisted status if live refresh fails.
        }
      }
    }

    const updated = await this.readState(target.kind, target.id);
    const publications = Object.values(updated.publications).sort((a, b) => b.updatedAt - a.updatedAt);
    const active =
      publications.find(item => item.filePath === targetEntry && item.status === 'published')
      ?? publications.find(item => item.status === 'published')
      ?? publications.find(item => item.filePath === targetEntry)
      ?? null;

    let bundle: PublishBundle | null = null;
    if (target.sourcePath) {
      bundle = await buildPublishBundle({
        dataDirectory: this.dataDirectory,
        kind: target.kind,
        targetId: target.id,
        sourcePath: target.sourcePath,
        entryPath: targetEntry,
      }).catch(() => null);
    }

    const freshness: WebPublishFreshness =
      !active || !active.contentFingerprint || !bundle
        ? 'unknown'
        : active.contentFingerprint === bundle.contentFingerprint
          ? 'fresh'
          : 'outdated';

    return {
      targetKind: target.kind,
      targetId: target.id,
      projectId: target.id,
      ...(target.title ? { title: target.title } : active?.name ? { title: active.name } : {}),
      entryPath: bundle?.entryPath ?? active?.entryPath ?? targetEntry,
      accountSignedIn,
      accountState,
      ...(accountEmail ? { accountEmail } : {}),
      freshness,
      fileCount: bundle?.fileCount ?? active?.fileCount ?? 0,
      totalBytes: bundle?.totalBytes ?? active?.totalBytes ?? 0,
      bundledAssetCount: bundle?.bundledAssetCount ?? active?.bundledAssetCount ?? 0,
      ...(target.multiplayer !== undefined
        ? { multiplayer: target.multiplayer }
        : active?.multiplayer !== undefined
          ? { multiplayer: active.multiplayer }
          : {}),
      publications,
      deployments: publications,
      active,
    };
  }

  async publish(
    target: WebPublishTarget,
    options: {
      filePath?: string;
      workspaceId?: string;
      mode?: WebPublishMode;
      name?: string;
    } = {},
  ): Promise<{
    publication: WebPublicationRecord;
    deployment: WebPublicationRecord;
    url: string | null;
    updated: boolean;
  }> {
    const filePath = normalizeEntryPath(options.filePath, target.entryPath || 'index.html');
    const mode: WebPublishMode = options.mode ?? 'publish';
    const displayName = (options.name || target.title || filePath).trim().slice(0, 120) || 'OpenMotion Web';

    const workspaces = await this.account.listWorkspaces();
    const workspace = selectTargetWorkspace(workspaces, options.workspaceId);

    const existingState = await this.readState(target.kind, target.id);
    const existingPublication = existingState.publications[filePath];

    if (existingPublication?.status === 'stopped' && mode === 'publish') {
      throw new Error(
        'SHARE_STOPPED_RESUME_REQUIRED: Existing share link is stopped. Pass deployMode="resume" to reopen it or deployMode="new_link" to create a new link.',
      );
    }

    if (mode === 'new_link' && existingPublication?.status === 'published') {
      const prevProjectId = existingPublication.cloudProjectId || cloudProjectIdFor(target.kind, target.id);
      const stoppedPrev = await this.runVelaJson(
        ['share', 'stop', existingPublication.slug, '--project-id', prevProjectId, '--json'],
        existingPublication.workspaceId,
      );
      if (stoppedPrev.status !== 'stopped' || stoppedPrev.slug !== existingPublication.slug) {
        throw new Error('DEPLOY_FAILED: Could not stop the previous public link before rotating to a new link');
      }
      await withProcessLock(this.lockFile(target.kind, target.id), async () => {
        const latest = await this.readState(target.kind, target.id);
        if (latest.publications[filePath]?.slug === existingPublication.slug) {
          latest.publications[filePath] = {
            ...latest.publications[filePath],
            status: 'stopped',
            updatedAt: Date.now(),
          };
          await this.saveState(target.kind, target.id, latest);
        }
      });
    }

    const cloudProjectId =
      mode !== 'new_link' && existingPublication?.cloudProjectId
        ? existingPublication.cloudProjectId
        : cloudProjectIdFor(target.kind, target.id);

    const bundle = await buildPublishBundle({
      dataDirectory: this.dataDirectory,
      kind: target.kind,
      targetId: target.id,
      sourcePath: target.sourcePath,
      entryPath: filePath,
    });

    const contentMatches =
      existingPublication?.contentFingerprint
        ? existingPublication.contentFingerprint === bundle.contentFingerprint
        : existingPublication?.sourceRevision === target.sourceRevision;

    // Fast path: resume an existing stopped share link when content hasn't changed.
    if (
      existingPublication
      && existingPublication.status === 'stopped'
      && mode === 'resume'
      && contentMatches
      && existingPublication.workspaceId === workspace.workspaceId
    ) {
      const remoteProjectId = existingPublication.cloudProjectId || cloudProjectId;
      const resumedRecord = await this.runVelaJson(
        [
          'share',
          'resume-existing',
          existingPublication.slug,
          '--project-id',
          remoteProjectId,
          '--source-file-path',
          filePath,
          '--json',
        ],
        workspace.workspaceId,
      );
      if (resumedRecord.status !== 'active') {
        throw new Error('DEPLOY_FAILED: OpenDesign could not resume the stopped share link');
      }
      const resumedUrl =
        parseShareLinkFromRecord(resumedRecord, remoteProjectId, existingPublication.slug)
        ?? existingPublication.url;
      const resumedPublication: WebPublicationRecord = {
        ...existingPublication,
        cloudProjectId: remoteProjectId,
        status: 'published',
        url: resumedUrl,
        fileCount: bundle.fileCount,
        totalBytes: bundle.totalBytes,
        bundledAssetCount: bundle.bundledAssetCount,
        contentFingerprint: bundle.contentFingerprint,
        ...(target.multiplayer !== undefined ? { multiplayer: target.multiplayer } : {}),
        updatedAt: Date.now(),
        publishedAt:
          typeof resumedRecord.publishedAt === 'number'
            ? resumedRecord.publishedAt
            : existingPublication.publishedAt,
      };
      await withProcessLock(this.lockFile(target.kind, target.id), async () => {
        const latest = await this.readState(target.kind, target.id);
        latest.publications[filePath] = resumedPublication;
        await this.saveState(target.kind, target.id, latest);
      });
      return {
        publication: resumedPublication,
        deployment: resumedPublication,
        url: resumedPublication.url,
        updated: true,
      };
    }

    // Reserve stable share identity before remote mutations (idempotent across retries).
    const reservation = await withProcessLock(this.lockFile(target.kind, target.id), async () => {
      const latest = await this.readState(target.kind, target.id);
      const current = latest.reservations[filePath];
      if (
        mode !== 'new_link'
        && current
        && current.workspaceId === workspace.workspaceId
        && current.ownerMemberId === workspace.workspaceMemberId
        && (!current.cloudProjectId || current.cloudProjectId === cloudProjectId)
      ) {
        return current;
      }
      const nextSourceFileId = randomUUID();
      const next: ShareReservation = {
        slug: randomUUID(),
        sourceFileId: nextSourceFileId,
        sourceKey: commentFileSourceKey(cloudProjectId, nextSourceFileId),
        workspaceId: workspace.workspaceId,
        ownerMemberId: workspace.workspaceMemberId,
        cloudProjectId,
      };
      latest.reservations[filePath] = next;
      await this.saveState(target.kind, target.id, latest);
      return next;
    });

    const resourceId = publicFileResourceIdFor({
      workspaceId: workspace.workspaceId,
      ownerMemberId: workspace.workspaceMemberId,
      projectId: cloudProjectId,
      filePath,
    });

    // 1. Register project & resource association under the pinned OpenDesign workspace.
    const ensured = await this.runVelaJson(
      ['team-projects', 'ensure-private', cloudProjectId],
      workspace.workspaceId,
    );
    if (ensured.projectId !== cloudProjectId) {
      throw new Error('DEPLOY_FAILED: OpenDesign workspace project verification mismatch');
    }

    const registered = await this.runVelaJson(
      ['team-projects', 'register-resource', cloudProjectId, resourceId],
      workspace.workspaceId,
    );
    if (registered.ok !== true) {
      throw new Error('DEPLOY_FAILED: Could not register project resource in OpenDesign workspace');
    }

    // 2. Stage bundled files (rewriting local media assets & internal URLs) & push content-addressed tree.
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'om-web-publish-'));
    try {
      await stagePublishFiles(tempDir, bundle.files);
      const uploadKey = createHash('sha256')
        .update(JSON.stringify([workspace.workspaceId, cloudProjectId, filePath, reservation.slug, bundle.contentFingerprint]))
        .digest('hex');

      const pushResult = await this.runVelaJson(
        [
          'resource',
          'push',
          'project',
          resourceId,
          tempDir,
          '--public-upload-key',
          uploadKey,
          '--metadata-json',
          JSON.stringify({
            source: 'open-design',
            projectId: cloudProjectId,
            targetKind: target.kind,
            targetId: target.id,
            fileName: filePath,
          }),
          '--json',
        ],
        workspace.workspaceId,
      );
      const versionId = typeof pushResult.id === 'string' && pushResult.id.trim() ? pushResult.id.trim() : '';
      if (!versionId) {
        throw new Error('DEPLOY_FAILED: OpenDesign resource push did not return a version ID');
      }

      // 3. Admit the immutable file receipt into the project catalog before publishing.
      await this.admitCommentFileReceipt({
        cloudProjectId,
        workspaceId: workspace.workspaceId,
        ownerMemberId: workspace.workspaceMemberId,
        resourceId,
        versionId,
        filePath,
        sourceFileId: reservation.sourceFileId,
      });

      // If resuming a stopped share whose contents changed, resume the remote slug first.
      if (existingPublication?.status === 'stopped' && mode === 'resume') {
        await this.runVelaJson(
          [
            'share',
            'resume-existing',
            reservation.slug,
            '--project-id',
            cloudProjectId,
            '--source-file-path',
            filePath,
            '--json',
          ],
          workspace.workspaceId,
        ).catch(() => {});
      }

      // 4. Publish immutable version behind the reserved stable share slug.
      const publishResult = await this.runVelaJson(
        [
          'share',
          'publish',
          resourceId,
          '--project-id',
          cloudProjectId,
          '--source-file-path',
          filePath,
          '--slug',
          reservation.slug,
          '--source-key',
          reservation.sourceKey,
          '--entry-path',
          filePath,
          '--name',
          displayName,
          '--version-id',
          versionId,
          '--json',
        ],
        workspace.workspaceId,
      );

      if (publishResult.status !== 'published') {
        throw new Error('DEPLOY_FAILED: OpenDesign share publish did not confirm published status');
      }
      if (publishResult.slug !== reservation.slug) {
        throw new Error('DEPLOY_FAILED: OpenDesign share publish returned mismatched slug');
      }
      const snapshot = publishResult.snapshot as Record<string, unknown> | undefined;
      if (!snapshot || snapshot.versionId !== versionId) {
        throw new Error('DEPLOY_FAILED: OpenDesign share publish returned mismatched version snapshot');
      }

      const publishedVersion =
        typeof publishResult.version === 'number' && Number.isSafeInteger(publishResult.version)
          ? publishResult.version
          : (existingPublication?.version ?? 0) + 1;
      const publishedAt =
        typeof publishResult.publishedAt === 'number' && Number.isSafeInteger(publishResult.publishedAt)
          ? publishResult.publishedAt
          : Date.now();
      const shareUrl = parseShareLinkFromRecord(publishResult, cloudProjectId, reservation.slug);

      const record: WebPublicationRecord = {
        schemaVersion: 1,
        targetKind: target.kind,
        targetId: target.id,
        cloudProjectId,
        projectId: target.id,
        filePath,
        entryPath: filePath,
        name: displayName,
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
        ownerMemberId: workspace.workspaceMemberId,
        resourceId,
        sourceFileId: reservation.sourceFileId,
        sourceKey: reservation.sourceKey,
        slug: reservation.slug,
        version: publishedVersion,
        versionId,
        status: 'published',
        url: shareUrl,
        publishedAt,
        updatedAt: Date.now(),
        fileCount: bundle.fileCount,
        totalBytes: bundle.totalBytes,
        bundledAssetCount: bundle.bundledAssetCount,
        contentFingerprint: bundle.contentFingerprint,
        ...(target.multiplayer !== undefined ? { multiplayer: target.multiplayer } : {}),
        sourceRevision: target.sourceRevision,
      };

      const wasExisting = Boolean(existingPublication && existingPublication.slug === reservation.slug);
      await withProcessLock(this.lockFile(target.kind, target.id), async () => {
        const latest = await this.readState(target.kind, target.id);
        latest.publications[filePath] = record;
        await this.saveState(target.kind, target.id, latest);
      });

      return { publication: record, deployment: record, url: record.url, updated: wasExisting };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async findStoredEntryPath(
    kind: WebPublishTargetKind,
    id: string,
    filePath?: string,
  ): Promise<string | undefined> {
    const state = await this.readState(kind, id);
    if (filePath) {
      const normalized = normalizeEntryPath(filePath, 'index.html');
      if (state.publications[normalized]) return normalized;
    }
    const records = Object.values(state.publications);
    const active = records.find(r => r.status === 'published');
    const chosen = active ?? records[0];
    return chosen?.filePath || chosen?.entryPath;
  }

  async unpublish(
    target: Pick<WebPublishTarget, 'kind' | 'id' | 'entryPath'>,
    options: { filePath?: string } = {},
  ): Promise<{ publication: WebPublicationRecord; deployment: WebPublicationRecord }> {
    const filePath = normalizeEntryPath(options.filePath, target.entryPath || 'index.html');
    const state = await this.readState(target.kind, target.id);
    const current = state.publications[filePath];
    if (!current) {
      throw new Error(`NOT_FOUND: No live publication found for "${filePath}"`);
    }

    if (current.status === 'stopped') {
      return { publication: current, deployment: current };
    }

    const remoteProjectId = current.cloudProjectId || cloudProjectIdFor(target.kind, target.id);
    const receipt = await this.runVelaJson(
      ['share', 'stop', current.slug, '--project-id', remoteProjectId, '--json'],
      current.workspaceId,
    );
    if (receipt.status !== 'stopped' || receipt.slug !== current.slug) {
      throw new Error('DEPLOY_FAILED: OpenDesign share stop confirmation failed');
    }

    const stopped: WebPublicationRecord = {
      ...current,
      status: 'stopped',
      updatedAt: Date.now(),
    };

    await withProcessLock(this.lockFile(target.kind, target.id), async () => {
      const latest = await this.readState(target.kind, target.id);
      latest.publications[filePath] = stopped;
      await this.saveState(target.kind, target.id, latest);
    });

    return { publication: stopped, deployment: stopped };
  }

  async listAll(): Promise<WebPublishListResponse> {
    const accountSignedIn = await this.account.isSignedIn();
    const collected = new Map<string, WebPublicationRecord>();

    const recordCandidate = (normalized: WebPublicationRecord) => {
      const key = `${normalized.targetKind}:${normalized.targetId}:${normalized.filePath}`;
      const prev = collected.get(key);
      if (!prev || normalized.updatedAt >= prev.updatedAt) {
        collected.set(key, normalized);
      }
    };

    const absorbDir = async (dir: string, defaultKind: WebPublishTargetKind) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const raw = await jsonFile<Partial<StoredPublishFile>>(path.join(dir, entry.name), {});
        const mapSource =
          raw.publications && typeof raw.publications === 'object'
            ? raw.publications
            : raw.deployments && typeof raw.deployments === 'object'
              ? raw.deployments
              : {};
        const stem = entry.name.slice(0, -5);
        const sep = stem.indexOf('--');
        const inferredKind = sep > 0 ? (stem.slice(0, sep) as WebPublishTargetKind) : defaultKind;
        const inferredId = sep > 0 ? stem.slice(sep + 2) : stem;
        for (const item of Object.values(mapSource)) {
          if (!item || typeof item !== 'object') continue;
          recordCandidate(normalizeStoredRecord(item, inferredKind, inferredId));
        }
      }
    };

    const absorbLegacyCloudShares = async () => {
      const entries = await readdir(this.legacyCloudShareRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const raw = await jsonFile<LegacyCloudShareFile>(path.join(this.legacyCloudShareRoot, entry.name), {});
        const converted = fromLegacyCloudShareRecord(raw);
        if (!converted) continue;
        for (const pub of Object.values(converted.publications)) {
          recordCandidate(pub);
        }
      }
    };

    await absorbDir(this.legacyDesignRoot, 'design');
    await absorbLegacyCloudShares();
    await absorbDir(this.storeRoot, 'html');

    const publications = [...collected.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return { accountSignedIn, publications };
  }
}

const publishServices = new Map<string, WebPublishService>();

export function webPublishFor(
  dataDirectory: string,
  account?: WebPublishAccountClient,
): WebPublishService {
  const key = path.resolve(dataDirectory);
  let instance = publishServices.get(key);
  if (!instance) {
    instance = new WebPublishService(key, account);
    publishServices.set(key, instance);
  } else if (account) {
    instance.bindAccount(account);
  }
  return instance;
}

export function closeWebPublishFor(dataDirectory: string): void {
  publishServices.delete(path.resolve(dataDirectory));
}
