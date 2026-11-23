import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { OpenDesignWorkspaceInfo } from '../gateway/account.ts';
import {
  commentFileSourceKey,
  DesignDeployService,
  publicFileResourceIdFor,
  type DesignDeployAccountClient,
} from '../gateway/design-deploy.ts';
import { startServer } from '../server.ts';
import { designRoutes } from '../shared/design-project.ts';
import { MCP_HTTP_PATH, MCP_TOKENS_API } from '../shared/mcp-http.ts';
import { fixture } from './fixtures.ts';

async function collectFiles(root: string, rel = ''): Promise<string[]> {
  const dir = rel ? path.join(root, rel) : root;
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(root, next)));
    } else if (entry.isFile()) {
      out.push(next);
    }
  }
  return out.sort();
}

function createMockAccount(options: { signedIn?: boolean } = {}) {
  let signedIn = options.signedIn ?? true;
  let versionCounter = 0;
  let liveStatus: 'active' | 'stopped' = 'active';
  const calls: Array<{ args: string[]; workspaceId?: string }> = [];
  const stagedSnapshots: string[][] = [];
  const catalogByProject = new Map<string, { schemaVersion: 1; revision: number; files: Array<Record<string, unknown>> }>();

  const workspaces: OpenDesignWorkspaceInfo[] = [
    {
      workspaceId: 'ws_personal_1',
      workspaceName: 'Personal Studio',
      workspaceType: 'personal',
      workspaceMemberId: 'member_1',
      role: 'owner',
      isDefault: true,
      memberStatus: 'active',
      lifecycleState: 'active',
    },
  ];

  const client: DesignDeployAccountClient = {
    async isSignedIn() {
      return signedIn;
    },
    async listWorkspaces() {
      if (!signedIn) {
        throw new Error('OPENDESIGN_SIGN_IN_REQUIRED: Sign in to OpenDesign before deploying.');
      }
      return workspaces;
    },
    async runWithEnv(args, extraEnv) {
      if (!signedIn) {
        throw new Error('OPENDESIGN_SIGN_IN_REQUIRED: Sign in to OpenDesign before deploying.');
      }
      calls.push({ args: [...args], workspaceId: extraEnv?.VELA_WORKSPACE_ID });
      const cmd = args.slice(0, 2).join(' ');

      if (cmd === 'team-projects ensure-private') {
        return JSON.stringify({ projectId: args[2], ok: true });
      }
      if (cmd === 'team-projects register-resource') {
        return JSON.stringify({ ok: true });
      }
      if (cmd === 'team-projects get') {
        const projectId = args[2];
        const state = catalogByProject.get(projectId) ?? { schemaVersion: 1 as const, revision: 0, files: [] };
        return JSON.stringify({
          projectId,
          workspaceId: 'ws_personal_1',
          ownerMemberId: 'member_1',
          resourceId: `project-root-${projectId}`,
          metadata: state.revision > 0 || state.files.length > 0 ? { _commentFiles: state } : {},
        });
      }
      if (cmd === 'team-projects upsert') {
        const projectId = args[2];
        const metaIdx = args.indexOf('--metadata-json');
        const payload = JSON.parse(args[metaIdx + 1]) as {
          _commentFiles?: {
            schemaVersion: number;
            baseRevision: number;
            resourceId: string;
            versionId: string;
            files: Array<{ sourceFileId: string; sourceFilePath: string; entryPath: string; retired: boolean }>;
          };
        };
        const current = catalogByProject.get(projectId) ?? { schemaVersion: 1 as const, revision: 0, files: [] };
        const mutation = payload._commentFiles;
        if (mutation) {
          const nextFiles = [...current.files];
          for (const item of mutation.files) {
            const idx = nextFiles.findIndex(f => f.sourceFileId === item.sourceFileId);
            const fact = {
              sourceFileId: item.sourceFileId,
              sourceFilePath: item.sourceFilePath,
              entryPath: item.entryPath,
              resourceId: mutation.resourceId,
              versionId: mutation.versionId,
              retired: item.retired,
            };
            if (idx >= 0) nextFiles[idx] = fact;
            else nextFiles.push(fact);
          }
          catalogByProject.set(projectId, { schemaVersion: 1, revision: current.revision + 1, files: nextFiles });
        }
        return JSON.stringify({ projectId, ok: true });
      }
      if (cmd === 'resource push') {
        const stagedDir = args[4];
        stagedSnapshots.push(await collectFiles(stagedDir));
        versionCounter += 1;
        return JSON.stringify({ id: `ver_${versionCounter}` });
      }
      if (cmd === 'share publish') {
        const slugIdx = args.indexOf('--slug');
        const projectIdx = args.indexOf('--project-id');
        const verIdx = args.indexOf('--version-id');
        const slug = args[slugIdx + 1];
        const projectId = args[projectIdx + 1];
        const versionId = args[verIdx + 1];
        liveStatus = 'active';
        return JSON.stringify({
          status: 'published',
          slug,
          version: versionCounter,
          publishedAt: 1_700_000_000_000 + versionCounter,
          snapshot: { versionId },
          url: `https://open-design.ai/artifact/${projectId}/${slug}`,
        });
      }
      if (cmd === 'share stop') {
        liveStatus = 'stopped';
        return JSON.stringify({ status: 'stopped', slug: args[2] });
      }
      if (cmd === 'share resume-existing') {
        liveStatus = 'active';
        const projectIdx = args.indexOf('--project-id');
        const slug = args[2];
        const projectId = args[projectIdx + 1];
        return JSON.stringify({
          status: 'active',
          slug,
          publishedAt: 1_700_000_000_999,
          url: `https://open-design.ai/artifact/${projectId}/${slug}`,
        });
      }
      if (cmd === 'share status') {
        const projectIdx = args.indexOf('--project-id');
        const slug = args[2];
        const projectId = args[projectIdx + 1];
        return JSON.stringify({
          status: liveStatus,
          slug,
          url: `https://open-design.ai/artifact/${projectId}/${slug}`,
        });
      }
      throw new Error(`Unexpected mock vela args: ${args.join(' ')}`);
    },
  };

  return {
    client,
    calls,
    stagedSnapshots,
    setSignedIn(value: boolean) {
      signedIn = value;
    },
  };
}

