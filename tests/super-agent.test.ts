import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { designHttp, designProjectsFor } from '../design-projects.ts';
import { gameHttp, gameProjectsFor } from '../game-projects.ts';
import { injectPreviewBridgeHtml, isValidPreviewBridgeToken } from '../shared/preview-bridge.ts';
import { Phase1Service } from '../phase1.ts';
import { pluginRoot } from '../hyperframes.ts';
import {
  SuperAgentConversations,
  extractLocalDevServerUrl,
  formatBrowserAnnotationsContext,
  superAgentConversations,
} from '../gateway/super-agent.ts';
import { buildResourceContextManifest, collectWorkspaceResources } from '../gateway/super-agent-resources.ts';
import { AssetAgentRpc } from '../gateway/asset-chat.ts';
import { fixture } from './fixtures.ts';
import { transport } from './http.ts';

test('collectWorkspaceResources and buildResourceContextManifest aggregate workspace inputs and filter cleanly', () => fixture(async store => {
  await designProjectsFor(store.directory).create({
    scenario: 'prototype',
    title: 'Neon Space Game',
    requestId: 'req-design-1',
  });

  const all = await collectWorkspaceResources(store, { limit: 100 });
  assert.ok(all.counts.designProjects >= 1);
  assert.ok(all.counts.motionProjects >= 1);
  assert.ok(all.counts.officialBrandKits > 0);
  assert.ok(all.counts.designTemplates > 0);
  assert.ok(all.counts.skills > 0);
  assert.ok(all.counts.designSkills > 0);

  const projectsOnly = await collectWorkspaceResources(store, { kind: 'design-project', query: 'Neon Space' });
  assert.equal(projectsOnly.items.length, 1);
  assert.equal(projectsOnly.items[0].kind, 'design-project');
  assert.equal(projectsOnly.items[0].title, 'Neon Space Game');

  const manifest = await buildResourceContextManifest(store, [
    { id: 'brand-ref', kind: 'brand-kit', title: 'Reference Brand', subtitle: 'editorial' },
  ]);
  assert.match(manifest, /^<openmotion-workspace-context>/);
  assert.match(manifest, /Neon Space Game/);
  assert.match(manifest, /Reference Brand/);
}));

test('SuperAgentConversations persists CRUD state, recovers interrupted runs, and enforces requestId idempotency', () => fixture(async store => {
  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
  });

  const created = await service.create({ engine: 'codex', permissionMode: 'on-request' });
  assert.equal(created.state, 'idle');
  assert.equal(created.title, 'New conversation');

  const updated = await service.update(created.id, {
    title: 'Interactive Game Build',
    pinned: true,
    permissionMode: 'auto',
    addArtifact: { kind: 'web', url: 'https://example.com/docs' },
  });
  assert.equal(updated.title, 'Interactive Game Build');
  assert.equal(updated.pinned, true);
  assert.equal(updated.permissionMode, 'auto');
  assert.equal(updated.artifacts.length, 1);
  assert.equal(updated.artifacts[0].kind, 'web');

  await assert.rejects(
    () => service.update(created.id, { addArtifact: { kind: 'design-project', url: 'javascript:alert(1)' } as any }),
    /same-origin/,
  );

  // Persist running state on disk directly to verify restart interruption recovery.
  const file = await service.file(created.id);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, JSON.stringify({ ...updated, state: 'running', approvals: [{ id: 'a1', kind: 'tool', title: 'Pending', detail: '{}' }] }));
  const reloaded = new SuperAgentConversations(store);
  const recovered = await reloaded.get(created.id);
  assert.equal(recovered.state, 'failed');
  assert.equal(recovered.approvals.length, 0);
  assert.match(recovered.error || '', /interrupted/i);

  const list = await reloaded.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);
  assert.equal(list[0].pinned, true);

  await reloaded.remove(created.id);
  await assert.rejects(() => reloaded.get(created.id), /CONVERSATION_NOT_FOUND/);
  await reloaded.close();
  await service.close();
}));

