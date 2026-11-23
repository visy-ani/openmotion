import type { BrowserPickedElement, BrowserRect } from './browser.ts';

export const SUPER_AGENT_API = '/motion-api/super-agent';

export type SuperAgentEngine = string;
export type SuperAgentPermissionMode = 'on-request' | 'auto';

export type SuperAgentResourceKind =
  | 'asset'
  | 'brand-kit'
  | 'motion-template'
  | 'design-template'
  | 'skill'
  | 'design-skill'
  | 'design-project'
  | 'motion-project'
  | 'workflow'
  | 'model'
  | 'game-project'
  | 'browser-annotation';

export type SuperAgentBrowserAnnotation = {
  mode: 'select' | 'region' | 'draw' | 'screenshot' | 'console';
  pageUrl: string;
  pageTitle?: string;
  comment?: string;
  element?: BrowserPickedElement;
  region?: BrowserRect;
  viewport?: { width: number; height: number };
  strokeCount?: number;
  strokeBounds?: BrowserRect;
  screenshotUrl?: string;
  screenshotPath?: string;
  consoleErrors?: string[];
  artifactId?: string;
  artifactKind?: SuperAgentArtifactKind;
  projectId?: string;
};

export type SuperAgentResourceAttachment = {
  id: string;
  kind: SuperAgentResourceKind;
  title: string;
  subtitle?: string;
  modality?: 'image' | 'video' | 'audio';
  versionId?: string;
  scenario?: string;
  previewUrl?: string;
  swatches?: string[];
  tags?: string[];
  annotation?: SuperAgentBrowserAnnotation;
};

export type SuperAgentResourceCounts = {
  assets: number;
  brandKits: number;
  officialBrandKits: number;
  motionTemplates: number;
  designTemplates: number;
  skills: number;
  designSkills: number;
  designProjects: number;
  motionProjects: number;
  mediaProvidersAvailable: number;
  workflows?: number;
  models?: number;
  games?: number;
};

export type SuperAgentResourceCatalog = {
  counts: SuperAgentResourceCounts;
  items: SuperAgentResourceAttachment[];
  generatedAt: number;
};

export type SuperAgentArtifactKind =
  | 'design-project'
  | 'motion-project'
  | 'motion-export'
  | 'asset-image'
  | 'asset-video'
  | 'asset-audio'
  | 'brand-kit'
  | 'game-project'
  | 'web';

export type SuperAgentArtifact = {
  id: string;
  kind: SuperAgentArtifactKind;
  title: string;
  subtitle?: string;
  projectId?: string;
  sessionId?: string;
  scenario?: string;
  entry?: string;
  revision?: string;
  assetId?: string;
  versionId?: string;
  kitId?: string;
  jobId?: string;
  url?: string;
  downloadUrl?: string;
  mimeType?: string;
  createdAt: number;
  updatedAt: number;
  /** Monotonic timestamp bumped when an artifact is explicitly presented/opened in the Artifact Viewer. */
  presentedAt?: number;
};

export type SuperAgentToolCategory =
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'file_delete'
  | 'command'
  | 'search'
  | 'web'
  | 'mcp'
  | 'agent'
  | 'tool';

export type SuperAgentFileOperation = {
  action: 'read' | 'create' | 'edit' | 'delete' | 'move';
  path: string;
  oldPath?: string;
  lineStart?: number;
  lineEnd?: number;
  addedLines?: number;
  removedLines?: number;
  diffPreview?: string;
};

export type SuperAgentPlanEntry = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'low' | 'medium' | 'high';
};

export type SuperAgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
};

export type SuperAgentTurnActivity = {
  phase: 'connecting' | 'thinking' | 'tool' | 'streaming' | 'waiting_approval';
  label?: string;
  startedAt: number;
  updatedAt: number;
  activeToolName?: string;
  plan?: SuperAgentPlanEntry[];
  usage?: SuperAgentUsage;
};

export type SuperAgentToolEvent = {
  callId: string;
  tool: string;
  label: string;
  status: 'running' | 'completed' | 'failed';
  category?: SuperAgentToolCategory;
  command?: string;
  exitCode?: number;
  fileOp?: SuperAgentFileOperation;
  files?: SuperAgentFileOperation[];
  durationMs?: number;
  summary?: string;
  inputPreview?: string;
  outputPreview?: string;
  artifactId?: string;
  startedAt: number;
  finishedAt?: number;
};

export type SuperAgentMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'reasoning';
  text: string;
  createdAt: number;
  status?: 'streaming' | 'completed';
  durationMs?: number;
  attachments?: SuperAgentResourceAttachment[];
  toolEvent?: SuperAgentToolEvent;
  artifactIds?: string[];
};

export type SuperAgentIntent =
  | 'chat'
  | 'coding'
  | 'image'
  | 'video'
  | 'audio'
  | 'game'
  | 'website'
  | 'slides'
  | 'brand';

export type SuperAgentModeId =
  | 'coding'
  | 'website'
  | 'motion'
  | 'deck'
  | 'game'
  | 'image'
  | 'media'
  | 'audio';

