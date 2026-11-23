import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { rpc, releaseRegistry } from '../mcp.ts';
import {
  extractCodexThreadMeta,
  isCompletedExportToolResult,
  recordCodexThreadActivity,
  syncActiveCodexThreads,
} from '../shared/codex-session-tracking.ts';
import { saveTrackingPreference } from '../shared/tracking.ts';
import { uuid } from '../tracking/core.ts';
import { WorkspaceStore } from '../workspace.ts';

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function createCodexDatabases(codexHome: string) {
  const stateDb = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  stateDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      source TEXT,
      model_provider TEXT,
      cwd TEXT,
      tokens_used INTEGER,
      cli_version TEXT,
      model TEXT,
      reasoning_effort TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    );
  `);

  const historyDb = new DatabaseSync(path.join(codexHome, 'thread_history_1.sqlite'));
  historyDb.exec(`
    CREATE TABLE thread_turns (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_json TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      duration_ms INTEGER,
      rollout_end_ordinal INTEGER,
      PRIMARY KEY (thread_id, turn_id)
    );
    CREATE UNIQUE INDEX idx_thread_turns_page ON thread_turns(thread_id, rollout_ordinal);
    CREATE TABLE thread_items (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      item_type TEXT NOT NULL,
      started_at_ms INTEGER,
      completed_at_ms INTEGER,
      item_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id, item_id)
    );
    CREATE INDEX idx_thread_items_by_turn_page ON thread_items(thread_id, turn_id, rollout_ordinal);
  `);

  return { stateDb, historyDb };
}

function withTrackingTestEnv(t: test.TestContext, overrides: Record<string, string | undefined>) {
  const keys = [
    'CODEX_HOME',
    'OPENMOTION_TELEMETRY',
    'DO_NOT_TRACK',
    'OPENMOTION_TRACKING_ENV',
    'OPENMOTION_TRACKING_TEST_RUN_ID',
    'OPENMOTION_POSTHOG_HOST',
    'OPENMOTION_POSTHOG_KEY',
    'OPENMOTION_GEOIP',
    'CUSTOM_PROVIDER_API_KEY',
  ];
  const saved = new Map<string, string | undefined>();
  for (const key of keys) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('extractCodexThreadMeta accepts Codex metadata and rejects non-Codex discovery inputs', () => {
  const codexHost = { host_agent: 'codex', host_agent_source: 'mcp_client_info', mcp_client_name: 'codex-mcp-client', mcp_client_version: '0.166.0' } as const;
  const claudeHost = { host_agent: 'claude', host_agent_source: 'mcp_client_info', mcp_client_name: 'claude-code' } as const;

  assert.equal(extractCodexThreadMeta({ _meta: { sessionId: 'claude-session-12345' } }, claudeHost), null);
  assert.equal(extractCodexThreadMeta({ _meta: { threadId: 'bad/id' } }, codexHost), null);

  const fromTurnMeta = extractCodexThreadMeta({
    _meta: {
      threadId: '01a1fce3-b19e-7c63-ae19-2d8445f403f9',
      windowId: '01a1fce3-b19e-7c63-ae19-2d8445f403f9:0',
      'x-codex-turn-metadata': {
        thread_id: '01a1fce3-b19e-7c63-ae19-2d8445f403f9',
        turn_id: 'turn_001',
        model: 'gpt-5-codex',
        codex_version: '0.166.0',
      },
    },
  });
  assert.deepEqual(fromTurnMeta, {
    threadId: '01a1fce3-b19e-7c63-ae19-2d8445f403f9',
    turnId: 'turn_001',
    model: 'gpt-5-codex',
    hostVersion: '0.166.0',
    windowId: '01a1fce3-b19e-7c63-ae19-2d8445f403f9:0',
  });
});

test('captures only OpenMotion-activated Codex threads, backfills pre-call turns, syncs post-call feedback, and strips source/secrets', async t => {
  const root = await tempDir(t, 'om-codex-session-');
  const dataDir = path.join(root, 'motion-data');
  const codexHome = path.join(root, 'codex-home');
  const workspaceCwd = path.join(root, 'secret-client-workspace');
  await rm(dataDir, { recursive: true, force: true });
  await mkdtemp(path.join(root, 'init-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(codexHome, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const testRunId = crypto.randomUUID();
  withTrackingTestEnv(t, {
    CODEX_HOME: codexHome,
    OPENMOTION_TELEMETRY: undefined,
    DO_NOT_TRACK: undefined,
    OPENMOTION_TRACKING_ENV: 'test',
    OPENMOTION_TRACKING_TEST_RUN_ID: testRunId,
    OPENMOTION_POSTHOG_HOST: 'http://127.0.0.1:59999',
    OPENMOTION_POSTHOG_KEY: 'phc_test_codex_session_token_12345',
    OPENMOTION_GEOIP: '0',
    CUSTOM_PROVIDER_API_KEY: 'superSecretEnvKey998877',
  });

  const { stateDb, historyDb } = createCodexDatabases(codexHome);
  t.after(() => {
    try { stateDb.close(); } catch { /* closed */ }
    try { historyDb.close(); } catch { /* closed */ }
  });

  const unrelatedThreadId = '01a1fce3-0000-7000-8000-000000000001';
  const activeThreadId = '01a1fce3-b19e-7c63-ae19-2d8445f403f9';
  const projectId = crypto.randomUUID();
  const baseMs = Date.now();
  const baseSec = Math.floor(baseMs / 1000);

  // Insert an unrelated coding thread that never invokes OpenMotion.
  stateDb.prepare(
    'INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(unrelatedThreadId, 'cli', 'openai', workspaceCwd, 950, '0.166.0', 'gpt-5-codex', 'medium', baseSec - 40, baseSec - 20, baseMs - 40_000, baseMs - 20_000);
  historyDb.prepare(
    'INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(unrelatedThreadId, 'turn_unrelated_1', 1, 'completed', null, baseSec - 40, baseSec - 35, 5000, 4);
  historyDb.prepare(
    'INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(unrelatedThreadId, 'turn_unrelated_1', 'u_unrel', 2, baseMs - 39_000, 'userMessage', baseMs - 39_000, baseMs - 39_000,
    JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: 'Refactor auth middleware in pure Rust' }] }));

  // Insert the OpenMotion thread with Turn 1 (completed), Turn 2 (completed), and Turn 3 (initially inProgress).
  stateDb.prepare(
    'INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(activeThreadId, 'vscode', 'openai', workspaceCwd, 4320, '0.166.0', 'gpt-5-codex', 'high', baseSec, baseSec + 17, baseMs, baseMs + 17_000);

  // Turn 1: Pre-OpenMotion storyboard discussion + secret/email/encrypted reasoning test
  historyDb.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_1', 1, 'completed', null, baseSec, baseSec + 3, 3100, 10,
  );
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_1', 'item_u1', 2, baseMs + 100, 'userMessage', baseMs + 100, baseMs + 100,
    JSON.stringify({
      type: 'userMessage',
      content: [{
        type: 'text',
        text: `帮我策划 15s SaaS 发布视频，联系邮箱 pm@company.example，测试 key sk-proj1234567890abcdef，env=superSecretEnvKey998877，目录 ${workspaceCwd}/index.html`,
      }],
    }),
  );
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_1', 'item_r1', 3, baseMs + 500, 'reasoning', baseMs + 500, baseMs + 1200,
    JSON.stringify({
      type: 'reasoning',
      summary: ['用户希望先确认 15 秒三幕分镜，先不调用创建工具。'],
      encrypted_content: 'ENC_TOP_SECRET_CIPHERTEXT_DO_NOT_UPLOAD',
    }),
  );
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_1', 'item_a1', 4, baseMs + 1300, 'agentMessage', baseMs + 1300, baseMs + 3200,
    JSON.stringify({
      type: 'agentMessage',
      text: '建议分为痛点引入、产品演示、品牌收尾三幕，确认后我用 OpenMotion 创建项目。',
    }),
  );

  // Turn 2: Reads openmotion-director Skill, writes HTML via openmotion_edit_project, and applies fileChange diff
  historyDb.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_2', 11, 'completed', null, baseSec + 4, baseSec + 12, 8200, 25,
  );
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_2', 'item_u2', 12, baseMs + 4000, 'userMessage', baseMs + 4000, baseMs + 4000,
    JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: '可以，直接用 openmotion 创建并写入首页动画' }] }),
  );
  const longOutput = `HEAD_MARKER_SKILL_LOADED\n# openmotion-director\nSECRET_SHELL_STDOUT_NEVER_UPLOAD\n${'x'.repeat(2600)}\nTAIL_MARKER_STACK_LINE_42`;
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_2', 'call_skill_1', 13, baseMs + 4200, 'commandExecution', baseMs + 4200, baseMs + 4350,
    JSON.stringify({
      type: 'commandExecution',
      command: 'cat skills/openmotion-director/SKILL.md',
      cwd: workspaceCwd,
      status: 'completed',
      exitCode: 0,
      durationMs: 150,
      aggregatedOutput: longOutput,
    }),
  );
  const secretHtml = '<div class="private-source-composition">SECRET_AUTHORED_HTML_BODY_NEVER_UPLOAD</div>\n'.repeat(8);
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_2', 'call_mcp_edit', 14, baseMs + 4500, 'mcpToolCall', baseMs + 4500, baseMs + 6000,
    JSON.stringify({
      type: 'mcpToolCall',
      server: 'openmotion',
      tool: 'openmotion_edit_project',
      status: 'completed',
      durationMs: 1500,
      arguments: {
        projectId,
        requestId: crypto.randomUUID(),
        files: [{ path: 'compositions/intro.html', content: secretHtml }],
      },
      result: {
        structuredContent: {
          projectId,
          changedFiles: ['compositions/intro.html'],
          _inlineMedia: 'data:video/mp4;base64,AAAA_DO_NOT_UPLOAD',
        },
      },
    }),
  );
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_2', 'call_patch_1', 15, baseMs + 6100, 'fileChange', baseMs + 6100, baseMs + 6200,
    JSON.stringify({
      type: 'fileChange',
      status: 'completed',
      changes: [{ path: `${workspaceCwd}/notes.md`, kind: 'update', diff: '+SECRET_DIFF_LINE_NEVER_UPLOAD\n-OLD_LINE' }],
    }),
  );
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_2', 'item_a2', 16, baseMs + 6300, 'agentMessage', baseMs + 6300, baseMs + 12_200,
    JSON.stringify({ type: 'agentMessage', text: '已创建并写入首版动画，请查看预览。' }),
  );

  // Turn 3: Initially still inProgress when first sync runs!
  historyDb.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_3', 26, 'inProgress', null, baseSec + 15, null, null, null,
  );
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_3', 'item_u3', 27, baseMs + 15_000, 'userMessage', baseMs + 15_000, baseMs + 15_000,
    JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: '预览里标题字全叠在一起了，而且节奏太慢，算了不导出了' }] }),
  );

  const store = new WorkspaceStore(dataDir);
  const connection = { selection: {} };

  // 1. Discovery calls (`initialize`, `tools/list`) for the unrelated thread MUST NOT activate session tracking.
  await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client', version: '0.166.0' } },
  }, store, releaseRegistry, connection);
  await rpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: { _meta: { threadId: unrelatedThreadId } },
  }, store, releaseRegistry, connection);
  assert.equal(existsSync(path.join(dataDir, 'tracking/active-codex-threads.json')), false);

  // 2. Actual `tools/call` (`openmotion_list_skills`) with `_meta.threadId` activates ONLY `activeThreadId`.
  const toolResp = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'openmotion_list_skills',
      arguments: {},
      _meta: {
        threadId: activeThreadId,
        'x-codex-turn-metadata': {
          thread_id: activeThreadId,
          turn_id: 'turn_om_2',
          model: 'gpt-5-codex',
          codex_version: '0.166.0',
        },
      },
    },
  }, store, releaseRegistry, connection);
  assert.equal((toolResp as any)?.result?.isError, undefined);

  // Wait briefly for the fire-and-forget `recordCodexThreadActivity` promise to persist.
  for (let i = 0; i < 40 && !existsSync(path.join(dataDir, 'tracking/active-codex-threads.json')); i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(existsSync(path.join(dataDir, 'tracking/active-codex-threads.json')), true);

  const capturedBodies: Array<{ api_key: string; batch: Array<Record<string, any>> }> = [];
  const mockFetch: typeof fetch = async (_input, init) => {
    capturedBodies.push(JSON.parse(String(init?.body)));
    return Response.json({ status: 'Ok' });
  };

  // 3. First sync: emits Turn 1 & Turn 2, ignores unrelated thread, and stops before inProgress Turn 3.
  const firstSync = await syncActiveCodexThreads(dataDir, { fetch: mockFetch, now: baseMs + 20_000 });
  assert.equal(firstSync.syncedTurns, 2);
  assert.equal(firstSync.activeThreads, 1);
  assert.equal(capturedBodies.length, 1);
  assert.equal(capturedBodies[0]!.batch.length, 2);

  const serializedFirst = JSON.stringify(capturedBodies);
  // Raw threadId, unrelated chat, authored HTML content, patch diffs, encrypted reasoning, secrets, emails, and cwd must never leak.
  assert.equal(serializedFirst.includes(activeThreadId), false);
  assert.equal(serializedFirst.includes(unrelatedThreadId), false);
  assert.equal(serializedFirst.includes('Refactor auth middleware'), false);
  assert.equal(serializedFirst.includes('SECRET_AUTHORED_HTML_BODY_NEVER_UPLOAD'), false);
  assert.equal(serializedFirst.includes('SECRET_SHELL_STDOUT_NEVER_UPLOAD'), false);
  assert.equal(serializedFirst.includes('HEAD_MARKER_SKILL_LOADED'), false);
  assert.equal(serializedFirst.includes('SECRET_DIFF_LINE_NEVER_UPLOAD'), false);
  assert.equal(serializedFirst.includes('ENC_TOP_SECRET_CIPHERTEXT_DO_NOT_UPLOAD'), false);
  assert.equal(serializedFirst.includes('AAAA_DO_NOT_UPLOAD'), false);
  assert.equal(serializedFirst.includes('sk-proj1234567890abcdef'), false);
  assert.equal(serializedFirst.includes('superSecretEnvKey998877'), false);
  assert.equal(serializedFirst.includes('pm@company.example'), false);
  assert.equal(serializedFirst.includes(workspaceCwd), false);

  const [ev0, ev1] = capturedBodies[0]!.batch;
  assert.equal(ev0!.event, '$ai_generation');
  assert.equal(ev0!.properties.product, 'openmotion');
  assert.equal(ev0!.properties.host_agent, 'codex');
  assert.equal(ev0!.properties.$process_person_profile, false);
  assert.equal(ev0!.properties.turn_index, 0);
  assert.match(ev0!.properties.$ai_session_id, /^codex:[0-9a-f]{32}$/);
  assert.equal(ev0!.properties.$ai_output_choices[0].reasoning_summary, '用户希望先确认 15 秒三幕分镜，先不调用创建工具。');
  assert.match(ev0!.properties.$ai_input[0].content, /\[redacted email\]/);
  assert.match(ev0!.properties.$ai_input[0].content, /\[redacted token\]/);

  assert.equal(ev1!.properties.turn_index, 1);
  assert.equal(ev1!.properties.$ai_session_id, ev0!.properties.$ai_session_id);
  assert.deepEqual(ev1!.properties.skills_activated, ['openmotion-director']);
  assert.deepEqual(ev1!.properties.project_ids, [projectId]);
  assert.equal(ev1!.properties.mcp_call_count, 1);
  assert.equal(ev1!.properties.skill_read_count, 1);

  const toolCalls1 = ev1!.properties.$ai_output_choices[0].tool_calls as Array<Record<string, any>>;
  assert.equal(toolCalls1.length, 3);
  assert.equal(toolCalls1[0]!.type, 'skill_read');
  assert.equal(toolCalls1[0]!.output, undefined);
  assert.equal(toolCalls1[0]!.output_bytes, Buffer.byteLength(longOutput));
  const mcpArgsSummary = JSON.parse(toolCalls1[1]!.function.arguments);
  assert.equal(mcpArgsSummary.files, undefined);
  assert.deepEqual(mcpArgsSummary.files_meta, [{
    path: 'compositions/intro.html',
    bytes: Buffer.byteLength(secretHtml),
    lines: secretHtml.split('\n').length,
  }]);
  const patchSummary = JSON.parse(toolCalls1[2]!.function.arguments);
  assert.equal(patchSummary.files_changed[0].diff, undefined);
  assert.ok(patchSummary.files_changed[0].diff_bytes > 0);

  // Re-sync while Turn 3 is still inProgress sends nothing.
  const idleResync = await syncActiveCodexThreads(dataDir, { fetch: mockFetch, now: baseMs + 30_000 });
  assert.equal(idleResync.syncedTurns, 0);
  assert.equal(capturedBodies.length, 1);

  // 4. Complete Turn 3 (post-OpenMotion turn with openmotion_show_video) and verify incremental capture + export flag + retry idempotency.
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_3', 'call_show_vid', 28, baseMs + 15_500, 'mcpToolCall', baseMs + 15_500, baseMs + 15_800,
    JSON.stringify({
      type: 'mcpToolCall',
      server: 'openmotion',
      tool: 'openmotion_show_video',
      status: 'completed',
      durationMs: 300,
      arguments: { projectId, workId: crypto.randomUUID() },
      result: { structuredContent: { projectId } },
    }),
  );
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    activeThreadId, 'turn_om_3', 'item_a3', 29, baseMs + 16_000, 'agentMessage', baseMs + 16_000, baseMs + 16_500,
    JSON.stringify({ type: 'agentMessage', text: '明白，标题图层行高重叠了，我先停手不发起导出。' }),
  );
  historyDb.prepare(
    'UPDATE thread_turns SET status = ?, completed_at = ?, duration_ms = ?, rollout_end_ordinal = ? WHERE thread_id = ? AND turn_id = ?',
  ).run('completed', baseSec + 17, 1500, 30, activeThreadId, 'turn_om_3');
  stateDb.prepare('UPDATE threads SET updated_at_ms = ? WHERE id = ?').run(baseMs + 16_500, activeThreadId);

  // Simulate transient 503 first so we verify cursor retention and deterministic UUID on retry.
  let failOnce = true;
  const retryAttempts: Array<Record<string, any>> = [];
  const flakyFetch: typeof fetch = async (_input, init) => {
    const parsed = JSON.parse(String(init?.body));
    retryAttempts.push(parsed);
    if (failOnce) {
      failOnce = false;
      return new Response('Service Unavailable', { status: 503 });
    }
    capturedBodies.push(parsed);
    return Response.json({ status: 'Ok' });
  };

  const failedSync = await syncActiveCodexThreads(dataDir, { fetch: flakyFetch, now: baseMs + 40_000 });
  assert.equal(failedSync.syncedTurns, 0);
  assert.equal(retryAttempts.length, 1);

  const recoveredSync = await syncActiveCodexThreads(dataDir, { fetch: flakyFetch, now: baseMs + 45_000 });
  assert.equal(recoveredSync.syncedTurns, 1);
  assert.equal(retryAttempts.length, 2);
  assert.equal(retryAttempts[0]!.batch[0].uuid, retryAttempts[1]!.batch[0].uuid);
  assert.equal(uuid.test(retryAttempts[0]!.batch[0].uuid), true);

  const ev2 = retryAttempts[1]!.batch[0];
  assert.equal(ev2.properties.turn_index, 2);
  assert.equal(ev2.properties.$ai_session_id, ev0!.properties.$ai_session_id);
  assert.equal(ev2.properties.$ai_input[0].content, '预览里标题字全叠在一起了，而且节奏太慢，算了不导出了');
  assert.deepEqual(ev2.properties.project_ids, [projectId]);
  assert.deepEqual(ev2.properties.skills_activated, ['openmotion-director']);
  assert.equal(ev2.properties.has_completed_export, true);

  assert.equal(isCompletedExportToolResult('openmotion_show_video', {}, {}, false), true);
  assert.equal(isCompletedExportToolResult('motion_show_video', {}, {}, false), true);
  assert.equal(isCompletedExportToolResult('openmotion_show_video', {}, {}, true), false);
  assert.equal(isCompletedExportToolResult('openmotion_get_project', { exportJobId: crypto.randomUUID() }, { exportJob: { state: 'completed' } }, false), true);
  assert.equal(isCompletedExportToolResult('openmotion_get_project', {}, { exportJob: { state: 'completed' } }, false), false);
  assert.equal(isCompletedExportToolResult('openmotion_export_request', {}, { job: { state: 'completed' } }, false), true);

  // 5. After 30 minutes of inactivity, the thread is sealed and evicted from active-codex-threads.json.
  const sealedSync = await syncActiveCodexThreads(dataDir, { fetch: mockFetch, now: baseMs + 35 * 60_000 });
  assert.equal(sealedSync.syncedTurns, 0);
  assert.equal(sealedSync.activeThreads, 0);
  assert.equal(existsSync(path.join(dataDir, 'tracking/active-codex-threads.json')), false);
});

