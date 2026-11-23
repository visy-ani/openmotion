import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useEffect, useMemo, useRef, useState } from 'react';
import { blackFridayTemplates } from '../../../shared/black-friday-collection';
import type { GalleryTemplate } from '../../../shared/catalog';
import { gameGenres, type GameCard, type GameGenre } from '../../../shared/game-contract';
import type { SuperAgentResourceAttachment } from '../../../shared/super-agent';
import { Select } from '../components/ui/Select';
import { Skeleton } from '../components/ui/Skeleton';
import { ScaledPreviewThumb } from '../design/ScaledPreviewThumb';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { groupBrandSeries, rankDiscoverySeries } from '../motion/brandStoryData';
import { cinemaTemplates } from '../motion/cinemaTemplates';
import { gptImageStory, seedanceStory } from '../motion/exploreModelStories';
import { GameMasonry, interleavePortrait } from '../motion/game/GameMasonry';
import {
  bundledGames,
  communityGames,
  coverUrl,
  formatPlays,
  gameApi,
  genreCovers,
  genreLabels,
} from '../motion/game/gameCatalog';
import {
  GAME_STUDIO_QUICK_IDEAS,
  localizedGameTitle,
  toGameResourceAttachment,
} from '../motion/game/gameSuperAgent';
import { sceneExamples } from '../motion/sceneShowcase';
import { motionSkills, skillCategories, type MotionSkill, type SkillCategory } from '../motion/skillCatalog';
import { templateCollectionFacets, templatesInCollection, type TemplateCollection } from '../motion/templateCollections';
import { aiTechnologyIndustry, purposeOrder } from '../motion/templateDiscoveryTaxonomy';
import { useCoveredTemplates } from '../motion/useCoveredTemplates';
import type { ModeComposerOptions } from './ModeComposerControls';
import { resourceIcon, resourceKey, type ResourceCategoryTab } from './ResourcePickerDialog';
import { fetchWorkspaceResources } from './superAgentClient';

export type SuperAgentCreationModeId = 'coding' | 'game' | 'website' | 'motion' | 'deck' | 'image' | 'media' | 'audio';

export type SuperAgentModeSpec = {
  id: SuperAgentCreationModeId;
  tone: 'coding' | 'agent' | 'image' | 'video' | 'audio';
  icon: string;
  label: string;
  title: string;
  subtitle: string;
  placeholder: string;
  defaultPrompt: string;
  pickerCategory: ResourceCategoryTab;
  quickIdeas: readonly { title: string; prompt: string }[];
};

export const SUPER_AGENT_MODES: readonly SuperAgentModeSpec[] = [
  {
    id: 'coding',
    tone: 'coding',
    icon: 'code-s-slash-line',
    label: 'Coding',
    title: 'Code, debug & ship',
    subtitle: 'Pure coding workspace for inspecting repositories, editing files, running shell commands, and reviewing diffs.',
    placeholder: 'Ask your coding agent to inspect files, fix a bug, refactor, or run tests…',
    defaultPrompt: 'Inspect the working directory, run git status or check the files present, and summarize the structure.',
    pickerCategory: 'all',
    quickIdeas: [
      { title: 'Inspect repo & architecture', prompt: 'Inspect the repository structure and explain the main modules and entry points.' },
      { title: 'Debug & fix an issue', prompt: 'Reproduce and diagnose the bug, apply a minimal clean fix, and verify with tests.' },
      { title: 'Write & run tests', prompt: 'Add focused unit tests for the changed behavior and run the test suite to verify everything passes.' },
      { title: 'Refactor & review diff', prompt: 'Refactor the duplicated logic into a small clean helper, then review the git diff.' },
    ],
  },
  {
    id: 'website',
    tone: 'agent',
    icon: 'layout-line',
    label: 'Website & App',
    title: 'Your idea, live on the web',
    subtitle: 'Pick a Design Studio template or Brand Kit below to attach as context, then describe what you want to build.',
    placeholder: 'Describe the website, dashboard, or mobile app you want to build…',
    defaultPrompt: 'Design a modern interactive website prototype with a bold hero, interactive feature tabs, pricing toggle, and responsive mobile layout, then open it in the Artifact Viewer.',
    pickerCategory: 'design-template',
    quickIdeas: [
      { title: 'AI product landing page', prompt: 'Build a responsive AI product landing page with interactive feature switcher, pricing toggle, and customer proof.' },
      { title: 'Interactive SaaS dashboard', prompt: 'Create a live analytics dashboard with KPI cards, interactive filters, and trend charts.' },
      { title: 'Mobile app prototype', prompt: 'Design a mobile app prototype in a 390x844 phone viewport with bottom tab navigation and smooth transitions.' },
    ],
  },
  {
    id: 'motion',
    tone: 'video',
    icon: 'movie-line',
    label: 'Motion Video',
    title: 'Direct an editable Motion film',
    subtitle: 'Select Motion Studio templates, Skills, or Brand Kits to feed into Super Agent and generate editable HyperFrames timelines.',
    placeholder: 'Describe the motion video you want to create…',
    defaultPrompt: 'Create an editable 15-second Motion Studio product launch video using HyperFrames HTML and GSAP timelines with bold kinetic typography and smooth transitions, then open it in the Artifact Viewer.',
    pickerCategory: 'motion-template',
    quickIdeas: [
      { title: '15s product launch reel', prompt: 'Create a 15-second product launch video with bold kinetic typography, feature callouts, and a crisp logo outro.' },
      { title: 'Website to launch video', prompt: 'Turn a product story into a fast-paced 20-second launch film with UI screen choreography.' },
      { title: 'Brand commercial intro', prompt: 'Design a sleek 12-second brand opener styled with the attached Brand Kit palette and typography.' },
    ],
  },
  {
    id: 'deck',
    tone: 'audio',
    icon: 'slideshow-line',
    label: 'Slides & Docs',
    title: 'Make a deck. Tell it clearly.',
    subtitle: 'Choose a Design Studio presentation or document template to attach, and export to PDF or PPTX anytime.',
    placeholder: 'Describe your presentation or document topic…',
    defaultPrompt: 'Create a clean 8-slide investor pitch deck in Design Studio with speaker notes, KPI visualizations, and keyboard slide navigation, then present it in the Artifact Viewer.',
    pickerCategory: 'design-template',
    quickIdeas: [
      { title: 'Investor pitch deck', prompt: 'Create an 8-slide investor pitch deck covering problem, solution, traction KPIs, and roadmap with speaker notes.' },
      { title: 'Quarterly business review', prompt: 'Build a quarterly performance deck with metric comparisons, key milestones, and next-quarter priorities.' },
      { title: 'Competitor landscape report', prompt: 'Draft a structured competitor analysis report with positioning matrix and executive summary.' },
    ],
  },
  {
    id: 'game',
    tone: 'agent',
    icon: 'gamepad-line',
    label: 'Game Studio',
    title: 'Create your own game in minutes',
    subtitle: 'Pick a genre, style and setting, describe your game in one line and your Agent builds a playable web game.',
    placeholder: 'Describe the game you want to make',
    defaultPrompt: 'Build a playable retro neon arcade space-shooter game in HTML5 Canvas with keyboard and mouse controls, score & wave HUD, particle explosions, and a restart button. Preview it in the Artifact Viewer.',
    pickerCategory: 'projects',
    quickIdeas: [
      { title: 'Co-op 3D crystal defense', prompt: 'Defend a glowing arena crystal through 5 waves with 1–4 co-op players, dash/nova skills, and an instant invite link.' },
      { title: 'Retro pixel platformer', prompt: 'Build a crisp pixel-art platformer with tight jump physics, hidden coins, hazards, and a dramatic boss arena.' },
      { title: 'Portrait one-tap arcade', prompt: 'Create an addictive 9:16 portrait one-tap arcade game playable with one thumb, instant restarts, and combo multipliers.' },
      { title: 'Cyberpunk drift racer', prompt: 'Build a neon night-time 3D street racing game with smooth drifting, nitro boost pads, and lap time records.' },
    ],
  },
  {
    id: 'image',
    tone: 'image',
    icon: 'image-line',
    label: 'Image Artwork',
    title: 'Generate or remix visual assets',
    subtitle: 'Start from curated Image Studio cases, or attach your own workspace assets and Brand Kits as visual references.',
    placeholder: 'Describe the image artwork or reference edit you want to generate…',
    defaultPrompt: 'Check my configured image models and generate a cinematic product hero illustration in the workspace asset library, inspect the result, and display it in the Artifact Viewer.',
    pickerCategory: 'asset',
    quickIdeas: [
      { title: 'Cinematic product hero', prompt: 'Generate a studio-lit product hero illustration matching the attached Brand Kit colors and mood.' },
      { title: 'Character concept sheet', prompt: 'Create a consistent character concept illustration in 16:9 widescreen framing.' },
      { title: 'Editorial poster artwork', prompt: 'Design a bold editorial campaign visual with dramatic lighting and clean composition.' },
    ],
  },
  {
    id: 'media',
    tone: 'video',
    icon: 'clapperboard-line',
    label: 'Cinema Video',
    title: 'Direct cinema shots',
    subtitle: 'Choose a Cinema Studio shot template or Seedance scene to seed your prompt, or switch to Motion graphics anytime.',
    placeholder: 'Describe the cinema video shot, camera motion, and lighting you want to generate…',
    defaultPrompt: 'Inspect my configured video models and help me generate a short cinematic shot in workspace assets, then show it in the Artifact Viewer.',
    pickerCategory: 'asset',
    quickIdeas: [
      { title: 'Cinematic B-roll shot', prompt: 'Generate a 5-second cinematic camera-movement shot based on the attached still reference.' },
      { title: 'Product slow-motion reveal', prompt: 'Direct a 5-second studio macro slow-motion product reveal with dramatic rim lighting.' },
      { title: 'Multi-shot story sequence', prompt: 'Create a 3-shot cinematic sequence with matching lighting and smooth camera push-in.' },
    ],
  },
  {
    id: 'audio',
    tone: 'audio',
    icon: 'music-2-line',
    label: 'Audio & Sound',
    title: 'Create sound & audio',
    subtitle: 'Compose original soundtracks, studio voiceovers, podcast intros, or crisp sound effects into workspace assets.',
    placeholder: 'Describe the soundtrack, voiceover, podcast, or sound effect you want to create…',
    defaultPrompt: 'Inspect my configured audio models and help me compose a 30-second product launch soundtrack or narration in workspace assets, then preview it in the Artifact Viewer.',
    pickerCategory: 'asset',
    quickIdeas: [
      { title: 'Product launch soundtrack', prompt: 'Compose an upbeat 30-second electronic product launch soundtrack with a clean build-up and crisp finale.' },
      { title: 'Warm narration voiceover', prompt: 'Generate a warm, natural studio voiceover intro suitable for a 20-second product film.' },
      { title: 'UI & transition sound effects', prompt: 'Create a set of crisp UI click, swoosh, and reveal transition sound effects for motion design.' },
    ],
  },
];

