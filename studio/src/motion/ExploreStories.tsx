import { Button } from 'open-design-ui/button';
import { HorizontalRail } from './HorizontalRail';
import { findTechniqueStudio, type CreativeStudio } from '../../../shared/studio-catalog';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { Skeleton } from '../components/ui/Skeleton';
import { ModelStoryGallery, StoryCard } from './ModelStoryGallery';
import { ProviderAvatar } from './settingsPrimitives';
import { useWorkspaceChrome } from './WorkspaceChromeContext';
import type { useMediaCatalog } from './useMediaCatalog';
import { floatingCity, seedanceStory, gptImageStory, storyModels, type ModelStory } from './exploreModelStories';
import { animeOpeningScenario, mcpCapabilities } from './mcpCapabilities';
import { supportsScene, type StudioDestination } from './creativeStudios';
import { archivedSkillPoster } from './skillCatalog';
import { communityGames, genreLabels, styleLabels } from './game/gameCatalog';
import { localizedGameDescription, localizedGameTitle } from './game/gameSuperAgent';
import castleValleyPoster from './game/community/omw-castle-valley.jpg';

const sale = archivedSkillPoster('sale-countdown');
const shorts = archivedSkillPoster('multi-clips-to-reels');
const paintedFilm = archivedSkillPoster('footage-to-handpainted');
const printCover = archivedSkillPoster('color-pop-poster');
const blueprint = archivedSkillPoster('chalk-blueprint');
const launch = archivedSkillPoster('premium-halo');

type StoryActions = {
  onNavigate: (target: StudioDestination, prompt: string) => void;
  onModel: (id: string) => void;
  onClaude: (example?: string) => void;
  onChooseStudio: (studio: CreativeStudio) => void;
  onOpenBlackFriday: (button: HTMLButtonElement) => void;
};

export function ExploreHighlights({ onChooseStudio, onOpenBlackFriday }: Pick<StoryActions, 'onChooseStudio' | 'onOpenBlackFriday'>) {
  const { t } = useI18n();
  const jump = (id: string) => {
    const heading = document.getElementById('explore-' + id);
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start' });
  };
  return <section aria-labelledby="explore-highlights">
    <header className="om-discovery-heading"><h2 id="explore-highlights">{t('Explore highlights')}</h2></header>
    <HorizontalRail label="Explore highlights" className="om-highlights" viewportClassName="om-stories-rail">
      <StoryCard title={seedanceStory.title} poster={paintedFilm} label={t('Cinema Studio') + ' · ' + t('Video')} description={seedanceStory.description} onClick={() => jump('seedance')} />
      <StoryCard title="Game Studio" poster={castleValleyPoster} label={t('Super Agent') + ' · ' + t('Game Studio')} description="Build, play, and deploy multiplayer web games with your Agent" onClick={() => jump('games')} />
      <StoryCard title="Black Friday collection" poster={sale} label={t('Template library')} description="Browse Black Friday video references and Skills for your sale." onClick={event => onOpenBlackFriday(event.currentTarget)} />
      <StoryCard title="Claude Fable 5.2" poster={blueprint} label="Claude Code · OpenMotion MCP" description="From a keyframe to an anime opening" onClick={() => jump('claude')} />
      <StoryCard title={gptImageStory.title} poster={printCover} label={t('Design Studio') + ' · ' + t('Image')} description={gptImageStory.description} onClick={() => jump('gpt-image')} />
      <StoryCard title="Shorts Studio" poster={shorts} label={t('Short-form video')} description="Cut a recording into vertical shorts or assemble several clips into one reel." onClick={() => onChooseStudio(findTechniqueStudio('shorts')!)} />
    </HorizontalRail>
  </section>;
}

export function ModelCollection({ story, gateway, onNavigate, onModel }: {
  story: ModelStory; gateway: ReturnType<typeof useMediaCatalog>;
} & Pick<StoryActions, 'onNavigate' | 'onModel'>) {
  const { t } = useI18n(), { openModelSettings } = useWorkspaceChrome();
  const models = storyModels(story, gateway.catalog);
  const loading = !gateway.catalog && !gateway.failed;
  const featured = models.find(model => supportsScene(model, story.cases[0].destination.scene))
    ?? models.find(model => story.cases.some(c => supportsScene(model, c.destination.scene)));
  const heading = 'explore-' + story.id;
  return <section aria-labelledby={heading}>
    <header className="om-discovery-heading"><div>
      <h2 id={heading} tabIndex={-1}>{story.title}</h2>
      <p className="om-muted">{t(story.description)}</p>
    </div>
      {loading ? <Skeleton className="om-story-action-skeleton" /> : gateway.failed ? <Button type="button" variant="secondary" className="om-button" onClick={gateway.retry}>{t('Retry loading models')}</Button> :
        <Button type="button" variant="secondary" className="om-button" onClick={featured ? () => onModel(featured.id) : openModelSettings}>{t(featured ? 'Model details' : 'Manage providers')}<RemixIcon name="arrow-right-line" size={16} /></Button>}
    </header>
    <ModelStoryGallery story={story} models={models} loading={loading} onNavigate={onNavigate} brandedFallback showLabels={false} />
  </section>;
}