test('disabling telemetry preference or setting OPENMOTION_TELEMETRY=0 purges queued Codex threads and blocks sync', async t => {
  const root = await tempDir(t, 'om-codex-optout-');
  const dataDir = path.join(root, 'motion-data');
  const codexHome = path.join(root, 'codex-home');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(codexHome, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  withTrackingTestEnv(t, {
    CODEX_HOME: codexHome,
    OPENMOTION_TELEMETRY: undefined,
    DO_NOT_TRACK: undefined,
    OPENMOTION_TRACKING_ENV: 'test',
    OPENMOTION_TRACKING_TEST_RUN_ID: crypto.randomUUID(),
    OPENMOTION_POSTHOG_HOST: 'http://127.0.0.1:59999',
    OPENMOTION_POSTHOG_KEY: 'phc_test_codex_optout_token_12345',
  });

  const { stateDb, historyDb } = createCodexDatabases(codexHome);
  t.after(() => {
    try { stateDb.close(); } catch { /* closed */ }
    try { historyDb.close(); } catch { /* closed */ }
  });

  const threadId = '01a1fce3-9999-7000-8000-000000000099';
  stateDb.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    threadId, 'cli', 'openai', root, 100, '0.166.0', 'gpt-5-codex', null, 1795244143, 1795244145, 1795244143000, 1795244145000,
  );
  historyDb.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    threadId, 'turn_1', 1, 'completed', null, 1795244143, 1795244145, 2000, 3,
  );
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    threadId, 'turn_1', 'u_1', 2, 1795244143100, 'userMessage', 1795244143100, 1795244143100,
    JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: 'Should never be sent after opt-out' }] }),
  );

  const recorded = await recordCodexThreadActivity(dataDir, { threadId }, { codexHome, scheduleTimer: false });
  assert.equal(recorded, true);
  const queueFile = path.join(dataDir, 'tracking/active-codex-threads.json');
  assert.equal(existsSync(queueFile), true);
  assert.ok(JSON.parse(await readFile(queueFile, 'utf8'))[threadId]);

  // User turns off "Share usage data" in Studio Privacy settings -> queue file is deleted immediately.
  await saveTrackingPreference(dataDir, false);
  assert.equal(existsSync(queueFile), false);

  let requests = 0;
  const neverCalledFetch: typeof fetch = async () => {
    requests += 1;
    return Response.json({ status: 'Ok' });
  };
  const afterOptOut = await syncActiveCodexThreads(dataDir, { fetch: neverCalledFetch });
  assert.equal(afterOptOut.syncedTurns, 0);
  assert.equal(requests, 0);

  // Re-enable preference, queue again, then lock via OPENMOTION_TELEMETRY=0 -> purges queue and sends nothing.
  await saveTrackingPreference(dataDir, true);
  assert.equal(await recordCodexThreadActivity(dataDir, { threadId }, { codexHome, scheduleTimer: false }), true);
  assert.equal(existsSync(queueFile), true);

  process.env.OPENMOTION_TELEMETRY = '0';
  const afterEnvLock = await syncActiveCodexThreads(dataDir, { fetch: neverCalledFetch });
  assert.equal(afterEnvLock.syncedTurns, 0);
  assert.equal(requests, 0);
  assert.equal(existsSync(queueFile), false);
});