export function findSuperAgentMode(id: SuperAgentCreationModeId | null): SuperAgentModeSpec | null {
  return id ? SUPER_AGENT_MODES.find(item => item.id === id) ?? null : null;
}

const PAGE_BATCH_SIZE = 24;

type CuratedShowcaseCard = {
  id: string;
  title: string;
  subtitle: string;
  poster: string;
  posterPosition?: string;
  prompt: string;
};

function buildImageCardsByCategory(category: string): CuratedShowcaseCard[] {
  const gpt: CuratedShowcaseCard[] = gptImageStory.cases.map((item, idx) => ({
    id: `gpt-${idx}`,
    title: item.example.title,
    subtitle: 'GPT Image 2.6 · Image',
    poster: item.example.poster,
    posterPosition: item.example.posterPosition,
    prompt: item.example.prompt,
  }));
  const t2i: CuratedShowcaseCard[] = sceneExamples['text-to-image'].map((ex, idx) => ({
    id: `t2i-${idx}`,
    title: ex.title,
    subtitle: 'Text to image',
    poster: ex.poster,
    posterPosition: ex.posterPosition,
    prompt: ex.prompt,
  }));
  const edit: CuratedShowcaseCard[] = sceneExamples['image-edit'].map((ex, idx) => ({
    id: `edit-${idx}`,
    title: ex.title,
    subtitle: 'Image edit',
    poster: ex.poster,
    posterPosition: ex.posterPosition,
    prompt: ex.prompt,
  }));
  const bg: CuratedShowcaseCard[] = sceneExamples['remove-background'].map((ex, idx) => ({
    id: `bg-${idx}`,
    title: ex.title,
    subtitle: 'Remove background',
    poster: ex.poster,
    posterPosition: ex.posterPosition,
    prompt: ex.prompt,
  }));
  const relight: CuratedShowcaseCard[] = sceneExamples.relight.map((ex, idx) => ({
    id: `relight-${idx}`,
    title: ex.title,
    subtitle: 'Relight',
    poster: ex.poster,
    posterPosition: ex.posterPosition,
    prompt: ex.prompt,
  }));
  const char: CuratedShowcaseCard[] = sceneExamples.character.map((ex, idx) => ({
    id: `char-${idx}`,
    title: ex.title,
    subtitle: 'Character consistency',
    poster: ex.poster,
    posterPosition: ex.posterPosition,
    prompt: ex.prompt,
  }));

  const cinemaStills: CuratedShowcaseCard[] = [
    ...cinemaTemplates.map(tpl => ({
      id: `still-cinema-${tpl.id}`,
      title: tpl.en.title,
      subtitle: 'Cinema still · Visual reference',
      poster: tpl.poster,
      prompt: tpl.en.prompt,
    })),
    ...seedanceStory.cases.map((item, idx) => ({
      id: `still-seedance-${idx}`,
      title: item.example.title,
      subtitle: 'Key visual · Art direction',
      poster: item.example.poster,
      posterPosition: item.example.posterPosition,
      prompt: item.example.prompt,
    })),
  ];

  if (category === 'gpt-image') return gpt;
  if (category === 'text-to-image') return t2i;
  if (category === 'image-edit') return edit;
  if (category === 'remove-background') return bg;
  if (category === 'relight') return relight;
  if (category === 'character') return char;

  const seenTitles = new Set<string>();
  const seenPosters = new Set<string>();
  const primary: CuratedShowcaseCard[] = [];
  const secondary: CuratedShowcaseCard[] = [];
  for (const item of [...gpt, ...t2i, ...edit, ...bg, ...relight, ...char, ...cinemaStills]) {
    if (seenTitles.has(item.title)) continue;
    seenTitles.add(item.title);
    if (item.poster && !seenPosters.has(item.poster)) {
      seenPosters.add(item.poster);
      primary.push(item);
    } else {
      secondary.push(item);
    }
  }
  return [...primary, ...secondary];
}