test('SuperAgentConversations runs Codex RPC dynamic tools, extracts artifacts, gates approvals, and deduplicates requestId', () => fixture(async store => {
  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });

  const toolCallsSeen: string[] = [];
  let approvalPrompted = false;

  class FakeRpc {
    onNotification: (msg: any) => void;
    sent: any[] = [];
    closed = false;

    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void, _onError: (err: Error) => void) {
      this.onNotification = onNotification;
    }

    async request(method: string, params: any) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'thread-codex-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          // 1. Call workspace resource discovery dynamic tool
          this.onNotification({
            id: 101,
            method: 'item/tool/call',
            params: { callId: 'c1', tool: 'openmotion_workspace_resources', arguments: { kind: 'all' } },
          });
        });
        return { turn: { id: 'turn-1' } };
      }
      return {};
    }

    send(payload: any) {
      this.sent.push(payload);
      if (payload.id === 101) {
        toolCallsSeen.push('resources');
        queueMicrotask(() => {
          // 2. Call design project create (auto-extracts design-project artifact)
          this.onNotification({
            id: 102,
            method: 'item/tool/call',
            params: {
              callId: 'c2',
              tool: 'openmotion_design_project',
              arguments: { action: 'create', scenario: 'prototype', title: 'Retro Shooter' },
            },
          });
        });
      }
      if (payload.id === 102) {
        toolCallsSeen.push('design');
        queueMicrotask(() => {
          // 3. Call present_artifact for official Brand Kit catalog entry
          this.onNotification({
            id: 103,
            method: 'item/tool/call',
            params: {
              callId: 'c3',
              tool: 'openmotion_present_artifact',
              arguments: { kind: 'brand-kit', kitId: 'catalog:vercel' },
            },
          });
        });
      }
      if (payload.id === 103) {
        toolCallsSeen.push('present');
        queueMicrotask(() => {
          // 4. Request command approval under on-request policy
          approvalPrompted = true;
          this.onNotification({
            id: 104,
            method: 'item/commandExecution/requestApproval',
            params: { command: 'echo hello' },
          });
        });
      }
      if (payload.id === 104) {
        assert.equal(payload.result?.decision, 'accept');
        queueMicrotask(() => {
          this.onNotification({
            method: 'item/agentMessage/delta',
            params: { itemId: 'msg-a1', delta: 'Built **Retro Shooter** ' },
          });
          this.onNotification({
            method: 'item/completed',
            params: { item: { id: 'msg-a1', type: 'agentMessage', text: 'Built **Retro Shooter** in Design Studio.' } },
          });
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-1', status: 'completed' } },
          });
        });
      }
    }

    close() {
      this.closed = true;
    }
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: FakeRpc as unknown as typeof AssetAgentRpc,
  });

  const chat = await service.create({ engine: 'codex', permissionMode: 'on-request' });
  const runtime = { origin: 'http://127.0.0.1:4173', phase1: () => phase1 };
  const turnInput = { requestId: 'req-turn-1', text: 'Build a retro arcade shooter game' };

  await service.start(chat.id, turnInput, runtime);
  // Idempotent retry with identical requestId succeeds; mismatched input fails with REQUEST_ID_CONFLICT
  await service.start(chat.id, turnInput, runtime);
  await assert.rejects(
    () => service.start(chat.id, { requestId: 'req-turn-1', text: 'Different prompt' }, runtime),
    /REQUEST_ID_CONFLICT/,
  );

  // Wait for approval prompt to arrive
  for (let i = 0; i < 60 && !approvalPrompted; i++) {
    await new Promise(r => setTimeout(r, 15));
  }
  const waiting = await service.get(chat.id);
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.approvals.length, 1);

  await service.answer(chat.id, waiting.approvals[0].id, true);

  for (let i = 0; i < 60; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle') break;
    await new Promise(r => setTimeout(r, 15));
  }

  const done = await service.get(chat.id);
  assert.equal(done.state, 'idle');
  assert.equal(done.title, 'Build a retro arcade shooter game');
  assert.deepEqual(toolCallsSeen, ['resources', 'design', 'present']);
  assert.ok(done.artifacts.some(a => a.kind === 'design-project' && a.title === 'Retro Shooter'));
  assert.ok(done.artifacts.some(a => a.kind === 'brand-kit' && a.kitId === 'catalog:vercel'));
  assert.ok(done.messages.some(m => m.role === 'assistant' && m.text.includes('Retro Shooter')));
  assert.ok(done.messages.some(m => m.role === 'tool' && m.toolEvent?.artifactId));

  await service.close();
}));

test('SuperAgentConversations runs Claude Code stream-json turns and extracts artifacts', () => fixture(async store => {
  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/claude',
    runClaude: async ({ prompt, onEvent }) => {
      assert.match(prompt, /<openmotion-workspace-context>/);
      await onEvent({ type: 'system', session_id: 'claude-sess-42' });
      await onEvent({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'mcp__openmotion__openmotion_create_project',
              input: { title: 'Launch Reel' },
            },
          ],
        },
      });
      await onEvent({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: JSON.stringify({ projectId: 'mproj-1', sessionId: 'msess-1', revision: 'rev1', project: { title: 'Launch Reel' } }),
            },
          ],
        },
      });
      await onEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Created your editable Motion project.' }] },
      });
    },
  });

  const chat = await service.create({ engine: 'claude', permissionMode: 'auto' });
  await service.start(chat.id, { requestId: 'req-claude-1', text: 'Create a launch reel' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 60; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle') break;
    await new Promise(r => setTimeout(r, 15));
  }

  const done = await service.get(chat.id);
  assert.equal(done.threadId, 'claude-sess-42');
  assert.ok(done.artifacts.some(a => a.kind === 'motion-project' && a.projectId === 'mproj-1'));
  assert.ok(done.messages.some(m => m.role === 'assistant' && m.text === 'Created your editable Motion project.'));

  await service.close();
}));

