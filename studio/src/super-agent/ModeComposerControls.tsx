import { Button } from 'open-design-ui/button';
import { useEffect, useMemo, useState } from 'react';
import {
  gameGenres,
  gameSettings,
  gameStyles,
  type GameCard,
  type GameGenre,
  type GameSetting,
  type GameStyle,
} from '../../../shared/game-contract';
import type { Modality, Model } from '../../../shared/gateway';
import { Popover } from '../components/ui/Popover';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import {
  genreCovers,
  genreLabels,
  genrePlaceholders,
  settingCovers,
  settingLabels,
  styleCovers,
  styleLabels,
} from '../motion/game/gameCatalog';
import { providerReady } from '../motion/imageMenuModels';
import { ModelAvatar } from '../motion/settingsPrimitives';
import { useMediaCatalog } from '../motion/useMediaCatalog';
import type { SuperAgentCreationModeId, SuperAgentModeSpec } from './ModeResourceShowcase';
import type { ResourceCategoryTab } from './ResourcePickerDialog';

export type ModeComposerOptions = {
  // Image Artwork
  imageModelId: string;
  imageAspect: 'auto' | '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2';
  imageQuality: 'standard' | 'high';
  imageCount: 1 | 2 | 4;

  // Cinema Video (also supports switching directly to Motion graphics)
  mediaSubMode: 'video' | 'motion';
  videoModelId: string;
  videoAspect: '16:9' | '9:16' | '1:1' | '21:9';
  videoDuration: '5s' | '8s' | '10s' | '15s';
  videoSpeed: 'fast' | 'standard' | 'cinema';

  // Audio & Sound
  audioModelId: string;
  audioType: 'music' | 'voiceover' | 'sfx';
  audioDuration: '10s' | '30s' | '60s';

  // Motion Video (also supports switching directly to AI Video models like Seedance)
  motionEngine: 'motion' | 'video-model';
  motionAspect: '16:9' | '9:16' | '1:1' | '4:5';
  motionDuration: '10s' | '15s' | '20s' | '30s';
  motionFps: '30fps' | '60fps';
  motionStyle: 'kinetic' | 'product' | 'editorial' | 'minimal';

  // Slides & Docs
  deckFormat: 'slides' | 'document' | 'report';
  deckSlides: '5-7' | '8-12' | '12-16' | 'auto';
  deckDensity: 'visual' | 'balanced' | 'detailed';

  // Website & App
  webTarget: 'responsive' | 'mobile' | 'dashboard';
  webReferenceUrl: string;

  // Game Studio
  gameGenre: GameGenre | null;
  gameStyle: GameStyle | null;
  gameSetting: GameSetting | null;
  gameOrientation: 'landscape' | 'portrait';
  gameMultiplayer: boolean;
  /** Portrait only: build a playable ad. On by default, matching Game Studio; ignored for landscape or multiplayer. */
  gamePlayableAd: boolean;
  gameTemplate: GameCard | null;

  // Pure Coding
  codingWorkdir: string;
  codingFocus: 'general' | 'debug' | 'refactor' | 'test' | 'review';
};

/** A local template is copied as it is (remix takes only its id), so the ad option cannot apply to it. */
export function canChoosePlayableAd(options: Pick<ModeComposerOptions, 'gameOrientation' | 'gameTemplate'>): boolean {
  return options.gameOrientation === 'portrait' && !(options.gameTemplate && !options.gameTemplate.external);
}

/** A portrait, single-player game brief with the ad option on is built as a playable ad. */
export function isPlayableAd(options: Pick<ModeComposerOptions, 'gameOrientation' | 'gameMultiplayer' | 'gamePlayableAd'> & Partial<Pick<ModeComposerOptions, 'gameTemplate'>>): boolean {
  return canChoosePlayableAd({ gameOrientation: options.gameOrientation, gameTemplate: options.gameTemplate ?? null }) && options.gamePlayableAd && !options.gameMultiplayer;
}

export const DEFAULT_MODE_COMPOSER_OPTIONS: ModeComposerOptions = {
  imageModelId: 'auto',
  imageAspect: '16:9',
  imageQuality: 'standard',
  imageCount: 1,

  mediaSubMode: 'video',
  videoModelId: 'auto',
  videoAspect: '16:9',
  videoDuration: '5s',
  videoSpeed: 'standard',
  audioModelId: 'auto',
  audioType: 'music',
  audioDuration: '30s',

  motionEngine: 'motion',
  motionAspect: '16:9',
  motionDuration: '15s',
  motionFps: '30fps',
  motionStyle: 'kinetic',

  deckFormat: 'slides',
  deckSlides: '8-12',
  deckDensity: 'visual',

  webTarget: 'responsive',
  webReferenceUrl: '',

  gameGenre: 'shooter',
  gameStyle: null,
  gameSetting: null,
  gameOrientation: 'landscape',
  gameMultiplayer: false,
  gamePlayableAd: true,
  gameTemplate: null,

  codingWorkdir: '',
  codingFocus: 'general',
};

const WEB_TARGET_LABELS: Record<ModeComposerOptions['webTarget'], string> = {
  responsive: 'Responsive Web',
  mobile: 'Mobile App',
  dashboard: 'Dashboard',
};

const DECK_FORMAT_LABELS: Record<ModeComposerOptions['deckFormat'], string> = {
  slides: 'Slides (16:9)',
  document: 'Document (A4)',
  report: 'Visual Report',
};

const DECK_DENSITY_LABELS: Record<ModeComposerOptions['deckDensity'], string> = {
  visual: 'Visual',
  balanced: 'Balanced',
  detailed: 'Detailed',
};

const MOTION_STYLE_LABELS: Record<ModeComposerOptions['motionStyle'], string> = {
  kinetic: 'Kinetic Type',
  product: 'Product Launch',
  editorial: 'Editorial',
  minimal: 'Minimal',
};

const AUDIO_TYPE_LABELS: Record<ModeComposerOptions['audioType'], string> = {
  music: 'Music',
  voiceover: 'Voiceover',
  sfx: 'Sound FX',
};

const VIDEO_SPEED_LABELS: Record<ModeComposerOptions['videoSpeed'], string> = {
  fast: 'Fast',
  standard: 'Standard',
  cinema: 'Cinema',
};

const CODING_FOCUS_LABELS: Record<ModeComposerOptions['codingFocus'], string> = {
  general: 'General coding',
  debug: 'Debug & fix',
  refactor: 'Refactor',
  test: 'Tests',
  review: 'Code review',
};