function buildCinemaCardsByCategory(category: string, isZh: boolean): CuratedShowcaseCard[] {
  const cinema: CuratedShowcaseCard[] = cinemaTemplates.map(tpl => {
    const copy = isZh ? tpl.zh : tpl.en;
    return {
      id: `cinema-${tpl.id}`,
      title: copy.title,
      subtitle: `${tpl.model.name} · ${tpl.aspect} · ${tpl.duration}s`,
      poster: tpl.poster,
      prompt: copy.prompt,
    };
  });
  const seedance: CuratedShowcaseCard[] = seedanceStory.cases.map((item, idx) => ({
    id: `seedance-${idx}`,
    title: item.example.title,
    subtitle: 'Seedance 2.5 · Video',
    poster: item.example.poster,
    posterPosition: item.example.posterPosition,
    prompt: item.example.prompt,
  }));
  const videoScenes: CuratedShowcaseCard[] = (['video-camera-control', 'video-multi-shot'] as const).flatMap(sceneKey =>
    sceneExamples[sceneKey].map((ex, idx) => ({
      id: `${sceneKey}-${idx}`,
      title: ex.title,
      subtitle: sceneKey.replace('video-', '').replaceAll('-', ' '),
      poster: ex.poster,
      posterPosition: ex.posterPosition,
      prompt: ex.prompt,
    })),
  );
  const music: CuratedShowcaseCard[] = sceneExamples.music.map((ex, idx) => ({
    id: `audio-${idx}`,
    title: ex.title,
    subtitle: [ex.kind || 'Audio', ex.model, ex.seconds ? `${ex.seconds}s` : ''].filter(Boolean).join(' · '),
    poster: ex.poster,
    prompt: ex.prompt,
  }));
  const speech: CuratedShowcaseCard[] = sceneExamples.speech.map((ex, idx) => ({
    id: `speech-${idx}`,
    title: ex.title,
    subtitle: 'Text to speech',
    poster: ex.poster,
    prompt: ex.prompt,
  }));
  const audio: CuratedShowcaseCard[] = [...music, ...speech];

  const dedupe = (list: CuratedShowcaseCard[]) => {
    const seenTitles = new Set<string>();
    const seenPosters = new Set<string>();
    const primary: CuratedShowcaseCard[] = [];
    const secondary: CuratedShowcaseCard[] = [];
    for (const item of list) {
      if (seenTitles.has(item.title)) continue;
      seenTitles.add(item.title);
      if (item.poster && !seenPosters.has(item.poster)) {
        seenPosters.add(item.poster);
        primary.push(item);
      } else {
        secondary.push(item);
      }
    }
    return [...primary, ...secondary];
  };

  if (category === 'all-media') return dedupe([...cinema, ...seedance, ...videoScenes]);
  if (category === 'ai-video') return dedupe([...cinema, ...seedance, ...videoScenes]);
  if (category === 'cinema') return cinema;
  if (category === 'seedance') return seedance;
  if (category === 'video-scenes') return videoScenes;
  if (category === 'all-audio' || category === 'audio') return dedupe(audio);
  if (category === 'music') return dedupe(music);
  if (category === 'speech') return dedupe(speech);
  return dedupe([...cinema, ...seedance, ...videoScenes]);
}

function motionTemplateToAttachment(tpl: GalleryTemplate): SuperAgentResourceAttachment {
  return {
    id: tpl.id,
    kind: 'motion-template',
    title: tpl.title,
    subtitle: tpl.brand || tpl.subtitle || tpl.collection || 'Motion',
    previewUrl: tpl.posterUrl,
    tags: tpl.tags,
  };
}

function motionSkillToAttachment(skill: MotionSkill): SuperAgentResourceAttachment {
  return {
    id: skill.id,
    kind: 'skill',
    title: skill.title,
    subtitle: `${skill.category} · ${skill.useWhen}`,
    previewUrl: skill.cover?.poster || skill.cover?.gif,
    tags: [skill.category],
  };
}

type FilterOption = { id: string; label: string; count?: number };

function ResourceShowcaseThumb({ item, active = true }: { item: SuperAgentResourceAttachment; active?: boolean }) {
  const [imgFailed, setImgFailed] = useState(false);

  if (item.kind === 'design-template' && item.previewUrl) {
    return (
      <div className="om-sa-showcase-thumb om-sa-showcase-iframe-wrap" aria-hidden="true">
        <ScaledPreviewThumb src={item.previewUrl} title={item.title} active={active} />
      </div>
    );
  }

  const showImg =
    !imgFailed
    && Boolean(item.previewUrl)
    && (
      item.kind === 'motion-template'
      || item.kind === 'brand-kit'
      || item.kind === 'skill'
      || (item.kind === 'asset' && item.modality === 'image')
    );

  if (showImg) {
    return (
      <div className="om-sa-showcase-thumb" aria-hidden="true">
        <img src={item.previewUrl} alt="" loading="lazy" decoding="async" onError={() => setImgFailed(true)} />
      </div>
    );
  }

  if (item.swatches?.length) {
    return (
      <div className="om-sa-showcase-thumb om-sa-showcase-swatches" aria-hidden="true">
        {item.swatches.slice(0, 5).map((hex, i) => (
          <span key={`${hex}-${i}`} style={{ background: hex }} />
        ))}
      </div>
    );
  }

  return (
    <div className="om-sa-showcase-thumb om-sa-showcase-icon-fallback" aria-hidden="true">
      <RemixIcon name={resourceIcon(item)} size={24} />
    </div>
  );
}

type GameSort = 'relevance' | 'plays' | 'newest';

const GAME_STATUS_LABELS: Partial<Record<GameCard['status'], string>> = {
  draft: 'Waiting for your Agent',
  building: 'Agent is running',
  ready: 'Ready to publish',
  failed: 'Not finished',
};

