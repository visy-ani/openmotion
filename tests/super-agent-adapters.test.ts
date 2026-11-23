import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Phase1Service } from '../phase1.ts';
import { pluginRoot } from '../hyperframes.ts';
import {
  buildUnifiedDiffPreview,
  classifySuperAgentTool,
  countUnifiedDiffStats,
  detectIntentFromPrompt,
  generateSuperAgentTitle,
  inferSuperAgentIntent,
  modeToSuperAgentIntent,
  superAgentIntentMeta,
} from '../shared/super-agent.ts';
import { SuperAgentConversations } from '../gateway/super-agent.ts';
import { AssetAgentRpc } from '../gateway/asset-chat.ts';
import { fixture } from './fixtures.ts';

function fakePhase1(store: any) {
  return new Phase1Service(store, pluginRoot, {
    origin: () => 'http://127.0.0.1:4173',
    nativeUrl: () => undefined,
    openProject: async () => {},
    mutation: async fn => fn(),
    cancel: async () => ({ id: 'x', state: 'cancelled' } as any),
  });
}

test('classifySuperAgentTool and unified diff helpers normalize Codex, Claude, Antigravity, and ACP tools', () => {
  const diff = buildUnifiedDiffPreview('const a = 1;\nconst b = 2;\n', 'const a = 1;\nconst b = 3;\nconst c = 4;\n');
  assert.equal(diff.addedLines, 2);
  assert.equal(diff.removedLines, 1);
  assert.match(diff.diffPreview, /\+const c = 4;/);
  assert.deepEqual(countUnifiedDiffStats('--- a\n+++ b\n@@ -1,1 +1,2 @@\n-old\n+new1\n+new2\n'), {
    addedLines: 2,
    removedLines: 1,
  });

  const cmd = classifySuperAgentTool('Bash', { command: 'npm test', description: 'Run unit tests' });
  assert.equal(cmd.category, 'command');
  assert.equal(cmd.command, 'npm test');
  assert.equal(cmd.label, 'Run unit tests');

  const writeOp = classifySuperAgentTool('write_to_file', { TargetFile: '/tmp/notes.md', CodeContent: 'line1\nline2' });
  assert.equal(writeOp.category, 'file_write');
  assert.equal(writeOp.label, 'Created notes.md');
  assert.equal(writeOp.fileOp?.action, 'create');
  assert.equal(writeOp.fileOp?.addedLines, 2);

  const editOp = classifySuperAgentTool('Edit', { file_path: '/tmp/app.ts', old_string: 'x = 1', new_string: 'x = 2\ny = 3' });
  assert.equal(editOp.category, 'file_edit');
  assert.equal(editOp.label, 'Edited app.ts');
  assert.equal(editOp.fileOp?.addedLines, 2);
  assert.equal(editOp.fileOp?.removedLines, 1);

  const acpDiff = classifySuperAgentTool('replace_file_content', {}, {
    kind: 'edit',
    title: 'Updated card CSS',
    diffs: [{ path: 'card.css', oldText: '.a { color: red; }', newText: '.a { color: blue; }\n.b { gap: 4px; }' }],
  });
  assert.equal(acpDiff.category, 'file_edit');
  assert.equal(acpDiff.files?.[0]?.path, 'card.css');
  assert.equal(acpDiff.files?.[0]?.addedLines, 2);
  assert.equal(acpDiff.files?.[0]?.removedLines, 1);

  const mcp = classifySuperAgentTool('mcp__openmotion__openmotion_design_project', { action: 'create', title: 'Landing' });
  assert.equal(mcp.category, 'mcp');
  assert.equal(mcp.label, 'Created HTML design project');

  const acpMcpSingle = classifySuperAgentTool('mcp_openmotion_openmotion_design_edit', { action: 'write', path: 'index.html', content: '<h1/>' });
  assert.equal(acpMcpSingle.category, 'file_edit');
  assert.equal(acpMcpSingle.label, 'Updated HTML/CSS/JS source');
  assert.equal(acpMcpSingle.summary, 'index.html');
});