export type SuperAgentApproval = {
  id: string;
  kind: 'generation' | 'command' | 'file' | 'tool';
  title: string;
  detail: string;
};

export type SuperAgentChat = {
  id: string;
  title: string;
  titleCustomized?: boolean;
  intent?: SuperAgentIntent;
  workingDir?: string;
  pinned?: boolean;
  runtimeId?: string;
  engine: SuperAgentEngine;
  model?: string;
  reasoning?: string;
  permissionMode: SuperAgentPermissionMode;
  threadId?: string;
  createdAt: number;
  updatedAt: number;
  state: 'idle' | 'running' | 'waiting' | 'failed' | 'cancelled';
  messages: SuperAgentMessage[];
  artifacts: SuperAgentArtifact[];
  activeArtifactId?: string;
  approvals: SuperAgentApproval[];
  turnActivity?: SuperAgentTurnActivity;
  lastTurnDurationMs?: number;
  lastTurnUsage?: SuperAgentUsage;
  error?: string;
  requestReceipts?: { requestId: string; inputHash: string }[];
};

export type SuperAgentChatSummary = {
  id: string;
  title: string;
  intent?: SuperAgentIntent;
  pinned?: boolean;
  runtimeId?: string;
  engine: SuperAgentEngine;
  state: SuperAgentChat['state'];
  artifactCount: number;
  messageCount: number;
  updatedAt: number;
  createdAt: number;
};

export type SuperAgentTurnInput = {
  requestId: string;
  text: string;
  mode?: SuperAgentModeId;
  workingDir?: string;
  runtimeId?: string;
  engine?: SuperAgentEngine;
  model?: string;
  reasoning?: string;
  permissionMode?: SuperAgentPermissionMode;
  attachments?: SuperAgentResourceAttachment[];
};

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function isSuperAgentId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function normalizeSuperAgentTitle(value: unknown): string {
  if (typeof value !== 'string') return 'New conversation';
  const normalized = value.replace(/\s+/g, ' ').trim().slice(0, 100);
  return normalized || 'New conversation';
}

export const NEW_VIEWER_TAB_ID = '__new__';

export function safeBrowserTabId(artifactId: string): string {
  const cleaned = artifactId.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 80);
  return cleaned || 'web-tab';
}

export function artifactCanonicalAddress(artifact: SuperAgentArtifact): string {
  switch (artifact.kind) {
    case 'design-project':
      return `design://${artifact.projectId ?? artifact.id}`;
    case 'motion-project':
      return `motion://${artifact.projectId ?? artifact.id}`;
    case 'game-project':
      return `game://${artifact.projectId ?? artifact.id}`;
    case 'motion-export':
      return `export://${artifact.jobId ?? artifact.id}`;
    case 'asset-image':
    case 'asset-video':
    case 'asset-audio':
      return `asset://${artifact.assetId ?? artifact.id}${artifact.versionId ? `/${artifact.versionId}` : ''}`;
    case 'brand-kit':
      return `brand://${artifact.kitId ?? artifact.id}`;
    case 'web':
      return artifact.url || 'about:blank';
  }
}