test('DesignDeployService handles auth guard, staging exclusions, idempotent republish, stop, resume, and new_link', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'om-design-deploy-unit-'));
  try {
    const dataDir = path.join(root, 'data');
    const projectDir = path.join(root, 'project');
    await mkdir(path.join(projectDir, 'assets'), { recursive: true });
    await mkdir(path.join(projectDir, '.git'), { recursive: true });
    await mkdir(path.join(projectDir, 'node_modules/pkg'), { recursive: true });

    await writeFile(path.join(projectDir, 'index.html'), '<!doctype html><html><body><h1>Hi</h1></body></html>');
    await writeFile(path.join(projectDir, 'assets/styles.css'), 'body { color: black; }');
    await writeFile(path.join(projectDir, '.env'), 'SECRET_KEY=do_not_publish\n');
    await writeFile(path.join(projectDir, '.git/HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(projectDir, 'node_modules/pkg/index.js'), 'module.exports = {};\n');

    const mock = createMockAccount({ signedIn: false });
    const service = new DesignDeployService(dataDir, mock.client);
    const project = {
      id: 'des_test_1',
      title: 'Campaign Page',
      entry: 'index.html',
      revision: 'rev-1',
    };

    // 1. Signed-out checks
    const initialStatus = await service.status(project);
    assert.equal(initialStatus.accountSignedIn, false);
    assert.equal(initialStatus.active, null);
    assert.deepEqual(initialStatus.deployments, []);

    await assert.rejects(
      () => service.deploy(project, projectDir),
      /OPENDESIGN_SIGN_IN_REQUIRED/,
    );

    // 2. First deployment stages only safe static files and publishes unique URL
    mock.setSignedIn(true);
    const first = await service.deploy(project, projectDir);
    assert.equal(first.updated, false);
    assert.equal(first.deployment.status, 'published');
    assert.equal(first.deployment.version, 1);
    assert.equal(first.deployment.workspaceId, 'ws_personal_1');
    assert.equal(
      first.deployment.resourceId,
      publicFileResourceIdFor({
        workspaceId: 'ws_personal_1',
        ownerMemberId: 'member_1',
        projectId: project.id,
        filePath: 'index.html',
      }),
    );
    assert.equal(
      first.deployment.sourceKey,
      commentFileSourceKey(project.id, first.deployment.sourceFileId),
    );
    assert.equal(
      first.url,
      `https://open-design.ai/artifact/${project.id}/${first.deployment.slug}`,
    );
    assert.deepEqual(mock.stagedSnapshots[0], ['assets/styles.css', 'index.html']);
    const pushIdx = mock.calls.findIndex(c => c.args[0] === 'resource' && c.args[1] === 'push');
    const upsertIdx = mock.calls.findIndex(c => c.args[0] === 'team-projects' && c.args[1] === 'upsert');
    const publishIdx = mock.calls.findIndex(c => c.args[0] === 'share' && c.args[1] === 'publish');
    assert.ok(pushIdx >= 0 && upsertIdx > pushIdx && publishIdx > upsertIdx);
    const upsertMeta = JSON.parse(mock.calls[upsertIdx].args[mock.calls[upsertIdx].args.indexOf('--metadata-json') + 1]);
    assert.equal(upsertMeta._commentFiles.resourceId, first.deployment.resourceId);
    assert.equal(upsertMeta._commentFiles.versionId, first.deployment.versionId);
    assert.equal(upsertMeta._commentFiles.files[0].sourceFileId, first.deployment.sourceFileId);

    // 3. Re-deploy preserves slug/sourceFileId/resourceId and bumps version
    await writeFile(path.join(projectDir, 'index.html'), '<!doctype html><html><body><h1>Hi v2</h1></body></html>');
    const second = await service.deploy({ ...project, revision: 'rev-2' }, projectDir);
    assert.equal(second.updated, true);
    assert.equal(second.deployment.version, 2);
    assert.equal(second.deployment.slug, first.deployment.slug);
    assert.equal(second.deployment.sourceFileId, first.deployment.sourceFileId);
    assert.equal(second.deployment.resourceId, first.deployment.resourceId);
    assert.equal(second.url, first.url);

    // 4. Stop sharing transitions to stopped; plain publish refuses to overwrite stopped binding
    const stopped = await service.unpublish(project);
    assert.equal(stopped.deployment.status, 'stopped');

    await assert.rejects(
      () => service.deploy({ ...project, revision: 'rev-2' }, projectDir, { mode: 'publish' }),
      /SHARE_STOPPED_RESUME_REQUIRED/,
    );

    // 5. Resume existing restores published link without pushing a brand new archive when revision is unchanged
    const pushCountBeforeResume = mock.stagedSnapshots.length;
    const resumed = await service.deploy({ ...project, revision: 'rev-2' }, projectDir, { mode: 'resume' });
    assert.equal(mock.stagedSnapshots.length, pushCountBeforeResume);
    assert.equal(resumed.deployment.status, 'published');
    assert.equal(resumed.deployment.slug, first.deployment.slug);
    assert.equal(resumed.url, first.url);

    // 6. Stop again then deploy with new_link mints a new slug & sourceFileId
    await service.unpublish(project);
    const fresh = await service.deploy({ ...project, revision: 'rev-2' }, projectDir, { mode: 'new_link' });
    assert.equal(fresh.deployment.status, 'published');
    assert.notEqual(fresh.deployment.slug, first.deployment.slug);
    assert.notEqual(fresh.deployment.sourceFileId, first.deployment.sourceFileId);
    assert.notEqual(fresh.url, first.url);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Design HTTP deploy endpoint and Streamable HTTP /mcp enforce deploy_status and scoped token permissions', () =>
  fixture(async store => {
    const running = await startServer(store, 0, { editor: false });
    const port = (running.server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const mcpUrl = `${origin}${MCP_HTTP_PATH}`;

    try {
      // Create a Design Studio HTML prototype via HTTP API
      const createRes = await fetch(`${origin}${designRoutes.projects}`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: 'prototype', title: 'Deploy HTTP Test' }),
      });
      assert.equal(createRes.status, 200);
      const { project } = (await createRes.json()) as { project: { id: string } };
      assert.ok(project?.id);

      // GET /motion-api/design/projects/:id/deploy
      const statusRes = await fetch(`${origin}${designRoutes.deploy(project.id)}`);
      assert.equal(statusRes.status, 200);
      const deployStatus = (await statusRes.json()) as {
        projectId: string;
        accountSignedIn: boolean;
        deployments: unknown[];
        active: unknown;
      };
      assert.equal(deployStatus.projectId, project.id);
      assert.equal(typeof deployStatus.accountSignedIn, 'boolean');
      assert.deepEqual(deployStatus.deployments, []);
      assert.equal(deployStatus.active, null);

      // Issue read and write scoped MCP tokens
      const [readRes, writeRes] = await Promise.all([
        fetch(`${origin}${MCP_TOKENS_API}`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Read Only Deploy Check', scope: 'read' }),
        }),
        fetch(`${origin}${MCP_TOKENS_API}`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: 'Write Deploy Client', scope: 'write' }),
        }),
      ]);
      const readToken = ((await readRes.json()) as { token: string }).token;
      const writeToken = ((await writeRes.json()) as { token: string }).token;

      async function mcpRpc(token: string, body: Record<string, unknown>, sessionId?: string) {
        const res = await fetch(mcpUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
          },
          body: JSON.stringify(body),
        });
        const payload = await res.json();
        return { res, payload, sessionId: res.headers.get('Mcp-Session-Id') ?? sessionId };
      }

      // 1. Write-scoped MCP session can inspect deployment status via openmotion_design_project(action="deploy_status")
      const initWrite = await mcpRpc(writeToken, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'design-deploy-test', version: '1.0.0' },
        },
      });
      assert.equal(initWrite.res.status, 200);
      assert.ok(initWrite.sessionId);

      const statusCall = await mcpRpc(
        writeToken,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'openmotion_design_project',
            arguments: { action: 'deploy_status', projectId: project.id },
          },
        },
        initWrite.sessionId,
      );
      assert.equal(statusCall.res.status, 200);
      assert.equal(statusCall.payload.error, undefined);
      const parsedText = JSON.parse(statusCall.payload.result.content[0].text) as {
        projectId: string;
        accountSignedIn: boolean;
      };
      assert.equal(parsedText.projectId, project.id);
      assert.equal(typeof parsedText.accountSignedIn, 'boolean');

      // 2. Read-scoped MCP token is rejected with -32003 (MCP_SCOPE_FORBIDDEN) on write tool deploy action
      const initRead = await mcpRpc(readToken, {
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'readonly-deploy-test', version: '1.0.0' },
        },
      });
      const forbiddenCall = await mcpRpc(
        readToken,
        {
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'openmotion_design_project',
            arguments: { action: 'deploy', projectId: project.id },
          },
        },
        initRead.sessionId,
      );
      assert.equal(forbiddenCall.payload.error?.code, -32003);
      assert.match(String(forbiddenCall.payload.error?.message), /MCP_SCOPE_FORBIDDEN/);
    } finally {
      await running.close();
    }
  }));
