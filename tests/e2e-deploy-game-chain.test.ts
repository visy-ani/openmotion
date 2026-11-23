import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { designProjectsFor } from '../design-projects.ts';
import type { OpenDesignWorkspaceInfo } from '../gateway/account.ts';
import { AssetLibrary } from '../gateway/asset-library.ts';
import { SuperAgentConversations } from '../gateway/super-agent.ts';
import { webPublishFor, type WebPublishAccountClient } from '../gateway/web-publish.ts';
import { pluginRoot } from '../hyperframes.ts';
import { releaseRegistry, rpc } from '../mcp.ts';
import { Phase1Service } from '../phase1.ts';
import { startServer } from '../server.ts';
import { MCP_HTTP_PATH, MCP_TOKENS_API } from '../shared/mcp-http.ts';
import { fixture } from './fixtures.ts';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

type PushedBundle = {
  files: Map<string, Buffer>;
  metadata: Record<string, unknown>;
};

function createRecordingWebPublishAccount() {
  const pushes: PushedBundle[] = [];
  const catalogByProject = new Map<string, { schemaVersion: 1; revision: number; files: Array<Record<string, unknown>> }>();
  let versionCounter = 0;

  const workspaces: OpenDesignWorkspaceInfo[] = [
    {
      workspaceId: 'ws_e2e_1',
      workspaceName: 'OpenMotion E2E Cloud',
      workspaceType: 'personal',
      workspaceMemberId: 'member_e2e_1',
      role: 'owner',
      isDefault: true,
      memberStatus: 'active',
      lifecycleState: 'active',
    },
  ];

  async function snapshotDir(root: string, prefix = '', out = new Map<string, Buffer>()): Promise<Map<string, Buffer>> {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(root, entry.name);
      if (entry.isDirectory()) {
        await snapshotDir(abs, rel, out);
      } else if (entry.isFile()) {
        out.set(rel, await readFile(abs));
      }
    }
    return out;
  }

  const client: WebPublishAccountClient = {
    async isSignedIn() {
      return true;
    },
    async listWorkspaces() {
      return workspaces;
    },
    async runWithEnv(args) {
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
          workspaceId: 'ws_e2e_1',
          ownerMemberId: 'member_e2e_1',
          resourceId: `root-${projectId}`,
          metadata: state.revision > 0 || state.files.length > 0 ? { _commentFiles: state } : {},
        });
      }
      if (cmd === 'team-projects upsert') {
        const projectId = args[2];
        const metaIdx = args.indexOf('--metadata-json');
        const payload = JSON.parse(args[metaIdx + 1]) as {
          _commentFiles?: {
            resourceId: string;
            versionId: string;
            files: Array<{ sourceFileId: string; sourceFilePath: string; entryPath: string; retired: boolean }>;
          };
        };
        const current = catalogByProject.get(projectId) ?? { schemaVersion: 1 as const, revision: 0, files: [] };
        const mutation = payload._commentFiles!;
        catalogByProject.set(projectId, {
          schemaVersion: 1,
          revision: current.revision + 1,
          files: mutation.files.map(item => ({
            ...item,
            resourceId: mutation.resourceId,
            versionId: mutation.versionId,
          })),
        });
        return JSON.stringify({ projectId, ok: true });
      }
      if (cmd === 'resource push') {
        const stagedRoot = args[4];
        const metaIdx = args.indexOf('--metadata-json');
        const files = await snapshotDir(stagedRoot);
        pushes.push({
          files,
          metadata: JSON.parse(args[metaIdx + 1]) as Record<string, unknown>,
        });
        versionCounter += 1;
        return JSON.stringify({ id: `ver_e2e_${versionCounter}` });
      }
      if (cmd === 'share publish') {
        const slug = args[args.indexOf('--slug') + 1];
        const projectId = args[args.indexOf('--project-id') + 1];
        const versionId = args[args.indexOf('--version-id') + 1];
        return JSON.stringify({
          status: 'published',
          slug,
          version: versionCounter,
          publishedAt: 1_700_200_000_000 + versionCounter,
          snapshot: { versionId },
          url: `https://open-design.app/artifact/${projectId}/${slug}`,
        });
      }
      if (cmd === 'share stop') {
        return JSON.stringify({ status: 'stopped', slug: args[2] });
      }
      if (cmd === 'share resume-existing') {
        const slug = args[2];
        const projectId = args[args.indexOf('--project-id') + 1];
        return JSON.stringify({
          status: 'active',
          slug,
          url: `https://open-design.app/artifact/${projectId}/${slug}`,
        });
      }
      if (cmd === 'share list') {
        return JSON.stringify([]);
      }
      throw new Error(`Unexpected mock args: ${args.join(' ')}`);
    },
  };

  return { client, pushes };
}