test('HTTP /motion-api/super-agent/* routes serve resources, CRUD chats, SSE initial frame, and clean errors', () => fixture(async store => {
  const req = transport(store);

  const resRes = await req('/motion-api/super-agent/resources?kind=design-template&limit=5');
  assert.equal(resRes.status, 200);
  const resBody = await resRes.json();
  assert.ok(resBody.counts.designTemplates > 0);
  assert.ok(resBody.items.length > 0);

  const createdRes = await req('/motion-api/super-agent/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: 'codex', title: 'HTTP Chat' }),
  });
  assert.equal(createdRes.status, 200);
  const created = (await createdRes.json()).conversation;
  assert.equal(created.title, 'HTTP Chat');

  const patchRes = await req(`/motion-api/super-agent/chats/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: true, addArtifact: { kind: 'web', url: 'https://open-design.ai' } }),
  });
  assert.equal(patchRes.status, 200);
  const patched = (await patchRes.json()).conversation;
  assert.equal(patched.pinned, true);
  assert.equal(patched.artifacts[0].kind, 'web');

  const missingRes = await req('/motion-api/super-agent/chats/not-a-uuid');
  assert.equal(missingRes.status, 404);

  const listRes = await req('/motion-api/super-agent/chats');
  assert.equal(listRes.status, 200);
  assert.equal((await listRes.json()).conversations.length, 1);

  const delRes = await req(`/motion-api/super-agent/chats/${created.id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  assert.equal((await req(`/motion-api/super-agent/chats/${created.id}`)).status, 404);

  await superAgentConversations(store).close();
}));

test('local Claude runtime enforces on-request approvals for paid generation through the host MCP bridge', () => fixture(async store => {
  const { readFile } = await import('node:fs/promises');
  let generationExecuted = false;
  const phase1: any = {
    call: async (name: string, args: Record<string, unknown>) => {
      if (name === 'openmotion_assets_use' && args.action === 'generate') {
        generationExecuted = true;
        return { job: { id: 'job-claude-1', state: 'queued' } };
      }
      return {};
    },
  };

  let approvalObserved = false;
  const service = new SuperAgentConversations(store, {
    resolveAgent: async () => '/usr/local/bin/claude',
    runClaude: async ({ mcpConfigPath, onEvent }) => {
      const cfg = JSON.parse(await readFile(mcpConfigPath, 'utf8'));
      const server = cfg.mcpServers.openmotion;
      assert.equal(server.type, 'http');
      const callPromise = fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...server.headers },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: {
            name: 'openmotion_assets_use',
            arguments: { action: 'generate', modality: 'image', prompt: 'neon poster' },
          },
        }),
      });
      // Wait for approval gate to appear
      for (let i = 0; i < 60; i++) {
        const current = await service.get(chat.id);
        if (current.approvals.length > 0) {
          approvalObserved = true;
          assert.equal(current.state, 'waiting');
          assert.equal(generationExecuted, false);
          await service.answer(chat.id, current.approvals[0].id, true);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      const res = await callPromise;
      const body = await res.json() as any;
      assert.equal(body.result.isError, false);
      await onEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Queued your image after approval.' }] },
      });
    },
  });

  const chat = await service.create({ engine: 'claude', permissionMode: 'on-request' });
  await service.start(chat.id, { requestId: 'req-claude-approval-1', text: 'Generate a neon poster' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 80; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const done = await service.get(chat.id);
  assert.equal(approvalObserved, true);
  assert.equal(generationExecuted, true);
  assert.equal(done.state, 'idle');
  await service.close();
}));

test('deleting a conversation during an in-flight tool call prevents recreating the chat file', () => fixture(async store => {
  const { existsSync } = await import('node:fs');
  let releaseTool!: () => void;
  let toolStarted!: () => void;
  const toolStartedPromise = new Promise<void>(resolve => { toolStarted = resolve; });
  const phase1: any = {
    call: async () => {
      toolStarted();
      await new Promise<void>(resolve => { releaseTool = resolve; });
      return { ok: true };
    },
  };

  class DeleteRaceRpc {
    onNotification: (msg: any) => void;
    closed = false;

    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void, _onError: (err: Error) => void) {
      this.onNotification = onNotification;
    }

    async request(method: string) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'thread-del-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.onNotification({
            method: 'item/tool/call',
            id: 50,
            params: { tool: 'openmotion_create_project', callId: 'call-del-1', arguments: { title: 'Race' } },
          });
        });
        return { turn: { id: 'turn-del-1' } };
      }
      return {};
    }

    send() {}

    close() {
      this.closed = true;
    }
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: DeleteRaceRpc as unknown as typeof AssetAgentRpc,
  });

  const chat = await service.create({ engine: 'codex', permissionMode: 'auto' });
  await service.start(chat.id, { requestId: 'req-del-race-1', text: 'Create project' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  await toolStartedPromise;
  const removePromise = service.remove(chat.id);
  releaseTool();
  await removePromise;

  const chatPath = path.join(store.directory, 'super-agent', 'chats', `${chat.id}.json`);
  assert.equal(existsSync(chatPath), false);
  await assert.rejects(() => service.get(chat.id), /CONVERSATION_NOT_FOUND/);
  await service.close();
}));

