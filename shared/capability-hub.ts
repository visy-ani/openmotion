import type { SuperAgentArtifact, SuperAgentResourceAttachment } from './super-agent.ts';

export type CapabilityDomainId =
  | 'motion'
  | 'design'
  | 'game'
  | 'media'
  | 'brand-kit'
  | 'skills'
  | 'workflows'
  | 'assets-captions';

export type CapabilityDomain = {
  id: CapabilityDomainId;
  title: string;
  description: string;
  tools: readonly string[];
  resourceKinds: readonly SuperAgentResourceAttachment['kind'][];
  directEntry: 'motion' | 'design' | 'game' | 'image' | 'video' | 'audio' | 'brand-kit' | 'skills' | 'scenarios' | 'assets';
};

export const CAPABILITY_DOMAINS: readonly CapabilityDomain[] = [
  {
    id: 'motion',
    title: 'Motion Studio',
    description: 'Author editable HyperFrames HTML/GSAP compositions, versions, templates, and verified MP4 renders.',
    tools: [
      'openmotion_list_templates',
      'openmotion_get_template',
      'openmotion_create_project',
      'openmotion_get_project',
      'openmotion_edit_project',
      'openmotion_open_preview',
      'openmotion_import_assets',
      'openmotion_list_versions',
      'openmotion_restore_version',
      'openmotion_export_request',
      'openmotion_export_cancel',
      'openmotion_manage_project',
      'openmotion_project_archive',
    ],
    resourceKinds: ['motion-template', 'motion-project'],
    directEntry: 'motion',
  },
  {
    id: 'design',
    title: 'Design Studio',
    description: 'Create responsive prototypes, mobile apps, slide decks, documents, live artifacts, and WebGL scenes.',
    tools: [
      'openmotion_design_catalog',
      'openmotion_design_project',
      'openmotion_design_edit',
      'openmotion_design_comments',
    ],
    resourceKinds: ['design-template', 'design-skill', 'design-project'],
    directEntry: 'design',
  },
  {
    id: 'game',
    title: 'Game Studio',
    description: 'Build, validate, simulate, playtest, capture covers, and publish single-player or multiplayer HTML games.',
    tools: [
      'openmotion_game_create',
      'openmotion_game_get',
      'openmotion_game_read_file',
      'openmotion_game_write_files',
      'openmotion_game_update_meta',
      'openmotion_game_capture_cover',
      'openmotion_game_playtest',
      'openmotion_game_simulate',
      'openmotion_game_trailer',
      'openmotion_game_validate',
      'openmotion_game_set_status',
      'openmotion_game_publish',
    ],
    resourceKinds: ['game-project'],
    directEntry: 'game',
  },
  {
    id: 'media',
    title: 'Media Models & Generation',
    description: 'Discover configured providers and models to generate or edit images, videos, music, SFX, and speech.',
    tools: [
      'openmotion_media_use',
      'openmotion_assets_use',
    ],
    resourceKinds: ['model', 'asset'],
    directEntry: 'image',
  },
  {
    id: 'brand-kit',
    title: 'Brand Kits',
    description: 'Extract and reuse brand styles, palettes, typography, logos, and visual rules across every workflow.',
    tools: [
      'openmotion_assets_use',
      'openmotion_design_catalog',
    ],
    resourceKinds: ['brand-kit'],
    directEntry: 'brand-kit',
  },
  {
    id: 'skills',
    title: 'Creative & Technique Skills',
    description: 'Apply curated production, motion technique, and design Skills inside projects or external Agents.',
    tools: [
      'openmotion_list_skills',
      'openmotion_get_skill',
      'openmotion_design_catalog',
    ],
    resourceKinds: ['skill', 'design-skill'],
    directEntry: 'skills',
  },
  {
    id: 'workflows',
    title: 'Multi-Step Workflows',
    description: 'Orchestrate end-to-end campaign and role workflows with shared Asset Pools and step-bound iterations.',
    tools: [
      'openmotion_assets_use',
    ],
    resourceKinds: ['workflow'],
    directEntry: 'scenarios',
  },
  {
    id: 'assets-captions',
    title: 'Workspace Assets & Captions',
    description: 'Manage reusable media versions, references, speech transcription, and synced project captions.',
    tools: [
      'openmotion_assets_use',
      'openmotion_import_assets',
    ],
    resourceKinds: ['asset'],
    directEntry: 'assets',
  },
] as const;