export function formatSuperAgentToolLabel(tool: string, args?: Record<string, unknown>): string {
  const normalized = tool.replace(/^mcp_+openmotion_+/, '');
  const action = typeof args?.action === 'string' ? args.action : '';
  switch (normalized) {
    case 'openmotion_workspace_resources':
      return 'Scanned workspace resources';
    case 'openmotion_asset_models':
      return 'Inspected configured media models';
    case 'openmotion_read_workflow':
      return 'Read workflow guidance';
    case 'openmotion_present_artifact':
      return 'Opened artifact in Browser Viewer';
    case 'openmotion_design_catalog':
      return action === 'list_design_systems' || action === 'get_design_system'
        ? 'Browsed design systems'
        : action === 'list_templates' || action === 'get_template'
          ? 'Browsed design templates'
          : action === 'list_skills' || action === 'get_skill'
            ? 'Read design skill'
            : 'Explored Design Studio catalog';
    case 'openmotion_design_project':
      if (action === 'create') return 'Created HTML design project';
      if (action === 'open') return 'Prepared HTML design preview';
      if (action === 'export') return 'Exported HTML design';
      if (action === 'duplicate') return 'Duplicated design project';
      return 'Managed HTML design project';
    case 'openmotion_design_edit':
      if (action === 'write') return 'Updated HTML/CSS/JS source';
      if (action === 'read_file') return 'Read design source file';
      if (action === 'restore_version') return 'Restored design version';
      return 'Inspected design project files';
    case 'openmotion_design_comments':
      return 'Updated design annotations';
    case 'openmotion_game_create':
      return 'Created interactive game project';
    case 'openmotion_game_get':
      return 'Inspected game files & state';
    case 'openmotion_game_read_file':
      return 'Read game source file';
    case 'openmotion_game_write_files':
      return 'Updated game source files';
    case 'openmotion_game_update_meta':
      return 'Updated game metadata';
    case 'openmotion_game_capture_cover':
      return 'Captured game cover';
    case 'openmotion_game_playtest':
      return 'Playtested interactive game';
    case 'openmotion_game_simulate':
      return 'Simulated game logic';
    case 'openmotion_game_trailer':
      return 'Generated game trailer';
    case 'openmotion_game_validate':
      return 'Validated game build';
    case 'openmotion_game_set_status':
      return 'Updated game status';
    case 'openmotion_game_publish':
      return 'Published playable game';
    case 'openmotion_create_project':
      return 'Created Motion Studio project';
    case 'openmotion_get_project':
      return args?.projectId ? 'Inspected Motion project' : 'Listed Motion projects';
    case 'openmotion_edit_project':
      return 'Updated Motion composition';
    case 'openmotion_open_preview':
      return args?.target === 'providers'
        ? 'Prepared provider setup'
        : args?.target === 'templates'
          ? 'Prepared template library'
          : 'Prepared Motion Studio preview';
    case 'openmotion_export_request':
      return 'Queued Motion MP4 export';
    case 'openmotion_export_cancel':
      return 'Cancelled Motion export';
    case 'openmotion_list_versions':
      return 'Listed Motion project versions';
    case 'openmotion_restore_version':
      return 'Restored Motion project version';
    case 'openmotion_import_assets':
      return 'Imported files into Motion project';
    case 'openmotion_list_templates':
    case 'openmotion_get_template':
      return 'Browsed Motion templates';
    case 'openmotion_list_skills':
    case 'openmotion_get_skill':
      return 'Read creative Skills';
    case 'openmotion_assets_use':
    case 'openmotion_assets':
      if (action === 'generate') return 'Generated workspace media asset';
      if (action === 'read') return 'Inspected media asset';
      if (action === 'brand_kit') return 'Worked with Brand Kit';
      if (action === 'status') return 'Checked media generation job';
      if (action === 'import_to_project') return 'Adopted asset into Motion project';
      if (action === 'scenario') return 'Updated multi-step workflow run';
      if (action === 'transcript') return 'Processed speech transcript or captions';
      return 'Managed workspace assets';
    case 'openmotion_media_use':
      if (action === 'generate') return 'Generated media';
      if (action === 'models') return 'Listed media models';
      if (action === 'inspect') return 'Checked media providers';
      return 'Checked media gateway';
    case 'openmotion_project_archive':
      return 'Managed project archive';
    case 'openmotion_manage_project':
      return 'Organized workspace projects';
    default:
      return normalized.replace(/^openmotion_/, '').replaceAll('_', ' ');
  }
}

export function countUnifiedDiffStats(unifiedDiff: string): { addedLines: number; removedLines: number } {
  let addedLines = 0;
  let removedLines = 0;
  for (const line of unifiedDiff.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) addedLines += 1;
    else if (line.startsWith('-')) removedLines += 1;
  }
  return { addedLines, removedLines };
}

