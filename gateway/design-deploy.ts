import path from 'node:path';
import type {
  DesignDeployMode,
  DesignDeploymentRecord,
  DesignDeployStatusResponse,
  DesignProject,
} from '../shared/design-project.ts';
import {
  commentFileSourceKey,
  parseShareLinkFromRecord,
  publicFileResourceIdFor,
  verifiedShareUrl,
  webPublishFor,
  WebPublishService,
  type WebPublishAccountClient,
} from './web-publish.ts';

export type DesignDeployAccountClient = WebPublishAccountClient;

export {
  commentFileSourceKey,
  parseShareLinkFromRecord,
  publicFileResourceIdFor,
  verifiedShareUrl,
};

/**
 * Compatibility facade preserving Design Studio deploy semantics on top of the
 * shared generalized WebPublishService domain implementation.
 */
export class DesignDeployService {
  readonly dataDirectory: string;
  readonly webPublish: WebPublishService;

  constructor(dataDirectory: string, accountOrService?: DesignDeployAccountClient | WebPublishService) {
    this.dataDirectory = path.resolve(dataDirectory);
    this.webPublish =
      accountOrService instanceof WebPublishService
        ? accountOrService
        : new WebPublishService(this.dataDirectory, accountOrService);
  }

  get storeRoot(): string {
    return this.webPublish.storeRoot;
  }

  get account(): DesignDeployAccountClient {
    return this.webPublish.account;
  }

  status(
    project: Pick<DesignProject, 'id' | 'entry'> & { path?: string; title?: string },
    options: { filePath?: string; refresh?: boolean } = {},
  ): Promise<DesignDeployStatusResponse> {
    return this.webPublish.status(
      {
        kind: 'design',
        id: project.id,
        entryPath: project.entry || 'index.html',
        ...(project.path ? { sourcePath: project.path } : {}),
        ...(project.title ? { title: project.title } : {}),
      },
      options,
    );
  }

  async deploy(
    project: Pick<DesignProject, 'id' | 'title' | 'entry' | 'revision'>,
    projectDir: string,
    options: {
      filePath?: string;
      workspaceId?: string;
      mode?: DesignDeployMode;
      name?: string;
    } = {},
  ): Promise<{ deployment: DesignDeploymentRecord; url: string | null; updated: boolean }> {
    const result = await this.webPublish.publish(
      {
        kind: 'design',
        id: project.id,
        title: project.title,
        entryPath: project.entry || 'index.html',
        sourceRevision: project.revision,
        sourcePath: projectDir,
      },
      options,
    );
    return {
      deployment: result.publication,
      url: result.url,
      updated: result.updated,
    };
  }

  async unpublish(
    project: Pick<DesignProject, 'id' | 'entry'>,
    options: { filePath?: string } = {},
  ): Promise<{ deployment: DesignDeploymentRecord }> {
    const result = await this.webPublish.unpublish(
      {
        kind: 'design',
        id: project.id,
        entryPath: project.entry || 'index.html',
      },
      options,
    );
    return { deployment: result.publication };
  }
}

const deployServices = new Map<string, DesignDeployService>();

export function designDeployFor(dataDirectory: string): DesignDeployService {
  const key = path.resolve(dataDirectory);
  let instance = deployServices.get(key);
  if (!instance) {
    instance = new DesignDeployService(key, webPublishFor(key));
    deployServices.set(key, instance);
  }
  return instance;
}

export function closeDesignDeployFor(dataDirectory: string): void {
  deployServices.delete(path.resolve(dataDirectory));
}