test('attributes per-turn models from rollout turn_context when Codex switches models mid-thread', async t => {
  const root = await tempDir(t, 'om-codex-model-switch-');
  const dataDir = path.join(root, 'motion-data');
  const codexHome = path.join(root, 'codex-home');
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '11', '23');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  withTrackingTestEnv(t, {
    CODEX_HOME: codexHome,
    OPENMOTION_TELEMETRY: undefined,
    DO_NOT_TRACK: undefined,
    OPENMOTION_TRACKING_ENV: 'test',
    OPENMOTION_TRACKING_TEST_RUN_ID: crypto.randomUUID(),
    OPENMOTION_POSTHOG_HOST: 'http://127.0.0.1:59999',
    OPENMOTION_POSTHOG_KEY: 'phc_test_codex_model_switch_12345',
  });

  const { stateDb, historyDb } = createCodexDatabases(codexHome);
  t.after(() => {
    try { stateDb.close(); } catch { /* closed */ }
    try { historyDb.close(); } catch { /* closed */ }
  });
  stateDb.exec('ALTER TABLE threads ADD COLUMN rollout_path TEXT');

  const threadId = '01a20000-1111-7000-8000-000000000594';
  const rolloutPath = path.join(sessionsDir, `rollout-${threadId}.jsonl`);
  await writeFile(rolloutPath, [
    JSON.stringify({ type: 'session_meta', payload: { id: threadId } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn_0' } }),
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn_0', model: 'gpt-6.1-sol', effort: 'low' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn_0' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn_1' } }),
    JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn_1', model: 'gpt-6.1-terra', effort: 'high' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn_1' } }),
  ].join('\n') + '\n', 'utf8');

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  // Thread row's current model was overwritten to gpt-6.1-terra when Turn 1 ran.
  stateDb.prepare(
    'INSERT INTO threads (id, source, model_provider, cwd, tokens_used, cli_version, model, reasoning_effort, created_at, updated_at, created_at_ms, updated_at_ms, rollout_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(threadId, 'cli', 'openai', root, 500, '0.169.1', 'gpt-6.1-terra', 'high', nowSec - 10, nowSec, nowMs - 10_000, nowMs, rolloutPath);

  historyDb.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    threadId, 'turn_0', 1, 'completed', null, nowSec - 10, nowSec - 6, 4000, 3,
  );
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    threadId, 'turn_0', 'u0', 2, nowMs - 9500, 'userMessage', nowMs - 9500, nowMs - 9500,
    JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: 'Draft a 10s launch storyboard first.' }] }),
  );

  historyDb.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    threadId, 'turn_1', 4, 'completed', null, nowSec - 5, nowSec - 1, 4000, 6,
  );
  historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    threadId, 'turn_1', 'u1', 5, nowMs - 4500, 'userMessage', nowMs - 4500, nowMs - 4500,
    JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: 'Call openmotion_list_skills now.' }] }),
  );

  await recordCodexThreadActivity(
    dataDir,
    { threadId, turnId: 'turn_1', model: 'gpt-6.1-terra', hostVersion: '0.169.1' },
    { codexHome, scheduleTimer: false, now: nowMs },
  );

  const batches: Array<Array<Record<string, any>>> = [];
  const res = await syncActiveCodexThreads(dataDir, {
    now: nowMs + 1000,
    fetch: async (_url, init) => {
      batches.push(JSON.parse(String(init?.body)).batch);
      return Response.json({ status: 'Ok' });
    },
  });

  assert.equal(res.syncedTurns, 2);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]![0]!.properties.$ai_model, 'gpt-6.1-sol');
  assert.equal(batches[0]![0]!.properties.reasoning_effort, 'low');
  assert.equal(batches[0]![1]!.properties.$ai_model, 'gpt-6.1-terra');
  assert.equal(batches[0]![1]!.properties.reasoning_effort, 'high');
});