export function buildUnifiedDiffPreview(
  oldText: string,
  newText: string,
  maxChars = 4000,
): { addedLines: number; removedLines: number; diffPreview: string } {
  const normOld = (oldText || '').replace(/\r\n/g, '\n');
  const normNew = (newText || '').replace(/\r\n/g, '\n');
  if (normOld === normNew) {
    return { addedLines: 0, removedLines: 0, diffPreview: '' };
  }
  const oldLines = normOld ? normOld.split('\n') : [];
  const newLines = normNew ? normNew.split('\n') : [];

  if (!oldLines.length) {
    const out = newLines.map(line => `+${line}`).join('\n');
    return {
      addedLines: newLines.length,
      removedLines: 0,
      diffPreview: out.length > maxChars ? `${out.slice(0, maxChars)}\n…` : out,
    };
  }
  if (!newLines.length) {
    const out = oldLines.map(line => `-${line}`).join('\n');
    return {
      addedLines: 0,
      removedLines: oldLines.length,
      diffPreview: out.length > maxChars ? `${out.slice(0, maxChars)}\n…` : out,
    };
  }

  // Fast bounded LCS diff for readable inline hunks; falls back to coarse hunk if very large.
  if (oldLines.length * newLines.length > 90_000) {
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix
      && suffix < newLines.length - prefix
      && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) suffix++;
    const removed = oldLines.slice(prefix, oldLines.length - suffix);
    const added = newLines.slice(prefix, newLines.length - suffix);
    const outLines = [
      `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
      ...removed.map(line => `-${line}`),
      ...added.map(line => `+${line}`),
    ];
    const joined = outLines.join('\n');
    return {
      addedLines: added.length,
      removedLines: removed.length,
      diffPreview: joined.length > maxChars ? `${joined.slice(0, maxChars)}\n…` : joined,
    };
  }

  const m = oldLines.length;
  const n = newLines.length;
  const dp = new Int32Array((m + 1) * (n + 1));
  const width = n + 1;
  for (let i = m - 1; i >= 0; i--) {
    const row = i * width;
    const nextRow = (i + 1) * width;
    for (let j = n - 1; j >= 0; j--) {
      dp[row + j] = oldLines[i] === newLines[j]
        ? dp[nextRow + j + 1] + 1
        : Math.max(dp[nextRow + j], dp[row + j + 1]);
    }
  }

  const ops: { type: 'eq' | 'del' | 'add'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'eq', line: oldLines[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push({ type: 'del', line: oldLines[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: newLines[j] });
      j++;
    }
  }
  while (i < m) ops.push({ type: 'del', line: oldLines[i++] });
  while (j < n) ops.push({ type: 'add', line: newLines[j++] });

  let addedLines = 0;
  let removedLines = 0;
  const rendered: string[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    if (op.type === 'add') {
      addedLines++;
      rendered.push(`+${op.line}`);
    } else if (op.type === 'del') {
      removedLines++;
      rendered.push(`-${op.line}`);
    } else {
      const nearChange = ops.slice(Math.max(0, idx - 2), Math.min(ops.length, idx + 3)).some(o => o.type !== 'eq');
      if (nearChange) rendered.push(` ${op.line}`);
    }
  }
  const diffPreview = rendered.join('\n');
  return {
    addedLines,
    removedLines,
    diffPreview: diffPreview.length > maxChars ? `${diffPreview.slice(0, maxChars)}\n…` : diffPreview,
  };
}

export type SuperAgentToolClassificationMeta = {
  kind?: string;
  title?: string;
  locations?: Array<{ path?: string; line?: number }>;
  diffs?: Array<{ path?: string; oldText?: string; newText?: string }>;
};

function firstString(...candidates: unknown[]): string | undefined {
  for (const val of candidates) {
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return undefined;
}

function firstNumber(...candidates: unknown[]): number | undefined {
  for (const val of candidates) {
    if (typeof val === 'number' && Number.isFinite(val)) return val;
  }
  return undefined;
}

function shortTargetName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || filePath;
}

export function classifySuperAgentTool(
  tool: string,
  args: Record<string, unknown> = {},
  acpMeta?: SuperAgentToolClassificationMeta,
): {
  category: SuperAgentToolCategory;
  label: string;
  summary?: string;
  command?: string;
  fileOp?: SuperAgentFileOperation;
  files?: SuperAgentFileOperation[];
} {
  const rawName = (tool || 'tool').trim();
  const normalized = rawName.replace(/^mcp_+openmotion_+/, '');
  const lower = normalized.toLowerCase();
  const action = typeof args.action === 'string' ? args.action : '';

  const buildDiffFiles = (): SuperAgentFileOperation[] | undefined => {
    if (!acpMeta?.diffs?.length) return undefined;
    return acpMeta.diffs
      .filter(d => typeof d.path === 'string' && d.path.trim())
      .map(d => {
        const oldStr = typeof d.oldText === 'string' ? d.oldText : '';
        const newStr = typeof d.newText === 'string' ? d.newText : '';
        const act: SuperAgentFileOperation['action'] = !oldStr ? 'create' : !newStr ? 'delete' : 'edit';
        const stats = buildUnifiedDiffPreview(oldStr, newStr);
        return {
          action: act,
          path: d.path!.trim(),
          addedLines: stats.addedLines,
          removedLines: stats.removedLines,
          ...(stats.diffPreview ? { diffPreview: stats.diffPreview } : {}),
        };
      });
  };

  // 1. OpenMotion first-class MCP tools
  if (normalized.startsWith('openmotion_')) {
    const humanLabel = formatSuperAgentToolLabel(normalized, args);
    if (normalized === 'openmotion_design_edit') {
      const filePath = firstString(args.path, Array.isArray(args.files) ? (args.files[0] as any)?.path : undefined);
      if (action === 'write' && filePath) {
        const content = firstString(args.content);
        const op: SuperAgentFileOperation = {
          action: 'edit',
          path: filePath,
          ...(content ? { addedLines: content.split('\n').length } : {}),
        };
        return { category: 'file_edit', label: humanLabel, summary: filePath, fileOp: op, files: [op] };
      }
      if (action === 'read_file' && filePath) {
        const op: SuperAgentFileOperation = { action: 'read', path: filePath };
        return { category: 'file_read', label: humanLabel, summary: filePath, fileOp: op };
      }
    }
    if (normalized === 'openmotion_game_write_files' || normalized === 'openmotion_game_read_file') {
      const filePath = firstString(args.path, Array.isArray(args.files) ? (args.files[0] as any)?.path : undefined);
      const isRead = normalized === 'openmotion_game_read_file';
      const op: SuperAgentFileOperation | undefined = filePath
        ? { action: isRead ? 'read' : 'edit', path: filePath }
        : undefined;
      return {
        category: isRead ? 'file_read' : 'file_edit',
        label: humanLabel,
        ...(filePath ? { summary: filePath } : {}),
        ...(op ? { fileOp: op, ...(!isRead ? { files: [op] } : {}) } : {}),
      };
    }
    return {
      category: 'mcp',
      label: humanLabel,
      summary: firstString(args.title, args.projectId, args.url, action),
    };
  }

  const argPath = firstString(
    args.Path,
    args.path,
    args.TargetFile,
    args.target_file,
    args.file_path,
    args.filePath,
    args.AbsolutePath,
    args.DirectoryPath,
    args.SearchPath,
    acpMeta?.locations?.[0]?.path,
  );
  const startLine = firstNumber(args.StartLine, args.start_line, args.offset, acpMeta?.locations?.[0]?.line);
  const endLine = firstNumber(args.EndLine, args.end_line);
  const cmdStr = firstString(args.CommandLine, args.command, args.cmd);

  // 2. Shell / command execution tools (Codex commandExecution, Claude Bash, Antigravity run_command, ACP execute)
  if (
    lower === 'run_command'
    || lower === 'bash'
    || lower === 'commandexecution'
    || lower === 'command_execution'
    || lower === 'shell'
    || lower === 'exec'
    || acpMeta?.kind === 'execute'
    || Boolean(cmdStr && lower.includes('command'))
  ) {
    const command = cmdStr || firstString(acpMeta?.title) || rawName;
    const label = acpMeta?.title && acpMeta.title !== rawName
      ? acpMeta.title
      : firstString(args.toolSummary, args.description) || 'Executed command';
    return {
      category: 'command',
      label,
      command,
      summary: command,
    };
  }

  // 3. File creation tools (Write, write_to_file, write_file)
  if (lower === 'write_to_file' || lower === 'write_file' || lower === 'write' || lower === 'create_file') {
    const content = firstString(args.CodeContent, args.Content, args.content);
    const addedLines = content ? content.replace(/\r\n/g, '\n').split('\n').length : 0;
    const diffPreview = content ? buildUnifiedDiffPreview('', content).diffPreview : undefined;
    const files = buildDiffFiles() ?? (argPath ? [{
      action: 'create' as const,
      path: argPath,
      addedLines,
      removedLines: 0,
      ...(diffPreview ? { diffPreview } : {}),
    }] : undefined);
    const op = files?.[0];
    return {
      category: 'file_write',
      label: argPath ? `Created ${shortTargetName(argPath)}` : acpMeta?.title || 'Created file',
      summary: argPath,
      ...(op ? { fileOp: op } : {}),
      ...(files ? { files } : {}),
    };
  }

  // 4. File edit tools (Edit, MultiEdit, replace_file_content, multi_replace_file_content, edit_file, sed_file, fileChange)
  if (
    lower === 'edit'
    || lower === 'multiedit'
    || lower === 'edit_file'
    || lower === 'replace_file_content'
    || lower === 'multi_replace_file_content'
    || lower === 'sed_file'
    || lower === 'notebookedit'
    || lower === 'notebook_edit'
    || lower === 'filechange'
    || lower === 'file_change'
    || acpMeta?.kind === 'edit'
    || acpMeta?.kind === 'move'
  ) {
    const oldChunk = firstString(args.old_string, args.TargetContent, args.Target) ?? '';
    const newChunk = firstString(args.new_string, args.ReplacementContent, args.Replacement) ?? '';
    const diffFromArgs = (oldChunk || newChunk) ? buildUnifiedDiffPreview(oldChunk, newChunk) : undefined;
    const files = buildDiffFiles() ?? (argPath ? [{
      action: 'edit' as const,
      path: argPath,
      ...(startLine !== undefined ? { lineStart: startLine } : {}),
      ...(endLine !== undefined ? { lineEnd: endLine } : {}),
      ...(diffFromArgs ? {
        addedLines: diffFromArgs.addedLines,
        removedLines: diffFromArgs.removedLines,
        diffPreview: diffFromArgs.diffPreview,
      } : {}),
    }] : undefined);
    const op = files?.[0];
    return {
      category: 'file_edit',
      label: argPath ? `Edited ${shortTargetName(argPath)}` : acpMeta?.title || 'Edited files',
      summary: argPath,
      ...(op ? { fileOp: op } : {}),
      ...(files ? { files } : {}),
    };
  }

  // 5. File deletion
  if (lower === 'delete_file' || lower === 'remove_file' || acpMeta?.kind === 'delete') {
    const files = buildDiffFiles() ?? (argPath ? [{ action: 'delete' as const, path: argPath }] : undefined);
    return {
      category: 'file_delete',
      label: argPath ? `Deleted ${shortTargetName(argPath)}` : acpMeta?.title || 'Deleted file',
      summary: argPath,
      ...(files?.[0] ? { fileOp: files[0] } : {}),
      ...(files ? { files } : {}),
    };
  }

  // 6. File / directory read tools
  if (
    lower === 'read_file'
    || lower === 'view_file'
    || lower === 'read'
    || lower === 'ls'
    || lower === 'list_dir'
    || acpMeta?.kind === 'read'
  ) {
    const op: SuperAgentFileOperation | undefined = argPath
      ? {
          action: 'read',
          path: argPath,
          ...(startLine !== undefined ? { lineStart: startLine } : {}),
          ...(endLine !== undefined ? { lineEnd: endLine } : {}),
        }
      : undefined;
    const isDir = lower === 'ls' || lower === 'list_dir';
    return {
      category: 'file_read',
      label: argPath
        ? `${isDir ? 'Listed' : 'Read'} ${shortTargetName(argPath)}`
        : acpMeta?.title || (isDir ? 'Listed directory' : 'Read file'),
      summary: argPath,
      ...(op ? { fileOp: op } : {}),
    };
  }

  // 7. Codebase search tools
  if (
    lower === 'grep_search'
    || lower === 'grep'
    || lower === 'glob'
    || lower === 'find_by_name'
    || lower === 'search_files'
    || acpMeta?.kind === 'search'
  ) {
    const q = firstString(args.Query, args.Pattern, args.pattern, args.query, argPath);
    return {
      category: 'search',
      label: q ? `Searched ${q}` : acpMeta?.title || 'Searched workspace',
      summary: q,
    };
  }

  // 8. Web / browser tools
  if (
    lower === 'search_web'
    || lower === 'websearch'
    || lower === 'web_search'
    || lower === 'webfetch'
    || lower === 'web_fetch'
    || lower === 'read_url_content'
    || lower === 'open_browser_url'
    || lower.startsWith('browser_')
    || acpMeta?.kind === 'fetch'
  ) {
    const q = firstString(args.query, args.url, args.Url);
    return {
      category: 'web',
      label: q ? (lower.includes('search') ? `Searched web: ${q}` : `Fetched ${q}`) : acpMeta?.title || 'Web tool',
      summary: q,
    };
  }

  // 9. Subagent delegation
  if (lower === 'invoke_subagent' || lower === 'task' || lower === 'agent') {
    const desc = firstString(args.Role, args.description, args.subagent_type, args.TypeName);
    return {
      category: 'agent',
      label: desc ? `Subagent: ${desc}` : acpMeta?.title || 'Delegated subagent',
      summary: desc,
    };
  }

  // 10. External MCP tools (`mcp__server__tool` or `call_mcp_tool`)
  if (rawName.startsWith('mcp__') || lower === 'call_mcp_tool' || lower === 'mcptoolcall') {
    const mcpTool = firstString(args.ToolName, args.toolName) || normalized.replace(/^mcp__/, '').replaceAll('__', ' · ');
    return {
      category: 'mcp',
      label: acpMeta?.title && acpMeta.title !== rawName ? acpMeta.title : mcpTool,
      summary: firstString(args.ServerName, args.serverName),
    };
  }

  // Fallback
  const files = buildDiffFiles();
  return {
    category: files?.length ? 'file_edit' : 'tool',
    label: acpMeta?.title && acpMeta.title.trim() ? acpMeta.title.trim() : normalized.replaceAll('_', ' '),
    summary: firstString(argPath, cmdStr, args.query, args.description),
    ...(files?.[0] ? { fileOp: files[0] } : {}),
    ...(files ? { files } : {}),
  };
}

export function modeToSuperAgentIntent(mode?: SuperAgentModeId): SuperAgentIntent | undefined {
  switch (mode) {
    case 'coding':
      return 'coding';
    case 'image':
      return 'image';
    case 'motion':
    case 'media':
      return 'video';
    case 'audio':
      return 'audio';
    case 'game':
      return 'game';
    case 'website':
      return 'website';
    case 'deck':
      return 'slides';
    default:
      return undefined;
  }
}

export function artifactToSuperAgentIntent(
  artifact: Pick<SuperAgentArtifact, 'kind' | 'scenario' | 'title'>,
): SuperAgentIntent | undefined {
  switch (artifact.kind) {
    case 'game-project':
      return 'game';
    case 'motion-project':
    case 'motion-export':
    case 'asset-video':
      return 'video';
    case 'asset-image':
      return 'image';
    case 'asset-audio':
      return 'audio';
    case 'brand-kit':
      return 'brand';
    case 'design-project':
      return artifact.scenario === 'deck' || artifact.scenario === 'document' ? 'slides' : 'website';
    default:
      return undefined;
  }
}

const CODING_TOOL_CATEGORIES = new Set<SuperAgentToolCategory>([
  'command',
  'file_read',
  'file_write',
  'file_edit',
  'file_delete',
  'search',
]);

export function detectIntentFromPrompt(
  text: string,
  attachments?: SuperAgentResourceAttachment[],
): SuperAgentIntent {
  const source = (text || '').trim();
  if (/^\[(?:Mode:\s*Coding|Coding:)/i.test(source)) return 'coding';
  if (/^\[Mode:\s*Image Artwork/i.test(source)) return 'image';
  if (/^\[Mode:\s*(?:Motion graphics|AI Cinema Video)/i.test(source)) return 'video';
  if (/^\[Mode:\s*Audio & Sound/i.test(source)) return 'audio';
  if (/^\[Mode:\s*HTML Game/i.test(source)) return 'game';
  if (/^\[Mode:\s*Website & App/i.test(source)) return 'website';
  if (/^\[Mode:\s*Slides & Docs/i.test(source)) return 'slides';

  // Explicit OpenMotion tool names or attached game projects always map to their creative domain first
  if (
    /\bopenmotion_game_|openmotion-game|openmotion:\/\/workflow\/game\//i.test(source)
    || attachments?.some(att => att.kind === 'game-project')
  ) {
    return 'game';
  }
  if (/\bopenmotion_design_/i.test(source)) return 'website';
  if (/\bopenmotion_(?:create_project|edit_project|export_request)\b/i.test(source)) return 'video';

  // Strong software-engineering cues (non-HTML source files, CLIs, bugfix/refactor/test tasks)
  if (
    /\b(?:git|npm|pnpm|npx|yarn|vitest|pytest|cargo|rustc|go test|node -v|node --|bash|zsh|shell|terminal|cli|debug|refactor|typecheck|lint|compile|unit test|bugfix|bug fix|fix (?:the |a |this )?bug|stack trace|pull request|git diff|code review)\b/i.test(source)
    || /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cpp|c|h|css|scss|sh|json|yaml|yml)\b/i.test(source)
    || /(?:写代码|重构|调试|修\s*bug|修复.*?(?:bug|报错|问题|类型)|单元测试|单测|脚本|终端|命令行|报错|编译|类型检查)/i.test(source)
  ) {
    return 'coding';
  }

  // Creative deliverables
  if (/(?:\b(?:arcade|shooter|puzzle|webgl|playable)\s+)?\bgame\b|小游戏|写个游戏|做个游戏|游戏|射击游戏|闯关|联机游戏/i.test(source)) {
    return 'game';
  }
  if (/(?:landing page|dashboard|\bwebsite\b|web app|mobile app|\bprototype\b|网站|网页|落地页|仪表盘|原型)/i.test(source)) {
    return 'website';
  }
  if (/(?:pitch deck|\bslides?\b|presentation|\bpptx\b|幻灯片|演示文稿|\bppt\b|商业计划书)/i.test(source)) {
    return 'slides';
  }
  if (/(?:\b(?:motion video|hyperframes|seedance|cinema)\b|\bmp4\b|video reel|视频|短片|动效|宣传片|剪辑|动画)/i.test(source)) {
    return 'video';
  }
  if (/(?:\b(?:generate|create|edit|remove background|relight)\b.{0,24}\b(?:image|poster|illustration|artwork|photo|thumbnail)\b|生成.*?(?:图|海报|插画)|生图|画一张|修图|海报)/i.test(source)) {
    return 'image';
  }
  if (/(?:\b(?:soundtrack|music|audio|voiceover|sfx|tts|narration|podcast)\b|音乐|配乐|音效|配音|旁白|音频|播客)/i.test(source)) {
    return 'audio';
  }
  if (/(?:\bbrand[- ]?kit\b|\bdesign system\b|品牌套件|品牌规范|配色方案)/i.test(source)) {
    return 'brand';
  }

  // General coding fallback (when not clearly a creative asset prompt)
  if (/(?:\b(?:diff|script|repo|repository|codebase)\b|代码|编程|接口|函数)/i.test(source)) {
    return 'coding';
  }

  if (attachments?.length) {
    const first = attachments[0];
    if (first.kind === 'game-project') return 'game';
    if (first.kind === 'motion-project' || first.kind === 'motion-template' || first.modality === 'video') return 'video';
    if (first.modality === 'image') return 'image';
    if (first.modality === 'audio') return 'audio';
    if (first.kind === 'brand-kit') return 'brand';
    if (first.kind === 'design-project' || first.kind === 'design-template') {
      return first.scenario === 'deck' || first.scenario === 'document' ? 'slides' : 'website';
    }
  }

  return 'chat';
}

export function inferSuperAgentIntent(
  chat: Pick<SuperAgentChat, 'intent' | 'artifacts' | 'messages' | 'title'>,
): SuperAgentIntent {
  const artifacts = chat.artifacts ?? [];
  if (artifacts.length > 0) {
    const primary = [...artifacts].reverse().find(a => a.kind !== 'web') ?? artifacts[artifacts.length - 1];
    const fromArtifact = primary ? artifactToSuperAgentIntent(primary) : undefined;
    if (fromArtifact) return fromArtifact;
  }

  if (chat.intent && chat.intent !== 'chat') {
    return chat.intent;
  }

  let sawCodingTool = false;
  for (const msg of chat.messages ?? []) {
    if (msg.role !== 'tool' || !msg.toolEvent) continue;
    const rawTool = msg.toolEvent.tool.replace(/^mcp_+openmotion_+/, '');
    if (rawTool.startsWith('openmotion_game_')) return 'game';
    if (rawTool.startsWith('openmotion_design_')) return 'website';
    if (rawTool === 'openmotion_create_project' || rawTool === 'openmotion_edit_project' || rawTool === 'openmotion_export_request') {
      return 'video';
    }
    if (!rawTool.startsWith('openmotion_') && msg.toolEvent.category && CODING_TOOL_CATEGORIES.has(msg.toolEvent.category)) {
      sawCodingTool = true;
    }
  }
  if (sawCodingTool) return 'coding';

  const firstUser = (chat.messages ?? []).find(m => m.role === 'user');
  if (firstUser) {
    return detectIntentFromPrompt(firstUser.text, firstUser.attachments);
  }
  return chat.intent ?? 'chat';
}

const GENERIC_TITLES = new Set([
  'new conversation',
  'new task',
  'artifact',
  'untitled',
  'hello',
  'hi',
  'hey',
  'test',
  '你好',
  '您好',
  '测试',
]);

const GENERIC_HEADINGS = new Set([
  'summary',
  'overview',
  'result',
  'results',
  'execution summary',
  'what was built',
  'final file contents',
  'references',
  'notes',
  'next steps',
  '总结',
  '概述',
  '结果',
  '参考',
]);

export function isGenericSuperAgentTitle(title?: string): boolean {
  const trimmed = (title ?? '').trim();
  return !trimmed || GENERIC_TITLES.has(trimmed.toLowerCase());
}

function stripPromptNoise(raw: string): string {
  let cleaned = raw
    .replace(/^\[(?:Mode|Coding):[^\]]*\]\s*/i, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const gameBriefMatch = cleaned.match(/^Use the openmotion-game Skill[\s\S]*?\bBrief:\s*([^\n]+?)(?:\s+(?:Ask at most|Propose a visual|Set building|Read openmotion|$))/i);
  if (gameBriefMatch?.[1]?.trim()) {
    return gameBriefMatch[1].trim();
  }

  cleaned = cleaned
    .replace(/^(?:(?:can you |could you )?please(?: help(?: me)?)?|help me|use\s+openmotion_[a-z0-9_]+(?:\s+and\s+openmotion_[a-z0-9_]+)*\s+to|call\s+openmotion_[a-z0-9_]+(?:\s+with\s+[^\s,]+)?\s+(?:and|to)?)\s+/i, '')
    .replace(/^(?:请帮我|麻烦帮我|麻烦你|能否帮我|请你|帮我|我想)\s*/, '')
    .trim();

  return cleaned;
}

function clipTitle(raw: string, maxLen = 48): string {
  const oneSentence = raw.split(/[。！？\n]|(?:\.\s)/)[0]?.trim() ?? raw.trim();
  const text = (oneSentence || raw).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  const sliced = text.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(' ');
  if (lastSpace >= Math.floor(maxLen * 0.55)) {
    return sliced.slice(0, lastSpace).trim();
  }
  return sliced.trim();
}

export function generateSuperAgentTitle(input: {
  prompt?: string;
  intent?: SuperAgentIntent;
  artifactTitle?: string;
  assistantText?: string;
  currentTitle?: string;
}): string {
  const current = (input.currentTitle ?? '').trim();
  const currentLower = current.toLowerCase();
  const currentIsGeneric = !current || GENERIC_TITLES.has(currentLower);
  const currentIsNoisy = /^\[(?:Mode|Coding):/i.test(current) || current.length > 48 || /\bopenmotion_[a-z_]+/i.test(current);

  const promptClean = input.prompt ? stripPromptNoise(input.prompt) : '';
  const promptWasLongOrComplex = Boolean(input.prompt && (promptClean.length > 42 || input.prompt.length > 60 || /\bopenmotion_[a-z_]+/i.test(input.prompt)));

  const artifact = (input.artifactTitle ?? '').trim();
  if (artifact && !GENERIC_TITLES.has(artifact.toLowerCase()) && artifact.toLowerCase() !== 'new project') {
    if (currentIsGeneric || currentIsNoisy || promptWasLongOrComplex || !input.prompt) {
      return normalizeSuperAgentTitle(clipTitle(artifact));
    }
  }

  if (promptClean && !GENERIC_TITLES.has(promptClean.toLowerCase())) {
    if (!current || currentIsGeneric || currentIsNoisy) {
      return normalizeSuperAgentTitle(clipTitle(promptClean));
    }
    return normalizeSuperAgentTitle(current);
  }

  if (input.assistantText) {
    const headingMatch = input.assistantText.match(/^#{1,3}\s+(.+)$/m);
    const heading = headingMatch?.[1]?.replace(/[`*_]/g, '').trim();
    if (heading && !GENERIC_HEADINGS.has(heading.toLowerCase()) && !GENERIC_TITLES.has(heading.toLowerCase())) {
      return normalizeSuperAgentTitle(clipTitle(heading));
    }
  }

  if (promptClean) {
    return normalizeSuperAgentTitle(clipTitle(promptClean));
  }
  if (current) {
    return normalizeSuperAgentTitle(current);
  }
  return 'New conversation';
}

export function superAgentIntentMeta(intent?: SuperAgentIntent): {
  icon: string;
  tone: 'neutral' | 'coding' | 'image' | 'video' | 'audio' | 'agent';
  label: string;
} {
  switch (intent) {
    case 'coding':
      return { icon: 'code-s-slash-line', tone: 'coding', label: 'Coding' };
    case 'image':
      return { icon: 'image-line', tone: 'image', label: 'Image' };
    case 'video':
      return { icon: 'movie-line', tone: 'video', label: 'Video' };
    case 'audio':
      return { icon: 'music-2-line', tone: 'audio', label: 'Audio' };
    case 'game':
      return { icon: 'gamepad-line', tone: 'agent', label: 'Game' };
    case 'website':
      return { icon: 'layout-line', tone: 'agent', label: 'Website & App' };
    case 'slides':
      return { icon: 'slideshow-line', tone: 'audio', label: 'Slides & Docs' };
    case 'brand':
      return { icon: 'palette-line', tone: 'image', label: 'Brand Kit' };
    case 'chat':
    default:
      return { icon: 'chat-1-line', tone: 'neutral', label: 'Chat' };
  }
}