export function getModeComposerPlaceholder(
  mode: SuperAgentModeSpec | null,
  options: ModeComposerOptions,
  t: (text: string) => string,
): string {
  if (!mode) return t('Ask Super Agent to build a game, website, video, deck, or asset…');
  if (mode.id === 'coding') {
    if (options.codingFocus === 'debug') return t('Describe the bug, stack trace, or failing behavior to investigate and fix…');
    if (options.codingFocus === 'refactor') return t('Describe the module or code pattern to refactor cleanly…');
    if (options.codingFocus === 'test') return t('Describe the tests to write or run in this repository…');
    if (options.codingFocus === 'review') return t('Describe the diff, branch, or files to review…');
    return t(mode.placeholder);
  }
  if (mode.id === 'media') {
    if (options.mediaSubMode === 'motion') {
      return t('Describe the editable Motion graphics film you want to build…');
    }
    return t('Describe the cinema video shot, camera motion, and lighting you want to generate…');
  }
  if (mode.id === 'audio') {
    if (options.audioType === 'voiceover') {
      return t('Write the narration script or describe the voiceover tone you want to generate…');
    }
    if (options.audioType === 'sfx') {
      return t('Describe the sound effects or foley audio cues you want to generate…');
    }
    return t('Describe the soundtrack, mood, tempo, or audio you want to create…');
  }
  if (mode.id === 'motion' && options.motionEngine === 'video-model') {
    return t('Describe the AI video shot you want to generate with Seedance or your video model…');
  }
  if (mode.id === 'game') {
    return t(genrePlaceholders[options.gameGenre ?? 'none']);
  }
  return t(mode.placeholder);
}

export function formatModePromptPrefix(
  mode: SuperAgentModeSpec,
  options: ModeComposerOptions,
  mediaModels: Model[],
): string {
  const parts: string[] = [];
  const findModelLabel = (id: string) => {
    if (!id || id === 'auto') return null;
    const found = mediaModels.find(item => item.id === id);
    return found ? `${found.label} (${found.id})` : id;
  };

  if (mode.id === 'image') {
    parts.push('Mode: Image Artwork');
    const modelLabel = findModelLabel(options.imageModelId);
    if (modelLabel) parts.push(`Image Model: ${modelLabel}`);
    if (options.imageAspect !== 'auto') parts.push(`Aspect: ${options.imageAspect}`);
    if (options.imageQuality === 'high') parts.push('Quality: High / 2K');
    if (options.imageCount > 1) parts.push(`Count: ${options.imageCount} variations`);
  } else if (mode.id === 'media') {
    if (options.mediaSubMode === 'motion') {
      parts.push('Mode: Motion graphics (Editable HyperFrames Code)');
      parts.push(`Format: ${options.motionAspect} · ${options.motionDuration} · ${options.motionFps}`);
      parts.push(`Style: ${MOTION_STYLE_LABELS[options.motionStyle]}`);
    } else {
      parts.push('Mode: AI Cinema Video (Video Model)');
      const modelLabel = findModelLabel(options.videoModelId);
      if (modelLabel) parts.push(`Video Model: ${modelLabel}`);
      parts.push(`Format: ${options.videoAspect} · ${options.videoDuration} · ${VIDEO_SPEED_LABELS[options.videoSpeed]}`);
    }
  } else if (mode.id === 'audio') {
    parts.push('Mode: Audio & Sound');
    const modelLabel = findModelLabel(options.audioModelId);
    if (modelLabel) parts.push(`Audio Model: ${modelLabel}`);
    parts.push(`Type: ${AUDIO_TYPE_LABELS[options.audioType]}`);
    parts.push(`Duration: ${options.audioDuration}`);
  } else if (mode.id === 'motion') {
    if (options.motionEngine === 'video-model') {
      parts.push('Mode: AI Cinema Video (Video Model)');
      const modelLabel = findModelLabel(options.videoModelId);
      if (modelLabel) parts.push(`Video Model: ${modelLabel}`);
      parts.push(`Format: ${options.videoAspect} · ${options.videoDuration} · ${VIDEO_SPEED_LABELS[options.videoSpeed]}`);
    } else {
      parts.push('Mode: Motion graphics (Editable HyperFrames Code)');
      parts.push(`Format: ${options.motionAspect} · ${options.motionDuration} · ${options.motionFps}`);
      parts.push(`Style: ${MOTION_STYLE_LABELS[options.motionStyle]}`);
    }
  } else if (mode.id === 'deck') {
    parts.push('Mode: Slides & Docs');
    parts.push(`Format: ${DECK_FORMAT_LABELS[options.deckFormat]}`);
    if (options.deckSlides !== 'auto') parts.push(`Length: ${options.deckSlides} slides`);
    parts.push(`Style: ${DECK_DENSITY_LABELS[options.deckDensity]}`);
  } else if (mode.id === 'website') {
    parts.push('Mode: Website & App');
    parts.push(`Target: ${WEB_TARGET_LABELS[options.webTarget]}`);
    if (options.webReferenceUrl.trim()) parts.push(`Reference URL: ${options.webReferenceUrl.trim()}`);
  } else if (mode.id === 'coding') {
    if (options.codingFocus === 'general') return '';
    return `[Coding: ${CODING_FOCUS_LABELS[options.codingFocus]}]`;
  } else if (mode.id === 'game') {
    parts.push('Mode: Game Studio');
    if (options.gameGenre) parts.push(`Genre: ${genreLabels[options.gameGenre]}`);
    if (options.gameStyle) parts.push(`Style: ${styleLabels[options.gameStyle]}`);
    if (options.gameSetting) parts.push(`Setting: ${settingLabels[options.gameSetting]}`);
    parts.push(`Layout: ${options.gameOrientation === 'portrait' ? 'Portrait (9:16)' : 'Landscape (16:9)'}`);
    parts.push(`Players: ${isPlayableAd(options) ? 'Playable ad' : options.gameMultiplayer ? 'Multiplayer' : 'Single player'}`);
    if (options.gameTemplate) parts.push(`Template: ${options.gameTemplate.title}`);
  } else {
    parts.push(`Mode: ${mode.label}`);
  }

  return `[${parts.join(' | ')}]`;
}