test('SuperAgentConversations supports game intent, initial game artifact, openmotion_game_* live updates, and GET /api/games/:id/files', () => fixture(async store => {
  const createdGame = await gameProjectsFor(store.directory).create({
    prompt: 'Neon space drifter',
    genre: 'shooter',
    style: 'pixel',
    setting: 'space',
    multiplayer: false,
    orientation: 'portrait',
  });
  const gameId = createdGame.game.id;

  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });

  class GameToolRpc {
    onNotification: (msg: any) => void;
    closed = false;

    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void, _onError: (err: Error) => void) {
      this.onNotification = onNotification;
    }

    async request(method: string) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'thread-game-1' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.onNotification({
            id: 201,
            method: 'item/tool/call',
            params: {
              callId: 'g1',
              tool: 'openmotion_game_write_files',
              arguments: {
                id: gameId,
                files: [
                  { path: 'index.html', content: '<!doctype html><canvas id="c"></canvas><script src="./logic.js"></script>' },
                  { path: 'logic.js', content: 'window.__GAME_READY__ = true;' },
                ],
              },
            },
          });
        });
        return { turn: { id: 'turn-game-1' } };
      }
      return {};
    }

    send(payload: any) {
      if (payload.id === 201) {
        queueMicrotask(() => {
          this.onNotification({
            id: 202,
            method: 'item/tool/call',
            params: {
              callId: 'g2',
              tool: 'openmotion_game_update_meta',
              arguments: {
                id: gameId,
                title: 'Star Drifter 99',
                description: 'Portrait space wave dodger',
                controls: 'Move with arrow keys',
              },
            },
          });
        });
      }
      if (payload.id === 202) {
        queueMicrotask(() => {
          this.onNotification({
            method: 'item/completed',
            params: { item: { id: 'msg-g1', type: 'agentMessage', text: 'Updated **Star Drifter 99**.' } },
          });
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-game-1', status: 'completed' } },
          });
        });
      }
    }

    close() {
      this.closed = true;
    }
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: GameToolRpc as unknown as typeof AssetAgentRpc,
  });

  const chat = await service.create({
    engine: 'codex',
    intent: 'game',
    permissionMode: 'auto',
    initialArtifact: {
      id: `game:${gameId}`,
      kind: 'game-project',
      title: createdGame.game.title,
      projectId: gameId,
      scenario: 'portrait',
      url: `/motion-api/games/${gameId}/play/index.html`,
    },
  });
  assert.equal(chat.intent, 'game');
  assert.equal(chat.activeArtifactId, `game:${gameId}`);

  await service.start(chat.id, {
    requestId: 'req-game-turn-1',
    mode: 'game',
    text: `Update game ${gameId} with faster meteors`,
  }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 80; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  const done = await service.get(chat.id);
  assert.equal(done.state, 'idle');
  assert.equal(done.intent, 'game');
  assert.equal(done.title, 'Star Drifter 99');
  const gameArtifact = done.artifacts.find(item => item.kind === 'game-project' && item.projectId === gameId);
  assert.ok(gameArtifact);
  assert.equal(gameArtifact.title, 'Star Drifter 99');
  assert.equal(gameArtifact.scenario, 'portrait');
  assert.equal(gameArtifact.url, `/motion-api/games/${gameId}/play/index.html`);
  assert.equal(done.activeArtifactId, gameArtifact.id);

  // Verify GET /api/games/:id/files HTTP handler returns written game source inventory
  let statusCode = 0;
  let bodyText = '';
  const handled = await gameHttp(
    { method: 'GET', headers: {} } as any,
    {
      writeHead(code: number) { statusCode = code; },
      end(chunk: string) { bodyText += chunk; },
    } as any,
    new URL(`http://127.0.0.1:4173/api/games/${encodeURIComponent(gameId)}/files`),
    store.directory,
    async () => ({}),
  );
  assert.equal(handled, true);
  assert.equal(statusCode, 200);
  const filesRes = JSON.parse(bodyText) as { files: Array<{ path: string; bytes: number }> };
  assert.ok(filesRes.files.some(f => f.path === 'index.html'));
  assert.ok(filesRes.files.some(f => f.path === 'logic.js'));

  await service.close();
}));

