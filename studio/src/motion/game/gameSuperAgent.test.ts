import { describe, expect, it } from 'vitest';
import type { GameCard } from '../../../../shared/game-contract';
import { canChoosePlayableAd, isPlayableAd } from '../../super-agent/ModeComposerControls';
import { buildDirectGamePrompt, GAME_STUDIO_QUICK_IDEAS, toGameArtifact } from './gameSuperAgent';

const game = (patch: Partial<GameCard> = {}): GameCard => ({
  id: 'g1', title: 'Coin Cascade', description: 'Pull pins', genre: 'casual', style: '3d', setting: null, multiplayer: false, maxPlayers: 1,
  orientation: 'portrait', status: 'draft', cover: null, playUrl: '/api/games/g1/play/index.html', plays: 0, likes: 0, dislikes: 0,
  reaction: 0, favorite: false, source: 'mine', remixOf: null, controls: '', ...patch,
} as GameCard);

describe('playable ads in Super Agent', () => {
  it('counts only portrait single-player briefs with the ad option on', () => {
    expect(isPlayableAd({ gameOrientation: 'portrait', gameMultiplayer: false, gamePlayableAd: true })).toBe(true);
    expect(isPlayableAd({ gameOrientation: 'landscape', gameMultiplayer: false, gamePlayableAd: true })).toBe(false);
    expect(isPlayableAd({ gameOrientation: 'portrait', gameMultiplayer: true, gamePlayableAd: true })).toBe(false);
    expect(isPlayableAd({ gameOrientation: 'portrait', gameMultiplayer: false, gamePlayableAd: false })).toBe(false);
  });

  it('does not offer the ad option while a local template is selected, because remix copies it unchanged', () => {
    const base = { gameOrientation: 'portrait' as const, gameMultiplayer: false, gamePlayableAd: true };
    expect(canChoosePlayableAd({ gameOrientation: 'portrait', gameTemplate: game({ source: 'template' }) })).toBe(false);
    expect(isPlayableAd({ ...base, gameTemplate: game({ source: 'template' }) })).toBe(false);
    const community = game({ source: 'community', external: { url: 'https://x.test', author: 'a', postUrl: 'https://x.test/p', model: 'm', embeddable: true } });
    expect(isPlayableAd({ ...base, gameTemplate: community })).toBe(true);
  });

  it('tells the Super Agent turn to follow the playable-ad recipe only for ad drafts', () => {
    expect(buildDirectGamePrompt(game({ playableAd: true }), 'Build it')).toContain('format=playable ad');
    expect(buildDirectGamePrompt(game(), 'Build it')).not.toContain('playable ad');
    expect(toGameArtifact(game({ playableAd: true }), 'Coin Cascade').subtitle).toContain('Playable ad');
  });

  it('offers a portrait single-player playable-ad quick idea', () => {
    const idea = GAME_STUDIO_QUICK_IDEAS.find(item => item.playableAd);
    expect(idea).toMatchObject({ orientation: 'portrait', multiplayer: false });
  });
});