export type CapabilityResourceRef =
  | {
      kind: 'motion-template';
      id: string;
      title: string;
      subtitle?: string;
      previewUrl?: string;
      workflow?: 'template' | 'recreate';
      tags?: string[];
    }
  | {
      kind: 'design-template';
      id: string;
      title: string;
      subtitle?: string;
      scenario?: string;
      previewUrl?: string;
      tags?: string[];
    }
  | {
      kind: 'skill';
      id: string;
      title: string;
      subtitle?: string;
      tags?: string[];
    }
  | {
      kind: 'design-skill';
      id: string;
      title: string;
      subtitle?: string;
      scenario?: string;
    }
  | {
      kind: 'brand-kit';
      id: string;
      title: string;
      subtitle?: string;
      websiteUrl?: string;
      swatches?: string[];
      catalog?: boolean;
    }
  | {
      kind: 'asset';
      id: string;
      title: string;
      subtitle?: string;
      modality: 'image' | 'video' | 'audio';
      versionId: string;
      previewUrl?: string;
      model?: string;
      prompt?: string;
    }
  | {
      kind: 'model';
      id: string;
      title: string;
      provider: string;
      modelId: string;
      modality: 'image' | 'video' | 'audio';
      description?: string;
      mode?: string;
    }
  | {
      kind: 'workflow';
      id: string;
      title: string;
      subtitle?: string;
      category?: string;
      runId?: string;
      stepId?: string;
      attachments?: SuperAgentResourceAttachment[];
    }
  | {
      kind: 'game-project';
      id: string;
      title: string;
      subtitle?: string;
      genre?: string;
      playUrl?: string;
      coverUrl?: string;
    }
  | {
      kind: 'scene-prompt';
      id: string;
      title: string;
      modality: 'image' | 'video' | 'audio';
      sceneId: string;
      modelId?: string;
      attachments?: SuperAgentResourceAttachment[];
    };

export type SuperAgentHandoffPayload = {
  prompt: string;
  attachments?: SuperAgentResourceAttachment[];
  initialArtifact?: Partial<SuperAgentArtifact>;
  mode?: 'game' | 'website' | 'motion' | 'deck' | 'image' | 'media' | 'audio';
  title?: string;
  autoSend?: boolean;
  newChat?: boolean;
};

export function capabilityRefToAttachment(ref: CapabilityResourceRef): SuperAgentResourceAttachment | null {
  switch (ref.kind) {
    case 'motion-template':
      return {
        id: ref.id,
        kind: 'motion-template',
        title: ref.title,
        ...(ref.subtitle ? { subtitle: ref.subtitle } : {}),
        ...(ref.previewUrl ? { previewUrl: ref.previewUrl } : {}),
        ...(ref.tags ? { tags: ref.tags } : {}),
      };
    case 'design-template':
      return {
        id: ref.id,
        kind: 'design-template',
        title: ref.title,
        ...(ref.subtitle ? { subtitle: ref.subtitle } : {}),
        ...(ref.scenario ? { scenario: ref.scenario } : {}),
        ...(ref.previewUrl ? { previewUrl: ref.previewUrl } : {}),
        ...(ref.tags ? { tags: ref.tags } : {}),
      };
    case 'skill':
      return {
        id: ref.id,
        kind: 'skill',
        title: ref.title,
        ...(ref.subtitle ? { subtitle: ref.subtitle } : {}),
        ...(ref.tags ? { tags: ref.tags } : {}),
      };
    case 'design-skill':
      return {
        id: ref.id,
        kind: 'design-skill',
        title: ref.title,
        ...(ref.subtitle ? { subtitle: ref.subtitle } : {}),
        ...(ref.scenario ? { scenario: ref.scenario } : {}),
      };
    case 'brand-kit': {
      const normalizedId = ref.catalog && !ref.id.startsWith('catalog:') ? `catalog:${ref.id}` : ref.id;
      return {
        id: normalizedId,
        kind: 'brand-kit',
        title: ref.title,
        ...(ref.subtitle || ref.websiteUrl ? { subtitle: ref.subtitle || ref.websiteUrl } : {}),
        ...(ref.swatches?.length ? { swatches: ref.swatches.slice(0, 5) } : {}),
      };
    }
    case 'asset':
      return {
        id: ref.id,
        kind: 'asset',
        title: ref.title,
        subtitle: ref.subtitle || ref.model || ref.modality,
        modality: ref.modality,
        versionId: ref.versionId,
        ...(ref.previewUrl ? { previewUrl: ref.previewUrl } : {}),
      };
    case 'model':
      return {
        id: ref.id,
        kind: 'model',
        title: ref.title,
        subtitle: `${ref.provider} · ${ref.modelId}`,
        modality: ref.modality,
      };
    case 'workflow':
      return {
        id: ref.id,
        kind: 'workflow',
        title: ref.title,
        subtitle: ref.subtitle || ref.category || 'Workflow',
      };
    case 'game-project':
      return {
        id: ref.id,
        kind: 'game-project',
        title: ref.title,
        subtitle: ref.subtitle || ref.genre || 'Game Studio',
        ...(ref.coverUrl ? { previewUrl: ref.coverUrl } : {}),
      };
    case 'scene-prompt':
      return null;
  }
}