function modelShortDescription(model: Model, t: (text: string) => string): string {
  if (model.description?.trim()) return model.description.trim();
  const hints: string[] = [];
  if (model.modality === 'image' && model.supportsImageReference) hints.push(t('Supports image reference & edit'));
  if (model.modality === 'video' && (model.maxInputImages ?? 0) > 0) hints.push(t('Supports start-frame reference'));
  if (model.modality === 'audio' && model.mode) hints.push(model.mode);
  if (hints.length) return hints.join(' · ');
  return model.provider;
}

/**
 * Floating pill bar placed cleanly ABOVE the composer box (Manus-style),
 * keeping model / pipeline switches (`Seedance`, `Motion graphics`, `Audio`, `Import from…`)
 * accessible without crowding the composer's bottom toolbar.
 */
export function ModeComposerTopBar({
  active = true,
  modeId,
  options,
  disabled,
  onChange,
  onCatalogModelsChange,
  onOpenResourcePicker,
  onOpenModelSettings,
}: {
  active?: boolean;
  modeId: SuperAgentCreationModeId;
  options: ModeComposerOptions;
  disabled?: boolean;
  onChange: (patch: Partial<ModeComposerOptions>) => void;
  onCatalogModelsChange?: (models: Model[]) => void;
  onOpenResourcePicker: (category: ResourceCategoryTab) => void;
  onOpenModelSettings: () => void;
}) {
  const { t } = useI18n();
  const needsMediaCatalog = active && (modeId === 'image' || modeId === 'media' || modeId === 'motion' || modeId === 'audio');
  const { catalog } = useMediaCatalog(needsMediaCatalog);
  const [openMenu, setOpenMenu] = useState<
    | 'video-model'
    | 'image-model'
    | 'audio-model'
    | 'import'
    | 'coding-workdir'
    | 'game-genre'
    | 'game-style'
    | 'game-setting'
    | 'game-orientation'
    | 'game-players'
    | null
  >(null);
  const [urlDraft, setUrlDraft] = useState(options.webReferenceUrl);
  const [workdirDraft, setWorkdirDraft] = useState(options.codingWorkdir);

  useEffect(() => {
    setUrlDraft(options.webReferenceUrl);
  }, [options.webReferenceUrl]);

  useEffect(() => {
    setWorkdirDraft(options.codingWorkdir);
  }, [options.codingWorkdir]);

  useEffect(() => {
    if (!active) setOpenMenu(null);
  }, [active]);

  useEffect(() => {
    setOpenMenu(null);
  }, [modeId]);

  useEffect(() => {
    if (catalog?.models && onCatalogModelsChange) {
      onCatalogModelsChange(catalog.models);
    }
  }, [catalog?.models, onCatalogModelsChange]);

  const providers = catalog?.status.providers ?? [];

  const getModelsFor = useMemo(() => {
    const all = catalog?.models ?? [];
    return (modality: Modality) =>
      all
        .filter(item => item.modality === modality)
        .sort((a, b) => {
          const aReady = providerReady(providers, a.provider) ? 0 : 1;
          const bReady = providerReady(providers, b.provider) ? 0 : 1;
          if (aReady !== bReady) return aReady - bReady;
          return a.label.localeCompare(b.label);
        });
  }, [catalog?.models, providers]);

  const renderFloatingModelPill = ({
    menuKey,
    modality,
    selectedId,
    isActiveEngine,
    fallbackLabel,
    title,
    onSelect,
  }: {
    menuKey: 'video-model' | 'image-model' | 'audio-model';
    modality: Modality;
    selectedId: string;
    isActiveEngine: boolean;
    fallbackLabel: string;
    title: string;
    onSelect: (id: string) => void;
  }) => {
    const list = getModelsFor(modality);
    const defaultRouteId = catalog?.status.routes?.[modality];
    const defaultRouteModel = (defaultRouteId ? list.find(item => item.id === defaultRouteId) : undefined) ?? list[0];
    const selectedModel = selectedId !== 'auto' ? list.find(item => item.id === selectedId) : undefined;
    const displayModel = selectedModel ?? defaultRouteModel;
    const label = displayModel?.label ?? fallbackLabel;

    return (
      <Popover
        open={openMenu === menuKey}
        onOpenChange={next => setOpenMenu(next ? menuKey : null)}
        side="top"
        align="start"
        aria-label={title}
        className="om-sa-mode-popover om-sa-mode-model-popover"
        trigger={
          <Button
            variant="plain"
            type="button"
            className="om-sa-composer-top-pill"
            data-active={isActiveEngine || undefined}
            data-open={openMenu === menuKey || undefined}
            aria-pressed={isActiveEngine}
            disabled={disabled}
          >
            {displayModel ? (
              <span className="om-sa-mode-param-avatar" aria-hidden="true">
                <ModelAvatar
                  name={displayModel.label}
                  modelId={displayModel.modelId}
                  provider={{ id: displayModel.provider, custom: false }}
                />
              </span>
            ) : (
              <RemixIcon name="add-line" size={13} />
            )}
            <span className="om-sa-composer-top-pill-label">{label}</span>
            <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
          </Button>
        }
      >
        <div className="om-sa-mode-menu">
          <div className="om-sa-mode-menu-head">
            <span className="om-sa-popover-label">{title}</span>
            <span className="om-sa-mode-menu-count">{list.length}</span>
          </div>
          <div className="om-sa-mode-model-list" role="listbox" aria-label={title}>
            <Button
              variant="plain"
              type="button"
              role="option"
              aria-selected={isActiveEngine && selectedId === 'auto'}
              data-active={(isActiveEngine && selectedId === 'auto') || undefined}
              className="om-sa-mode-model-row"
              onClick={() => {
                onSelect('auto');
                setOpenMenu(null);
              }}
            >
              <span className="om-sa-mode-model-avatar" aria-hidden="true">
                <RemixIcon name="sparkling-fill" size={14} />
              </span>
              <span className="om-sa-mode-model-copy">
                <strong>{t('Auto (Recommended)')}</strong>
                <span>{defaultRouteModel ? `${t('Uses')} ${defaultRouteModel.label}` : t('Pick best configured model automatically')}</span>
              </span>
              {isActiveEngine && selectedId === 'auto' && <RemixIcon name="check-line" size={15} />}
            </Button>

            {list.map(model => {
              const isSelected = isActiveEngine && selectedId === model.id;
              const ready = providerReady(providers, model.provider);
              return (
                <Button
                  key={model.id}
                  variant="plain"
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-active={isSelected || undefined}
                  className="om-sa-mode-model-row"
                  onClick={() => {
                    onSelect(model.id);
                    setOpenMenu(null);
                  }}
                >
                  <span className="om-sa-mode-model-avatar" aria-hidden="true">
                    <ModelAvatar name={model.label} modelId={model.modelId} provider={{ id: model.provider, custom: false }} />
                  </span>
                  <span className="om-sa-mode-model-copy">
                    <span className="om-sa-mode-model-title-line">
                      <strong>{model.label}</strong>
                      <span className="om-sa-model-group-dot" data-ready={ready || undefined} aria-hidden="true" />
                    </span>
                    <span>{modelShortDescription(model, t)}</span>
                  </span>
                  {isSelected && <RemixIcon name="check-line" size={15} />}
                </Button>
              );
            })}

            {list.length === 0 && (
              <div className="om-sa-model-unavailable">
                <p className="om-muted">{t('No configured models yet. Connect a provider in Settings.')}</p>
              </div>
            )}
          </div>
          <div className="om-sa-model-menu-foot">
            <Button
              variant="plain"
              type="button"
              className="om-sa-popover-link-row"
              onClick={() => {
                setOpenMenu(null);
                onOpenModelSettings();
              }}
            >
              <RemixIcon name="settings-3-line" size={15} />
              <span>{t('Manage Model Providers')}</span>
              <RemixIcon name="arrow-right-up-line" size={14} />
            </Button>
          </div>
        </div>
      </Popover>
    );
  };

  if (modeId === 'motion' || modeId === 'media') {
    const isVideoActive = modeId === 'motion'
      ? options.motionEngine === 'video-model'
      : options.mediaSubMode === 'video';
    const isMotionActive = modeId === 'motion'
      ? options.motionEngine === 'motion'
      : options.mediaSubMode === 'motion';

    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Video generation options')}>
        {renderFloatingModelPill({
          menuKey: 'video-model',
          modality: 'video',
          selectedId: options.videoModelId,
          isActiveEngine: isVideoActive,
          fallbackLabel: t('AI Video model'),
          title: t('Video model'),
          onSelect: id => {
            if (modeId === 'motion') {
              onChange({ motionEngine: 'video-model', videoModelId: id });
            } else {
              onChange({ mediaSubMode: 'video', videoModelId: id });
            }
          },
        })}

        <Button
          variant="plain"
          type="button"
          className="om-sa-composer-top-pill"
          data-active={isMotionActive || undefined}
          aria-pressed={isMotionActive}
          disabled={disabled}
          onClick={() => {
            setOpenMenu(null);
            if (modeId === 'motion') onChange({ motionEngine: 'motion' });
            else onChange({ mediaSubMode: 'motion' });
          }}
        >
          <RemixIcon name={isMotionActive ? 'check-line' : 'add-line'} size={13} />
          <span>{t('Motion graphics')}</span>
        </Button>
      </div>
    );
  }

  if (modeId === 'audio') {
    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Audio model')}>
        {renderFloatingModelPill({
          menuKey: 'audio-model',
          modality: 'audio',
          selectedId: options.audioModelId,
          isActiveEngine: true,
          fallbackLabel: t('Audio model'),
          title: t('Audio model'),
          onSelect: id => onChange({ audioModelId: id }),
        })}
      </div>
    );
  }

  if (modeId === 'image') {
    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Image model')}>
        {renderFloatingModelPill({
          menuKey: 'image-model',
          modality: 'image',
          selectedId: options.imageModelId,
          isActiveEngine: true,
          fallbackLabel: t('Image model'),
          title: t('Image model'),
          onSelect: id => onChange({ imageModelId: id }),
        })}
      </div>
    );
  }

  if (modeId === 'website') {
    const hasUrl = Boolean(options.webReferenceUrl.trim());
    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Website references')}>
        <Popover
          open={openMenu === 'import'}
          onOpenChange={next => setOpenMenu(next ? 'import' : null)}
          side="top"
          align="start"
          aria-label={t('Import from URL or Brand Kit')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={hasUrl || openMenu === 'import' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="global-line" size={13} />
              <span className="om-sa-composer-top-pill-label">
                {hasUrl ? options.webReferenceUrl.replace(/^https?:\/\//, '').slice(0, 26) : t('Import from…')}
              </span>
              <RemixIcon name="arrow-down-s-line" size={14} />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Reference website URL')}</span>
              <div className="om-sa-mode-url-row">
                <input
                  type="url"
                  className="om-sa-mode-url-input"
                  value={urlDraft}
                  placeholder="https://example.com"
                  onChange={event => setUrlDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onChange({ webReferenceUrl: urlDraft.trim() });
                      setOpenMenu(null);
                    }
                  }}
                />
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  data-active
                  onClick={() => {
                    onChange({ webReferenceUrl: urlDraft.trim() });
                    setOpenMenu(null);
                  }}
                >
                  {t('Apply')}
                </Button>
                {hasUrl && (
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    onClick={() => {
                      setUrlDraft('');
                      onChange({ webReferenceUrl: '' });
                      setOpenMenu(null);
                    }}
                  >
                    {t('Clear')}
                  </Button>
                )}
              </div>
            </div>
            <div className="om-sa-model-menu-foot">
              <Button
                variant="plain"
                type="button"
                className="om-sa-popover-link-row"
                onClick={() => {
                  setOpenMenu(null);
                  onOpenResourcePicker('brand-kit');
                }}
              >
                <RemixIcon name="palette-line" size={15} />
                <span>{t('Attach Brand Kit')}</span>
                <RemixIcon name="arrow-right-up-line" size={14} />
              </Button>
              <Button
                variant="plain"
                type="button"
                className="om-sa-popover-link-row"
                onClick={() => {
                  setOpenMenu(null);
                  onOpenResourcePicker('design-template');
                }}
              >
                <RemixIcon name="layout-line" size={15} />
                <span>{t('Attach Design Template')}</span>
                <RemixIcon name="arrow-right-up-line" size={14} />
              </Button>
            </div>
          </div>
        </Popover>
      </div>
    );
  }

  if (modeId === 'coding') {
    const trimmed = options.codingWorkdir.trim();
    const shortDir = trimmed ? (trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed) : '';
    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Working directory')}>
        <Popover
          open={openMenu === 'coding-workdir'}
          onOpenChange={next => setOpenMenu(next ? 'coding-workdir' : null)}
          side="top"
          align="start"
          aria-label={t('Working directory')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={Boolean(trimmed) || openMenu === 'coding-workdir' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="folder-line" size={13} />
              <span className="om-sa-composer-top-pill-label" title={trimmed || undefined}>
                {shortDir || t('Workspace folder')}
              </span>
              <RemixIcon name="arrow-down-s-line" size={14} />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Local project folder path')}</span>
              <div className="om-sa-mode-url-row">
                <input
                  type="text"
                  className="om-sa-mode-url-input"
                  value={workdirDraft}
                  placeholder="/path/to/repo"
                  onChange={event => setWorkdirDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onChange({ codingWorkdir: workdirDraft.trim() });
                      setOpenMenu(null);
                    }
                  }}
                />
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  data-active
                  onClick={() => {
                    onChange({ codingWorkdir: workdirDraft.trim() });
                    setOpenMenu(null);
                  }}
                >
                  {t('Apply')}
                </Button>
                {trimmed && (
                  <Button
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    onClick={() => {
                      setWorkdirDraft('');
                      onChange({ codingWorkdir: '' });
                      setOpenMenu(null);
                    }}
                  >
                    {t('Clear')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </Popover>
      </div>
    );
  }

  if (modeId === 'game') {
    const renderGameArtPicker = ({
      menuKey,
      fallbackIcon,
      label,
      clearLabel,
      selectedId,
      items,
      labels,
      covers,
      onSelect,
    }: {
      menuKey: 'game-genre' | 'game-style' | 'game-setting';
      fallbackIcon: string;
      label: string;
      clearLabel: string;
      selectedId: string | null;
      items: readonly string[];
      labels: Record<string, string>;
      covers: Record<string, string | null>;
      onSelect: (id: string | null) => void;
    }) => {
      const selectedCover = selectedId ? covers[selectedId] : null;
      return (
        <Popover
          open={openMenu === menuKey}
          onOpenChange={next => setOpenMenu(next ? menuKey : null)}
          side="top"
          align="start"
          aria-label={t(label)}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={Boolean(selectedId) || openMenu === menuKey || undefined}
              data-open={openMenu === menuKey || undefined}
              disabled={disabled}
            >
              <span key={selectedId ?? 'any'} className="om-sa-pill-swap">
                {selectedCover ? (
                  <img className="om-sa-game-pill-thumb" src={selectedCover} alt="" />
                ) : (
                  <RemixIcon name={fallbackIcon} size={13} />
                )}
                <span className="om-sa-composer-top-pill-label">
                  {selectedId ? t(labels[selectedId]) : t(label)}
                </span>
              </span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-menu-head">
              <span className="om-sa-popover-label">{t(label)}</span>
              {selectedId && (
                <Button
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  onClick={() => {
                    onSelect(null);
                    setOpenMenu(null);
                  }}
                >
                  {t(clearLabel)}
                </Button>
              )}
            </div>
            <div className="om-sa-game-art-grid" role="group" aria-label={t(label)}>
              {items.map(id => {
                const activeItem = selectedId === id;
                const cover = covers[id];
                return (
                  <Button
                    key={id}
                    variant="plain"
                    type="button"
                    className="om-sa-game-art-option"
                    aria-pressed={activeItem}
                    data-active={activeItem || undefined}
                    onClick={() => {
                      onSelect(activeItem ? null : id);
                      setOpenMenu(null);
                    }}
                  >
                    {cover ? (
                      <img src={cover} alt="" />
                    ) : (
                      <span className="om-sa-game-art-fallback" aria-hidden="true">
                        <RemixIcon name={fallbackIcon} size={18} />
                      </span>
                    )}
                    <span>{t(labels[id])}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        </Popover>
      );
    };

    return (
      <div className="om-sa-composer-top-bar" role="group" aria-label={t('Game studio options')}>
        {renderGameArtPicker({
          menuKey: 'game-genre',
          fallbackIcon: 'gamepad-line',
          label: 'Genre',
          clearLabel: 'Any genre',
          selectedId: options.gameGenre,
          items: gameGenres,
          labels: genreLabels,
          covers: genreCovers,
          onSelect: id => onChange({ gameGenre: id as GameGenre | null }),
        })}
        {renderGameArtPicker({
          menuKey: 'game-style',
          fallbackIcon: 'brush-line',
          label: 'Style',
          clearLabel: 'Any style',
          selectedId: options.gameStyle,
          items: gameStyles,
          labels: styleLabels,
          covers: styleCovers,
          onSelect: id => onChange({ gameStyle: id as GameStyle | null }),
        })}
        {renderGameArtPicker({
          menuKey: 'game-setting',
          fallbackIcon: 'landscape-line',
          label: 'Setting',
          clearLabel: 'Any setting',
          selectedId: options.gameSetting,
          items: gameSettings,
          labels: settingLabels,
          covers: settingCovers,
          onSelect: id => onChange({ gameSetting: id as GameSetting | null }),
        })}
        <Popover
          open={openMenu === 'game-orientation'}
          onOpenChange={next => setOpenMenu(next ? 'game-orientation' : null)}
          side="top"
          align="start"
          aria-label={t('Screen layout')}
          className="om-sa-mode-popover om-sa-game-choice-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={options.gameOrientation === 'portrait' || openMenu === 'game-orientation' || undefined}
              data-open={openMenu === 'game-orientation' || undefined}
              aria-haspopup="listbox"
              aria-expanded={openMenu === 'game-orientation'}
              disabled={disabled}
            >
              <span key={options.gameOrientation} className="om-sa-pill-swap">
                <RemixIcon name={options.gameOrientation === 'portrait' ? 'smartphone-line' : 'computer-line'} size={13} />
                <span className="om-sa-composer-top-pill-label">
                  {t(options.gameOrientation === 'portrait' ? 'Portrait' : 'Landscape')}
                </span>
              </span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-menu-head">
              <span className="om-sa-popover-label">{t('Screen layout')}</span>
            </div>
            <div className="om-sa-game-choice-list" role="listbox" aria-label={t('Screen layout')}>
              {([
                {
                  id: 'landscape' as const,
                  label: 'Landscape',
                  ratio: '16:9',
                  description: 'Desktop & widescreen browser play',
                },
                {
                  id: 'portrait' as const,
                  label: 'Portrait',
                  ratio: '9:16',
                  description: 'Mobile & one-thumb vertical play',
                },
              ]).map(item => {
                const selected = options.gameOrientation === item.id;
                return (
                  <Button
                    key={item.id}
                    variant="plain"
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-active={selected || undefined}
                    className="om-sa-game-choice-row"
                    onClick={() => {
                      // Choosing portrait selects Playable ad by default, every time (like Game Studio).
                      onChange(item.id === 'portrait' && options.gameOrientation !== 'portrait'
                        ? { gameOrientation: item.id, gamePlayableAd: true, gameMultiplayer: false }
                        : { gameOrientation: item.id });
                      setOpenMenu(null);
                    }}
                  >
                    <span className="om-sa-game-choice-visual" aria-hidden="true">
                      <span className="om-sa-ratio-glyph" data-ratio={item.ratio} />
                    </span>
                    <span className="om-sa-game-choice-copy">
                      <span className="om-sa-game-choice-title">
                        <strong>{t(item.label)}</strong>
                        <small>{item.ratio}</small>
                      </span>
                      <span>{t(item.description)}</span>
                    </span>
                    <span className="om-sa-game-choice-check" aria-hidden="true">
                      {selected && <RemixIcon name="check-line" size={15} />}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        </Popover>

        <Popover
          open={openMenu === 'game-players'}
          onOpenChange={next => setOpenMenu(next ? 'game-players' : null)}
          side="top"
          align="end"
          aria-label={t('Players')}
          className="om-sa-mode-popover om-sa-game-choice-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-composer-top-pill"
              data-active={options.gameMultiplayer || isPlayableAd(options) || openMenu === 'game-players' || undefined}
              data-open={openMenu === 'game-players' || undefined}
              aria-haspopup="listbox"
              aria-expanded={openMenu === 'game-players'}
              disabled={disabled}
            >
              <span key={isPlayableAd(options) ? 'ad' : options.gameMultiplayer ? 'multi' : 'solo'} className="om-sa-pill-swap">
                <RemixIcon name={isPlayableAd(options) ? 'cursor-line' : options.gameMultiplayer ? 'group-line' : 'user-3-line'} size={13} />
                <span className="om-sa-composer-top-pill-label">
                  {t(isPlayableAd(options) ? 'Playable ad' : options.gameMultiplayer ? 'Multiplayer' : 'Single player')}
                </span>
              </span>
              <RemixIcon name="arrow-down-s-line" size={14} className="om-sa-pill-chevron" />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-menu-head">
              <span className="om-sa-popover-label">{t('Players')}</span>
            </div>
            <div className="om-sa-game-choice-list" role="listbox" aria-label={t('Players')}>
              {([
                {
                  multiplayer: false,
                  icon: 'user-3-line',
                  label: 'Single player',
                  description: 'Solo arcade, story, or puzzle session',
                },
                {
                  multiplayer: true,
                  icon: 'group-line',
                  label: 'Multiplayer',
                  description: 'Shared room link so friends can join live',
                },
                // A playable ad is a portrait single-player build, offered only for portrait briefs that are not a local template copy.
                ...(canChoosePlayableAd(options) ? [{
                  multiplayer: false,
                  playableAd: true,
                  icon: 'cursor-line',
                  label: 'Playable ad',
                  description: 'Ad-ready: instant play, hand tutorial, short levels and a store button',
                }] : []),
              ] as { multiplayer: boolean; playableAd?: boolean; icon: string; label: string; description: string }[]).map(item => {
                const selected = item.playableAd ? isPlayableAd(options) : !isPlayableAd(options) && options.gameMultiplayer === item.multiplayer;
                return (
                  <Button
                    key={item.label}
                    variant="plain"
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-active={selected || undefined}
                    className="om-sa-game-choice-row"
                    onClick={() => {
                      onChange({ gameMultiplayer: item.multiplayer, gamePlayableAd: Boolean(item.playableAd) });
                      setOpenMenu(null);
                    }}
                  >
                    <span className="om-sa-game-choice-visual" aria-hidden="true">
                      <RemixIcon name={item.icon} size={15} />
                    </span>
                    <span className="om-sa-game-choice-copy">
                      <span className="om-sa-game-choice-title">
                        <strong>{t(item.label)}</strong>
                      </span>
                      <span>{t(item.description)}</span>
                    </span>
                    <span className="om-sa-game-choice-check" aria-hidden="true">
                      {selected && <RemixIcon name="check-line" size={15} />}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        </Popover>
      </div>
    );
  }

  return null;
}

/**
 * Compact single-pill parameter control inside the composer's bottom toolbar.
 * Keeps the toolbar airy and strictly single-row alongside Mode pill and Agent selector.
 */
export function ModeComposerControls({
  active = true,
  modeId,
  options,
  disabled,
  onChange,
}: {
  active?: boolean;
  modeId: SuperAgentCreationModeId;
  options: ModeComposerOptions;
  disabled?: boolean;
  onChange: (patch: Partial<ModeComposerOptions>) => void;
}) {
  const { t } = useI18n();
  const [openMenu, setOpenMenu] = useState<'params' | null>(null);

  useEffect(() => {
    if (!active) setOpenMenu(null);
  }, [active]);

  useEffect(() => {
    setOpenMenu(null);
  }, [modeId]);

  const renderVideoParamsPopover = () => {
    const paramSummary = `${options.videoAspect} · ${options.videoDuration} · ${t(VIDEO_SPEED_LABELS[options.videoSpeed])}`;
    return (
      <Popover
        open={openMenu === 'params'}
        onOpenChange={next => setOpenMenu(next ? 'params' : null)}
        side="top"
        align="start"
        aria-label={t('Video parameters')}
        className="om-sa-mode-popover"
        trigger={
          <Button
            variant="plain"
            type="button"
            className="om-sa-mode-param-trigger"
            data-active={openMenu === 'params' || undefined}
            disabled={disabled}
          >
            <RemixIcon name="clapperboard-line" size={13} />
            <span className="om-sa-mode-param-label">{paramSummary}</span>
            <RemixIcon name="arrow-down-s-line" size={14} />
          </Button>
        }
      >
        <div className="om-sa-mode-menu">
          <div className="om-sa-mode-field">
            <span className="om-sa-popover-label">{t('Aspect ratio')}</span>
            <div className="om-sa-popover-pills">
              {(['16:9', '9:16', '1:1', '21:9'] as const).map(ratio => (
                <Button
                  key={ratio}
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.videoAspect === ratio}
                  data-active={options.videoAspect === ratio || undefined}
                  onClick={() => onChange({ videoAspect: ratio })}
                >
                  {ratio}
                </Button>
              ))}
            </div>
          </div>
          <div className="om-sa-mode-field">
            <span className="om-sa-popover-label">{t('Duration')}</span>
            <div className="om-sa-popover-pills">
              {(['5s', '8s', '10s', '15s'] as const).map(dur => (
                <Button
                  key={dur}
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.videoDuration === dur}
                  data-active={options.videoDuration === dur || undefined}
                  onClick={() => onChange({ videoDuration: dur })}
                >
                  {dur}
                </Button>
              ))}
            </div>
          </div>
          <div className="om-sa-mode-field">
            <span className="om-sa-popover-label">{t('Generation mode')}</span>
            <div className="om-sa-popover-pills">
              {(['fast', 'standard', 'cinema'] as const).map(speed => (
                <Button
                  key={speed}
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.videoSpeed === speed}
                  data-active={options.videoSpeed === speed || undefined}
                  onClick={() => onChange({ videoSpeed: speed })}
                >
                  {t(VIDEO_SPEED_LABELS[speed])}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </Popover>
    );
  };

  const renderMotionParamsPopover = () => {
    const motionSummary = `${options.motionAspect} · ${options.motionDuration} · ${options.motionFps}`;
    return (
      <Popover
        open={openMenu === 'params'}
        onOpenChange={next => setOpenMenu(next ? 'params' : null)}
        side="top"
        align="start"
        aria-label={t('Motion graphics parameters')}
        className="om-sa-mode-popover"
        trigger={
          <Button
            variant="plain"
            type="button"
            className="om-sa-mode-param-trigger"
            data-active={openMenu === 'params' || undefined}
            disabled={disabled}
          >
            <RemixIcon name="movie-line" size={13} />
            <span className="om-sa-mode-param-label">{motionSummary}</span>
            <RemixIcon name="arrow-down-s-line" size={14} />
          </Button>
        }
      >
        <div className="om-sa-mode-menu">
          <div className="om-sa-mode-field">
            <span className="om-sa-popover-label">{t('Aspect ratio')}</span>
            <div className="om-sa-popover-pills">
              {(['16:9', '9:16', '1:1', '4:5'] as const).map(ratio => (
                <Button
                  key={ratio}
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.motionAspect === ratio}
                  data-active={options.motionAspect === ratio || undefined}
                  onClick={() => onChange({ motionAspect: ratio })}
                >
                  {ratio}
                </Button>
              ))}
            </div>
          </div>
          <div className="om-sa-mode-field">
            <span className="om-sa-popover-label">{t('Duration')}</span>
            <div className="om-sa-popover-pills">
              {(['10s', '15s', '20s', '30s'] as const).map(dur => (
                <Button
                  key={dur}
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.motionDuration === dur}
                  data-active={options.motionDuration === dur || undefined}
                  onClick={() => onChange({ motionDuration: dur })}
                >
                  {dur}
                </Button>
              ))}
            </div>
          </div>
          <div className="om-sa-mode-field">
            <span className="om-sa-popover-label">{t('Frame rate & style')}</span>
            <div className="om-sa-popover-pills">
              {(['30fps', '60fps'] as const).map(fps => (
                <Button
                  key={fps}
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.motionFps === fps}
                  data-active={options.motionFps === fps || undefined}
                  onClick={() => onChange({ motionFps: fps })}
                >
                  {fps}
                </Button>
              ))}
            </div>
            <div className="om-sa-popover-pills">
              {(['kinetic', 'product', 'editorial', 'minimal'] as const).map(style => (
                <Button
                  key={style}
                  variant="plain"
                  type="button"
                  className="om-sa-popover-pill"
                  aria-pressed={options.motionStyle === style}
                  data-active={options.motionStyle === style || undefined}
                  onClick={() => onChange({ motionStyle: style })}
                >
                  {t(MOTION_STYLE_LABELS[style])}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </Popover>
    );
  };

  if (modeId === 'image') {
    const aspectSummary = options.imageAspect === 'auto' ? t('Auto') : options.imageAspect;
    const countSummary = options.imageCount > 1 ? ` · ${options.imageCount}×` : '';
    const qualitySummary = options.imageQuality === 'high' ? ' · 2K' : '';

    return (
      <div className="om-sa-mode-controls" role="group" aria-label={t('Image options')}>
        <Popover
          open={openMenu === 'params'}
          onOpenChange={next => setOpenMenu(next ? 'params' : null)}
          side="top"
          align="start"
          aria-label={t('Image parameters')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-mode-param-trigger"
              data-active={openMenu === 'params' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="layout-line" size={13} />
              <span className="om-sa-mode-param-label">{`${aspectSummary}${qualitySummary}${countSummary}`}</span>
              <RemixIcon name="arrow-down-s-line" size={14} />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Aspect ratio')}</span>
              <div className="om-sa-popover-pills">
                {(['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2'] as const).map(ratio => (
                  <Button
                    key={ratio}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.imageAspect === ratio}
                    data-active={options.imageAspect === ratio || undefined}
                    onClick={() => onChange({ imageAspect: ratio })}
                  >
                    {ratio === 'auto' ? t('Auto') : ratio}
                  </Button>
                ))}
              </div>
            </div>
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Quality')}</span>
              <div className="om-sa-popover-pills">
                {(['standard', 'high'] as const).map(q => (
                  <Button
                    key={q}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.imageQuality === q}
                    data-active={options.imageQuality === q || undefined}
                    onClick={() => onChange({ imageQuality: q })}
                  >
                    {q === 'high' ? t('High · 2K') : t('Standard')}
                  </Button>
                ))}
              </div>
            </div>
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Variations')}</span>
              <div className="om-sa-popover-pills">
                {([1, 2, 4] as const).map(count => (
                  <Button
                    key={count}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.imageCount === count}
                    data-active={options.imageCount === count || undefined}
                    onClick={() => onChange({ imageCount: count })}
                  >
                    {`${count} ${count === 1 ? t('image') : t('images')}`}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Popover>
      </div>
    );
  }

  if (modeId === 'media') {
    return (
      <div className="om-sa-mode-controls" role="group" aria-label={t('Cinema Video options')}>
        {options.mediaSubMode === 'motion' ? renderMotionParamsPopover() : renderVideoParamsPopover()}
      </div>
    );
  }

  if (modeId === 'audio') {
    const audioSummary = `${t(AUDIO_TYPE_LABELS[options.audioType])} · ${options.audioDuration}`;
    return (
      <div className="om-sa-mode-controls" role="group" aria-label={t('Audio & Sound options')}>
        <Popover
          open={openMenu === 'params'}
          onOpenChange={next => setOpenMenu(next ? 'params' : null)}
          side="top"
          align="start"
          aria-label={t('Audio parameters')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-mode-param-trigger"
              data-active={openMenu === 'params' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="music-2-line" size={13} />
              <span className="om-sa-mode-param-label">{audioSummary}</span>
              <RemixIcon name="arrow-down-s-line" size={14} />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Audio type')}</span>
              <div className="om-sa-popover-pills">
                {(['music', 'voiceover', 'sfx'] as const).map(kind => (
                  <Button
                    key={kind}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.audioType === kind}
                    data-active={options.audioType === kind || undefined}
                    onClick={() => onChange({ audioType: kind })}
                  >
                    {t(AUDIO_TYPE_LABELS[kind])}
                  </Button>
                ))}
              </div>
            </div>
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Duration')}</span>
              <div className="om-sa-popover-pills">
                {(['10s', '30s', '60s'] as const).map(dur => (
                  <Button
                    key={dur}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.audioDuration === dur}
                    data-active={options.audioDuration === dur || undefined}
                    onClick={() => onChange({ audioDuration: dur })}
                  >
                    {dur}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Popover>
      </div>
    );
  }

  if (modeId === 'motion') {
    return (
      <div className="om-sa-mode-controls" role="group" aria-label={t('Motion graphics options')}>
        {options.motionEngine === 'motion' ? renderMotionParamsPopover() : renderVideoParamsPopover()}
      </div>
    );
  }

  if (modeId === 'deck') {
    const slidesLabel = options.deckSlides === 'auto' ? t('Auto') : options.deckSlides;
    return (
      <div className="om-sa-mode-controls" role="group" aria-label={t('Slides & Docs options')}>
        <Popover
          open={openMenu === 'params'}
          onOpenChange={next => setOpenMenu(next ? 'params' : null)}
          side="top"
          align="start"
          aria-label={t('Deck format & length')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-mode-param-trigger"
              data-active={openMenu === 'params' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="slideshow-line" size={13} />
              <span className="om-sa-mode-param-label">{`${t(DECK_FORMAT_LABELS[options.deckFormat])} · ${slidesLabel}`}</span>
              <RemixIcon name="arrow-down-s-line" size={14} />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Output format')}</span>
              <div className="om-sa-popover-pills">
                {(['slides', 'document', 'report'] as const).map(fmt => (
                  <Button
                    key={fmt}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.deckFormat === fmt}
                    data-active={options.deckFormat === fmt || undefined}
                    onClick={() => onChange({ deckFormat: fmt })}
                  >
                    {t(DECK_FORMAT_LABELS[fmt])}
                  </Button>
                ))}
              </div>
            </div>
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Length')}</span>
              <div className="om-sa-popover-pills">
                {(['5-7', '8-12', '12-16', 'auto'] as const).map(len => (
                  <Button
                    key={len}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.deckSlides === len}
                    data-active={options.deckSlides === len || undefined}
                    onClick={() => onChange({ deckSlides: len })}
                  >
                    {len === 'auto' ? t('Auto') : len}
                  </Button>
                ))}
              </div>
            </div>
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Density')}</span>
              <div className="om-sa-popover-pills">
                {(['visual', 'balanced', 'detailed'] as const).map(density => (
                  <Button
                    key={density}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.deckDensity === density}
                    data-active={options.deckDensity === density || undefined}
                    onClick={() => onChange({ deckDensity: density })}
                  >
                    {t(DECK_DENSITY_LABELS[density])}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Popover>
      </div>
    );
  }

  if (modeId === 'coding') {
    return (
      <div className="om-sa-mode-controls" role="group" aria-label={t('Coding focus')}>
        <Popover
          open={openMenu === 'params'}
          onOpenChange={next => setOpenMenu(next ? 'params' : null)}
          side="top"
          align="start"
          aria-label={t('Coding focus')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-mode-param-trigger"
              data-active={openMenu === 'params' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="code-s-slash-line" size={13} />
              <span className="om-sa-mode-param-label">{t(CODING_FOCUS_LABELS[options.codingFocus])}</span>
              <RemixIcon name="arrow-down-s-line" size={14} />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Coding focus')}</span>
              <div className="om-sa-popover-pills">
                {(['general', 'debug', 'refactor', 'test', 'review'] as const).map(focus => (
                  <Button
                    key={focus}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.codingFocus === focus}
                    data-active={options.codingFocus === focus || undefined}
                    onClick={() => {
                      onChange({ codingFocus: focus });
                      setOpenMenu(null);
                    }}
                  >
                    {t(CODING_FOCUS_LABELS[focus])}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Popover>
      </div>
    );
  }

  if (modeId === 'website') {
    return (
      <div className="om-sa-mode-controls" role="group" aria-label={t('Website & App options')}>
        <Popover
          open={openMenu === 'params'}
          onOpenChange={next => setOpenMenu(next ? 'params' : null)}
          side="top"
          align="start"
          aria-label={t('Target viewport')}
          className="om-sa-mode-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-mode-param-trigger"
              data-active={openMenu === 'params' || undefined}
              disabled={disabled}
            >
              <RemixIcon name="layout-line" size={13} />
              <span className="om-sa-mode-param-label">{t(WEB_TARGET_LABELS[options.webTarget])}</span>
              <RemixIcon name="arrow-down-s-line" size={14} />
            </Button>
          }
        >
          <div className="om-sa-mode-menu">
            <div className="om-sa-mode-field">
              <span className="om-sa-popover-label">{t('Target layout')}</span>
              <div className="om-sa-popover-pills">
                {(['responsive', 'mobile', 'dashboard'] as const).map(target => (
                  <Button
                    key={target}
                    variant="plain"
                    type="button"
                    className="om-sa-popover-pill"
                    aria-pressed={options.webTarget === target}
                    data-active={options.webTarget === target || undefined}
                    onClick={() => {
                      onChange({ webTarget: target });
                      setOpenMenu(null);
                    }}
                  >
                    {t(WEB_TARGET_LABELS[target])}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </Popover>
      </div>
    );
  }

  return null;
}