test('game generation suppresses premature starter-kit artifacts during building and auto-presents on ready or turn completion', () => fixture(async store => {
  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });
  const draftA = await gameProjectsFor(store.directory).create({
    prompt: 'Starlit little prince planet exploration game',
    genre: 'story',
    orientation: 'landscape',
    multiplayer: false,
  });
  const gameIdA = draftA.game.id;
  assert.equal(draftA.game.status, 'draft');

  let turnCount = 0;
  let capturedSnapshots: Array<{ step: string; count: number; active?: string }> = [];
  let serviceRef!: SuperAgentConversations;
  let chatIdA = '';

  class StagedGameRpc {
    onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string) {
      if (method === 'initialize') return {};
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'thread-staged-game' } };
      if (method === 'turn/start') {
        turnCount += 1;
        if (turnCount === 1) {
          queueMicrotask(() => {
            this.onNotification({
              id: 301,
              method: 'item/tool/call',
              params: {
                callId: 'sg-1',
                tool: 'openmotion_game_read_file',
                arguments: { id: gameIdA, path: 'index.html' },
              },
            });
          });
        } else {
          queueMicrotask(() => {
            this.onNotification({
              id: 311,
              method: 'item/tool/call',
              params: {
                callId: 'sg-4',
                tool: 'openmotion_game_write_files',
                arguments: {
                  id: gameIdA,
                  files: [
                    { path: 'index.html', content: '<!doctype html><title>Celestial Star Journey</title><canvas id="sky"></canvas>' },
                    { path: 'logic.js', content: 'export const version = 2;' },
                  ],
                },
              },
            });
          });
        }
        return { turn: { id: `turn-staged-${turnCount}` } };
      }
      return {};
    }
    send(payload: any) {
      const recordAndSend = async (step: string, nextMsg: any) => {
        const snap = await serviceRef.get(chatIdA);
        capturedSnapshots.push({ step, count: snap.artifacts.length, active: snap.activeArtifactId });
        this.onNotification(nextMsg);
      };
      if (payload.id === 301) {
        void recordAndSend('after_read', {
          id: 302,
          method: 'item/tool/call',
          params: {
            callId: 'sg-2',
            tool: 'openmotion_game_set_status',
            arguments: { id: gameIdA, status: 'building' },
          },
        });
      } else if (payload.id === 302) {
        void recordAndSend('after_building', {
          id: 303,
          method: 'item/tool/call',
          params: {
            callId: 'sg-3',
            tool: 'openmotion_game_write_files',
            arguments: {
              id: gameIdA,
              files: [{ path: 'design/style.md', content: '# Visual Style\nWarm gouache starfields.' }],
            },
          },
        });
      } else if (payload.id === 303) {
        void recordAndSend('after_style_md', {
          method: 'turn/completed',
          params: { turn: { id: 'turn-staged-1', status: 'completed' } },
        });
      } else if (payload.id === 311) {
        void recordAndSend('after_code_still_building', {
          id: 312,
          method: 'item/tool/call',
          params: {
            callId: 'sg-5',
            tool: 'openmotion_game_update_meta',
            arguments: {
              id: gameIdA,
              title: 'Celestial Star Journey',
              description: 'Gouache planet hopping adventure',
            },
          },
        });
      } else if (payload.id === 312) {
        void recordAndSend('after_meta_still_building', {
          id: 313,
          method: 'item/tool/call',
          params: {
            callId: 'sg-6',
            tool: 'openmotion_game_set_status',
            arguments: { id: gameIdA, status: 'ready' },
          },
        });
      } else if (payload.id === 313) {
        void recordAndSend('after_ready', {
          method: 'turn/completed',
          params: { turn: { id: 'turn-staged-2', status: 'completed' } },
        });
      }
    }
    close() {}
  }

  serviceRef = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: StagedGameRpc as unknown as typeof AssetAgentRpc,
  });

  const chatA = await serviceRef.create({
    engine: 'codex',
    intent: 'game',
    permissionMode: 'auto',
  });
  chatIdA = chatA.id;

  // Turn 1: read starter files + set status=building + write design/style.md ONLY
  await serviceRef.start(chatIdA, {
    requestId: 'req-staged-1',
    mode: 'game',
    text: `Plan visual style for game ${gameIdA}`,
  }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 80; i++) {
    const snap = await serviceRef.get(chatIdA);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  const afterTurn1 = await serviceRef.get(chatIdA);
  assert.equal(afterTurn1.state, 'idle');
  assert.equal(afterTurn1.artifacts.length, 0, 'design/style.md and building status must not prematurely register starter kit');
  assert.equal(afterTurn1.activeArtifactId, undefined);
  for (const snap of capturedSnapshots) {
    assert.equal(snap.count, 0, `expected 0 artifacts at ${snap.step}`);
    assert.equal(snap.active, undefined, `expected no activeArtifactId at ${snap.step}`);
  }

  // Turn 2: write runnable code -> update meta -> set status=ready -> must auto-present immediately
  capturedSnapshots = [];
  await serviceRef.start(chatIdA, {
    requestId: 'req-staged-2',
    mode: 'game',
    text: `Implement and finalize game ${gameIdA}`,
  }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 80; i++) {
    const snap = await serviceRef.get(chatIdA);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  const afterTurn2 = await serviceRef.get(chatIdA);
  assert.equal(afterTurn2.state, 'idle');
  assert.equal(capturedSnapshots.find(s => s.step === 'after_code_still_building')?.count, 0);
  assert.equal(capturedSnapshots.find(s => s.step === 'after_meta_still_building')?.count, 0);
  assert.equal(capturedSnapshots.find(s => s.step === 'after_ready')?.active, `game:${gameIdA}`);
  const readyArt = afterTurn2.artifacts.find(item => item.id === `game:${gameIdA}`);
  assert.ok(readyArt);
  assert.equal(readyArt.title, 'Celestial Star Journey');
  assert.equal(typeof readyArt.presentedAt, 'number');
  assert.ok((readyArt.presentedAt ?? 0) > 0);
  assert.equal(afterTurn2.activeArtifactId, `game:${gameIdA}`);

  await serviceRef.close();

  // Part C: end-of-turn auto-present safety net when Agent writes runnable code and finishes without set_status("ready") or present_artifact
  const draftB = await gameProjectsFor(store.directory).create({
    prompt: 'Fast neon breakout shooter',
    genre: 'shooter',
    orientation: 'portrait',
    multiplayer: false,
  });
  const gameIdB = draftB.game.id;

  class ForgotPresentRpc {
    onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'thread-forgot-present' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.onNotification({
            id: 401,
            method: 'item/tool/call',
            params: {
              callId: 'fp-1',
              tool: 'openmotion_game_write_files',
              arguments: {
                id: gameIdB,
                files: [
                  { path: 'index.html', content: '<!doctype html><canvas id="breakout"></canvas>' },
                  { path: 'client.js', content: 'console.log("ready");' },
                ],
              },
            },
          });
        });
        return { turn: { id: 'turn-forgot-present' } };
      }
      return {};
    }
    send(payload: any) {
      if (payload.id === 401) {
        queueMicrotask(() => {
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-forgot-present', status: 'completed' } },
          });
        });
      }
    }
    close() {}
  }

  const serviceB = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: ForgotPresentRpc as unknown as typeof AssetAgentRpc,
  });
  const chatB = await serviceB.create({
    engine: 'codex',
    intent: 'game',
    permissionMode: 'auto',
  });
  await serviceB.start(chatB.id, {
    requestId: 'req-forgot-present',
    mode: 'game',
    text: `Build game ${gameIdB}`,
  }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });
  for (let i = 0; i < 80; i++) {
    const snap = await serviceB.get(chatB.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  const doneB = await serviceB.get(chatB.id);
  assert.equal(doneB.state, 'idle');
  assert.equal(doneB.activeArtifactId, `game:${gameIdB}`);
  const autoPresented = doneB.artifacts.find(item => item.id === `game:${gameIdB}`);
  assert.ok(autoPresented);
  assert.ok((autoPresented.presentedAt ?? 0) > 0);
  await serviceB.close();
}));