export function buildResourceMcpPrompt(
  ref: CapabilityResourceRef,
  options: { prompt?: string; locale?: string } = {},
): string {
  const customPrompt = options.prompt?.trim();
  const localeLine = options.locale && options.locale !== 'en'
    ? `Reply and author visible copy in ${options.locale}.`
    : '';

  switch (ref.kind) {
    case 'motion-template': {
      const actionLine = ref.workflow === 'template'
        ? `1. Inspect template "${ref.id}" with openmotion_get_template(templateId="${ref.id}") and create an editable project with openmotion_create_project(projectType="template", templateId="${ref.id}").`
        : `1. Inspect template "${ref.id}" with openmotion_get_template(templateId="${ref.id}") and follow its workflowGuide (use openmotion_create_project + openmotion_edit_project).`;
      return [
        `Use OpenMotion MCP tools to create a Motion Studio project based on template "${ref.title}" (${ref.id}).`,
        actionLine,
        '2. Edit the HyperFrames HTML/CSS/GSAP composition with openmotion_edit_project and verify with openmotion_open_preview.',
        customPrompt ? `Brief: ${customPrompt}` : null,
        localeLine || null,
      ].filter(Boolean).join('\n');
    }
    case 'design-template':
      return [
        `Use OpenMotion MCP tools to create a Design Studio project from template "${ref.title}" (${ref.id}).`,
        `1. Inspect scenario/template with openmotion_design_catalog(action="get_template", id="${ref.id}").`,
        `2. Create with openmotion_design_project(action="create", scenario="${ref.scenario || 'prototype'}", templateId="${ref.id}") and author complete HTML/CSS/JS via openmotion_design_edit(action="write").`,
        '3. Present the updated design with openmotion_design_project(action="open").',
        customPrompt ? `Brief: ${customPrompt}` : null,
        localeLine || null,
      ].filter(Boolean).join('\n');
    case 'skill':
      return [
        `Use OpenMotion MCP tools to apply Creative Skill "${ref.title}" (${ref.id}).`,
        `1. Call openmotion_get_skill(skillId="${ref.id}") and read its instructions carefully.`,
        '2. Create a native project with openmotion_create_project(projectType="natural_language") and build it via openmotion_edit_project.',
        customPrompt ? `Brief: ${customPrompt}` : null,
        localeLine || null,
      ].filter(Boolean).join('\n');
    case 'design-skill':
      return [
        `Use OpenMotion MCP tools to apply Design Skill "${ref.title}" (${ref.id}).`,
        `1. Read the skill with openmotion_design_catalog(action="get_skill", id="${ref.id}").`,
        `2. Create a design project with openmotion_design_project(action="create", scenario="${ref.scenario || 'prototype'}") and apply the skill via openmotion_design_edit(action="write").`,
        customPrompt ? `Brief: ${customPrompt}` : null,
        localeLine || null,
      ].filter(Boolean).join('\n');
    case 'brand-kit': {
      const kitId = ref.catalog && !ref.id.startsWith('catalog:') ? `catalog:${ref.id}` : ref.id;
      return [
        `Use OpenMotion MCP tools to style a project using Brand Kit "${ref.title}" (${kitId}).`,
        kitId.startsWith('catalog:')
          ? `1. Read design system tokens with openmotion_design_catalog(action="get_design_system", id="${kitId.slice('catalog:'.length)}").`
          : `1. Read Brand Kit tokens and rules with openmotion_assets_use(action="brand_kit", brandKit={command:"get", id:"${kitId}"}).`,
        '2. Apply the palette, typography, and layout rules consistently across the project.',
        customPrompt ? `Brief: ${customPrompt}` : null,
        localeLine || null,
      ].filter(Boolean).join('\n');
    }
    case 'asset':
      return [
        `Use OpenMotion MCP tools to reuse or iterate on Workspace Asset "${ref.title}" (assetId="${ref.id}", versionId="${ref.versionId}").`,
        `1. Inspect asset metadata/contents with openmotion_assets_use(action="read", assetId="${ref.id}", versionId="${ref.versionId}").`,
        ref.modality === 'image'
          ? `2. Either adopt into a composition (openmotion_assets_use(action="import_to_project")) or generate a new version referencing it via openmotion_assets_use(action="generate", modality="image", referenceAssets=[{assetId:"${ref.id}", versionId:"${ref.versionId}"}]).`
          : `2. Adopt this ${ref.modality} asset into a Motion project via openmotion_assets_use(action="import_to_project", assetId="${ref.id}", versionId="${ref.versionId}") or attach it to a video/audio generation.`,
        customPrompt ? `Brief: ${customPrompt}` : ref.prompt ? `Original prompt: ${ref.prompt}` : null,
        localeLine || null,
      ].filter(Boolean).join('\n');
    case 'model':
      return [
        `Use OpenMotion MCP tools to run media model "${ref.title}" (gateway key: "${ref.id}", modality: "${ref.modality}").`,
        `1. Inspect provider availability and schema via openmotion_media_use(action="inspect") and openmotion_media_use(action="models", modality="${ref.modality}", query="${ref.modelId}").`,
        `2. Queue generation with openmotion_assets_use(action="generate", modality="${ref.modality}", model="${ref.id}", prompt=..., requestId=...), poll action="status", then inspect with action="read".`,
        customPrompt ? `Prompt: ${customPrompt}` : null,
        localeLine || null,
      ].filter(Boolean).join('\n');
    case 'workflow':
      return [
        `Use OpenMotion MCP tools to run Workflow "${ref.title}" (${ref.id}${ref.runId ? `, runId="${ref.runId}"` : ''}${ref.stepId ? `, stepId="${ref.stepId}"` : ''}).`,
        ref.runId
          ? `1. Inspect the workflow run with openmotion_assets_use(action="scenario", scenario={command:"get", runId:"${ref.runId}"}) and record step iterations via openmotion_assets_use(action="scenario", scenario={command:"add_iteration", runId:"${ref.runId}", stepId:"${ref.stepId || 'brief'}", ...}).`
          : `1. Start a workflow run with openmotion_assets_use(action="scenario", scenario={command:"create", scenarioId:"${ref.id}"}).`,
        '2. Generate missing media assets with openmotion_assets_use(action="generate") and sync or adopt completed outputs into the workflow Asset Pool.',
        customPrompt ? `Brief: ${customPrompt}` : null,
        localeLine || null,
      ].filter(Boolean).join('\n');
    case 'game-project':
      return [
        `Use OpenMotion MCP tools to inspect or extend Game Studio project "${ref.title}" (${ref.id}).`,
        `1. Read openmotion://workflow/game/start, inspect files with openmotion_game_get(id="${ref.id}"), and read code via openmotion_game_read_file.`,
        `2. Optionally generate sprites, backgrounds, or sound via openmotion_assets_use(action="generate") and reference them with /motion-api/assets/<assetId>/versions/<versionId>/media.`,
        `3. Write updates via openmotion_game_write_files(id="${ref.id}"), validate via openmotion_game_validate(id="${ref.id}"), and present the playable game via openmotion_present_artifact(kind="game-project", projectId="${ref.id}").`,
        customPrompt ? `Brief: ${customPrompt}` : null,
        localeLine || null,
      ].filter(Boolean).join('\n');
    case 'scene-prompt':
      return [
        `Use OpenMotion MCP tools for ${ref.modality} scene "${ref.title}" (${ref.sceneId}).`,
        `1. Check available models with openmotion_media_use(action="models", modality="${ref.modality}").`,
        `2. Generate an asset with openmotion_assets_use(action="generate", modality="${ref.modality}"${ref.modelId ? `, model="${ref.modelId}"` : ''}, prompt=...), poll status, and inspect with action="read".`,
        customPrompt ? `Prompt: ${customPrompt}` : null,
        localeLine || null,
      ].filter(Boolean).join('\n');
  }
}