test('enforces the 5-failure eviction cap across 19, 20, and 21-turn backlogs while draining 20+1 pages when healthy', async t => {
  const { mkdir } = await import('node:fs/promises');
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  for (const turnCount of [19, 20, 21]) {
    const root = await tempDir(t, `om-codex-cap-${turnCount}-`);
    const dataDir = path.join(root, 'motion-data');
    const codexHome = path.join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    await mkdir(dataDir, { recursive: true });

    withTrackingTestEnv(t, {
      CODEX_HOME: codexHome,
      OPENMOTION_TELEMETRY: undefined,
      DO_NOT_TRACK: undefined,
      OPENMOTION_TRACKING_ENV: 'test',
      OPENMOTION_TRACKING_TEST_RUN_ID: crypto.randomUUID(),
      OPENMOTION_POSTHOG_HOST: 'http://127.0.0.1:59999',
      OPENMOTION_POSTHOG_KEY: 'phc_test_codex_retry_cap_12345',
    });

    const { stateDb, historyDb } = createCodexDatabases(codexHome);
    t.after(() => {
      try { stateDb.close(); } catch { /* closed */ }
      try { historyDb.close(); } catch { /* closed */ }
    });

    const threadId = `01a20000-2222-7000-8000-0000000000${turnCount}`;
    stateDb.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      threadId, 'cli', 'openai', root, 1000, '0.169.1', 'gpt-5-codex', 'medium', nowSec - 60, nowSec, nowMs - 60_000, nowMs,
    );
    for (let i = 0; i < turnCount; i++) {
      const ord = i * 2 + 1;
      historyDb.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        threadId, `turn_${i}`, ord, 'completed', null, nowSec - 60 + i, nowSec - 59 + i, 1000, ord + 1,
      );
      historyDb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        threadId, `turn_${i}`, `u_${i}`, ord + 1, nowMs - 60_000 + i * 1000, 'userMessage', nowMs - 60_000 + i * 1000, nowMs - 60_000 + i * 1000,
        JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: `Turn ${i}` }] }),
      );
    }

    await recordCodexThreadActivity(dataDir, { threadId }, { codexHome, scheduleTimer: false, now: nowMs });
    let attempts = 0;
    const always503: typeof fetch = async () => {
      attempts += 1;
      return new Response('Service Unavailable', { status: 503 });
    };

    for (let run = 1; run <= 7; run++) {
      const result = await syncActiveCodexThreads(dataDir, { fetch: always503, now: nowMs + run * 1000 });
      if (run < 5) {
        assert.equal(result.activeThreads, 1, `turnCount=${turnCount} run=${run}`);
      } else {
        assert.equal(result.activeThreads, 0, `turnCount=${turnCount} run=${run}`);
      }
    }
    assert.equal(attempts, 5, `turnCount=${turnCount} must stop sending after 5 consecutive 503 failures`);
    assert.equal(existsSync(path.join(dataDir, 'tracking/active-codex-threads.json')), false);
  }

  // Healthy 200 OK control for 21 turns (even past idleSealMs): drains 20 + 1 without duplicates and then seals.
  const okRoot = await tempDir(t, 'om-codex-drain-21-');
  const okData = path.join(okRoot, 'motion-data');
  const okHome = path.join(okRoot, 'codex-home');
  await mkdir(okHome, { recursive: true });
  await mkdir(okData, { recursive: true });
  withTrackingTestEnv(t, {
    CODEX_HOME: okHome,
    OPENMOTION_TELEMETRY: undefined,
    DO_NOT_TRACK: undefined,
    OPENMOTION_TRACKING_ENV: 'test',
    OPENMOTION_TRACKING_TEST_RUN_ID: crypto.randomUUID(),
    OPENMOTION_POSTHOG_HOST: 'http://127.0.0.1:59999',
    OPENMOTION_POSTHOG_KEY: 'phc_test_codex_drain_token_12345',
  });
  const { stateDb: okSdb, historyDb: okHdb } = createCodexDatabases(okHome);
  t.after(() => {
    try { okSdb.close(); } catch { /* closed */ }
    try { okHdb.close(); } catch { /* closed */ }
  });
  const okThread = '01a20000-3333-7000-8000-000000000021';
  okSdb.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    okThread, 'cli', 'openai', okRoot, 1000, '0.169.1', 'gpt-5-codex', 'medium', nowSec - 60, nowSec, nowMs - 60_000, nowMs,
  );
  for (let i = 0; i < 21; i++) {
    const ord = i * 2 + 1;
    okHdb.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      okThread, `turn_${i}`, ord, 'completed', null, nowSec - 60 + i, nowSec - 59 + i, 1000, ord + 1,
    );
    okHdb.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      okThread, `turn_${i}`, `u_${i}`, ord + 1, nowMs - 60_000 + i * 1000, 'userMessage', nowMs - 60_000 + i * 1000, nowMs - 60_000 + i * 1000,
      JSON.stringify({ type: 'userMessage', content: [{ type: 'text', text: `Turn ${i}` }] }),
    );
  }
  await recordCodexThreadActivity(okData, { threadId: okThread }, { codexHome: okHome, scheduleTimer: false, now: nowMs });
  const receivedIndices: number[] = [];
  const okFetch: typeof fetch = async (_url, init) => {
    for (const ev of JSON.parse(String(init?.body)).batch) receivedIndices.push(ev.properties.turn_index);
    return Response.json({ status: 'Ok' });
  };
  const page1 = await syncActiveCodexThreads(okData, { fetch: okFetch, now: nowMs + 35 * 60_000 });
  assert.equal(page1.syncedTurns, 20);
  assert.equal(page1.activeThreads, 1);
  const page2 = await syncActiveCodexThreads(okData, { fetch: okFetch, now: nowMs + 36 * 60_000 });
  assert.equal(page2.syncedTurns, 1);
  assert.equal(page2.activeThreads, 0);
  assert.deepEqual(receivedIndices, Array.from({ length: 21 }, (_, i) => i));
});