const FEATURED_GAME_IDS = ['community-what-the-water-keeps', 'community-evensong'] as const;

export function GameStories({ onOpenGameStudio, onBuildGameInSuperAgent }: {
  onOpenGameStudio: (gameId?: string) => void;
  onBuildGameInSuperAgent?: () => void;
}) {
  const { t, locale } = useI18n();
  const preferred = FEATURED_GAME_IDS.map(id => communityGames.find(game => game.id === id)).filter((game): game is NonNullable<typeof game> => Boolean(game));
  const featured = preferred.length === 2 ? preferred : communityGames.slice(0, 2);
  return <section className="om-card om-claude-stories" aria-labelledby="explore-games">
    <div className="om-claude-intro">
      <span className="om-feed-card-label"><RemixIcon name="gamepad-line" size={16} />{t('Super Agent')} · {t('Playable web games')}</span>
      <div className="om-discovery-heading"><h2 id="explore-games" tabIndex={-1}>{t('Game Studio')}</h2></div>
      <p className="om-muted">{t('Describe a game in one line, iterate live with Super Agent, play solo or multiplayer, and deploy a shareable link.')}</p>
      <div className="om-story-intro-actions">
        {onBuildGameInSuperAgent && (
          <Button type="button" variant="primary" className="om-button" data-primary onClick={onBuildGameInSuperAgent}>
            {t('Build a game')}<RemixIcon name="arrow-right-line" size={16} />
          </Button>
        )}
        <Button
          type="button"
          variant={onBuildGameInSuperAgent ? 'secondary' : 'primary'}
          className="om-button"
          data-primary={onBuildGameInSuperAgent ? undefined : true}
          onClick={() => onOpenGameStudio()}
        >
          {t('Explore games')}<RemixIcon name="arrow-right-line" size={16} />
        </Button>
      </div>
    </div>
    {featured.map(game => (
      <StoryCard
        key={game.id}
        title={localizedGameTitle(game, locale)}
        label={[t(genreLabels[game.genre]), game.style ? t(styleLabels[game.style]) : ''].filter(Boolean).join(' · ')}
        poster={game.cover ?? ''}
        credit={game.external ? `${game.external.author} · ${game.external.model}` : undefined}
        creditUrl={game.external?.postUrl}
        description={localizedGameDescription(game, locale)}
        onClick={() => onOpenGameStudio(game.id)}
      />
    ))}
  </section>;
}

export function ClaudeStories({ onClaude }: Pick<StoryActions, 'onClaude'>) {
  const { t } = useI18n();
  const film = mcpCapabilities.find(capability => capability.id === 'create')!;
  return <section className="om-card om-claude-stories" aria-labelledby="explore-claude">
    <div className="om-claude-intro">
      <span className="om-feed-card-label"><ProviderAvatar name="Claude" provider={{ id: 'claude-code', custom: false }} />OpenMotion MCP</span>
      <div className="om-discovery-heading"><h2 id="explore-claude" tabIndex={-1}>Claude Fable 5.2</h2></div>
      <p className="om-muted">{t('Choose Fable in Claude Code to plan shots, work with your media models and build an editable film through MCP.')}</p>
      <Button type="button" variant="primary" className="om-button" data-primary onClick={() => onClaude()}>{t('Connect Claude Code')}<RemixIcon name="plug-line" size={16} /></Button>
    </div>
    <StoryCard title={animeOpeningScenario.title} label="GPT Image 2.6 → Seedance 2.5" poster={floatingCity.poster} credit={floatingCity.credit} creditUrl={floatingCity.creditUrl} description={animeOpeningScenario.description} onClick={() => onClaude(animeOpeningScenario.id)} />
    <StoryCard title={film.title} label={'Claude Code · ' + t('Motion Studio')} poster={launch} description={film.description} onClick={() => onClaude(film.id)} />
  </section>;
}