function defaultModeForRef(ref: CapabilityResourceRef): SuperAgentHandoffPayload['mode'] {
  switch (ref.kind) {
    case 'design-template':
    case 'design-skill':
      return ref.scenario === 'deck' || ref.scenario === 'document'
        ? 'deck'
        : ref.scenario === 'webgl'
          ? 'game'
          : 'website';
    case 'motion-template':
    case 'skill':
      return 'motion';
    case 'game-project':
      return 'game';
    case 'asset':
    case 'model':
    case 'scene-prompt':
      return ref.modality === 'audio' ? 'audio' : ref.modality === 'video' ? 'media' : 'image';
    case 'brand-kit':
      return 'website';
    case 'workflow':
      return 'motion';
  }
}

export function buildSuperAgentHandoff(
  ref: CapabilityResourceRef,
  options: {
    prompt?: string;
    locale?: string;
    autoSend?: boolean;
    newChat?: boolean;
    initialArtifact?: Partial<SuperAgentArtifact>;
  } = {},
): SuperAgentHandoffPayload {
  const custom = options.prompt?.trim();
  const baseAttachment = capabilityRefToAttachment(ref);
  const extraAttachments = ref.kind === 'workflow' || ref.kind === 'scene-prompt'
    ? (ref.attachments ?? [])
    : [];
  const attachments = [
    ...(baseAttachment ? [baseAttachment] : []),
    ...extraAttachments,
  ];

  let prompt = custom || '';
  if (!prompt) {
    switch (ref.kind) {
      case 'motion-template':
        prompt = `Create a Motion Studio project inspired by "${ref.title}" (${ref.id}) and customize its visuals and pacing cleanly.`;
        break;
      case 'design-template':
        prompt = `Create an interactive ${ref.scenario || 'web'} design project starting from template "${ref.title}" (${ref.id}) and open it in the Viewer.`;
        break;
      case 'skill':
        prompt = `Apply the creative Skill "${ref.title}" (${ref.id}) to build an editable Motion Studio project and present it.`;
        break;
      case 'design-skill':
        prompt = `Use Design Skill "${ref.title}" (${ref.id}) to design and build an interactive HTML experience.`;
        break;
      case 'brand-kit':
        prompt = `Apply Brand Kit "${ref.title}" colors, typography, and design rules to build a cohesive interactive webpage or motion promo.`;
        break;
      case 'asset':
        prompt = ref.modality === 'image'
          ? `Use workspace asset "${ref.title}" (${ref.id}/${ref.versionId}) as visual reference to remix or compose a polished deliverable.`
          : `Use workspace ${ref.modality} asset "${ref.title}" (${ref.id}/${ref.versionId}) in a new creative composition.`;
        break;
      case 'model':
        prompt = `Use configured ${ref.modality} model "${ref.title}" (${ref.id}) to generate a creative asset and display the result in the Artifact Viewer.`;
        break;
      case 'workflow':
        prompt = `Execute workflow "${ref.title}" (${ref.id}${ref.runId ? `, run ${ref.runId}` : ''}) step by step and present the deliverables.`;
        break;
      case 'game-project':
        prompt = `Inspect and enhance interactive game "${ref.title}" (${ref.id}), then preview it in the Artifact Viewer.`;
        break;
      case 'scene-prompt':
        prompt = `Create a ${ref.modality} asset using scene "${ref.title}"${ref.modelId ? ` (${ref.modelId})` : ''} and preview it.`;
        break;
    }
  }

  return {
    prompt,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(options.initialArtifact ? { initialArtifact: options.initialArtifact } : {}),
    mode: defaultModeForRef(ref),
    title: ref.title,
    autoSend: options.autoSend,
    ...(options.newChat !== undefined ? { newChat: options.newChat } : {}),
  };
}