async function mcpHttpPost(
  mcpUrl: string,
  token: string,
  body: Record<string, unknown>,
  sessionId?: string,
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  return { res, payload: payload as any, sessionId: res.headers.get('mcp-session-id') ?? sessionId };
}

async function callHttpTool(
  mcpUrl: string,
  token: string,
  sessionId: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
  expectSuccess = true,
) {
  const { res, payload } = await mcpHttpPost(
    mcpUrl,
    token,
    {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    sessionId,
  );
  assert.equal(res.status, 200, `Expected 200 on ${name}`);
  if (expectSuccess) {
    assert.ok(!payload.error, `Unexpected JSON-RPC error on ${name}: ${JSON.stringify(payload.error)}`);
    assert.ok(!payload.result?.isError, `Unexpected tool error on ${name}: ${JSON.stringify(payload.result)}`);
  }
  return payload;
}

test('E2E full chain: Streamable HTTP & stdio MCP deployment, game lifecycle with asset bundling, freshness, and Super Agent artifacts', () =>
  fixture(async store => {
    const { client, pushes } = createRecordingWebPublishAccount();
    webPublishFor(store.directory, client);

    const running = await startServer(store, 0, { editor: false });
    const port = (running.server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const mcpUrl = `${origin}${MCP_HTTP_PATH}`;
    const extraDir = await mkdtemp(path.join(os.tmpdir(), 'om-e2e-standalone-'));

    try {
      // 1. Issue scoped read and write tokens over /motion-api/mcp/tokens
      const readRes = await fetch(`${origin}${MCP_TOKENS_API}`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'E2E Read', scope: 'read' }),
      });
      assert.equal(readRes.status, 201);
      const readToken = ((await readRes.json()) as { token: string }).token;

      const writeRes = await fetch(`${origin}${MCP_TOKENS_API}`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'E2E Write', scope: 'write' }),
      });
      assert.equal(writeRes.status, 201);
      const writeToken = ((await writeRes.json()) as { token: string }).token;

      // 2. Initialize both Streamable HTTP sessions & list tools
      const readInit = await mcpHttpPost(mcpUrl, readToken, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e-read', version: '1.0' } },
      });
      const readSessionId = readInit.sessionId!;
      assert.ok(readSessionId);

      const writeInit = await mcpHttpPost(mcpUrl, writeToken, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e-write', version: '1.0' } },
      });
      const writeSessionId = writeInit.sessionId!;
      assert.ok(writeSessionId);

      const toolsList = await mcpHttpPost(mcpUrl, writeToken, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, writeSessionId);
      const listedNames = new Set((toolsList.payload.result.tools as Array<{ name: string }>).map(item => item.name));
      for (const requiredTool of [
        'openmotion_assets_use',
        'openmotion_design_project',
        'openmotion_game_create',
        'openmotion_game_set_status',
        'openmotion_game_write_files',
        'openmotion_game_update_meta',
        'openmotion_game_validate',
        'openmotion_game_publish',
      ]) {
        assert.ok(listedNames.has(requiredTool), `Missing ${requiredTool} in /mcp tools/list`);
      }

      // 3. Import a real PNG asset into the workspace library for bundling verification
      const pngPath = path.join(extraDir, 'player-ship.png');
      const pngBytes = Buffer.from(TINY_PNG_BASE64, 'base64');
      await writeFile(pngPath, pngBytes);
      const spriteAsset = await new AssetLibrary(store).importFile(pngPath, { requestId: 'e2e-sprite-1', name: 'Player Ship' });
      const spriteUrl = `/motion-api/assets/${spriteAsset.id}/versions/${spriteAsset.currentVersionId!}/media`;

      // 4. Read token blocks write-capable deployment tools (-32003), allows read-only game_get
      const blockedWebPublish = await callHttpTool(
        mcpUrl,
        readToken,
        readSessionId,
        10,
        'openmotion_assets_use',
        { action: 'web_publish', webPublish: { command: 'list' } },
        false,
      );
      assert.equal(blockedWebPublish.error?.code, -32003);

      const blockedDesignDeploy = await callHttpTool(
        mcpUrl,
        readToken,
        readSessionId,
        11,
        'openmotion_design_project',
        { action: 'deploy', projectId: '00000000-0000-4000-8000-000000000001' },
        false,
      );
      assert.equal(blockedDesignDeploy.error?.code, -32003);

      // 5. Full Game Generation Chain over live Streamable HTTP /mcp
      const createdGameRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 20, 'openmotion_game_create', {
        prompt: 'Orbit Pulse arcade dodger with neon HUD',
        multiplayer: false,
        genre: 'shooter',
        style: 'minimal',
        setting: 'space',
        orientation: 'landscape',
      });
      const createdGame = createdGameRes.result.structuredContent.game;
      assert.equal(createdGame.status, 'draft');

      // Read-only token can inspect the newly created game
      const readGameRes = await callHttpTool(mcpUrl, readToken, readSessionId, 12, 'openmotion_game_get', { id: createdGame.id });
      assert.equal(readGameRes.result.structuredContent.id, createdGame.id);

      const buildingRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 21, 'openmotion_game_set_status', {
        id: createdGame.id,
        status: 'building',
      });
      assert.equal(buildingRes.result.structuredContent.status, 'building');

      const gameHtmlV1 = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Orbit Pulse</title></head><body><img id="ship" src="${spriteUrl}?v=1" /><canvas id="game" width="800" height="480"></canvas><script>const c=document.getElementById('game'),g=c.getContext('2d');let score=0;function draw(t){g.clearRect(0,0,800,480);g.fillRect(100+Math.sin(t/400)*50,200,32,32);requestAnimationFrame(draw)}requestAnimationFrame(draw);</script></body></html>`;
      await callHttpTool(mcpUrl, writeToken, writeSessionId, 22, 'openmotion_game_write_files', {
        id: createdGame.id,
        files: [{ path: 'index.html', content: gameHtmlV1 }],
      });

      const metaRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 23, 'openmotion_game_update_meta', {
        id: createdGame.id,
        title: 'Orbit Pulse E2E',
        description: 'Arcade space dodger built in E2E test.',
        controls: 'Arrow keys / Mouse',
      });
      assert.equal(metaRes.result.structuredContent.title, 'Orbit Pulse E2E');

      const validateRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 24, 'openmotion_game_validate', {
        id: createdGame.id,
      });
      assert.equal(validateRes.result.structuredContent.passed, true);

      const readyRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 25, 'openmotion_game_set_status', {
        id: createdGame.id,
        status: 'ready',
      });
      assert.equal(readyRes.result.structuredContent.status, 'ready');

      const localPublishRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 26, 'openmotion_game_publish', {
        id: createdGame.id,
      });
      assert.equal(localPublishRes.result.structuredContent.game.status, 'published');
      assert.ok(localPublishRes.result.structuredContent.playUrl.includes(createdGame.id));

      // Verify local preview CSP allows opaque-origin iframe to fetch workspace assets & own game files without allow-same-origin
      const playHtmlRes = await fetch(`${origin}/motion-api/games/${encodeURIComponent(createdGame.id)}/play/index.html`);
      assert.equal(playHtmlRes.status, 200);
      const playCsp = playHtmlRes.headers.get('content-security-policy') || '';
      assert.match(playCsp, /sandbox allow-scripts/);
      assert.doesNotMatch(playCsp, /allow-same-origin/);
      assert.ok(playCsp.includes(`${origin}/motion-api/assets/`));
      assert.ok(playCsp.includes(`${origin}/motion-api/games/${encodeURIComponent(createdGame.id)}/play/`));

      // Verify both /file and /media asset routes succeed with Access-Control-Allow-Origin: *
      for (const suffix of ['file', 'media']) {
        const assetHttpRes = await fetch(`${origin}/motion-api/assets/${spriteAsset.id}/versions/${spriteAsset.currentVersionId!}/${suffix}`);
        assert.equal(assetHttpRes.status, 200, `Expected 200 on /${suffix}`);
        assert.equal(assetHttpRes.headers.get('access-control-allow-origin'), '*');
        assert.deepEqual(Buffer.from(await assetHttpRes.arrayBuffer()), pngBytes);
      }

      // 6. Deploy Game to OpenDesign Cloud via Streamable HTTP /mcp & verify bundling + freshness
      const publishGameRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 27, 'openmotion_assets_use', {
        action: 'web_publish',
        webPublish: { command: 'publish', targetKind: 'game', targetId: createdGame.id },
      });
      const gamePub1 = publishGameRes.result.structuredContent;
      assert.match(gamePub1.url, /^https:\/\/open-design\.app\/artifact\/[a-f0-9-]+\/.+/);
      assert.equal(gamePub1.publication.bundledAssetCount, 1);

      const push1 = pushes.at(-1)!;
      const expectedBundledKey = `_shared-assets/${spriteAsset.id}-${spriteAsset.currentVersionId!}.png`;
      assert.deepEqual(push1.files.get(expectedBundledKey), pngBytes);
      const stagedHtml1 = push1.files.get('index.html')!.toString('utf8');
      assert.ok(stagedHtml1.includes(`./${expectedBundledKey}`), 'Staged HTML should rewrite /motion-api asset URL');
      assert.equal(stagedHtml1.includes('/motion-api/'), false, 'Staged HTML must not leak local /motion-api/ paths');

      const freshRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 28, 'openmotion_assets_use', {
        action: 'web_publish',
        webPublish: { command: 'status', targetKind: 'game', targetId: createdGame.id },
      });
      assert.equal(freshRes.result.structuredContent.freshness, 'fresh');

      // Mutate game source -> status detects outdated -> re-publish bumps version & restores fresh
      await callHttpTool(mcpUrl, writeToken, writeSessionId, 29, 'openmotion_game_write_files', {
        id: createdGame.id,
        files: [{ path: 'index.html', content: gameHtmlV1.replace('Orbit Pulse', 'Orbit Pulse v2') }],
      });
      const outdatedRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 30, 'openmotion_assets_use', {
        action: 'web_publish',
        webPublish: { command: 'status', targetKind: 'game', targetId: createdGame.id },
      });
      assert.equal(outdatedRes.result.structuredContent.freshness, 'outdated');

      const publishGameRes2 = await callHttpTool(mcpUrl, writeToken, writeSessionId, 31, 'openmotion_assets_use', {
        action: 'web_publish',
        webPublish: { command: 'publish', targetKind: 'game', targetId: createdGame.id },
      });
      assert.equal(publishGameRes2.result.structuredContent.publication.version, 2);
      assert.equal(publishGameRes2.result.structuredContent.url, gamePub1.url);

      // Stop -> Resume (keeps URL) -> New Link (mints distinct slug/URL)
      const stoppedRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 32, 'openmotion_assets_use', {
        action: 'web_publish',
        webPublish: { command: 'unpublish', targetKind: 'game', targetId: createdGame.id },
      });
      assert.equal(stoppedRes.result.structuredContent.publication.status, 'stopped');

      const resumedRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 33, 'openmotion_assets_use', {
        action: 'web_publish',
        webPublish: { command: 'publish', targetKind: 'game', targetId: createdGame.id, deployMode: 'resume' },
      });
      assert.equal(resumedRes.result.structuredContent.publication.status, 'published');
      assert.equal(resumedRes.result.structuredContent.url, gamePub1.url);

      const newLinkRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 34, 'openmotion_assets_use', {
        action: 'web_publish',
        webPublish: { command: 'publish', targetKind: 'game', targetId: createdGame.id, deployMode: 'new_link' },
      });
      assert.notEqual(newLinkRes.result.structuredContent.url, gamePub1.url);

      // 7. Design Studio MCP deploy / deploy_status / unpublish + Standalone HTML + Motion target over /mcp
      const createdDesign = await callHttpTool(mcpUrl, writeToken, writeSessionId, 40, 'openmotion_design_project', {
        action: 'create',
        scenario: 'prototype',
        title: 'E2E Design Deploy',
        requestId: 'e2e-design-create-1',
      });
      const designId = createdDesign.result.structuredContent.project.id;

      const designDeployRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 41, 'openmotion_design_project', {
        action: 'deploy',
        projectId: designId,
      });
      assert.match(designDeployRes.result.structuredContent.url, /^https:\/\/open-design\.app\/artifact\/.+/);

      const designStatusRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 42, 'openmotion_design_project', {
        action: 'deploy_status',
        projectId: designId,
      });
      assert.equal(designStatusRes.result.structuredContent.active.status, 'published');

      // Standalone HTML folder publish over /mcp
      const standaloneFile = path.join(extraDir, 'landing.html');
      await writeFile(standaloneFile, '<!doctype html><html><body><h1>Standalone Cloud Page</h1></body></html>');
      const htmlPubRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 43, 'openmotion_assets_use', {
        action: 'web_publish',
        webPublish: { command: 'publish', targetKind: 'html', sourcePath: standaloneFile, title: 'Standalone Landing' },
      });
      assert.match(htmlPubRes.result.structuredContent.url, /^https:\/\/open-design\.app\/artifact\/.+/);

      // Motion project HTML bundle publish over /mcp
      const createdMotion = await callHttpTool(mcpUrl, writeToken, writeSessionId, 44, 'openmotion_create_project', {
        requestId: 'e2e-motion-create-1',
        projectType: 'natural_language',
        title: 'E2E Motion Bundle',
        requirements: 'Short HTML title sequence.',
        namingLanguage: 'en',
      });
      const motionProjectId = createdMotion.result.structuredContent.projectId;
      await writeFile(
        path.join(store.forProject(motionProjectId).directory, 'index.html'),
        '<!doctype html><html><body><div>Motion Live Frame</div></body></html>',
      );
      const motionPubRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 45, 'openmotion_assets_use', {
        action: 'web_publish',
        webPublish: { command: 'publish', targetKind: 'motion', targetId: motionProjectId },
      });
      assert.match(motionPubRes.result.structuredContent.url, /^https:\/\/open-design\.app\/artifact\/.+/);

      // List all publications over /mcp
      const listRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 46, 'openmotion_assets_use', {
        action: 'web_publish',
        webPublish: { command: 'list' },
      });
      const listKinds = new Set(
        (listRes.result.structuredContent.publications as Array<{ targetKind: string }>).map(item => item.targetKind),
      );
      assert.deepEqual(listKinds, new Set(['game', 'design', 'html', 'motion']));

      // Unpublish Design via openmotion_design_project(action="unpublish")
      const designUnpubRes = await callHttpTool(mcpUrl, writeToken, writeSessionId, 47, 'openmotion_design_project', {
        action: 'unpublish',
        projectId: designId,
      });
      assert.equal(designUnpubRes.result.structuredContent.deployment.status, 'stopped');

      // 8. Stdio MCP (mcp.ts rpc + Phase1Service) invokes web_publish & deploy with identical behavior
      const phase1 = new Phase1Service(store, pluginRoot, {
        origin: () => origin,
        nativeUrl: () => undefined,
        openProject: async () => {},
        mutation: async fn => fn(),
        cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
      });
      const callPhase1 = (payload: { name: string; arguments: any; trackingHost: any; trackingContext?: string }) =>
        phase1.call(payload.name, payload.arguments ?? {}, payload.trackingHost);

      const stdioList = await rpc(
        {
          jsonrpc: '2.0',
          id: 100,
          method: 'tools/call',
          params: { name: 'openmotion_assets_use', arguments: { action: 'web_publish', webPublish: { command: 'list' } } },
        },
        store,
        releaseRegistry,
        undefined,
        undefined,
        { callPhase1 },
      );
      assert.equal((stdioList as any).result.structuredContent.publications.length, 4);

      const stdioDeploy = await rpc(
        {
          jsonrpc: '2.0',
          id: 101,
          method: 'tools/call',
          params: { name: 'openmotion_design_project', arguments: { action: 'deploy', projectId: designId, deployMode: 'resume' } },
        },
        store,
        releaseRegistry,
        undefined,
        undefined,
        { callPhase1 },
      );
      assert.equal((stdioDeploy as any).result.structuredContent.deployment.status, 'published');

      // 9. Super Agent Auto-Artifact Extraction extracts 'game-project' and 'web' artifacts cleanly
      const agentDesign = await designProjectsFor(store.directory).create({
        requestId: 'e2e-agent-design-1',
        scenario: 'prototype',
        title: 'Agent Auto Deploy Page',
      });
      const superAgent = new SuperAgentConversations(store, {
        resolve: async () => '/usr/local/bin/claude',
        runClaude: async ({ onEvent }) => {
          await onEvent({ type: 'system', session_id: 'claude-e2e-1' });
          const toolUses = [
            {
              id: 'tu-game-ready',
              name: 'mcp__openmotion__openmotion_game_set_status',
              input: { id: createdGame.id, status: 'ready' },
              output: { id: createdGame.id, title: 'Orbit Pulse E2E', genre: 'arcade', multiplayer: false, status: 'ready', playUrl: `/api/games/${createdGame.id}/play/index.html`, updatedAt: 9001 },
            },
            {
              id: 'tu-game-web',
              name: 'mcp__openmotion__openmotion_assets_use',
              input: { action: 'web_publish', webPublish: { command: 'publish', targetKind: 'game', targetId: createdGame.id } },
              output: {
                url: newLinkRes.result.structuredContent.url,
                publication: { targetKind: 'game', targetId: createdGame.id, name: 'Orbit Pulse E2E' },
              },
            },
            {
              id: 'tu-design-web',
              name: 'mcp__openmotion__openmotion_design_project',
              input: { action: 'deploy', projectId: agentDesign.id },
              output: {
                url: `https://open-design.app/artifact/${agentDesign.id}/agent-live`,
                deployment: { projectId: agentDesign.id, slug: 'agent-live', name: 'Agent Auto Deploy Page', version: 1 },
              },
            },
          ];
          await onEvent({
            type: 'assistant',
            message: { content: toolUses.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })) },
          });
          await onEvent({
            type: 'user',
            message: { content: toolUses.map(t => ({ type: 'tool_result', tool_use_id: t.id, content: JSON.stringify(t.output) })) },
          });
          await onEvent({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Game ready and deployed.' }] },
          });
        },
      });
      const chat = await superAgent.create({ engine: 'claude', intent: 'game', permissionMode: 'auto' });
      await superAgent.start(chat.id, { requestId: 'e2e-chat-run-1', text: 'Build and deploy game' }, {
        origin,
        phase1: () => phase1,
      });
      for (let i = 0; i < 60; i++) {
        const snap = await superAgent.get(chat.id);
        if (snap.state === 'idle' || snap.state === 'failed') break;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      const doneChat = await superAgent.get(chat.id);
      assert.equal(doneChat.state, 'idle');
      assert.ok(doneChat.artifacts.some(a => a.kind === 'game-project' && a.projectId === createdGame.id));
      assert.ok(doneChat.artifacts.some(a => a.kind === 'web' && a.url === newLinkRes.result.structuredContent.url));
      assert.ok(doneChat.artifacts.some(a => a.kind === 'web' && a.url === `https://open-design.app/artifact/${agentDesign.id}/agent-live`));
      await superAgent.close();
    } finally {
      await running.close();
      await rm(extraDir, { recursive: true, force: true });
    }
  }));
