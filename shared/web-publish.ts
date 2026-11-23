/**
 * Generalized web publishing contract shared by domain services, HTTP routes,
 * public MCP tools, and Studio surfaces (Design, Game, Motion, or any standalone HTML bundle).
 */

export const WEB_PUBLISH_API = '/motion-api/web-publish';

export const webPublishTargetKinds = ['design', 'game', 'html', 'motion'] as const;
export type WebPublishTargetKind = typeof webPublishTargetKinds[number];

export type WebPublishMode = 'publish' | 'resume' | 'new_link';
export type WebPublishStatus = 'published' | 'stopped';
export type WebPublishFreshness = 'fresh' | 'outdated' | 'unknown';
export type WebPublishAccountState = 'signed-out' | 'authorizing' | 'signed-in' | 'reauth-required' | 'unavailable';

export type WebPublishTarget = {
  kind: WebPublishTargetKind;
  id: string;
  title: string;
  entryPath: string;
  sourceRevision: string;
  /** Directory containing the HTML bundle, or a direct .html / .htm file path. */
  sourcePath: string;
  multiplayer?: boolean;
};

export type WebPublicationRecord = {
  schemaVersion: 1;
  targetKind: WebPublishTargetKind;
  targetId: string;
  /** Remote OpenDesign project UUID used for cloud resource registration and share URLs. */
  cloudProjectId: string;
  /** Compatibility alias preserved for Design Studio consumers (= targetId). */
  projectId: string;
  filePath: string;
  entryPath: string;
  name: string;
  workspaceId: string;
  workspaceName?: string;
  ownerMemberId: string;
  resourceId: string;
  sourceFileId: string;
  sourceKey: string;
  slug: string;
  version: number;
  versionId: string;
  status: WebPublishStatus;
  url: string | null;
  publishedAt: number;
  updatedAt: number;
  fileCount: number;
  totalBytes: number;
  bundledAssetCount?: number;
  contentFingerprint?: string;
  multiplayer?: boolean;
  sourceRevision: string;
};

export type WebPublishStatusResponse = {
  targetKind: WebPublishTargetKind;
  targetId: string;
  /** Compatibility alias preserved for Design Studio consumers (= targetId). */
  projectId: string;
  title?: string;
  entryPath?: string;
  accountSignedIn: boolean;
  accountState?: WebPublishAccountState;
  accountEmail?: string;
  freshness?: WebPublishFreshness;
  fileCount?: number;
  totalBytes?: number;
  bundledAssetCount?: number;
  multiplayer?: boolean;
  publications: WebPublicationRecord[];
  /** Compatibility alias preserved for Design Studio consumers (= publications). */
  deployments: WebPublicationRecord[];
  active: WebPublicationRecord | null;
};

export type WebPublishListResponse = {
  accountSignedIn: boolean;
  publications: WebPublicationRecord[];
};

export const webPublishRoutes = {
  list: WEB_PUBLISH_API,
  target: (kind: WebPublishTargetKind, id: string) =>
    `${WEB_PUBLISH_API}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
} as const;

export const webPublishToolDescription =
  ' Use action=web_publish with webPublish={command:"publish"|"status"|"unpublish"|"list", targetKind:"design"|"game"|"html"|"motion", ...} to bundle local referenced assets and publish any HTML-expressed project, playable game, or standalone HTML file/folder to a unique Open Design Cloud share link.';

export const webPublishToolArguments = {
  type: 'object',
  additionalProperties: false,
  required: ['command'],
  properties: {
    command: {
      enum: ['publish', 'status', 'unpublish', 'list'],
      description: 'Operation to run: publish/update a live HTTPS link, inspect status and content freshness, stop sharing, or list all publications.',
    },
    targetKind: {
      enum: ['design', 'game', 'html', 'motion'],
      description: 'What is being published: a Design Studio project, Game Studio game, Motion project HTML bundle, or standalone HTML file/folder.',
    },
    targetId: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Target project or game ID (optional for targetKind="html" when sourcePath is provided).',
    },
    sourcePath: {
      type: 'string',
      minLength: 1,
      maxLength: 4096,
      description: 'Local HTML file or static directory path when targetKind is "html".',
    },
    filePath: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'Entry HTML path relative to the bundle root (default index.html).',
    },
    workspaceId: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'Optional OpenDesign workspace ID override.',
    },
    deployMode: {
      enum: ['publish', 'resume', 'new_link'],
      description: 'publish (create or update live link), resume (reopen stopped link), or new_link (rotate to a fresh share URL).',
    },
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'Optional public display title for the published web link.',
    },
    refresh: {
      type: 'boolean',
      description: 'When command="status", refresh live status from Open Design Cloud.',
    },
  },
};