export function ModeResourceShowcase({
  active = true,
  mode,
  attachments,
  modeOptions,
  playingGameId = null,
  onChangeModeOptions,
  onToggleAttachment,
  onPlayGame,
  onFocusComposer,
  onPickPrompt,
  onOpenAllResources,
  onClose,
}: {
  active?: boolean;
  mode: SuperAgentModeSpec;
  attachments: SuperAgentResourceAttachment[];
  modeOptions?: ModeComposerOptions;
  playingGameId?: string | null;
  onChangeModeOptions?: (patch: Partial<ModeComposerOptions>) => void;
  onToggleAttachment: (item: SuperAgentResourceAttachment) => void;
  onPlayGame?: (game: GameCard) => void;
  onFocusComposer?: () => void;
  onPickPrompt: (prompt: string) => void;
  onOpenAllResources: (category: ResourceCategoryTab) => void;
  onOpenGameStudio?: () => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const isZh = locale === 'zh-CN';

  // Motion & Cinema modes share Explore's full covered Motion template catalog.
  const coveredMotion = useCoveredTemplates(locale, mode.id === 'motion' || mode.id === 'media', { showFirstPage: true });
  const motionCatalog = useMemo(
    () => coveredMotion.catalog ?? coveredMotion.firstPage?.items ?? [],
    [coveredMotion.catalog, coveredMotion.firstPage],
  );
  const motionPurposes = useMemo(
    () => (coveredMotion.catalog ? templateCollectionFacets(coveredMotion.catalog).purposes : purposeOrder),
    [coveredMotion.catalog],
  );

  // Full workspace catalogs cached per kind for Design templates, Brand Kits, Design Skills, Assets, and Game Studio.
  const [designTemplates, setDesignTemplates] = useState<SuperAgentResourceAttachment[] | null>(null);
  const [brandKits, setBrandKits] = useState<SuperAgentResourceAttachment[] | null>(null);
  const [designSkills, setDesignSkills] = useState<SuperAgentResourceAttachment[] | null>(null);
  const [assets, setAssets] = useState<SuperAgentResourceAttachment[] | null>(null);
  const [gameCatalog, setGameCatalog] = useState<GameCard[]>(() => [...communityGames, ...bundledGames]);
  const [loadingKind, setLoadingKind] = useState<string | null>(null);

  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [activeSkillCategory, setActiveSkillCategory] = useState<SkillCategory | 'all'>('all');
  const [gameQuery, setGameQuery] = useState('');
  const [gameSort, setGameSort] = useState<GameSort>('relevance');
  const [visibleCount, setVisibleCount] = useState(PAGE_BATCH_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const publishedGameTemplates = useMemo(
    () => gameCatalog.filter(g => g.source !== 'mine' && g.status === 'published'),
    [gameCatalog],
  );
  const fannedGames = useMemo(
    () => publishedGameTemplates.filter(g => Boolean(coverUrl(g))).slice(0, 5),
    [publishedGameTemplates],
  );
  const myGames = useMemo(
    () => gameCatalog.filter(g => g.source === 'mine').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [gameCatalog],
  );

  // Build real categories & live counts per mode.
  const filters = useMemo<FilterOption[]>(() => {
    switch (mode.id) {
      case 'coding':
        return [];
      case 'website': {
        const all = (designTemplates ?? []).filter(i => i.scenario !== 'deck' && i.scenario !== 'document' && i.scenario !== 'webgl');
        const proto = (designTemplates ?? []).filter(i => i.scenario === 'prototype');
        const mobile = (designTemplates ?? []).filter(i => i.scenario === 'mobile-app');
        const live = (designTemplates ?? []).filter(i => i.scenario === 'live-artifact');
        const clone = (designTemplates ?? []).filter(i => i.scenario === 'web-clone');
        return [
          { id: 'all', label: 'All templates', count: designTemplates ? all.length : undefined },
          { id: 'prototype', label: 'Prototype', count: designTemplates ? proto.length : undefined },
          { id: 'mobile-app', label: 'Mobile App', count: designTemplates ? mobile.length : undefined },
          { id: 'live-artifact', label: 'Live artifact', count: designTemplates ? live.length : undefined },
          ...(clone.length ? [{ id: 'web-clone', label: 'Website clone', count: clone.length }] : []),
          { id: 'brand-kit', label: 'Brand Kits', count: brandKits?.length },
          { id: 'design-skill', label: 'Design Skills', count: designSkills?.length },
        ];
      }
      case 'deck': {
        const decks = (designTemplates ?? []).filter(i => i.scenario === 'deck');
        const docs = (designTemplates ?? []).filter(i => i.scenario === 'document');
        return [
          { id: 'all', label: 'All templates', count: designTemplates ? decks.length + docs.length : undefined },
          { id: 'deck', label: 'Slide deck', count: designTemplates ? decks.length : undefined },
          { id: 'document', label: 'Document', count: designTemplates ? docs.length : undefined },
          { id: 'brand-kit', label: 'Brand Kits', count: brandKits?.length },
          { id: 'design-skill', label: 'Design Skills', count: designSkills?.length },
        ];
      }
      case 'game': {
        const portraitCount = publishedGameTemplates.filter(g => g.orientation === 'portrait').length;
        return [
          { id: 'all', label: 'All games', count: publishedGameTemplates.length },
          ...(myGames.length > 0 ? [{ id: 'mine', label: 'My games', count: myGames.length }] : []),
          ...gameGenres
            .map(g => ({
              id: `genre:${g}`,
              label: genreLabels[g],
              count: publishedGameTemplates.filter(item => item.genre === g).length,
            }))
            .filter(item => item.count > 0),
          ...(portraitCount > 0 ? [{ id: 'portrait', label: 'Portrait games', count: portraitCount }] : []),
          { id: 'brand-kit', label: 'Brand Kits', count: brandKits?.length },
        ];
      }
      case 'motion': {
        const hasFull = Boolean(coveredMotion.catalog);
        return [
          { id: 'all', label: 'All', count: hasFull ? motionCatalog.length : undefined },
          { id: 'ai-video', label: 'AI Video & Seedance', count: buildCinemaCardsByCategory('ai-video', isZh).length },
          { id: 'top-100-brands', label: 'TOP 100 brands' },
          ...motionPurposes.map(purpose => ({
            id: `purpose:${purpose}`,
            label: purpose,
            count: hasFull ? templatesInCollection(motionCatalog, `purpose:${purpose}` as TemplateCollection).length : undefined,
          })),
          { id: 'ai-technology', label: aiTechnologyIndustry, count: hasFull ? templatesInCollection(motionCatalog, 'ai-technology').length : undefined },
          { id: 'black-friday', label: 'Black Friday collection' },
          { id: 'skills', label: 'Skills', count: motionSkills.length },
          { id: 'brand-kit', label: 'Brand Kits', count: brandKits?.length },
        ];
      }
      case 'image': {
        return [
          { id: 'all-image', label: 'All image scenes', count: buildImageCardsByCategory('all-image').length },
          { id: 'gpt-image', label: 'GPT Image 2.6', count: gptImageStory.cases.length },
          { id: 'text-to-image', label: 'Text to image', count: sceneExamples['text-to-image'].length },
          { id: 'image-edit', label: 'Image edit', count: sceneExamples['image-edit'].length },
          { id: 'remove-background', label: 'Remove background', count: sceneExamples['remove-background'].length },
          { id: 'relight', label: 'Relight', count: sceneExamples.relight.length },
          { id: 'character', label: 'Character', count: sceneExamples.character.length },
          { id: 'design-template', label: 'Design templates', count: designTemplates?.length },
          { id: 'asset', label: 'Workspace Assets', count: assets ? assets.filter(a => a.modality === 'image').length : undefined },
          { id: 'brand-kit', label: 'Brand Kits', count: brandKits?.length },
        ];
      }
      case 'media': {
        const hasFull = Boolean(coveredMotion.catalog);
        return [
          { id: 'all-media', label: 'All video', count: buildCinemaCardsByCategory('all-media', isZh).length },
          { id: 'motion-video', label: 'Motion graphics', count: hasFull ? motionCatalog.length : undefined },
          { id: 'cinema', label: 'Cinema Studio', count: cinemaTemplates.length },
          { id: 'seedance', label: 'Seedance 2.5', count: seedanceStory.cases.length },
          { id: 'video-scenes', label: 'Camera & multi-shot', count: buildCinemaCardsByCategory('video-scenes', isZh).length },
          { id: 'asset', label: 'Workspace Assets', count: assets ? assets.filter(a => a.modality === 'video').length : undefined },
        ];
      }
      case 'audio': {
        return [
          { id: 'all-audio', label: 'All audio', count: buildCinemaCardsByCategory('all-audio', isZh).length },
          { id: 'music', label: 'Music & Soundtracks', count: sceneExamples.music.length },
          { id: 'speech', label: 'Voiceover & Speech', count: sceneExamples.speech.length },
          { id: 'asset', label: 'Workspace Audio', count: assets ? assets.filter(a => a.modality === 'audio').length : undefined },
        ];
      }
    }
  }, [mode.id, designTemplates, brandKits, designSkills, assets, publishedGameTemplates, myGames, coveredMotion.catalog, motionCatalog, motionPurposes, isZh]);

  // Reset active tab when switching mode.
  useEffect(() => {
    setActiveFilter(filters[0]?.id ?? 'all');
    setActiveSkillCategory('all');
    setGameQuery('');
    setGameSort('relevance');
    setVisibleCount(PAGE_BATCH_SIZE);
  }, [mode.id]);

  // Reset visible scroll window when filter changes.
  useEffect(() => {
    setVisibleCount(PAGE_BATCH_SIZE);
  }, [activeFilter, activeSkillCategory, gameQuery, gameSort]);

  // Eagerly fetch needed catalogs cleanly with full limits (no truncation).
  useEffect(() => {
    let cancelled = false;
    const ensure = async (kind: 'design-template' | 'brand-kit' | 'design-skill' | 'asset') => {
      if (kind === 'design-template' && designTemplates !== null) return;
      if (kind === 'brand-kit' && brandKits !== null) return;
      if (kind === 'design-skill' && designSkills !== null) return;
      if (kind === 'asset' && assets !== null) return;
      setLoadingKind(kind);
      try {
        const res = await fetchWorkspaceResources({ kind, limit: 600 });
        if (cancelled) return;
        if (kind === 'design-template') setDesignTemplates(res.items);
        if (kind === 'brand-kit') setBrandKits(res.items);
        if (kind === 'design-skill') setDesignSkills(res.items);
        if (kind === 'asset') setAssets(res.items);
      } catch {
        if (cancelled) return;
        if (kind === 'design-template') setDesignTemplates([]);
        if (kind === 'brand-kit') setBrandKits([]);
        if (kind === 'design-skill') setDesignSkills([]);
        if (kind === 'asset') setAssets([]);
      } finally {
        if (!cancelled) setLoadingKind(prev => (prev === kind ? null : prev));
      }
    };

    if (mode.id === 'website' || mode.id === 'deck') {
      void ensure('design-template');
      if (activeFilter === 'brand-kit') void ensure('brand-kit');
      if (activeFilter === 'design-skill') void ensure('design-skill');
    } else if (mode.id === 'game') {
      if (activeFilter === 'brand-kit') void ensure('brand-kit');
      void gameApi.catalog().then(res => {
        if (!cancelled && Array.isArray(res?.games)) {
          setGameCatalog([...communityGames, ...(res.games.length ? res.games : bundledGames)]);
        }
      }).catch(() => { /* fallback keeps bundled + community games */ });
    } else if (mode.id === 'motion') {
      if (activeFilter === 'brand-kit') void ensure('brand-kit');
    } else if (mode.id === 'image') {
      if (activeFilter === 'design-template') void ensure('design-template');
      if (activeFilter === 'asset') void ensure('asset');
      if (activeFilter === 'brand-kit') void ensure('brand-kit');
    } else if (mode.id === 'media' || mode.id === 'audio') {
      if (activeFilter === 'asset') void ensure('asset');
    }

    return () => {
      cancelled = true;
    };
  }, [mode.id, activeFilter, designTemplates, brandKits, designSkills, assets]);

  // Resolve active curated cards (Image / Cinema / Audio / AI Video).
  const curatedCards = useMemo<CuratedShowcaseCard[] | null>(() => {
    if (mode.id === 'image' && activeFilter !== 'asset' && activeFilter !== 'brand-kit' && activeFilter !== 'design-template') {
      return buildImageCardsByCategory(activeFilter);
    }
    if ((mode.id === 'media' || mode.id === 'audio') && activeFilter !== 'asset' && activeFilter !== 'motion-video') {
      return buildCinemaCardsByCategory(activeFilter, isZh);
    }
    if (mode.id === 'motion' && activeFilter === 'ai-video') {
      return buildCinemaCardsByCategory('ai-video', isZh);
    }
    return null;
  }, [mode.id, activeFilter, isZh]);

  // Resolve full resource items for all other tabs (NO 12-item cap!).
  const resourceItems = useMemo<SuperAgentResourceAttachment[]>(() => {
    if (curatedCards) return [];
    if (activeFilter === 'brand-kit') return brandKits ?? [];
    if (activeFilter === 'design-template') return designTemplates ?? [];
    if (activeFilter === 'design-skill') {
      const all = designSkills ?? [];
      if (mode.id === 'deck') {
        const scoped = all.filter(s => s.scenario === 'deck' || s.scenario === 'document');
        return scoped.length ? scoped : all;
      }
      if (mode.id === 'game') {
        const scoped = all.filter(s => s.scenario === 'webgl' || s.scenario === 'live-artifact' || s.scenario === 'prototype');
        return scoped.length ? scoped : all;
      }
      return all;
    }
    if (activeFilter === 'asset') {
      const all = assets ?? [];
      if (mode.id === 'image') return all.filter(a => a.modality === 'image');
      if (mode.id === 'audio') return all.filter(a => a.modality === 'audio');
      if (mode.id === 'media') return all.filter(a => a.modality === 'video');
      return all;
    }
    if (mode.id === 'media' && activeFilter === 'motion-video') {
      return motionCatalog.map(motionTemplateToAttachment);
    }
    if (mode.id === 'motion') {
      if (activeFilter === 'skills') {
        const list = activeSkillCategory === 'all'
          ? motionSkills
          : motionSkills.filter(s => s.category === activeSkillCategory);
        return list.map(motionSkillToAttachment);
      }
      if (activeFilter === 'top-100-brands') {
        return rankDiscoverySeries(groupBrandSeries(motionCatalog)).map(b => motionTemplateToAttachment(b.items[0]));
      }
      if (activeFilter === 'black-friday') {
        return blackFridayTemplates(motionCatalog, locale).flatMap(stage => stage.items).map(motionTemplateToAttachment);
      }
      if (activeFilter !== 'all') {
        return templatesInCollection(motionCatalog, activeFilter as TemplateCollection).map(motionTemplateToAttachment);
      }
      return motionCatalog.map(motionTemplateToAttachment);
    }
    // Design templates (website / deck / game)
    const all = designTemplates ?? [];
    if (activeFilter !== 'all') return all.filter(i => i.scenario === activeFilter);
    if (mode.id === 'deck') return all.filter(i => i.scenario === 'deck' || i.scenario === 'document');
    if (mode.id === 'game') return all.filter(i => i.scenario === 'webgl' || i.scenario === 'live-artifact' || i.scenario === 'prototype');
    return all.filter(i => i.scenario !== 'deck' && i.scenario !== 'document' && i.scenario !== 'webgl');
  }, [curatedCards, activeFilter, activeSkillCategory, mode.id, brandKits, designSkills, assets, motionCatalog, locale, designTemplates]);

  const showGameCards = mode.id === 'game' && activeFilter !== 'brand-kit';

  const filteredGames = useMemo<GameCard[]>(() => {
    if (!showGameCards) return [];
    const needle = gameQuery.trim().toLocaleLowerCase();
    const base = activeFilter === 'mine'
      ? myGames
      : activeFilter === 'portrait'
        ? publishedGameTemplates.filter(g => g.orientation === 'portrait')
        : activeFilter.startsWith('genre:')
          ? publishedGameTemplates.filter(item => item.genre === (activeFilter.slice(6) as GameGenre))
          : publishedGameTemplates;
    const matched = needle
      ? base.filter(game =>
          [
            game.title,
            game.description,
            game.i18n?.[locale]?.title,
            game.i18n?.[locale]?.description,
            t(genreLabels[game.genre]),
          ].some(text => text?.toLocaleLowerCase().includes(needle)),
        )
      : base;
    if (activeFilter === 'mine') return matched;
    if (gameSort === 'plays') return [...matched].sort((a, b) => b.plays - a.plays);
    if (gameSort === 'newest') return [...matched].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return interleavePortrait(matched);
  }, [showGameCards, activeFilter, publishedGameTemplates, myGames, gameQuery, gameSort, locale, t]);

  const totalCount = showGameCards
    ? filteredGames.length
    : curatedCards
      ? curatedCards.length
      : resourceItems.length;
  const hasMore = visibleCount < totalCount;

  // Automatic continuous scrolling via IntersectionObserver.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setVisibleCount(prev => Math.min(totalCount, prev + PAGE_BATCH_SIZE));
        }
      },
      { rootMargin: '280px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, totalCount]);

  const isLoading =
    !curatedCards
    && (
      (mode.id === 'motion' && activeFilter !== 'skills' && activeFilter !== 'brand-kit' && activeFilter !== 'black-friday' && motionCatalog.length === 0 && !coveredMotion.failed)
      || (activeFilter === 'brand-kit' && brandKits === null)
      || (activeFilter === 'design-skill' && designSkills === null)
      || (activeFilter === 'asset' && assets === null)
      || ((mode.id === 'website' || mode.id === 'deck') && activeFilter !== 'brand-kit' && activeFilter !== 'design-skill' && designTemplates === null)
      || (loadingKind !== null && totalCount === 0)
    );

  const selectedKeys = useMemo(() => new Set(attachments.map(resourceKey)), [attachments]);
  const selectGameForAgent = (game: GameCard) => {
    const title = localizedGameTitle(game, locale);
    if (game.source === 'mine') {
      const att = toGameResourceAttachment(game, title);
      const alreadyAttached = selectedKeys.has(resourceKey(att));
      onToggleAttachment(att);
      if (!alreadyAttached) onFocusComposer?.();
      return;
    }
    const isSelected = modeOptions?.gameTemplate?.id === game.id;
    onChangeModeOptions?.({
      gameTemplate: isSelected ? null : game,
      ...(!isSelected
        ? {
            gameGenre: game.genre,
            gameStyle: game.style,
            gameSetting: game.setting,
            gameOrientation: game.orientation ?? 'landscape',
            gameMultiplayer: game.multiplayer,
            gamePlayableAd: Boolean(game.playableAd),
          }
        : {}),
    });
    if (!isSelected) onFocusComposer?.();
  };
  const visibleGames = showGameCards ? filteredGames.slice(0, visibleCount) : null;
  const visibleCurated = !showGameCards && curatedCards ? curatedCards.slice(0, visibleCount) : null;
  const visibleResources = !showGameCards && !curatedCards ? resourceItems.slice(0, visibleCount) : [];

  return (
    <div className="om-sa-mode-showcase">
      <div className="om-sa-mode-hero">
        <div className="om-sa-mode-hero-close">
          <IconButton
            variant="ghost"
            className="motion-icon-button"
            aria-label={t('Close')}
            onClick={onClose}
            icon={<RemixIcon name="close-line" size={16} />}
          />
        </div>
        {mode.id === 'game' && fannedGames.length > 0 ? (
          <div className="om-sa-game-fan" aria-label={t('Game Studio')}>
            {fannedGames.map((game, index) => {
              const title = localizedGameTitle(game, locale);
              const cover = coverUrl(game);
              const isSelected = modeOptions?.gameTemplate?.id === game.id;
              const isPlaying = playingGameId === game.id;
              return (
                <div
                  key={game.id}
                  className="om-sa-game-fan-item"
                  data-slot={index}
                  data-selected={isSelected || undefined}
                  data-playing={isPlaying || undefined}
                >
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-game-fan-card"
                    aria-label={t('Play {title}', { title })}
                    onClick={() => {
                      if (onPlayGame) {
                        onPlayGame(game);
                        return;
                      }
                      selectGameForAgent(game);
                    }}
                  >
                    {cover && <img src={cover} alt="" />}
                    <span className="om-sa-game-play-cue" aria-hidden="true">
                      <RemixIcon name="play-fill" size={13} />
                      <span>{t('Play')}</span>
                    </span>
                    <span className="om-sa-game-fan-label">{t(genreLabels[game.genre])}</span>
                  </Button>
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-game-tile-remix om-sa-game-fan-remix"
                    aria-pressed={isSelected}
                    data-selected={isSelected || undefined}
                    title={t('Make one like this')}
                    aria-label={`${t('Make one like this')}: ${title}`}
                    onClick={() => selectGameForAgent(game)}
                  >
                    <RemixIcon name={isSelected ? 'check-line' : 'sparkling-line'} size={12} />
                    <span>{isSelected ? t('Selected') : t('Make one like this')}</span>
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <span className="om-creation-icon om-sa-mode-hero-icon" data-tone={mode.tone} aria-hidden="true">
            <RemixIcon name={mode.icon} size={22} />
          </span>
        )}
        <div className="om-sa-mode-hero-copy">
          <h2>{t(mode.title)}</h2>
          <p className="om-muted">{t(mode.subtitle)}</p>
        </div>

        {mode.id === 'game' && (
          <div className="om-sa-game-genre-strip" role="group" aria-label={t('Genre')}>
            {gameGenres.map(id => {
              const selected = modeOptions?.gameGenre === id;
              const cover = genreCovers[id];
              return (
                <Button
                  key={id}
                  variant="plain"
                  type="button"
                  className="om-sa-game-genre-card"
                  aria-pressed={selected}
                  data-active={selected || undefined}
                  onClick={() => onChangeModeOptions?.({ gameGenre: selected ? null : id })}
                >
                  <span className="om-sa-game-genre-art" aria-hidden="true">
                    {cover ? <img src={cover} alt="" /> : <RemixIcon name="gamepad-line" size={22} />}
                  </span>
                  <span>{t(genreLabels[id])}</span>
                </Button>
              );
            })}
          </div>
        )}

        <div className="om-sa-mode-ideas">
          {mode.id === 'game' ? (
            GAME_STUDIO_QUICK_IDEAS.map(idea => (
              <Button
                key={idea.title}
                variant="plain"
                type="button"
                className="om-sa-idea-chip"
                onClick={() => {
                  onChangeModeOptions?.({
                    gameGenre: idea.genre,
                    gameStyle: idea.style,
                    gameSetting: idea.setting,
                    gameOrientation: idea.orientation,
                    gameMultiplayer: idea.multiplayer,
                    gamePlayableAd: Boolean(idea.playableAd),
                    gameTemplate: null,
                  });
                  onPickPrompt(t(idea.prompt));
                }}
              >
                <span className="om-sa-tone-icon" data-tone={mode.tone} aria-hidden="true">
                  <RemixIcon name={idea.multiplayer ? 'group-line' : 'sparkling-line'} size={12} />
                </span>
                <span>{t(idea.title)}</span>
              </Button>
            ))
          ) : (
            mode.quickIdeas.map(idea => (
              <Button
                key={idea.title}
                variant="plain"
                type="button"
                className="om-sa-idea-chip"
                onClick={() => onPickPrompt(t(idea.prompt))}
              >
                <span className="om-sa-tone-icon" data-tone={mode.tone} aria-hidden="true">
                  <RemixIcon name="sparkling-line" size={12} />
                </span>
                <span>{t(idea.title)}</span>
              </Button>
            ))
          )}
        </div>
      </div>

      {mode.id !== 'coding' && (
      <section className="om-sa-showcase-panel">
        <div className="om-sa-showcase-bar" data-game-bar={showGameCards || undefined}>
          <div className="om-sa-showcase-tabs" role="tablist" aria-label={t('Template filters')}>
            {filters.map(f => (
              <Button
                key={f.id}
                variant="plain"
                type="button"
                role="tab"
                aria-selected={activeFilter === f.id}
                data-active={activeFilter === f.id || undefined}
                className="om-sa-showcase-tab"
                onClick={() => setActiveFilter(f.id)}
              >
                <span>{t(f.label)}</span>
                {typeof f.count === 'number' && <span className="om-sa-tab-count">{f.count}</span>}
              </Button>
            ))}
          </div>
          {showGameCards ? (
            <div className="om-sa-game-bar-controls">
              <span className="om-field om-sa-game-search">
                <RemixIcon name="search-line" size={14} />
                <input
                  value={gameQuery}
                  placeholder={t('Search')}
                  aria-label={t('Search games')}
                  onChange={event => setGameQuery(event.target.value)}
                />
                {gameQuery && (
                  <IconButton
                    variant="plain"
                    className="om-sa-game-search-clear"
                    aria-label={t('Clear')}
                    onClick={() => setGameQuery('')}
                    icon={<RemixIcon name="close-line" size={12} />}
                  />
                )}
              </span>
              {activeFilter !== 'mine' && (
                <div className="om-sa-game-sort">
                  <Select
                    label={t('Sort')}
                    value={gameSort}
                    onCommit={next => setGameSort(next as GameSort)}
                    options={[
                      { value: 'relevance', label: t('Relevance') },
                      { value: 'plays', label: t('Most played') },
                      { value: 'newest', label: t('Newest') },
                    ]}
                  />
                </div>
              )}
            </div>
          ) : (
            <Button
              variant="plain"
              type="button"
              className="om-sa-showcase-more"
              onClick={() => onOpenAllResources(
                activeFilter === 'brand-kit' ? 'brand-kit'
                  : activeFilter === 'asset' ? 'asset'
                  : activeFilter === 'skills' || activeFilter === 'design-skill' ? 'skills'
                  : mode.pickerCategory,
              )}
            >
              <span>{t('View all')}</span>
              <RemixIcon name="arrow-right-up-line" size={13} />
            </Button>
          )}
        </div>

        {mode.id === 'motion' && activeFilter === 'skills' && (
          <div className="om-sa-showcase-subtabs" role="tablist" aria-label={t('Skill categories')}>
            <Button
              variant="plain"
              type="button"
              role="tab"
              aria-selected={activeSkillCategory === 'all'}
              data-active={activeSkillCategory === 'all' || undefined}
              className="om-sa-showcase-subtab"
              onClick={() => setActiveSkillCategory('all')}
            >
              <span>{t('All')}</span>
              <span className="om-sa-tab-count">{motionSkills.length}</span>
            </Button>
            {skillCategories.map(cat => {
              const count = motionSkills.filter(s => s.category === cat).length;
              return (
                <Button
                  key={cat}
                  variant="plain"
                  type="button"
                  role="tab"
                  aria-selected={activeSkillCategory === cat}
                  data-active={activeSkillCategory === cat || undefined}
                  className="om-sa-showcase-subtab"
                  onClick={() => setActiveSkillCategory(cat)}
                >
                  <span>{t(cat)}</span>
                  <span className="om-sa-tab-count">{count}</span>
                </Button>
              );
            })}
          </div>
        )}

        {visibleGames ? (
          visibleGames.length === 0 ? (
            <div className="om-sa-showcase-empty">
              <p className="om-muted">{t('No matching games')}</p>
            </div>
          ) : (
            <GameMasonry
              games={visibleGames}
              minColumn={248}
              gap={12}
              className="om-sa-game-masonry"
              columnClassName="om-sa-game-masonry-column"
              render={game => {
                const title = localizedGameTitle(game, locale);
                const cover = coverUrl(game) ?? (game.source === 'mine' ? genreCovers[game.genre] : null);
                const isMine = game.source === 'mine';
                const mineAttachment = isMine ? toGameResourceAttachment(game, title) : null;
                const isSelected = isMine
                  ? Boolean(mineAttachment && selectedKeys.has(resourceKey(mineAttachment)))
                  : modeOptions?.gameTemplate?.id === game.id;
                const isPlaying = playingGameId === game.id;
                const status = isMine ? GAME_STATUS_LABELS[game.status] : undefined;

                return (
                  <article
                    key={game.id}
                    className="om-sa-game-tile om-sa-game-showcase-card"
                    data-orientation={game.orientation === 'portrait' ? 'portrait' : undefined}
                    data-selected={isSelected || undefined}
                    data-playing={isPlaying || undefined}
                  >
                    <Button
                      variant="plain"
                      type="button"
                      className="om-sa-game-tile-cover"
                      aria-label={t('Play {title}', { title })}
                      onClick={() => {
                        if (onPlayGame) {
                          onPlayGame(game);
                        } else {
                          selectGameForAgent(game);
                        }
                      }}
                    >
                      {cover ? (
                        <img src={cover} alt="" loading="lazy" decoding="async" />
                      ) : (
                        <div className="om-sa-game-tile-placeholder">
                          <RemixIcon name="gamepad-line" size={24} />
                          <span>{title}</span>
                        </div>
                      )}
                      <span className="om-sa-game-play-cue" aria-hidden="true">
                        <RemixIcon name="play-fill" size={14} />
                        <span>{t('Play')}</span>
                      </span>
                      {status && (
                        <span className="om-sa-game-status" data-tone={game.status}>
                          {game.status === 'building' && <RemixIcon name="loader-4-line" size={12} />}
                          {t(status)}
                        </span>
                      )}
                      {game.external && !game.external.embeddable && (
                        <span className="om-sa-game-status">
                          <RemixIcon name="external-link-line" size={12} />
                          {t('External link')}
                        </span>
                      )}
                      {game.multiplayer && !status && (
                        <span className="om-sa-game-status">
                          <RemixIcon name="group-line" size={12} />
                          {t('{count} players', { count: game.maxPlayers })}
                        </span>
                      )}
                    </Button>

                    <Button
                      variant="plain"
                      type="button"
                      className="om-sa-game-tile-remix"
                      aria-pressed={isSelected}
                      data-selected={isSelected || undefined}
                      title={isMine ? t('Attach to Chat') : t('Make one like this')}
                      aria-label={isMine ? `${t('Attach to Chat')}: ${title}` : `${t('Make one like this')}: ${title}`}
                      onClick={() => selectGameForAgent(game)}
                    >
                      <RemixIcon name={isSelected ? 'check-line' : 'sparkling-line'} size={12} />
                      <span>{isSelected ? t('Selected') : isMine ? t('Attach') : t('Make one like this')}</span>
                    </Button>

                    <div className="om-sa-game-tile-meta">
                      {cover && (
                        <span className="om-sa-game-tile-icon" aria-hidden="true">
                          <img src={cover} alt="" />
                        </span>
                      )}
                      <strong>{title}</strong>
                      {game.external ? (
                        <a
                          className="om-sa-game-tile-author"
                          href={game.external.postUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {game.external.author}
                        </a>
                      ) : game.plays > 0 ? (
                        <span className="om-sa-game-tile-plays">
                          <RemixIcon name="play-circle-line" size={13} />
                          {formatPlays(game.plays, locale)}
                        </span>
                      ) : null}
                    </div>
                  </article>
                );
              }}
            />
          )
        ) : (
        <div className="om-sa-showcase-grid" aria-busy={isLoading}>
          {visibleCurated ? (
            visibleCurated.map(card => (
              <Button
                key={card.id}
                variant="plain"
                type="button"
                className="om-sa-showcase-card"
                onClick={() => onPickPrompt(card.prompt)}
              >
                <div className="om-sa-showcase-thumb" aria-hidden="true">
                  <img
                    src={card.poster}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    style={card.posterPosition ? { objectPosition: card.posterPosition } : undefined}
                  />
                </div>
                <span className="om-sa-showcase-check" aria-hidden="true">
                  <RemixIcon name="arrow-right-up-line" size={13} />
                </span>
                <div className="om-sa-showcase-meta">
                  <strong>{t(card.title)}</strong>
                  <small>{card.subtitle}</small>
                </div>
              </Button>
            ))
          ) : isLoading ? (
            Array.from({ length: 10 }, (_, idx) => (
              <div key={idx} className="om-sa-showcase-skeleton">
                <Skeleton style={{ width: '100%', height: 130 }} />
              </div>
            ))
          ) : !visibleResources.length ? (
            <div className="om-sa-showcase-empty">
              <p className="om-muted">{t('No matching resources found')}</p>
              <Button
                variant="ghost"
                className="om-button h-auto"
                onClick={() => onOpenAllResources(mode.pickerCategory)}
              >
                {t('Browse workspace resources')}
              </Button>
            </div>
          ) : (
            visibleResources.map(item => {
              const isSelected = selectedKeys.has(resourceKey(item));
              return (
                <Button
                  key={resourceKey(item)}
                  variant="plain"
                  type="button"
                  className="om-sa-showcase-card"
                  aria-pressed={isSelected}
                  data-selected={isSelected || undefined}
                  onClick={() => onToggleAttachment(item)}
                >
                  <ResourceShowcaseThumb item={item} active={active} />
                  <span className="om-sa-showcase-check" aria-hidden="true">
                    <RemixIcon name={isSelected ? 'check-line' : 'add-line'} size={13} />
                  </span>
                  <div className="om-sa-showcase-meta">
                    <strong>{item.title}</strong>
                    {item.subtitle && <small>{item.subtitle}</small>}
                  </div>
                </Button>
              );
            })
          )}
        </div>
        )}

        {hasMore && (
          <div ref={sentinelRef} className="om-sa-showcase-load-more">
            <Button
              variant="plain"
              type="button"
              className="om-sa-load-more-btn"
              onClick={() => setVisibleCount(prev => Math.min(totalCount, prev + PAGE_BATCH_SIZE))}
            >
              <span>{t('Load more')}</span>
              <span className="om-sa-tab-count">{totalCount - visibleCount}</span>
            </Button>
          </div>
        )}
      </section>
      )}
    </div>
  );
}