test('extractLocalDevServerUrl, annotation image persistence, and lean Coding prompt injection', () => fixture(async store => {
  assert.equal(
    extractLocalDevServerUrl('  VITE v6.0 ready\n  ➜  Local:   http://localhost:5173/dashboard\n', 'http://127.0.0.1:4173'),
    'http://localhost:5173/dashboard',
  );
  assert.equal(
    extractLocalDevServerUrl('\u001b[32m➜\u001b[39m  \u001b[1mLocal:\u001b[22m   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m', 'http://127.0.0.1:4173'),
    'http://localhost:5173/',
  );
  assert.equal(
    extractLocalDevServerUrl('Listening on http://0.0.0.0:3000.', 'http://127.0.0.1:4173'),
    'http://127.0.0.1:3000/',
  );
  assert.equal(
    extractLocalDevServerUrl('OpenMotion UI at http://localhost:4173/agent', 'http://127.0.0.1:4173'),
    null,
  );

  let capturedPrompt = '';
  class CodingAnnotationRpc {
    onNotification: (msg: any) => void;
    closed = false;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string, params?: any) {
      if (method === 'initialize') return { capabilities: {} };
      if (method === 'thread/start') return { thread: { id: 'thr-coding-annot' } };
      if (method === 'turn/start') {
        capturedPrompt = String(params?.input?.[0]?.text ?? '');
        queueMicrotask(() => {
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-coding-annot', status: 'completed' } },
          });
        });
        return { turn: { id: 'turn-coding-annot' } };
      }
      return {};
    }
    send() {}
    close() { this.closed = true; }
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: CodingAnnotationRpc as unknown as typeof AssetAgentRpc,
  });
  const chat = await service.create({ engine: 'codex', intent: 'coding', permissionMode: 'auto' });

  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  const saved = await service.saveAnnotationImage(chat.id, pngBytes);
  const loaded = await service.readAnnotationImage(chat.id, saved.filename);
  assert.deepEqual(loaded, pngBytes);
  await assert.rejects(service.saveAnnotationImage(chat.id, Buffer.from('not-a-png')), /Invalid PNG/);
  await assert.rejects(service.readAnnotationImage(chat.id, '../escape.png'), /Invalid annotation/);

  const phase1 = new Phase1Service(store, undefined, pluginRoot);
  await service.start(chat.id, {
    requestId: 'req-coding-annot-1',
    mode: 'coding',
    text: 'Make this CTA rounded and purple',
    attachments: [{
      id: 'annot-1',
      kind: 'browser-annotation',
      title: 'HeroButton · button.cta',
      subtitle: 'http://localhost:5173/',
      previewUrl: `/motion-api/super-agent/chats/${chat.id}/annotations/${saved.filename}`,
      annotation: {
        mode: 'select',
        pageUrl: 'http://localhost:5173/',
        comment: 'Make this CTA rounded and purple',
        screenshotPath: saved.path,
        element: {
          tagName: 'button',
          selector: 'button.cta',
          label: 'Get Started',
          htmlPreview: '<button class="cta">Get Started</button>',
          styles: { borderRadius: '4px' },
          rect: { x: 20, y: 30, width: 120, height: 40 },
          viewport: { width: 1280, height: 800 },
          pageUrl: 'http://localhost:5173/',
          componentName: 'HeroButton',
          sourceFile: 'src/HeroButton.tsx',
          sourceLine: 18,
        },
      },
    }],
  }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 60; i++) {
    const snap = await service.get(chat.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }

  assert.ok(capturedPrompt.includes('<openmotion-browser-annotations>'));
  assert.ok(capturedPrompt.includes('button.cta'));
  assert.ok(capturedPrompt.includes('HeroButton'));
  assert.ok(capturedPrompt.includes('src/HeroButton.tsx'));
  assert.ok(capturedPrompt.includes(saved.path));
  assert.equal(capturedPrompt.includes('<openmotion-workspace-context>'), false);

  const formatted = formatBrowserAnnotationsContext([]);
  assert.equal(formatted, '');

  const allowedDir = path.dirname(saved.path);
  const confinedOut = formatBrowserAnnotationsContext([{
    id: 'bad-path-1',
    kind: 'browser-annotation',
    title: 'Bad path',
    annotation: {
      mode: 'select',
      pageUrl: 'http://localhost:5173/',
      screenshotPath: '/etc/passwd',
    },
  }, {
    id: 'good-path-1',
    kind: 'browser-annotation',
    title: 'Good path',
    annotation: {
      mode: 'select',
      pageUrl: 'http://localhost:5173/',
      screenshotPath: saved.path,
    },
  }], allowedDir);
  assert.equal(confinedOut.includes('/etc/passwd'), false);
  assert.ok(confinedOut.includes(saved.path));

  const formattedDraw = formatBrowserAnnotationsContext([{
    id: 'draw-1',
    kind: 'browser-annotation',
    title: 'Circle boss',
    annotation: {
      mode: 'draw',
      pageUrl: '/motion-api/games/g1/play/index.html',
      comment: 'Shrink boss hitbox',
      strokeCount: 2,
      strokeBounds: { x: 100, y: 120, width: 220, height: 180 },
    },
  }]);
  assert.ok(formattedDraw.includes('"strokeCount": 2'));
  assert.ok(formattedDraw.includes('"width": 220'));

  await service.close();
}));