test('SuperAgentConversations executes ACP Agent end-to-end with mcp-http-relay, diffs, plans, permission gate, and usage', () => fixture(async store => {
  const scriptDir = await mkdtemp(path.join(os.tmpdir(), 'openmotion-acp-mock-'));
  const acpBin = path.join(scriptDir, 'mock-acp.mjs');
  const script = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import readline from 'node:readline';

let mcpCfg = null;
const send = obj => process.stdout.write(JSON.stringify(obj) + '\\n');
const notif = update => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-sess-1', update } });

async function callMcpTool(name, args) {
  if (!mcpCfg) throw new Error('missing mcpCfg');
  const env = { ...process.env };
  for (const item of mcpCfg.env || []) env[item.name] = item.value;
  return await new Promise((resolve, reject) => {
    const child = spawn(mcpCfg.command, mcpCfg.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const responses = [];
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', line => {
      try {
        const msg = JSON.parse(line);
        responses.push(msg);
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) + '\\n');
        } else if (msg.id === 2) {
          child.stdin.end();
          resolve(msg.result);
        }
      } catch {}
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (!responses.some(r => r.id === 2)) reject(new Error('relay exited ' + code + ' ' + out));
    });
    child.stderr.on('data', d => { out += d.toString(); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mock', version: '1.0' } } }) + '\\n');
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pendingPermResolve = null;

async function handleRpc(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false } } });
  } else if (msg.method === 'session/new') {
    mcpCfg = msg.params?.mcpServers?.[0] || null;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'acp-sess-1',
        configOptions: [
          { id: 'model', category: 'model', options: [{ value: 'gemini-3-pro' }] },
          { id: 'thought_level', category: 'thought_level', options: [{ value: 'medium' }] },
        ],
      },
    });
  } else if (msg.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    notif({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Planning file update and Design project creation.' } });
    notif({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Run version command', status: 'in_progress' },
        { content: 'Create Design Studio artifact', status: 'pending' },
      ],
    });
    notif({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-cmd-1',
      name: 'run_command',
      kind: 'execute',
      title: 'Check Node runtime',
      rawInput: { CommandLine: 'node -v' },
      status: 'in_progress',
    });
    const permRes = await new Promise(res => {
      pendingPermResolve = res;
      send({
        jsonrpc: '2.0',
        id: 901,
        method: 'session/request_permission',
        params: {
          toolCall: { toolCallId: 'tc-cmd-1', title: 'Run node -v', kind: 'execute' },
          options: [
            { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
            { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
    });
    notif({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-cmd-1',
      status: permRes?.outcome?.outcome === 'selected' ? 'completed' : 'failed',
      rawOutput: { exitCode: 0, output: 'v26.11.1' },
    });
    notif({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-edit-1',
      name: 'replace_file_content',
      kind: 'edit',
      title: 'Update notes.md',
      locations: [{ path: 'notes.md', line: 1 }],
      status: 'completed',
      content: [{ type: 'diff', path: 'notes.md', oldText: '# Old', newText: '# New\\nDetails' }],
    });

    notif({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-mcp-1',
      name: 'call_mcp_tool',
      title: 'Call MCP openmotion_design_project',
      rawInput: { ToolName: 'openmotion_design_project', Arguments: { action: 'create', scenario: 'prototype', title: 'ACP Relay Demo' } },
      status: 'in_progress',
    });
    const mcpResult = await callMcpTool('openmotion_design_project', {
      action: 'create',
      scenario: 'prototype',
      title: 'ACP Relay Demo',
      requestId: 'req-acp-design-1',
    });
    notif({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-mcp-1',
      status: mcpResult?.isError ? 'failed' : 'completed',
      rawOutput: mcpResult?.content?.[0]?.text || '{}',
    });

    notif({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Run version command', status: 'completed' },
        { content: 'Create Design Studio artifact', status: 'completed' },
      ],
    });
    notif({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '| Check | Result |\\n| --- | --- |\\n| Node | v26.11.1 |\\n' } });
    notif({ sessionUpdate: 'usage_update', inputTokens: 120, outputTokens: 45, totalTokens: 165 });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { total_tokens: 165 } } });
  }
}

rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method && pendingPermResolve) {
    const res = pendingPermResolve;
    pendingPermResolve = null;
    res(msg.result);
    return;
  }
  void handleRpc(msg);
});
`;
  await writeFile(acpBin, script, { mode: 0o755 });

  const service = new SuperAgentConversations(store, {
    resolve: async bin => (bin === 'agy' ? acpBin : null),
  });
  try {
    const chat = await service.create({ engine: 'antigravity', model: 'gemini-3-pro-medium', permissionMode: 'on-request' });
    await service.start(chat.id, { requestId: 'req-acp-1', text: 'Inspect environment and build demo' }, {
      origin: 'http://127.0.0.1:4173',
      phase1: () => fakePhase1(store),
    });

    let done = await service.get(chat.id);
    for (let i = 0; i < 240 && (done.state === 'running' || done.state === 'waiting'); i++) {
      if (done.approvals.length > 0) {
        assert.equal(done.state, 'waiting');
        await service.answer(chat.id, done.approvals[0].id, true);
      }
      await new Promise(r => setTimeout(r, 25));
      done = await service.get(chat.id);
    }

    assert.equal(done.state, 'idle', `Expected idle, got ${done.state} (${done.error || ''})`);
    assert.equal(done.threadId, 'acp-sess-1');
    assert.equal(done.turnActivity, undefined);
    assert.ok(typeof done.lastTurnDurationMs === 'number' && done.lastTurnDurationMs >= 0);
    assert.equal(done.lastTurnUsage?.totalTokens, 165);

    const reasoningMsg = done.messages.find(m => m.role === 'reasoning');
    assert.ok(reasoningMsg && reasoningMsg.status === 'completed');
    assert.match(reasoningMsg.text, /Planning file update/);

    const cmdTool = done.messages.find(m => m.role === 'tool' && m.toolEvent?.category === 'command');
    assert.equal(cmdTool?.toolEvent?.command, 'node -v');
    assert.equal(cmdTool?.toolEvent?.exitCode, 0);
    assert.equal(cmdTool?.toolEvent?.status, 'completed');

    const editTool = done.messages.find(m => m.role === 'tool' && m.toolEvent?.category === 'file_edit');
    assert.equal(editTool?.toolEvent?.fileOp?.path, 'notes.md');
    assert.equal(editTool?.toolEvent?.fileOp?.addedLines, 2);
    assert.equal(editTool?.toolEvent?.fileOp?.removedLines, 1);

    const mcpTool = done.messages.find(m => m.role === 'tool' && m.toolEvent?.tool === 'openmotion_design_project');
    assert.equal(mcpTool?.toolEvent?.status, 'completed');
    assert.ok(mcpTool?.toolEvent?.artifactId);

    assert.ok(done.artifacts.some(a => a.kind === 'design-project' && a.title === 'ACP Relay Demo'));
    assert.ok(done.messages.some(m => m.role === 'assistant' && m.text.includes('| Node | v26.11.1 |')));
  } finally {
    await service.close();
    await rm(scriptDir, { recursive: true, force: true });
  }
}));

test('SuperAgentConversations normalizes Codex reasoning, commandExecution, fileChange, plan, and token usage', () => fixture(async store => {
  class RichCodexRpc {
    onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') return { thread: { id: 'codex-thread-rich' } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.onNotification({ method: 'turn/started', params: {} });
          this.onNotification({ method: 'item/started', params: { item: { id: 'r1', type: 'reasoning' } } });
          this.onNotification({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: 'Checking repository files' } });
          this.onNotification({ method: 'item/completed', params: { item: { id: 'r1', type: 'reasoning', summary: [{ text: 'Checking repository files' }] } } });
          this.onNotification({ method: 'turn/plan/updated', params: { plan: [{ step: 'Edit readme', status: 'completed' }] } });
          this.onNotification({ method: 'item/started', params: { item: { id: 'c1', type: 'commandExecution', command: 'echo ok' } } });
          this.onNotification({ method: 'item/completed', params: { item: { id: 'c1', type: 'commandExecution', command: 'echo ok', exitCode: 0, stdout: 'ok\n', status: 'completed' } } });
          this.onNotification({
            method: 'item/completed',
            params: {
              item: {
                id: 'f1',
                type: 'fileChange',
                status: 'completed',
                changes: [{ path: 'README.md', kind: 'update', diff: '--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n-old\n+new line 1\n+new line 2\n' }],
              },
            },
          });
          this.onNotification({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } } } });
          this.onNotification({ method: 'item/completed', params: { item: { id: 'a1', type: 'agentMessage', text: 'Updated `README.md`.' } } });
          this.onNotification({ method: 'turn/completed', params: { turn: { id: 't1', status: 'completed' } } });
        });
        return { turn: { id: 't1' } };
      }
      return {};
    }
    send() {}
    close() {}
  }

  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/codex',
    rpc: RichCodexRpc as unknown as typeof AssetAgentRpc,
  });
  try {
    const chat = await service.create({ engine: 'codex', permissionMode: 'auto' });
    await service.start(chat.id, { requestId: 'req-codex-rich-1', text: 'Update README' }, {
      origin: 'http://127.0.0.1:4173',
      phase1: () => fakePhase1(store),
    });

    let done = await service.get(chat.id);
    for (let i = 0; i < 60 && done.state === 'running'; i++) {
      await new Promise(r => setTimeout(r, 15));
      done = await service.get(chat.id);
    }

    assert.equal(done.state, 'idle');
    assert.equal(done.lastTurnUsage?.totalTokens, 100);
    assert.ok(done.messages.some(m => m.role === 'reasoning' && m.text.includes('Checking repository files')));
    const cmdMsg = done.messages.find(m => m.role === 'tool' && m.toolEvent?.category === 'command');
    assert.equal(cmdMsg?.toolEvent?.command, 'echo ok');
    assert.equal(cmdMsg?.toolEvent?.exitCode, 0);
    const fileMsg = done.messages.find(m => m.role === 'tool' && m.toolEvent?.tool === 'fileChange');
    assert.equal(fileMsg?.toolEvent?.fileOp?.path, 'README.md');
    assert.equal(fileMsg?.toolEvent?.fileOp?.addedLines, 2);
    assert.equal(fileMsg?.toolEvent?.fileOp?.removedLines, 1);
  } finally {
    await service.close();
  }
}));

test('SuperAgentConversations captures Claude thinking_delta, Bash/Edit classification, and usage', () => fixture(async store => {
  const service = new SuperAgentConversations(store, {
    resolve: async () => '/usr/local/bin/claude',
    runClaude: async ({ onEvent }) => {
      await onEvent({ type: 'system', session_id: 'claude-rich-1' });
      await onEvent({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking', id: 'th-1' } } });
      await onEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Inspecting project structure' } } });
      await onEvent({ type: 'stream_event', event: { type: 'content_block_stop' } });
      await onEvent({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'ls -la', description: 'List directory' } },
          ],
        },
      });
      await onEvent({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-bash', content: 'README.md\n', is_error: false },
          ],
        },
      });
      await onEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Listed workspace files.' }] },
      });
      await onEvent({ type: 'result', is_error: false, usage: { input_tokens: 40, output_tokens: 15 } });
    },
  });

  try {
    const chat = await service.create({ engine: 'claude', permissionMode: 'auto' });
    await service.start(chat.id, { requestId: 'req-claude-rich-1', text: 'List workspace' }, {
      origin: 'http://127.0.0.1:4173',
      phase1: () => fakePhase1(store),
    });

    let done = await service.get(chat.id);
    for (let i = 0; i < 60 && done.state === 'running'; i++) {
      await new Promise(r => setTimeout(r, 15));
      done = await service.get(chat.id);
    }

    assert.equal(done.state, 'idle');
    assert.equal(done.lastTurnUsage?.totalTokens, 55);
    const reasoning = done.messages.find(m => m.role === 'reasoning');
    assert.ok(reasoning?.text.includes('Inspecting project structure'));
    const bashMsg = done.messages.find(m => m.role === 'tool' && m.toolEvent?.tool === 'Bash');
    assert.equal(bashMsg?.toolEvent?.category, 'command');
    assert.equal(bashMsg?.toolEvent?.command, 'ls -la');
    assert.equal(bashMsg?.toolEvent?.status, 'completed');
  } finally {
    await service.close();
  }
}));

test('detectIntentFromPrompt, inferSuperAgentIntent, generateSuperAgentTitle, and superAgentIntentMeta classify tasks cleanly', () => {
  assert.equal(modeToSuperAgentIntent('coding'), 'coding');
  assert.equal(modeToSuperAgentIntent('motion'), 'video');
  assert.equal(modeToSuperAgentIntent('deck'), 'slides');

  assert.equal(detectIntentFromPrompt('Fix the bug in dashboard.tsx'), 'coding');
  assert.equal(detectIntentFromPrompt('帮我写个单元测试检查 parser.ts'), 'coding');
  assert.equal(detectIntentFromPrompt('Build a retro arcade shooter game'), 'game');
  assert.equal(detectIntentFromPrompt('帮我写一个贪吃蛇小游戏'), 'game');
  assert.equal(detectIntentFromPrompt('Design a SaaS pricing landing page'), 'website');
  assert.equal(detectIntentFromPrompt('Create a 6-slide pitch deck'), 'slides');
  assert.equal(detectIntentFromPrompt('Create a 15s motion video launch reel'), 'video');
  assert.equal(detectIntentFromPrompt('Generate a poster image for autumn coffee'), 'image');
  assert.equal(detectIntentFromPrompt('Compose ambient synth music soundtrack'), 'audio');
  assert.equal(detectIntentFromPrompt('Create a brand kit for our studio'), 'brand');
  assert.equal(detectIntentFromPrompt('What is the capital of France?'), 'chat');

  // Artifact intent overrides earlier generic chat state
  assert.equal(
    inferSuperAgentIntent({
      intent: 'chat',
      artifacts: [{ id: 'a1', kind: 'design-project', scenario: 'prototype', title: 'Landing Demo', createdAt: 1, updatedAt: 1 }],
      messages: [{ id: 'm1', role: 'user', text: 'hello', createdAt: 1 }],
    }),
    'website',
  );
  // Coding tool execution classifies unlabeled turns as coding
  assert.equal(
    inferSuperAgentIntent({
      intent: undefined,
      artifacts: [],
      messages: [
        { id: 'm1', role: 'user', text: 'check this repo', createdAt: 1 },
        { id: 't1', role: 'tool', text: 'Ran command', createdAt: 2, toolEvent: { tool: 'Bash', category: 'command', label: 'git status' } },
      ],
    }),
    'coding',
  );

  // Title generation preserves short prompts, strips noise, and upgrades generic hello titles
  assert.equal(generateSuperAgentTitle({ prompt: 'Build a retro arcade shooter game' }), 'Build a retro arcade shooter game');
  assert.equal(generateSuperAgentTitle({ prompt: '[Mode: Coding] Please fix bug in server.ts' }), 'fix bug in server.ts');
  assert.equal(generateSuperAgentTitle({ prompt: '帮我写一个贪吃蛇小游戏' }), '写一个贪吃蛇小游戏');
  assert.equal(
    generateSuperAgentTitle({
      currentTitle: 'hello',
      prompt: 'Create a neon status card prototype with openmotion_design_project',
      artifactTitle: 'Neon Status Card Prototype',
    }),
    'Neon Status Card Prototype',
  );

  assert.equal(superAgentIntentMeta('coding').icon, 'code-s-slash-line');
  assert.equal(superAgentIntentMeta('website').icon, 'layout-line');
  assert.equal(superAgentIntentMeta('chat').icon, 'chat-1-line');
});

test('SuperAgentConversations executes Coding mode without creative MCP tools and updates intent/title from Turn 2', () => fixture(async store => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'sa-coding-workdir-'));
  let capturedClaudeCwd = '';
  let capturedClaudePrompt = '';
  let capturedClaudeInstructions = '';
  let capturedClaudeMcpPath = '';
  let capturedMcpServers: Record<string, unknown> = { unexpected: true };
  let capturedCodexStartParams: any = null;

  class CodingCodexRpc {
    onNotification: (msg: any) => void;
    constructor(_bin: string, _cwd: string, onNotification: (msg: any) => void) {
      this.onNotification = onNotification;
    }
    async request(method: string, params?: any) {
      if (method === 'initialize') return {};
      if (method === 'thread/start') {
        capturedCodexStartParams = params;
        return { thread: { id: 'codex-coding-thread' } };
      }
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.onNotification({ method: 'turn/started', params: {} });
          this.onNotification({ method: 'item/completed', params: { item: { id: 'a1', type: 'agentMessage', text: 'Repo checked.' } } });
          this.onNotification({ method: 'turn/completed', params: { turn: { id: 't1', status: 'completed' } } });
        });
        return { turn: { id: 't1' } };
      }
      return {};
    }
    send() {}
    close() {}
  }

  const service = new SuperAgentConversations(store, {
    resolve: async engine => `/usr/local/bin/${engine}`,
    rpc: CodingCodexRpc as unknown as typeof AssetAgentRpc,
    runClaude: async opts => {
      capturedClaudeCwd = opts.cwd;
      capturedClaudePrompt = opts.prompt;
      capturedClaudeInstructions = opts.instructions;
      capturedClaudeMcpPath = opts.mcpConfigPath;
      capturedMcpServers = JSON.parse(await readFile(opts.mcpConfigPath, 'utf8')).mcpServers;
      await opts.onEvent({ type: 'system', session_id: 'claude-coding-1' });
      const reply = opts.prompt === 'hello' ? 'Hi! Ready to help with coding.' : 'All unit tests pass.';
      await opts.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
      await opts.onEvent({ type: 'result', is_error: false });
    },
  });

  try {
    const resolvedWorkDir = await realpath(workDir);
    const claudeChat = await service.create({ engine: 'claude', permissionMode: 'auto' });
    await service.start(claudeChat.id, {
      requestId: 'req-coding-claude-1',
      mode: 'coding',
      workingDir: workDir,
      text: 'hello',
    }, {
      origin: 'http://127.0.0.1:4173',
      phase1: () => fakePhase1(store),
    });

    let claudeDone = await service.get(claudeChat.id);
    for (let i = 0; i < 60 && claudeDone.state === 'running'; i++) {
      await new Promise(r => setTimeout(r, 15));
      claudeDone = await service.get(claudeChat.id);
    }

    assert.equal(claudeDone.state, 'idle');
    assert.equal(claudeDone.intent, 'coding');
    assert.equal(claudeDone.workingDir, resolvedWorkDir);
    assert.equal(capturedClaudeCwd, resolvedWorkDir);
    assert.equal(capturedClaudePrompt, 'hello');
    assert.doesNotMatch(capturedClaudePrompt, /<openmotion-workspace-context>/);
    assert.match(capturedClaudeInstructions, /T3 Code/i);
    assert.deepEqual(capturedMcpServers, {});
    assert.equal(capturedClaudeMcpPath.startsWith(resolvedWorkDir), false);

    // Turn 2 with a concrete task should upgrade generic "hello" title automatically
    await service.start(claudeChat.id, {
      requestId: 'req-coding-claude-2',
      mode: 'coding',
      text: 'Fix failing parser test in parser.test.ts',
    }, {
      origin: 'http://127.0.0.1:4173',
      phase1: () => fakePhase1(store),
    });
    for (let i = 0; i < 60 && (await service.get(claudeChat.id)).state === 'running'; i++) {
      await new Promise(r => setTimeout(r, 15));
    }
    const afterTurn2 = await service.get(claudeChat.id);
    assert.equal(afterTurn2.title, 'Fix failing parser test in parser.test.ts');

    // Codex in coding mode uses workspace-write sandbox & no creative dynamicTools
    const codexChat = await service.create({ engine: 'codex', permissionMode: 'auto' });
    await service.start(codexChat.id, {
      requestId: 'req-coding-codex-1',
      mode: 'coding',
      text: 'Run git status',
    }, {
      origin: 'http://127.0.0.1:4173',
      phase1: () => fakePhase1(store),
    });
    for (let i = 0; i < 60 && (await service.get(codexChat.id)).state === 'running'; i++) {
      await new Promise(r => setTimeout(r, 15));
    }
    assert.equal(capturedCodexStartParams?.sandbox, 'workspace-write');
    assert.deepEqual(capturedCodexStartParams?.dynamicTools, []);

    const summaries = await service.list();
    assert.equal(summaries.find(item => item.id === claudeChat.id)?.intent, 'coding');
    assert.equal(summaries.find(item => item.id === codexChat.id)?.intent, 'coding');
  } finally {
    await service.close();
    await rm(workDir, { recursive: true, force: true });
  }
}));
