import { Dialog } from '@base-ui/react/dialog';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LOCAL_DIRECT_RUNTIME_ID, type AgentRuntimeInfo } from '../../../shared/agent-runtimes';
import { assetMediaUrl } from '../../../shared/asset-library';
import type { SuperAgentHandoffPayload } from '../../../shared/capability-hub';
import { designRoutes } from '../../../shared/design-project';
import type { GameCard } from '../../../shared/game-contract';
import {
  NEW_VIEWER_TAB_ID,
  safeBrowserTabId,
  type SuperAgentArtifact,
  type SuperAgentChat,
  type SuperAgentChatSummary,
  type SuperAgentIntent,
  type SuperAgentPermissionMode,
  type SuperAgentResourceAttachment,
  type SuperAgentResourceCatalog,
} from '../../../shared/super-agent';
import { StudioToastViewport } from '../components/StudioToastViewport';
import { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { RouteSurfaceFallback } from '../motion/RouteSurfaceFallback';
import { consumeSuperAgentHandoff, subscribeSuperAgentHandoff } from '../motion/superAgentHandoff';
import { bundledGames, communityGames, gameApi } from '../motion/game/gameCatalog';
import { localizedGameTitle, toGameArtifact, toGameResourceAttachment } from '../motion/game/gameSuperAgent';
import { openAgentRuntimesSettings, useAgentRuntimes } from '../motion/useAgentRuntimes';
import { useLocalAgents } from '../motion/useLocalAgents';
import { preloadableLazyWithChunkReload } from '../utils/chunkReload';
import { ConversationSidebar } from './ConversationSidebar';
import { ConversationStream, type AgentSelection } from './ConversationStream';
import type { SuperAgentCreationModeId } from './ModeResourceShowcase';
import { resourceKey } from './ResourcePickerDialog';
import {
  approveSuperAgentAction,
  closeSuperAgentBrowserTab,
  createSuperAgentChat,
  deleteSuperAgentChat,
  fetchWorkspaceResources,
  getSuperAgentChat,
  listSuperAgentChats,
  startSuperAgentTurn,
  stopSuperAgentChat,
  subscribeSuperAgentChat,
  updateSuperAgentChat,
} from './superAgentClient';
import './superAgent.css';

const ArtifactBrowserPane = preloadableLazyWithChunkReload(() =>
  import('./ArtifactBrowserPane').then(m => ({ default: m.ArtifactBrowserPane })),
);

export const preloadArtifactBrowserPane = ArtifactBrowserPane.preload;

const MIN_CENTER_WIDTH = 300;
const MIN_VIEWER_WIDTH = 320;
const RESIZER_WIDTH = 1;
const COMPACT_THREE_PANE_WIDTH = 1180;

export function clampSuperAgentViewerWidth(
  desiredWidth: number,
  totalWidth: number,
  sidebarWidth: number,
): number {
  const desired = Math.round(desiredWidth);
  if (totalWidth <= 0) {
    return Math.max(MIN_VIEWER_WIDTH, Math.min(960, desired));
  }
  const available = Math.max(0, Math.floor(totalWidth - sidebarWidth - RESIZER_WIDTH));
  if (available <= MIN_CENTER_WIDTH + MIN_VIEWER_WIDTH) {
    return Math.max(240, Math.floor(available * 0.55));
  }
  const maxViewer = Math.max(
    MIN_VIEWER_WIDTH,
    Math.min(Math.floor(available * 0.72), available - MIN_CENTER_WIDTH),
  );
  return Math.max(MIN_VIEWER_WIDTH, Math.min(maxViewer, desired));
}

function upsertSummary(
  list: SuperAgentChatSummary[],
  chat: SuperAgentChat,
): SuperAgentChatSummary[] {
  const summary: SuperAgentChatSummary = {
    id: chat.id,
    title: chat.title,
    intent: chat.intent,
    ...(chat.pinned ? { pinned: true } : {}),
    engine: chat.engine,
    state: chat.state,
    artifactCount: chat.artifacts.length,
    messageCount: chat.messages.filter(m => m.role !== 'tool' && m.role !== 'reasoning').length,
    updatedAt: chat.updatedAt,
    createdAt: chat.createdAt,
  };
  const next = list.filter(item => item.id !== chat.id);
  next.push(summary);
  next.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
  return next;
}

function resourceToArtifactPatch(
  item: SuperAgentResourceAttachment,
): Partial<SuperAgentArtifact> | null {
  if (item.kind === 'design-project') {
    return {
      id: `design:${item.id}`,
      kind: 'design-project',
      title: item.title,
      subtitle: item.subtitle,
      projectId: item.id,
      scenario: item.scenario,
      entry: 'index.html',
      url: item.previewUrl || designRoutes.raw(item.id, 'index.html'),
    };
  }
  if (item.kind === 'motion-project') {
    return {
      id: `motion:${item.id}`,
      kind: 'motion-project',
      title: item.title,
      subtitle: item.subtitle || 'Motion Studio',
      projectId: item.id,
    };
  }
  if (item.kind === 'asset' && item.versionId) {
    const kind = item.modality === 'video' ? 'asset-video' : item.modality === 'audio' ? 'asset-audio' : 'asset-image';
    const url = assetMediaUrl(item.id, item.versionId);
    return {
      id: `asset:${item.id}:${item.versionId}`,
      kind,
      title: item.title,
      subtitle: item.subtitle,
      assetId: item.id,
      versionId: item.versionId,
      url,
      downloadUrl: `${url}?download=1`,
    };
  }
  if (item.kind === 'brand-kit') {
    return {
      id: `brand:${item.id}`,
      kind: 'brand-kit',
      title: item.title,
      subtitle: item.subtitle,
      kitId: item.id,
    };
  }
  if (item.kind === 'game-project') {
    return {
      id: `game:${item.id}`,
      kind: 'game-project',
      title: item.title,
      subtitle: item.subtitle || 'Game Studio',
      projectId: item.id,
      url: `/motion-api/games/${encodeURIComponent(item.id)}/play/index.html`,
    };
  }
  return null;
}

function artifactToResourceAttachment(artifact: SuperAgentArtifact): SuperAgentResourceAttachment | null {
  if (artifact.assetId && (artifact.kind === 'asset-image' || artifact.kind === 'asset-video' || artifact.kind === 'asset-audio')) {
    return {
      id: artifact.assetId,
      kind: 'asset',
      title: artifact.title,
      subtitle: artifact.subtitle,
      modality: artifact.kind === 'asset-video' ? 'video' : artifact.kind === 'asset-audio' ? 'audio' : 'image',
      versionId: artifact.versionId,
      previewUrl: artifact.url,
    };
  }
  if (artifact.kind === 'brand-kit' && artifact.kitId) {
    return {
      id: artifact.kitId,
      kind: 'brand-kit',
      title: artifact.title,
      subtitle: artifact.subtitle,
    };
  }
  if (artifact.kind === 'design-project' && artifact.projectId) {
    return {
      id: artifact.projectId,
      kind: 'design-project',
      title: artifact.title,
      subtitle: artifact.subtitle,
      scenario: artifact.scenario,
      previewUrl: artifact.url,
    };
  }
  if (artifact.kind === 'motion-project' && artifact.projectId) {
    return {
      id: artifact.projectId,
      kind: 'motion-project',
      title: artifact.title,
      subtitle: artifact.subtitle,
    };
  }
  if (artifact.kind === 'game-project' && artifact.projectId) {
    return {
      id: artifact.projectId,
      kind: 'game-project',
      title: artifact.title,
      subtitle: artifact.subtitle,
    };
  }
  return null;
}

export function SuperAgentWorkspace({
  active,
  chatId,
  requestedMode = null,
  requestedGameId = null,
  onBack,
  onExitRequestedMode,
  onChatIdChange,
  onOpenDesignProject,
  onOpenMotionProject,
  onOpenGameStudio,
  onOpenAsset,
  onOpenBrandKit,
  onOpenAgentSettings,
  onOpenModelSettings,
  onOpenMcp,
}: {
  active: boolean;
  chatId: string | null;
  requestedMode?: SuperAgentCreationModeId | null;
  requestedGameId?: string | null;
  onBack?: () => void;
  onExitRequestedMode?: () => void;
  onChatIdChange: (id: string | null, replace?: boolean) => void;
  onOpenDesignProject: (projectId: string) => void;
  onOpenMotionProject: (projectId: string) => void;
  onOpenGameStudio?: (gameId?: string) => void;
  onOpenAsset: (assetId: string, versionId?: string) => void;
  onOpenBrandKit: (kitId?: string) => void;
  onOpenAgentSettings: () => void;
  onOpenModelSettings?: () => void;
  onOpenMcp: () => void;
}) {
  const { t, locale } = useI18n();
  const { toasts, showToast, dismissToast } = useToast();
  const { data: agentDir, refresh: refreshAgents } = useLocalAgents();
  const { data: runtimesDir, refresh: refreshRuntimes } = useAgentRuntimes();
  const agents = agentDir?.agents ?? [];

  const availableRuntimes = useMemo<AgentRuntimeInfo[]>(() => {
    if (runtimesDir?.runtimes) {
      return runtimesDir.runtimes.map(rt =>
        rt.kind === 'local-direct' && agents.length > 0
          ? {
              ...rt,
              agents,
              runnableAgentIds: agents.filter(a => a.installed && a.auth !== 'signed-out').map(a => a.id),
            }
          : rt,
      );
    }
    return [
      {
        id: LOCAL_DIRECT_RUNTIME_ID,
        kind: 'local-direct',
        name: 'This computer',
        status: 'online',
        agents,
        runnableAgentIds: agents.filter(a => a.installed && a.auth !== 'signed-out').map(a => a.id),
      },
    ];
  }, [runtimesDir, agents]);

  const [conversations, setConversations] = useState<SuperAgentChatSummary[]>([]);
  const [loadingList, setLoadingList] = useState(() => Boolean(active));
  const [activeChat, setActiveChat] = useState<SuperAgentChat | null>(null);
  const [loadingChat, setLoadingChat] = useState(() => Boolean(active && chatId));
  const [loadFailed, setLoadFailed] = useState(false);
  const [chatRetry, setChatRetry] = useState(0);
  const [sending, setSending] = useState(false);

  const [resourcesCatalog, setResourcesCatalog] = useState<SuperAgentResourceCatalog | null>(null);
  const [attachments, setAttachments] = useState<SuperAgentResourceAttachment[]>([]);
  const [draftSeed, setDraftSeed] = useState<{ id: number; text: string; mode?: SuperAgentCreationModeId } | null>(null);
  const [gameTemplateSeed, setGameTemplateSeed] = useState<{ id: number; game: GameCard } | null>(null);
  const playedGamesRef = useRef<Map<string, GameCard>>(new Map());
  const handoffSeqRef = useRef(0);
  const [pendingAutoSend, setPendingAutoSend] = useState<{ id: number; payload: SuperAgentHandoffPayload } | null>(null);
  const dispatchedHandoffIdsRef = useRef<Set<number>>(new Set());

  const [selection, setSelection] = useState<AgentSelection>({
    engine: 'codex',
    model: 'default',
    reasoning: 'default',
  });
  const [permissionMode, setPermissionMode] = useState<SuperAgentPermissionMode>('on-request');

  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 900px)').matches
      : false,
  );
  const [containerWidth, setContainerWidth] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerExpanded, setViewerExpanded] = useState(false);
  const [viewerWidth, setViewerWidth] = useState<number | null>(null);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>(NEW_VIEWER_TAB_ID);
  const [previewArtifacts, setPreviewArtifacts] = useState<SuperAgentArtifact[]>([]);
  const handledRequestedGameRef = useRef<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const sidebarDockedRef = useRef(true);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const lastArtifactStateRef = useRef<{
    chatId: string | null;
    activeId?: string;
    sig: string;
    artifactIds: string[];
    presentedById: Record<string, number>;
  }>({
    chatId: null,
    sig: '',
    artifactIds: [],
    presentedById: {},
  });
  const prevBusyRef = useRef(false);

  const sidebarAsDrawer = narrow || (
    viewerOpen
    && !viewerExpanded
    && containerWidth > 0
    && containerWidth < COMPACT_THREE_PANE_WIDTH
  );
  const sidebarDocked = !sidebarAsDrawer && sidebarOpen;
  sidebarDockedRef.current = sidebarDocked;

  const prevSidebarAsDrawerRef = useRef(sidebarAsDrawer);
  useEffect(() => {
    if (sidebarAsDrawer && !prevSidebarAsDrawerRef.current) {
      setSidebarOpen(false);
    }
    prevSidebarAsDrawerRef.current = sidebarAsDrawer;
  }, [sidebarAsDrawer]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 900px)');
    const sync = () => {
      setNarrow(mq.matches);
      if (mq.matches) setSidebarOpen(false);
    };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const next = el.clientWidth;
      setContainerWidth(prev => (prev === next ? prev : next));
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [active]);

  // Sync engine/model selection with Settings → Local Agents default (both on initial load and after user changes it)
  const engineInitialized = useRef(false);
  const lastDefaultKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!agentDir || !agents.length) return;
    const def = agentDir.default;
    const nextKey = def ? `${def.agent}:${def.model || 'default'}:${def.reasoning || 'default'}` : '__none__';
    const prevKey = lastDefaultKeyRef.current;
    const defaultChangedByUser = prevKey !== null && nextKey !== prevKey;
    lastDefaultKeyRef.current = nextKey;

    if (def && agents.some(item => item.id === def.agent)) {
      const canAdopt = defaultChangedByUser || prevKey === null || !activeChat || activeChat.messages.length === 0;
      const busy = activeChat?.state === 'running' || activeChat?.state === 'waiting';
      if (canAdopt && !busy) {
        engineInitialized.current = true;
        setSelection({
          engine: def.agent,
          model: def.model?.trim() ? def.model : 'default',
          reasoning: def.reasoning?.trim() ? def.reasoning : 'default',
        });
        return;
      }
    }
    if (engineInitialized.current || activeChat) return;
    const runnable = agents.find(item => item.installed && item.auth !== 'signed-out');
    if (runnable) {
      engineInitialized.current = true;
      setSelection({
        engine: runnable.id,
        model: 'default',
        reasoning: 'default',
      });
    }
  }, [agentDir, agents, activeChat]);

  const refreshResources = useCallback(() => {
    void fetchWorkspaceResources({ limit: 48 })
      .then(setResourcesCatalog)
      .catch(() => { /* keep previous counts */ });
  }, []);

  const refreshConversations = useCallback(() => {
    setLoadingList(true);
    void listSuperAgentChats()
      .then(result => setConversations(Array.isArray(result?.conversations) ? result.conversations : []))
      .catch(() => { /* non-blocking sidebar refresh */ })
      .finally(() => setLoadingList(false));
  }, []);

  useEffect(() => {
    if (!runtimesDir) return;
    const online = runtimesDir.runtimes.filter(item => item.status === 'online');
    if (!online.length) return;
    const busy = activeChat?.state === 'running' || activeChat?.state === 'waiting';
    if (busy) return;

    const currentValid = selection.runtimeId && online.some(item => item.id === selection.runtimeId);
    if (currentValid) return;

    const preferred =
      (runtimesDir.defaultRuntimeId && online.find(item => item.id === runtimesDir.defaultRuntimeId))
      ?? (!runtimesDir.localDirectAvailable ? online.find(item => item.runnableAgentIds.length > 0) ?? online[0] : undefined);
    if (!preferred) return;

    const firstEngine = preferred.runnableAgentIds[0] ?? preferred.agents[0]?.id ?? selection.engine;
    setSelection({
      runtimeId: preferred.id,
      engine: firstEngine,
      model: 'default',
      reasoning: 'default',
    });
  }, [runtimesDir, activeChat, selection.runtimeId, selection.engine]);

  useEffect(() => {
    if (!active) return;
    refreshConversations();
    refreshResources();
    refreshAgents();
    refreshRuntimes();
  }, [active, refreshConversations, refreshResources, refreshAgents, refreshRuntimes]);

  // Apply chat snapshot and sync tabs / agent choices
  const applyChatSnapshot = useCallback((next: SuperAgentChat, isInitialLoad = false) => {
    setActiveChat(next);
    setPreviewArtifacts([]);
    setConversations(prev => upsertSummary(prev, next));
    setPermissionMode(next.permissionMode);

    if (isInitialLoad && next.messages.length > 0) {
      setSelection({
        ...(next.runtimeId ? { runtimeId: next.runtimeId } : {}),
        engine: next.engine,
        model: next.model || 'default',
        reasoning: next.reasoning || 'default',
      });
    }

    const allIds = next.artifacts.map(item => item.id);
    const presentedById: Record<string, number> = {};
    for (const item of next.artifacts) {
      if (typeof item.presentedAt === 'number') {
        presentedById[item.id] = item.presentedAt;
      }
    }
    const sig = next.artifacts
      .map(item => `${item.id}:${item.revision ?? ''}:${item.presentedAt ?? item.updatedAt}`)
      .join('|');
    const prev = lastArtifactStateRef.current;
    const chatSwitched = prev.chatId !== next.id;

    if (chatSwitched) {
      lastArtifactStateRef.current = {
        chatId: next.id,
        activeId: next.activeArtifactId,
        sig,
        artifactIds: allIds,
        presentedById,
      };
      setOpenTabIds(allIds);
      const initialActive = next.activeArtifactId && allIds.includes(next.activeArtifactId)
        ? next.activeArtifactId
        : allIds.at(-1) ?? NEW_VIEWER_TAB_ID;
      setActiveTabId(initialActive);
    } else if (sig !== prev.sig || next.activeArtifactId !== prev.activeId) {
      const newIds = allIds.filter(id => !prev.artifactIds.includes(id));
      const activePresentedAt = next.activeArtifactId ? presentedById[next.activeArtifactId] : undefined;
      const prevActivePresentedAt = next.activeArtifactId ? (prev.presentedById[next.activeArtifactId] ?? 0) : 0;
      const activeRePresented = activePresentedAt !== undefined && activePresentedAt > prevActivePresentedAt;
      const activeChanged = Boolean(next.activeArtifactId && next.activeArtifactId !== prev.activeId);
      const shouldPresent = Boolean(next.activeArtifactId) && (
        activeRePresented
        || activeChanged
        || (next.activeArtifactId ? newIds.includes(next.activeArtifactId) : false)
      );
      lastArtifactStateRef.current = {
        chatId: next.id,
        activeId: next.activeArtifactId,
        sig,
        artifactIds: allIds,
        presentedById,
      };
      setOpenTabIds(current => {
        const merged = current.filter(id => allIds.includes(id));
        for (const id of newIds) {
          if (!merged.includes(id)) merged.push(id);
        }
        if (shouldPresent && next.activeArtifactId && allIds.includes(next.activeArtifactId) && !merged.includes(next.activeArtifactId)) {
          merged.push(next.activeArtifactId);
        }
        return merged;
      });
      if (shouldPresent && next.activeArtifactId) {
        setActiveTabId(next.activeArtifactId);
        setViewerOpen(true);
      }
    }

    const busy = next.state === 'running' || next.state === 'waiting';
    if (prevBusyRef.current && !busy) {
      refreshResources();
    }
    prevBusyRef.current = busy;
  }, [refreshResources]);

  // Load selected chat & subscribe to SSE when active
  useEffect(() => {
    if (!active) return;
    if (!chatId) {
      setActiveChat(null);
      setLoadingChat(false);
      setLoadFailed(false);
      if (lastArtifactStateRef.current.chatId !== null) {
        setOpenTabIds([]);
        setActiveTabId(NEW_VIEWER_TAB_ID);
        lastArtifactStateRef.current = { chatId: null, sig: '', artifactIds: [], presentedById: {} };
      }
      return;
    }

    let cancelled = false;
    setLoadingChat(true);
    setLoadFailed(false);
    void getSuperAgentChat(chatId)
      .then(result => {
        if (!cancelled) applyChatSnapshot(result.conversation, true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoadingChat(false);
      });

    let resyncTimer: number | null = null;
    const resyncChat = () => {
      if (cancelled) return;
      void getSuperAgentChat(chatId)
        .then(result => {
          if (!cancelled) applyChatSnapshot(result.conversation, false);
        })
        .catch(() => { /* keep last known state while offline */ });
    };
    const scheduleResync = () => {
      if (cancelled || resyncTimer !== null) return;
      resyncTimer = window.setTimeout(() => {
        resyncTimer = null;
        resyncChat();
      }, 1500);
    };
    const onVisibilityChange = () => {
      if (!document.hidden && prevBusyRef.current) {
        resyncChat();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const unsubscribe = subscribeSuperAgentChat(
      chatId,
      next => {
        if (resyncTimer !== null) {
          window.clearTimeout(resyncTimer);
          resyncTimer = null;
        }
        if (!cancelled) applyChatSnapshot(next, false);
      },
      scheduleResync,
    );

    return () => {
      cancelled = true;
      if (resyncTimer !== null) window.clearTimeout(resyncTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      unsubscribe();
    };
  }, [active, chatId, chatRetry, applyChatSnapshot]);

  useEffect(() => {
    if (viewerOpen || (activeChat?.artifacts.length ?? 0) > 0) {
      void ArtifactBrowserPane.preload().catch(() => {});
    }
  }, [viewerOpen, activeChat?.artifacts.length]);

  const applyPendingHandoff = useCallback(() => {
    if (!active) return;
    const payload = consumeSuperAgentHandoff();
    if (!payload) return;
    const seq = ++handoffSeqRef.current;
    const mergedAttachments = (() => {
      const next: SuperAgentResourceAttachment[] = payload.newChat === false ? [...attachments] : [];
      for (const att of payload.attachments ?? []) {
        if (!next.some(existing => resourceKey(existing) === resourceKey(att))) {
          next.push(att);
        }
      }
      return next.slice(0, 30);
    })();

    setAttachments(mergedAttachments);

    if (payload.autoSend) {
      setPendingAutoSend({
        id: seq,
        payload: {
          ...payload,
          attachments: mergedAttachments,
        },
      });
      return;
    }

    if (payload.newChat !== false && !payload.initialArtifact) {
      setActiveChat(null);
      setViewerOpen(false);
    }

    setDraftSeed({
      id: seq,
      text: payload.prompt,
      mode: payload.mode,
    });

    if (payload.initialArtifact) {
      void createSuperAgentChat({
        ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
        engine: selection.engine,
        model: selection.model !== 'default' ? selection.model : undefined,
        permissionMode,
        ...(payload.mode === 'game' ? { intent: 'game' as SuperAgentIntent } : {}),
        ...(payload.title ? { title: payload.title } : {}),
        initialArtifact: payload.initialArtifact,
      })
        .then(created => {
          applyChatSnapshot(created.conversation, true);
          if (created.conversation.artifacts.length > 0) setViewerOpen(true);
          onChatIdChange(created.conversation.id, true);
        })
        .catch(() => { /* composer still holds draft + attachments */ });
    }

    showToast(t('Loaded into Super Agent'), 'info', 'feedback');
  }, [active, attachments, selection.runtimeId, selection.engine, selection.model, permissionMode, applyChatSnapshot, onChatIdChange, showToast, t]);

  useEffect(() => {
    applyPendingHandoff();
    return subscribeSuperAgentHandoff(applyPendingHandoff);
  }, [applyPendingHandoff]);

  const ensureChatCreated = useCallback(async (init?: {
    intent?: SuperAgentIntent;
    title?: string;
    initialArtifact?: Partial<SuperAgentArtifact>;
  }): Promise<SuperAgentChat> => {
    if (activeChat && !init?.initialArtifact) return activeChat;
    const created = await createSuperAgentChat({
      ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
      engine: selection.engine,
      model: selection.model !== 'default' ? selection.model : undefined,
      permissionMode,
      ...(init?.intent ? { intent: init.intent } : {}),
      ...(init?.title ? { title: init.title } : {}),
      ...(init?.initialArtifact ? { initialArtifact: init.initialArtifact } : {}),
    });
    applyChatSnapshot(created.conversation, true);
    if (created.conversation.artifacts.length > 0) setViewerOpen(true);
    onChatIdChange(created.conversation.id, true);
    return created.conversation;
  }, [activeChat, selection.runtimeId, selection.engine, selection.model, permissionMode, applyChatSnapshot, onChatIdChange]);

  const handleCreateConversation = () => {
    setActiveChat(null);
    setPreviewArtifacts([]);
    setLoadingChat(false);
    setLoadFailed(false);
    setAttachments([]);
    setOpenTabIds([]);
    setActiveTabId(NEW_VIEWER_TAB_ID);
    setViewerOpen(false);
    setViewerExpanded(false);
    lastArtifactStateRef.current = { chatId: null, sig: '', artifactIds: [], presentedById: {} };
    setDraftSeed({ id: ++handoffSeqRef.current, text: '' });
    if (chatId !== null || requestedMode) {
      onChatIdChange(null);
    }
    if (sidebarAsDrawer) setSidebarOpen(false);
  };

  const handleTogglePin = async (id: string, pinned: boolean) => {
    try {
      const updated = await updateSuperAgentChat(id, { pinned });
      setConversations(prev => upsertSummary(prev, updated.conversation));
      if (activeChat?.id === id) setActiveChat(updated.conversation);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not update conversation'));
    }
  };

  const handleRename = async (id: string, title: string) => {
    try {
      const updated = await updateSuperAgentChat(id, { title });
      setConversations(prev => upsertSummary(prev, updated.conversation));
      if (activeChat?.id === id) setActiveChat(updated.conversation);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not rename conversation'));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      if (activeChat?.id === id) {
        for (const item of activeChat.artifacts) {
          if (item.kind === 'web') {
            void closeSuperAgentBrowserTab(id, safeBrowserTabId(item.id));
          }
        }
      }
      await deleteSuperAgentChat(id);
      setConversations(prev => prev.filter(item => item.id !== id));
      if (chatId === id) {
        onChatIdChange(null, true);
      }
      showToast(t('Conversation deleted'), 'info', 'feedback');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not delete conversation'));
    }
  };

  const handleChangePermissionMode = async (nextMode: SuperAgentPermissionMode) => {
    setPermissionMode(nextMode);
    if (!activeChat) return;
    try {
      const updated = await updateSuperAgentChat(activeChat.id, { permissionMode: nextMode });
      setActiveChat(updated.conversation);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not update approval mode'));
    }
  };

  const handleSend = async (
    text: string,
    meta?: {
      mode?: SuperAgentCreationModeId;
      workingDir?: string;
      overrideAttachments?: SuperAgentResourceAttachment[];
      initialArtifact?: Partial<SuperAgentArtifact>;
    },
  ): Promise<boolean> => {
    setSending(true);
    try {
      const target = await ensureChatCreated(
        meta?.mode === 'game' || meta?.initialArtifact
          ? {
              ...(meta?.mode === 'game' ? { intent: 'game' } : {}),
              ...(meta?.initialArtifact ? { initialArtifact: meta.initialArtifact } : {}),
            }
          : undefined,
      );
      const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `sa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const outgoingAttachments = meta?.overrideAttachments ?? attachments;
      const result = await startSuperAgentTurn(target.id, {
        requestId,
        text,
        ...(meta?.mode ? { mode: meta.mode } : {}),
        ...(meta?.workingDir ? { workingDir: meta.workingDir } : {}),
        ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
        engine: selection.engine,
        model: selection.model,
        reasoning: selection.reasoning,
        permissionMode,
        attachments: outgoingAttachments,
      });
      applyChatSnapshot(result.conversation, false);
      setAttachments([]);
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not start Super Agent'));
      return false;
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    if (!activeChat) return;
    setSending(true);
    try {
      const result = await stopSuperAgentChat(activeChat.id);
      applyChatSnapshot(result.conversation, false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not stop Agent'));
    } finally {
      setSending(false);
    }
  };

  const handleApprove = async (approvalId: string, accepted: boolean) => {
    if (!activeChat) return;
    setSending(true);
    try {
      const result = await approveSuperAgentAction(activeChat.id, approvalId, accepted);
      applyChatSnapshot(result.conversation, false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Approval failed'));
    } finally {
      setSending(false);
    }
  };

  const handleOpenArtifactId = async (artifactId: string) => {
    setOpenTabIds(prev => (prev.includes(artifactId) ? prev : [...prev, artifactId]));
    setActiveTabId(artifactId);
    setViewerOpen(true);
    if (activeChat && activeChat.activeArtifactId !== artifactId) {
      void updateSuperAgentChat(activeChat.id, { activeArtifactId: artifactId })
        .then(res => {
          if (res?.conversation) setActiveChat(res.conversation);
        })
        .catch(() => { /* local tab already focused */ });
    }
  };

  const handleOpenWebUrl = async (url: string) => {
    try {
      const target = await ensureChatCreated();
      const res = await updateSuperAgentChat(target.id, {
        addArtifact: { kind: 'web', url },
      });
      applyChatSnapshot(res.conversation, false);
      setViewerOpen(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not open web page'));
    }
  };

  const handleOpenResource = async (item: SuperAgentResourceAttachment) => {
    if (item.kind === 'browser-annotation') {
      if (item.annotation?.artifactId && activeChat?.artifacts.some(a => a.id === item.annotation!.artifactId)) {
        void handleOpenArtifactId(item.annotation.artifactId);
        return;
      }
      if (item.annotation?.pageUrl && /^https?:\/\//i.test(item.annotation.pageUrl)) {
        void handleOpenWebUrl(item.annotation.pageUrl);
        return;
      }
    }
    const patch = resourceToArtifactPatch(item);
    if (!patch) {
      setAttachments(prev =>
        prev.some(existing => resourceKey(existing) === resourceKey(item))
          ? prev
          : [...prev, item].slice(0, 30),
      );
      showToast(t('Attached "{title}" to prompt', { title: item.title }), 'info', 'feedback');
      return;
    }
    try {
      const target = await ensureChatCreated(item.kind === 'game-project' ? { intent: 'game' } : undefined);
      const res = await updateSuperAgentChat(target.id, { addArtifact: patch });
      applyChatSnapshot(res.conversation, false);
      setViewerOpen(true);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('Could not preview resource'));
    }
  };

  const handleAttachArtifact = (artifact: SuperAgentArtifact) => {
    const att = artifactToResourceAttachment(artifact);
    if (!att) return;
    setAttachments(prev =>
      prev.some(existing => resourceKey(existing) === resourceKey(att))
        ? prev
        : [...prev, att].slice(0, 30),
    );
    showToast(t('Attached "{title}" to prompt', { title: att.title }), 'info', 'feedback');
  };

  const handleAttachBrowserAnnotation = (
    attachment: SuperAgentResourceAttachment,
    sendImmediately = false,
  ) => {
    const nextAttachments = attachments.some(existing => resourceKey(existing) === resourceKey(attachment))
      ? attachments
      : [...attachments, attachment].slice(0, 30);
    setAttachments(nextAttachments);
    const busy = activeChat?.state === 'running' || activeChat?.state === 'waiting';
    if (sendImmediately && !busy && !sending) {
      const promptText = attachment.annotation?.comment?.trim()
        || t('Update the page based on the attached browser preview annotation.');
      void handleSend(promptText, { overrideAttachments: nextAttachments });
      return;
    }
    showToast(t('Attached annotation to prompt'), 'info', 'feedback');
  };

  const handlePlayGame = useCallback(async (game: GameCard) => {
    playedGamesRef.current.set(game.id, game);
    const displayTitle = localizedGameTitle(game, locale);
    const patch = toGameArtifact(game, displayTitle);
    const artifactId = patch.id || `game:${game.id}`;
    const now = Date.now();
    const fullArtifact: SuperAgentArtifact = {
      id: artifactId,
      kind: 'game-project',
      title: patch.title || displayTitle,
      subtitle: patch.subtitle,
      ...(patch.projectId ? { projectId: patch.projectId } : {}),
      scenario: patch.scenario,
      revision: patch.revision,
      url: patch.url,
      createdAt: now,
      updatedAt: now,
      presentedAt: now,
    };

    if (activeChat) {
      try {
        const res = await updateSuperAgentChat(activeChat.id, { addArtifact: patch });
        applyChatSnapshot(res.conversation, false);
        setViewerOpen(true);
        return;
      } catch (error) {
        showToast(error instanceof Error ? error.message : t('Could not preview resource'));
        return;
      }
    }

    setPreviewArtifacts(prev => {
      const next = prev.filter(item => item.id !== fullArtifact.id);
      next.push(fullArtifact);
      return next;
    });
    setOpenTabIds(prev => (prev.includes(fullArtifact.id) ? prev : [...prev, fullArtifact.id]));
    setActiveTabId(fullArtifact.id);
    setViewerOpen(true);
  }, [activeChat, applyChatSnapshot, locale, showToast, t]);

  const handleUseGameInAgent = useCallback(async (artifact: SuperAgentArtifact) => {
    const gameId = artifact.projectId || (artifact.id.startsWith('game:') ? artifact.id.slice('game:'.length) : '');
    let game: GameCard | null =
      (gameId ? playedGamesRef.current.get(gameId) ?? null : null)
      ?? (gameId ? [...communityGames, ...bundledGames].find(item => item.id === gameId) ?? null : null);

    if (!game && gameId) {
      try {
        const res = await gameApi.catalog();
        game = res.games?.find(item => item.id === gameId) ?? null;
        if (game) playedGamesRef.current.set(game.id, game);
      } catch {
        /* ignore offline catalog lookup */
      }
    }

    if (game && game.source !== 'mine') {
      const displayTitle = localizedGameTitle(game, locale);
      setGameTemplateSeed({ id: ++handoffSeqRef.current, game });
      showToast(t('Based on {title}', { title: displayTitle }), 'info', 'feedback');
      return;
    }

    const att = game
      ? toGameResourceAttachment(game, localizedGameTitle(game, locale))
      : artifactToResourceAttachment(artifact);
    if (!att) return;
    setAttachments(prev =>
      prev.some(existing => resourceKey(existing) === resourceKey(att))
        ? prev
        : [...prev, att].slice(0, 30),
    );
    showToast(t('Attached "{title}" to prompt', { title: att.title }), 'info', 'feedback');
  }, [locale, showToast, t]);

  useEffect(() => {
    if (!active || !requestedGameId) {
      if (!requestedGameId) handledRequestedGameRef.current = null;
      return;
    }
    if (handledRequestedGameRef.current === requestedGameId) return;
    handledRequestedGameRef.current = requestedGameId;

    let cancelled = false;
    const staticMatch = [...communityGames, ...bundledGames].find(item => item.id === requestedGameId);
    if (staticMatch) {
      void handlePlayGame(staticMatch);
      return;
    }

    void gameApi.catalog()
      .then(res => {
        if (cancelled) return;
        const found = res.games?.find(item => item.id === requestedGameId);
        if (found) {
          void handlePlayGame(found);
        }
      })
      .catch(() => { /* ignore if game service is offline */ });

    return () => {
      cancelled = true;
    };
  }, [active, requestedGameId, handlePlayGame]);

  const viewerArtifacts = activeChat ? activeChat.artifacts : previewArtifacts;
  const playingGameId = useMemo(() => {
    if (!viewerOpen || activeTabId === NEW_VIEWER_TAB_ID) return null;
    const current = viewerArtifacts.find(item => item.id === activeTabId);
    if (!current || current.kind !== 'game-project') return null;
    if (current.projectId) return current.projectId;
    return current.id.startsWith('game:') ? current.id.slice('game:'.length) : null;
  }, [viewerOpen, activeTabId, viewerArtifacts]);

  const handleCloseTab = (tabId: string) => {
    const target = viewerArtifacts.find(item => item.id === tabId);
    if (target?.kind === 'web' && activeChat?.id) {
      void closeSuperAgentBrowserTab(activeChat.id, safeBrowserTabId(tabId));
    }
    if (!activeChat) {
      setPreviewArtifacts(prev => prev.filter(item => item.id !== tabId));
    }
    setOpenTabIds(prev => {
      const next = prev.filter(id => id !== tabId);
      if (activeTabId === tabId) {
        setActiveTabId(next.at(-1) ?? NEW_VIEWER_TAB_ID);
      }
      return next;
    });
  };

  const handleCopyText = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      showToast(t('Copied to clipboard'), 'info', 'feedback');
    } catch {
      showToast(t('Could not copy to clipboard'));
    }
  };

  const agentsLoaded = agentDir !== null || runtimesDir !== null;
  const openRuntimes = useCallback(() => {
    openAgentRuntimesSettings();
    onOpenAgentSettings();
  }, [onOpenAgentSettings]);

  const agentStatus = useMemo(() => {
    if (!agentsLoaded) {
      return { label: t('Local Agents'), detail: t('Checking Agent runtimes…'), ready: false, count: 0, loading: true };
    }
    const readyOnlineRuntimes = availableRuntimes.filter(rt => rt.status === 'online' && rt.runnableAgentIds.length > 0);
    const selectedRuntime = availableRuntimes.find(rt => rt.id === selection.runtimeId && rt.status === 'online');
    const targetRuntime = selectedRuntime ?? readyOnlineRuntimes[0] ?? availableRuntimes.find(rt => rt.status === 'online');
    const readyAgents = targetRuntime
      ? targetRuntime.agents.filter(item => item.installed && item.auth !== 'signed-out')
      : [];

    if (readyOnlineRuntimes.length > 0 && readyAgents.length > 0) {
      const activeFirst = [
        ...readyAgents.filter(item => item.id === selection.engine),
        ...readyAgents.filter(item => item.id !== selection.engine),
      ];
      const label = activeFirst.length <= 2
        ? activeFirst.map(a => a.label).join(' · ')
        : `${activeFirst[0].label} · +${activeFirst.length - 1}`;
      const detail =
        readyOnlineRuntimes.length > 1
          ? t('{count} runtimes connected', { count: readyOnlineRuntimes.length })
          : targetRuntime?.kind === 'local-bridge'
            ? t('Bridge · {name}', { name: targetRuntime.name })
            : targetRuntime?.kind === 'remote-service'
              ? t('Hosted · {name}', { name: targetRuntime.name })
              : t('Local Agent connected');
      return {
        label,
        detail,
        ready: true,
        count: readyAgents.length,
        loading: false,
      };
    }

    return {
      label: t('No Agent connected'),
      detail: runtimesDir && !runtimesDir.localDirectAvailable
        ? t('Connect local machine or service')
        : t('Configure Local Agent'),
      ready: false,
      count: 0,
      loading: false,
    };
  }, [availableRuntimes, agentsLoaded, selection.runtimeId, selection.engine, runtimesDir, t]);

  useEffect(() => {
    if (!active || !pendingAutoSend || !agentsLoaded) return;
    const needsAgentSync = agentStatus.ready && Boolean(
      !engineInitialized.current
      && agentDir
      && ((agentDir.default && agents.some(item => item.id === agentDir.default!.agent))
        || (!activeChat && agents.some(item => item.installed && item.auth !== 'signed-out'))),
    );
    const needsRuntimeSync = agentStatus.ready && Boolean(
      runtimesDir
      && !selection.runtimeId
      && (runtimesDir.defaultRuntimeId || !runtimesDir.localDirectAvailable)
      && runtimesDir.runtimes.some(item => item.status === 'online'),
    );
    if (needsAgentSync || needsRuntimeSync) return;
    if (dispatchedHandoffIdsRef.current.has(pendingAutoSend.id)) return;
    dispatchedHandoffIdsRef.current.add(pendingAutoSend.id);
    setPendingAutoSend(null);

    const { payload } = pendingAutoSend;
    const handoffAttachments = payload.attachments ?? [];

    if (!agentStatus.ready) {
      setDraftSeed({
        id: pendingAutoSend.id,
        text: payload.prompt,
        mode: payload.mode,
      });
      if (payload.initialArtifact) {
        void createSuperAgentChat({
          ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
          engine: selection.engine,
          model: selection.model !== 'default' ? selection.model : undefined,
          permissionMode,
          ...(payload.mode === 'game' ? { intent: 'game' as SuperAgentIntent } : {}),
          ...(payload.title ? { title: payload.title } : {}),
          initialArtifact: payload.initialArtifact,
        })
          .then(created => {
            applyChatSnapshot(created.conversation, true);
            if (created.conversation.artifacts.length > 0) setViewerOpen(true);
            onChatIdChange(created.conversation.id, true);
          })
          .catch(() => { /* keep draft seed only */ });
      }
      showToast(t('Loaded into Super Agent'), 'info', 'feedback');
      return;
    }

    void (async () => {
      setSending(true);
      try {
        const useExisting = payload.newChat === false && activeChat && !payload.initialArtifact;
        const target = useExisting
          ? activeChat
          : (
              await createSuperAgentChat({
                ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
                engine: selection.engine,
                model: selection.model !== 'default' ? selection.model : undefined,
                permissionMode,
                ...(payload.mode === 'game' ? { intent: 'game' as SuperAgentIntent } : {}),
                ...(payload.title ? { title: payload.title } : {}),
                ...(payload.initialArtifact ? { initialArtifact: payload.initialArtifact } : {}),
              })
            ).conversation;

        if (target.id !== activeChat?.id) {
          applyChatSnapshot(target, true);
          if (target.artifacts.length > 0) setViewerOpen(true);
          onChatIdChange(target.id, true);
        }

        const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `sa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const result = await startSuperAgentTurn(target.id, {
          requestId,
          text: payload.prompt,
          ...(payload.mode ? { mode: payload.mode } : {}),
          ...(selection.runtimeId ? { runtimeId: selection.runtimeId } : {}),
          engine: selection.engine,
          model: selection.model,
          reasoning: selection.reasoning,
          permissionMode,
          attachments: handoffAttachments,
        });
        applyChatSnapshot(result.conversation, false);
        setAttachments([]);
        setDraftSeed({ id: ++handoffSeqRef.current, text: '' });
      } catch (error) {
        setAttachments(handoffAttachments);
        setDraftSeed({
          id: ++handoffSeqRef.current,
          text: payload.prompt,
          mode: payload.mode,
        });
        showToast(error instanceof Error ? error.message : t('Could not start Super Agent'));
      } finally {
        setSending(false);
      }
    })();
  }, [
    active,
    pendingAutoSend,
    agentsLoaded,
    agentDir,
    agents,
    runtimesDir,
    agentStatus.ready,
    activeChat,
    selection.runtimeId,
    selection.engine,
    selection.model,
    selection.reasoning,
    permissionMode,
    applyChatSnapshot,
    onChatIdChange,
    showToast,
    t,
  ]);

  const getDockedSidebarWidth = useCallback(() => {
    if (!sidebarDockedRef.current) return 0;
    const sidebarEl = rootRef.current?.querySelector<HTMLElement>('.om-sa-sidebar-slot');
    const measured = sidebarEl ? Math.round(sidebarEl.getBoundingClientRect().width) : 0;
    return measured > 0 ? measured : 240;
  }, []);

  const effectiveViewerWidth =
    viewerExpanded || narrow || viewerWidth === null
      ? null
      : clampSuperAgentViewerWidth(viewerWidth, containerWidth, getDockedSidebarWidth());

  const maxViewerWidth = clampSuperAgentViewerWidth(10_000, containerWidth, getDockedSidebarWidth());

  const startResize = (clientX: number) => {
    const currentWidth = effectiveViewerWidth
      ?? Math.round(rootRef.current?.querySelector<HTMLElement>('.om-sa-viewer-slot')?.getBoundingClientRect().width || clampSuperAgentViewerWidth(560, containerWidth, getDockedSidebarWidth()));
    dragStartRef.current = { startX: clientX, startWidth: currentWidth };
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragStartRef.current;
      if (!drag) return;
      const totalWidth = rootRef.current?.clientWidth ?? 0;
      const dockedSidebar = getDockedSidebarWidth();
      const delta = drag.startX - event.clientX;
      setViewerWidth(clampSuperAgentViewerWidth(drag.startWidth + delta, totalWidth, dockedSidebar));
    };
    const onUp = () => {
      dragStartRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [getDockedSidebarWidth]);

  const sidebarNode = (
    <ConversationSidebar
      conversations={conversations}
      activeId={chatId}
      loading={loadingList}
      agentStatus={agentStatus}
      onSelect={id => {
        onChatIdChange(id);
        if (sidebarAsDrawer) setSidebarOpen(false);
      }}
      onCreate={handleCreateConversation}
      onTogglePin={(id, pinned) => void handleTogglePin(id, pinned)}
      onRename={(id, title) => handleRename(id, title)}
      onDelete={id => void handleDelete(id)}
      onCollapse={() => setSidebarOpen(false)}
      onOpenAgentSettings={() => {
        if (!agentStatus.ready && runtimesDir && !runtimesDir.localDirectAvailable) {
          openRuntimes();
        } else {
          onOpenAgentSettings();
        }
      }}
    />
  );

  return (
    <div
      ref={rootRef}
      className="om-super-agent"
      data-viewer-open={viewerOpen || undefined}
      data-viewer-expanded={viewerExpanded || undefined}
    >
      <StudioToastViewport toasts={toasts} dismissToast={dismissToast} />

      {!sidebarAsDrawer && sidebarOpen && (
        <div className="om-sa-sidebar-slot">
          {sidebarNode}
        </div>
      )}

      {sidebarAsDrawer && (
        <Dialog.Root open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <Dialog.Portal>
            <Dialog.Backdrop className="om-sa-dialog-backdrop" />
            <Dialog.Popup className="om-sa-sidebar-drawer" aria-label={t('Conversations')} onKeyDown={e => e.stopPropagation()}>
              {sidebarNode}
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}

      {!(viewerOpen && viewerExpanded) && (
        <div className="om-sa-center-slot">
          <ConversationStream
            active={active}
            chat={activeChat}
            requestedMode={requestedMode}
            playingGameId={playingGameId}
            loading={loadingChat}
            loadFailed={loadFailed}
            sending={sending}
            sidebarOpen={!sidebarAsDrawer && sidebarOpen}
            viewerOpen={viewerOpen}
            counts={resourcesCatalog?.counts ?? null}
            attachments={attachments}
            draftSeed={draftSeed}
            gameTemplateSeed={gameTemplateSeed}
            agents={agents}
            agentsLoaded={agentsLoaded}
            runtimes={availableRuntimes}
            localDirectAvailable={runtimesDir?.localDirectAvailable ?? true}
            selection={selection}
            permissionMode={permissionMode}
            onBack={onBack}
            onExitRequestedMode={onExitRequestedMode}
            onPlayGame={game => void handlePlayGame(game)}
            onRetryLoad={() => setChatRetry(value => value + 1)}
            onOpenSidebar={() => setSidebarOpen(true)}
            onToggleViewer={() => {
              setViewerOpen(open => {
                const next = !open;
                if (!next) setViewerExpanded(false);
                return next;
              });
            }}
            onRenameChat={title => (activeChat ? handleRename(activeChat.id, title) : undefined)}
            onChangeSelection={setSelection}
            onChangePermissionMode={mode => void handleChangePermissionMode(mode)}
            onSend={handleSend}
            onStop={() => void handleStop()}
            onApprove={(approvalId, accepted) => void handleApprove(approvalId, accepted)}
            onResourcesUploaded={refreshResources}
            onAttachmentsChange={setAttachments}
            onOpenArtifactId={artifactId => void handleOpenArtifactId(artifactId)}
            onPreviewAttachment={att => void handleOpenResource(att)}
            onOpenWebUrl={url => void handleOpenWebUrl(url)}
            onCopyText={code => void handleCopyText(code)}
            onOpenAgentSettings={onOpenAgentSettings}
            onOpenRuntimeSettings={openRuntimes}
            onOpenModelSettings={onOpenModelSettings}
            onOpenGameStudio={onOpenGameStudio ? () => onOpenGameStudio() : undefined}
            onOpenMcp={onOpenMcp}
            onError={message => showToast(message)}
          />
        </div>
      )}

      {viewerOpen && !viewerExpanded && !narrow && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t('Resize Artifact Viewer')}
          aria-valuemin={MIN_VIEWER_WIDTH}
          aria-valuemax={maxViewerWidth}
          aria-valuenow={effectiveViewerWidth ?? clampSuperAgentViewerWidth(560, containerWidth, getDockedSidebarWidth())}
          className="om-sa-resizer"
          onPointerDown={event => {
            event.preventDefault();
            startResize(event.clientX);
          }}
          onKeyDown={event => {
            const totalWidth = rootRef.current?.clientWidth ?? containerWidth;
            const dockedSidebar = getDockedSidebarWidth();
            const current = effectiveViewerWidth
              ?? Math.round(rootRef.current?.querySelector<HTMLElement>('.om-sa-viewer-slot')?.getBoundingClientRect().width || clampSuperAgentViewerWidth(560, totalWidth, dockedSidebar));
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              setViewerWidth(clampSuperAgentViewerWidth(current + 24, totalWidth, dockedSidebar));
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              setViewerWidth(clampSuperAgentViewerWidth(current - 24, totalWidth, dockedSidebar));
            }
          }}
        />
      )}

      {viewerOpen && (
        <div
          className="om-sa-viewer-slot"
          style={effectiveViewerWidth === null ? undefined : { width: effectiveViewerWidth, flexBasis: effectiveViewerWidth, flexGrow: 0, flexShrink: 1, maxWidth: '100%' }}
        >
          <Suspense fallback={<RouteSurfaceFallback compact />}>
            <ArtifactBrowserPane
              active={active}
              chatId={activeChat?.id ?? null}
              artifacts={viewerArtifacts}
              openTabIds={openTabIds}
              activeTabId={activeTabId}
              expanded={viewerExpanded}
              workspaceItems={resourcesCatalog?.items ?? []}
              onSelectTab={id => void handleOpenArtifactId(id)}
              onCloseTab={handleCloseTab}
              onNewTab={() => setActiveTabId(NEW_VIEWER_TAB_ID)}
              onOpenWebUrl={url => void handleOpenWebUrl(url)}
              onOpenArtifact={id => void handleOpenArtifactId(id)}
              onOpenResource={item => void handleOpenResource(item)}
              onToggleExpand={() => setViewerExpanded(v => !v)}
              onClosePane={() => {
                setViewerExpanded(false);
                setViewerOpen(false);
              }}
              onAttachArtifact={handleAttachArtifact}
              onUseGameInAgent={artifact => void handleUseGameInAgent(artifact)}
              onAttachBrowserAnnotation={handleAttachBrowserAnnotation}
              onNotify={(msg, tone) => showToast(msg, tone === 'error' ? 'error' : 'info', 'feedback')}
              onOpenInDesignStudio={onOpenDesignProject}
              onOpenInMotionStudio={onOpenMotionProject}
              onOpenInGameStudio={onOpenGameStudio}
              onOpenInAssets={onOpenAsset}
              onOpenInBrandKit={onOpenBrandKit}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