test('Claude tool_result and Codex streaming command output auto-present local dev servers', () => fixture(async store => {
  const phase1: any = { call: async () => ({ ok: true }) };
  const claudeService = new SuperAgentConversations(store, {
    resolveAgent: async () => '/usr/local/bin/claude',
    runClaude: async ({ onEvent }) => {
      await onEvent({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'npm run dev' } }],
        },
      });
      await onEvent({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'bash-1',
            content: '  ➜  Local:   \u001b[36mhttp://localhost:\u001b[1m5174\u001b[22m/\u001b[39m',
          }],
        },
      });
    },
  });
  const claudeChat = await claudeService.create({ engine: 'claude', intent: 'coding', permissionMode: 'auto' });
  await claudeService.start(claudeChat.id, { requestId: 'req-claude-dev-1', mode: 'coding', text: 'Run dev server' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });
  for (let i = 0; i < 60; i++) {
    const snap = await claudeService.get(claudeChat.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  const doneClaude = await claudeService.get(claudeChat.id);
  assert.equal(doneClaude.artifacts.some(a => a.kind === 'web' && a.url === 'http://localhost:5174/'), true);
  await claudeService.close();

  class StreamingCodexRpc {
    onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string) {
      if (method === 'initialize') return { capabilities: {} };
      if (method === 'thread/start') return { thread: { id: 'thr-stream-dev' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.onNotification({
            method: 'item/started',
            params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'npm run dev' } },
          });
          this.onNotification({
            method: 'item/commandExecution/outputDelta',
            params: { itemId: 'cmd-1', delta: 'Local: http://localhost:5175/\n' },
          });
          this.onNotification({
            method: 'turn/completed',
            params: { turn: { id: 'turn-stream-dev', status: 'completed' } },
          });
        });
        return { turn: { id: 'turn-stream-dev' } };
      }
      return {};
    }
    send() {}
    close() {}
  }

  const codexService = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: StreamingCodexRpc as unknown as typeof AssetAgentRpc,
  });
  const codexChat = await codexService.create({ engine: 'codex', intent: 'coding', permissionMode: 'auto' });
  await codexService.start(codexChat.id, { requestId: 'req-codex-dev-1', mode: 'coding', text: 'Start dev server' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });
  for (let i = 0; i < 60; i++) {
    const snap = await codexService.get(codexChat.id);
    if (snap.state === 'idle' || snap.state === 'failed') break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  const doneCodex = await codexService.get(codexChat.id);
  assert.equal(doneCodex.artifacts.some(a => a.kind === 'web' && a.url === 'http://localhost:5175/'), true);
  await codexService.close();
}));

