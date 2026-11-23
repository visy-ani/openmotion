import type { CapabilityResourceRef } from '../../../../shared/capability-hub';
import type { GameCard, GameGenre, GameSetting, GameStyle } from '../../../../shared/game-contract';
import type { SuperAgentArtifact, SuperAgentResourceAttachment } from '../../../../shared/super-agent';
import { coverUrl } from './gameCatalog';

export function gamePlayPath(id: string): string {
  return `/motion-api/games/${encodeURIComponent(id)}/play/index.html`;
}

function playerLabel(game: GameCard): string {
  return game.playableAd ? 'Playable ad' : game.multiplayer ? 'Multiplayer' : 'Single player';
}

export function localizedGameTitle(game: GameCard, locale: string): string {
  return game.i18n?.[locale]?.title || game.title;
}

export function localizedGameDescription(game: GameCard, locale: string): string {
  return game.i18n?.[locale]?.description || game.description;
}

export function toGameCapabilityRef(game: GameCard, displayTitle: string): CapabilityResourceRef {
  return {
    kind: 'game-project',
    id: game.id,
    title: displayTitle,
    subtitle: `${game.genre} · ${playerLabel(game)}`,
    genre: game.genre,
    playUrl: gamePlayPath(game.id),
    ...(coverUrl(game) ? { coverUrl: coverUrl(game)! } : {}),
  };
}

export function toGameArtifact(game: GameCard, displayTitle: string): Partial<SuperAgentArtifact> {
  const isExternal = Boolean(game.external);
  return {
    id: `game:${game.id}`,
    kind: 'game-project',
    title: displayTitle,
    subtitle: game.external
      ? `${game.external.author} · ${game.external.model}`
      : `${game.genre} · ${game.playableAd ? 'Playable ad' : game.multiplayer ? 'Multiplayer' : 'Game Studio'}`,
    ...(isExternal ? {} : { projectId: game.id }),
    scenario: game.orientation === 'portrait' ? 'portrait' : 'landscape',
    revision: game.updatedAt,
    url: game.external ? game.external.url : gamePlayPath(game.id),
  };
}

export function toGameResourceAttachment(game: GameCard, displayTitle: string): SuperAgentResourceAttachment {
  return {
    kind: 'game-project',
    id: game.id,
    title: displayTitle,
    subtitle: `${game.genre} · ${playerLabel(game)}`,
    ...(coverUrl(game) ? { previewUrl: coverUrl(game)! } : {}),
  };
}

export function buildDirectGamePrompt(game: GameCard, instruction: string, userNotes?: string): string {
  const layout = game.orientation === 'portrait' ? 'portrait 9:16 phone layout (390x844)' : 'landscape 16:9 widescreen layout';
  const trimmedNotes = userNotes?.trim();
  const extraNotes = trimmedNotes && trimmedNotes !== game.description.trim()
    ? `Additional user notes: ${trimmedNotes}`
    : '';
  const contextParts = [
    `genre=${game.genre}`,
    game.style ? `style=${game.style}` : '',
    game.setting ? `setting=${game.setting}` : '',
    `multiplayer=${game.multiplayer}`,
    `orientation=${layout}`,
    // The draft instruction already carries the ad recipe; repeating the format here keeps it visible in Super Agent turns.
    game.playableAd ? 'format=playable ad (follow the openmotion-game playable-ad recipe: first-frame play with a hand tutorial, short levels, win/fail end cards with a store CTA, one self-contained HTML)' : '',
  ].filter(Boolean);
  return [
    instruction,
    extraNotes,
    `Game Studio context: ${contextParts.join(', ')}. Proceed directly to building and testing without unnecessary questions. If custom visual sprites, textures, music, or sound effects will elevate the game, you may generate reusable assets via openmotion_assets_use(action="generate") and reference their /motion-api/assets/<assetId>/versions/<versionId>/media URLs. Always finish by calling openmotion_present_artifact(kind="game-project", projectId="${game.id}") so the playable result opens in the Browser Artifact Viewer.`,
  ].filter(Boolean).join('\n\n');
}

export type GameQuickIdea = {
  title: string;
  genre: GameGenre;
  style: GameStyle | null;
  setting: GameSetting | null;
  orientation: 'landscape' | 'portrait';
  multiplayer: boolean;
  /** Portrait single-player ideas can start as a playable ad. */
  playableAd?: boolean;
  prompt: string;
};

export const GAME_STUDIO_QUICK_IDEAS: readonly GameQuickIdea[] = [
  {
    title: 'Co-op 3D crystal defense',
    genre: 'shooter',
    style: '3d',
    setting: 'fantasy',
    orientation: 'landscape',
    multiplayer: true,
    prompt: 'Defend a glowing arena crystal through 5 waves with 1–4 co-op players, dash/nova skills, and an instant invite link.',
  },
  {
    title: 'Retro pixel platformer',
    genre: 'platformer',
    style: 'pixel',
    setting: 'retro',
    orientation: 'landscape',
    multiplayer: false,
    prompt: 'Build a crisp pixel-art platformer with tight jump physics, hidden coins, hazards, and a dramatic boss arena.',
  },
  {
    title: 'Portrait one-tap arcade',
    genre: 'casual',
    style: 'minimal',
    setting: 'modern',
    orientation: 'portrait',
    multiplayer: false,
    prompt: 'Create an addictive 9:16 portrait one-tap arcade game playable with one thumb, instant restarts, and combo multipliers.',
  },
  {
    title: 'Pull-the-pin playable ad',
    genre: 'casual',
    style: '3d',
    setting: null,
    orientation: 'portrait',
    multiplayer: false,
    playableAd: true,
    prompt: 'Make a pull-the-pin coin playable ad: coins pour through ×2 and ×5 rings into a piggy bank, with a hand tutorial and a Play now end card.',
  },
  {
    title: 'Cyberpunk drift racer',
    genre: 'racing',
    style: '3d',
    setting: 'cyberpunk',
    orientation: 'landscape',
    multiplayer: false,
    prompt: 'Build a neon night-time 3D street racing game with smooth drifting, nitro boost pads, and lap time records.',
  },
];