test('shared preview-bridge injects safely under strict CSP on Design/Game previews and preview-snapshot blocks SSRF paths', () => fixture(async store => {
  assert.equal(isValidPreviewBridgeToken('omb_valid1234'), true);
  assert.equal(isValidPreviewBridgeToken('bad'), false);
  assert.equal(isValidPreviewBridgeToken('bad<script>'), false);

  const injected = injectPreviewBridgeHtml('<html><body><div id="app">Hi</div></body></html>\n', 'omb_valid1234').toString('utf8');
  assert.ok(injected.includes('data-om-preview-bridge'));
  assert.ok(injected.includes("'__reactFiber$'"));
  const scriptMatch = /<script data-om-preview-bridge>\s*([\s\S]*?)\s*<\/script>/.exec(injected);
  assert.ok(scriptMatch?.[1]);
  assert.doesNotThrow(() => new Function(scriptMatch![1]));
  assert.ok(injected.includes('om:preview-pick'));
  assert.ok(injected.includes('om:preview-console'));
  assert.ok(injected.includes('om:preview-capture'));

  const uninjected = injectPreviewBridgeHtml('<html><body>Hi</body></html>', 'bad!').toString('utf8');
  assert.equal(uninjected, '<html><body>Hi</body></html>');

  // Verify designHttp ?omBridge= preserves sandbox CSP
  const dproj = await designProjectsFor(store.directory).create({ scenario: 'prototype', title: 'Bridge Web', requestId: 'req-dbridge-1' });
  let dStatus = 0;
  let dHeaders: Record<string, unknown> = {};
  let dBody = Buffer.alloc(0);
  const dHandled = await designHttp(
    { method: 'GET', headers: {} } as any,
    {
      writeHead(code: number, headers: Record<string, unknown>) { dStatus = code; dHeaders = headers; },
      end(chunk: Buffer | string) { dBody = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); },
    } as any,
    new URL(`http://127.0.0.1:4173/api/design/raw/${encodeURIComponent(dproj.id)}/index.html?omBridge=omb_valid1234`),
    store.directory,
    'http://127.0.0.1:4173',
    async () => ({}),
  );
  assert.equal(dHandled, true);
  assert.equal(dStatus, 200);
  assert.ok(String(dHeaders['Content-Security-Policy']).includes('sandbox allow-scripts'));
  assert.ok(dBody.toString('utf8').includes('data-om-preview-bridge'));

  // Verify gameHttp ?omBridge= preserves strict CSP & accurate Content-Length
  const createdGame = await gameProjectsFor(store.directory, pluginRoot).create({ prompt: 'Bridge game check', multiplayer: false });
  let gStatus = 0;
  let gHeaders: Record<string, unknown> = {};
  let gBody = Buffer.alloc(0);
  const gHandled = await gameHttp(
    { method: 'GET', headers: {} } as any,
    {
      writeHead(code: number, headers: Record<string, unknown>) { gStatus = code; gHeaders = headers; },
      end(chunk: Buffer | string) { gBody = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); },
    } as any,
    new URL(`http://127.0.0.1:4173/api/games/${encodeURIComponent(createdGame.game.id)}/play/index.html?omBridge=omb_valid1234`),
    store.directory,
    async () => ({}),
  );
  assert.equal(gHandled, true);
  assert.equal(gStatus, 200);
  assert.equal(Number(gHeaders['Content-Length']), gBody.length);
  assert.ok(String(gHeaders['Content-Security-Policy']).includes("worker-src 'none'"));
  assert.ok(gBody.toString('utf8').includes('data-om-preview-bridge'));

  // Verify preview-snapshot rejects unsafe/external paths
  const req = transport(store);
  const chatRes = await req('/motion-api/super-agent/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine: 'codex', title: 'Snapshot Guard Chat' }),
  });
  const chat = (await chatRes.json()).conversation;
  for (const badPath of ['https://evil.com/index.html', '/motion-api/design/raw/../../etc/passwd', '/etc/hosts']) {
    const badRes = await req(`/motion-api/super-agent/chats/${chat.id}/preview-snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: badPath }),
    });
    assert.ok(badRes.status >= 400);
  }
  await superAgentConversations(store).close();
}));

test('SuperAgentConversations marks interrupted shutdown runs failed and resets tool activity phase back to thinking', () => fixture(async store => {
  const phase1 = new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });

  let releaseTurn!: () => void;
  const turnBlocked = new Promise<void>(resolve => { releaseTurn = resolve; });
  const observedPhases: string[] = [];

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/agy',
    runAcp: async opts => {
      await opts.callbacks.onStatus('connecting', 'Antigravity');
      await opts.callbacks.onToolStarted({
        callId: 'c1',
        tool: 'openmotion_read_workflow',
        label: 'Read workflow guidance',
        status: 'running',
        category: 'mcp',
        startedAt: Date.now(),
      });
      await opts.callbacks.onToolFinished({
        callId: 'c1',
        tool: 'openmotion_read_workflow',
        label: 'Read workflow guidance',
        status: 'completed',
        category: 'mcp',
        startedAt: Date.now() - 50,
        finishedAt: Date.now(),
        durationMs: 50,
      }, { ok: true }, {});
      await opts.callbacks.onReasoningDelta('r1', 'Considering racing layout...');
      const midSnap = await service.get(chat.id);
      if (midSnap.turnActivity?.phase) observedPhases.push(midSnap.turnActivity.phase);
      await Promise.race([
        turnBlocked,
        new Promise<void>(resolve => opts.signal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
    },
  });

  const chat = await service.create({ engine: 'antigravity', intent: 'game', permissionMode: 'auto' });
  await service.start(chat.id, { requestId: 'req-agy-close-1', text: 'Build racing game' }, {
    origin: 'http://127.0.0.1:4173',
    phase1: () => phase1,
  });

  for (let i = 0; i < 60; i++) {
    if (observedPhases.length > 0) break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.deepEqual(observedPhases, ['thinking']);

  await service.close();
  releaseTurn();

  const reloaded = new SuperAgentConversations(store);
  const afterClose = await reloaded.get(chat.id);
  assert.equal(afterClose.state, 'failed');
  assert.match(afterClose.error || '', /Server restarted while the Agent was running/);
  await reloaded.close();
}));
