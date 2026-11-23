import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  AGENT_RUNTIMES_API,
  BRIDGE_SCRIPT_VERSION,
  type AgentDynamicToolDef,
  type AgentRunDispatch,
  type AgentRunEvent,
  type AgentToolCallResponse,
} from '../shared/agent-runtimes.ts';
import { isMain } from '../shared/entry.ts';
import { localAgents, type AgentDefinition, type LocalAgent } from '../shared/local-agents.ts';
import { countUnifiedDiffStats, type SuperAgentFileOperation, type SuperAgentPlanEntry, type SuperAgentUsage } from '../shared/super-agent.ts';
import { consumeSseFrames, sanitizeServiceError } from './agent-service-adapter.ts';
import { AssetAgentRpc } from './asset-chat.ts';
import { LocalAgentDirectory, resolveLocalAgent } from './local-agents.ts';
import type { ClaudeTurnRunner } from './super-agent.ts';
import {
  AcpBootstrapError,
  runAcpAdapter,
  runAgyPrintStreamAdapter,
  runCliFallbackAdapter,
  runPiRpcAdapter,
  type AcpMcpServerEntry,
  type ProviderAdapterCallbacks,
} from './super-agent-adapters.ts';

export type AgentBridgeOptions = {
  serverUrl: string;
  token: string;
  name?: string;
  machineId?: string;
  configDir?: string;
  heartbeatMs?: number;
  resolveBin?: (bin: string) => Promise<string | null>;
  inspectAgent?: (id: string) => Promise<LocalAgent>;
  rpcFactory?: typeof AssetAgentRpc;
  claudeRunner?: ClaudeTurnRunner;
  onLog?: (message: string) => void;
};

export type AgentBridgeHandle = {
  runtimeId: string;
  stop: () => Promise<void>;
};

const BRIDGE_PATH = fileURLToPath(import.meta.url);

async function ensureMachineId(configDir: string): Promise<string> {
  const file = path.join(configDir, 'machine-id');
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (existing) return existing;
  } catch {
    /* create new machine id */
  }
  const created = randomUUID();
  try {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(file, created, { mode: 0o600 });
  } catch {
    /* keep ephemeral machine id */
  }
  return created;
}

async function discoverBridgeAgents(
  directory: LocalAgentDirectory,
  inspectFn: (id: string) => Promise<LocalAgent>,
): Promise<LocalAgent[]> {
  const listed = await directory.list();
  const eagerIds = new Set(['codex', 'claude']);
  const updated = await Promise.all(
    listed.agents.map(async agent => {
      if (!agent.installed || !eagerIds.has(agent.id)) return agent;
      try {
        return await inspectFn(agent.id);
      } catch {
        return agent;
      }
    }),
  );
  return updated;
}

function summarizeBridgeToolOutput(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, any>;
  if (typeof obj.error === 'string') return obj.error;
  if (obj.project?.title) return String(obj.project.title);
  if (obj.artifact?.title) return String(obj.artifact.title);
  if (obj.kit?.name) return String(obj.kit.name);
  if (obj.job?.state) return `Job ${obj.job.state}`;
  return undefined;
}

function toCodexContentItems(res: AgentToolCallResponse) {
  if (Array.isArray(res.contentItems) && res.contentItems.length) {
    return res.contentItems.map(item => {
      if (item.type === 'image' && item.imageUrl) {
        return { type: 'inputImage', imageUrl: item.imageUrl };
      }
      if (item.type === 'inputImage' || item.type === 'inputText' || item.type === 'inputAudio') {
        return item;
      }
      return { type: 'inputText', text: item.text ?? JSON.stringify(res.structuredContent ?? {}) };
    });
  }
  const text = res.error ? JSON.stringify({ error: res.error }) : JSON.stringify(res.structuredContent ?? {});
  return [{ type: 'inputText', text }];
}

const bridgeClaudeRunner: ClaudeTurnRunner = async ({
  bin,
  cwd,
  prompt,
  model,
  threadId,
  mcpConfigPath,
  instructions,
  onEvent,
  signal,
}) => {
  signal.throwIfAborted();
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools', 'mcp__openmotion__*',
    '--append-system-prompt', instructions,
    ...(model ? ['--model', model] : []),
    ...(threadId ? ['--resume', threadId] : []),
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    let stderr = '';
    let settled = false;
    let processing = Promise.resolve();
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const abort = () => {
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
      timer.unref();
      fail(new Error('Agent conversation stopped'));
    };
    signal.addEventListener('abort', abort, { once: true });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8_000_000) {
        child.kill('SIGTERM');
        fail(new Error('Agent stream output exceeded limit'));
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          processing = processing
            .then(() => onEvent(event))
            .catch(err => fail(err instanceof Error ? err : new Error(String(err))));
        } catch {
          /* ignore non-JSON diagnostic lines */
        }
      }
    });
    child.once('error', err => {
      signal.removeEventListener('abort', abort);
      fail(err);
    });
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      void processing.then(() => {
        if (settled) return;
        settled = true;
        if (code && code !== 0) {
          reject(new Error(stderr.trim() || `Claude Code exited with status ${code}`));
        } else {
          resolve();
        }
      }, fail);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
};

export async function runMcpRelayFromEnv(): Promise<void> {
  const serverUrl = process.env.OM_BRIDGE_SERVER || '';
  const token = process.env.OM_BRIDGE_TOKEN || '';
  const runId = process.env.OM_BRIDGE_RUN_ID || '';
  const toolsJson = process.env.OM_BRIDGE_TOOLS_B64
    ? Buffer.from(process.env.OM_BRIDGE_TOOLS_B64, 'base64').toString('utf8')
    : '[]';
  const tools = JSON.parse(toolsJson) as AgentDynamicToolDef[];

  const reply = (value: unknown) => {
    process.stdout.write(JSON.stringify(value) + '\n');
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (msg.id === undefined || msg.id === null) continue;

    if (msg.method === 'initialize') {
      reply({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'openmotion-bridge-mcp', version: BRIDGE_SCRIPT_VERSION },
        },
      });
    } else if (msg.method === 'tools/list') {
      reply({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      });
    } else if (msg.method === 'tools/call') {
      const toolName = String(msg.params?.name || '').replace(/^mcp_+openmotion_+/, '');
      const toolArgs = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
      try {
        const response = await fetch(`${serverUrl}${AGENT_RUNTIMES_API}/bridge/tool-call`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            runId,
            callId: String(msg.id),
            tool: toolName,
            arguments: toolArgs,
          }),
        });
        const data = (await response.json()) as AgentToolCallResponse;
        const textContent = data.error
          ? data.error
          : JSON.stringify(data.structuredContent ?? {});
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: textContent }],
            ...(data.structuredContent !== undefined ? { structuredContent: data.structuredContent } : {}),
            ...(!response.ok || data.ok === false ? { isError: true } : {}),
          },
        });
      } catch (error) {
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: sanitizeServiceError(error) }],
            isError: true,
          },
        });
      }
    } else {
      reply({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unsupported method: ${msg.method}` },
      });
    }
  }
}

export async function startAgentBridge(options: AgentBridgeOptions): Promise<AgentBridgeHandle> {
  const serverUrl = new URL(options.serverUrl).origin;
  const token = options.token.trim();
  const configDir = options.configDir || path.join(os.homedir(), '.openmotion-bridge');
  const machineId = options.machineId || await ensureMachineId(configDir);
  const name = options.name?.trim() || os.hostname() || 'Local Machine';
  const heartbeatMs = Math.max(2_000, options.heartbeatMs ?? 15_000);
  const log = options.onLog ?? (() => {});

  const resolveBin = options.resolveBin ?? resolveLocalAgent;
  const localDir = new LocalAgentDirectory(configDir, resolveBin);
  const inspectFn = options.inspectAgent ?? (id => localDir.inspect(id));

  const postJson = async <T>(apiPath: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await fetch(`${serverUrl}${AGENT_RUNTIMES_API}${apiPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let parsed: any = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text };
    }
    if (!response.ok) {
      throw new Error(parsed?.error || `Bridge request failed (${response.status})`);
    }
    return parsed as T;
  };

  let agents = await discoverBridgeAgents(localDir, inspectFn);
  const registered = await postJson<{ runtimeId: string; heartbeatIntervalMs?: number }>(
    '/bridge/register',
    {
      machineId,
      name,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      bridgeVersion: BRIDGE_SCRIPT_VERSION,
      agents,
    },
  );
  const runtimeId = registered.runtimeId;
  log(`Registered bridge runtime ${runtimeId} (${name}) with ${serverUrl}`);

  let stopped = false;
  const loopController = new AbortController();
  const activeRuns = new Map<string, { controller: AbortController; kill: () => void }>();

  const sendRunEvent = async (runId: string, event: AgentRunEvent) => {
    if (stopped) return;
    await postJson('/bridge/events', { runId, event });
  };

  const makeBridgeCallbacks = (runId: string): ProviderAdapterCallbacks => ({
    onThreadId: threadId => sendRunEvent(runId, { type: 'thread.started', threadId }),
    onStatus: (phase, label, activeToolName) => sendRunEvent(runId, {
      type: 'status.update',
      phase,
      ...(label ? { label } : {}),
      ...(activeToolName ? { activeToolName } : {}),
    }),
    onReasoningDelta: (id, delta) => sendRunEvent(runId, { type: 'reasoning.delta', messageId: id, delta }),
    onReasoningComplete: (id, text, durationMs) => sendRunEvent(runId, { type: 'reasoning.complete', messageId: id, text, durationMs }),
    onMessageDelta: (id, delta) => sendRunEvent(runId, { type: 'message.delta', messageId: id, delta }),
    onMessageComplete: (id, text) => sendRunEvent(runId, { type: 'message.complete', messageId: id, text }),
    onToolStarted: async ev => {
      if (ev.tool.startsWith('openmotion_')) return;
      await sendRunEvent(runId, {
        type: 'tool.started',
        callId: ev.callId,
        tool: ev.tool,
        category: ev.category,
        title: ev.label,
        command: ev.command,
        fileOp: ev.fileOp,
        files: ev.files,
      });
    },
    onToolUpdated: async () => {
      /* Final completion emitted via tool.finished */
    },
    onToolFinished: async (ev, rawResult, toolArgs) => {
      if (ev.tool.startsWith('openmotion_')) return;
      await sendRunEvent(runId, {
        type: 'tool.finished',
        callId: ev.callId,
        tool: ev.tool,
        args: toolArgs,
        ok: ev.status === 'completed',
        output: rawResult ?? ev.outputPreview,
        summary: ev.summary,
        category: ev.category,
        title: ev.label,
        command: ev.command,
        exitCode: ev.exitCode,
        fileOp: ev.fileOp,
        files: ev.files,
        durationMs: ev.durationMs,
      });
    },
    onPlanUpdate: entries => sendRunEvent(runId, { type: 'plan.update', entries }),
    onUsageUpdate: usage => sendRunEvent(runId, { type: 'usage.update', usage }),
    onApprovalRequest: async () => false,
  });

  const executeDispatchedTurn = async (dispatch: AgentRunDispatch) => {
    const runController = new AbortController();
    let killActive = () => {};
    activeRuns.set(dispatch.runId, {
      controller: runController,
      kill: () => killActive(),
    });

    const workRoot = await mkdtemp(path.join(os.tmpdir(), 'openmotion-bridge-run-'));
    try {
      let resolvedWorkingDir: string | undefined;
      if (typeof dispatch.workingDir === 'string' && dispatch.workingDir.trim()) {
        const rawDir = dispatch.workingDir.trim();
        if (rawDir.includes('\0') || rawDir.length > 1024 || !path.isAbsolute(rawDir)) {
          await sendRunEvent(dispatch.runId, {
            type: 'turn.failed',
            error: 'Working directory must be an absolute folder path on the bridge machine',
          });
          return;
        }
        const st = await stat(rawDir).catch(() => null);
        if (!st?.isDirectory()) {
          await sendRunEvent(dispatch.runId, {
            type: 'turn.failed',
            error: `Working directory does not exist on ${name}: ${rawDir}`,
          });
          return;
        }
        resolvedWorkingDir = await realpath(rawDir);
      }
      const execCwd = resolvedWorkingDir ?? workRoot;

      const def: AgentDefinition | undefined = localAgents.find(item => item.id === dispatch.engine);
      const binName = def?.bin || dispatch.engine;
      const bin = await resolveBin(binName);
      if (!bin) {
        await sendRunEvent(dispatch.runId, {
          type: 'turn.failed',
          error: `${def?.label || dispatch.engine} CLI is not installed on ${name}`,
        });
        return;
      }

      if (dispatch.engine === 'codex') {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let rpc: AssetAgentRpc | undefined;
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            runController.signal.removeEventListener('abort', onAbort);
            if (err) reject(err);
            else resolve();
          };
          const onAbort = () => {
            rpc?.close();
            finish();
          };
          runController.signal.addEventListener('abort', onAbort, { once: true });
          killActive = () => rpc?.close();

          rpc = new (options.rpcFactory ?? AssetAgentRpc)(
            bin,
            execCwd,
            async message => {
              const { method, params: p = {}, id } = message;
              try {
                if (method === 'item/tool/call' && id !== undefined) {
                  const toolName = String(p.tool || '');
                  const toolArgs = p.arguments && typeof p.arguments === 'object' ? p.arguments : {};
                  const callId = String(p.callId || randomUUID());
                  const res = await postJson<AgentToolCallResponse>('/bridge/tool-call', {
                    runId: dispatch.runId,
                    callId,
                    tool: toolName,
                    arguments: toolArgs,
                  }, runController.signal);
                  rpc?.send({
                    id,
                    result: {
                      contentItems: toCodexContentItems(res),
                      success: res.ok !== false,
                    },
                  });
                } else if (id !== undefined && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
                  rpc?.send({
                    id,
                    result: { decision: dispatch.permissionMode === 'auto' ? 'accept' : 'decline' },
                  });
                } else if (id !== undefined) {
                  rpc?.send({
                    id,
                    error: { code: -32601, message: 'Bridge session does not support this interactive host request' },
                  });
                } else if (method === 'turn/started') {
                  await sendRunEvent(dispatch.runId, { type: 'status.update', phase: 'thinking' });
                } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
                  await sendRunEvent(dispatch.runId, {
                    type: 'reasoning.delta',
                    messageId: String(p.itemId || 'reasoning'),
                    delta: String(p.delta ?? ''),
                  });
                } else if (method === 'item/started' && p.item && ['commandExecution', 'fileChange', 'webSearch'].includes(p.item.type)) {
                  const it = p.item;
                  await sendRunEvent(dispatch.runId, {
                    type: 'tool.started',
                    callId: String(it.id || randomUUID()),
                    tool: String(it.type),
                    args: it.type === 'commandExecution'
                      ? { command: it.command }
                      : it.type === 'webSearch'
                        ? { query: it.query }
                        : { changes: it.changes },
                  });
                } else if (method === 'item/agentMessage/delta') {
                  await sendRunEvent(dispatch.runId, {
                    type: 'message.delta',
                    messageId: String(p.itemId || 'assistant'),
                    delta: String(p.delta ?? ''),
                  });
                } else if (method === 'item/completed' && p.item?.type === 'agentMessage') {
                  await sendRunEvent(dispatch.runId, {
                    type: 'message.complete',
                    messageId: String(p.item.id || 'assistant'),
                    text: String(p.item.text ?? ''),
                  });
                } else if (method === 'item/completed' && p.item?.type === 'reasoning') {
                  const summaryParts = Array.isArray(p.item.summary) ? p.item.summary.map((s: any) => String(s?.text ?? s ?? '')).filter(Boolean) : [];
                  const contentParts = Array.isArray(p.item.content) ? p.item.content.map((c: any) => String(c?.text ?? c ?? '')).filter(Boolean) : [];
                  const fullText = [p.item.text, ...summaryParts, ...contentParts].filter(Boolean).join('\n').trim();
                  if (fullText) {
                    await sendRunEvent(dispatch.runId, {
                      type: 'reasoning.complete',
                      messageId: String(p.item.id || 'reasoning'),
                      text: fullText,
                    });
                  }
                } else if (method === 'item/completed' && p.item?.type === 'commandExecution') {
                  const it = p.item;
                  const ok = it.status !== 'failed' && it.status !== 'declined' && (typeof it.exitCode !== 'number' || it.exitCode === 0);
                  await sendRunEvent(dispatch.runId, {
                    type: 'tool.finished',
                    callId: String(it.id),
                    tool: 'commandExecution',
                    ok,
                    category: 'command',
                    command: typeof it.command === 'string' ? it.command : undefined,
                    exitCode: typeof it.exitCode === 'number' ? it.exitCode : undefined,
                    output: it.aggregatedOutput ?? it.stdout ?? it.stderr,
                    durationMs: typeof it.durationMs === 'number' ? it.durationMs : undefined,
                  });
                } else if (method === 'item/completed' && p.item?.type === 'fileChange') {
                  const it = p.item;
                  const files: SuperAgentFileOperation[] = Array.isArray(it.changes)
                    ? it.changes.filter((c: any) => c && typeof c.path === 'string').map((c: any) => {
                        const k = String(c.kind || 'update').toLowerCase();
                        const action: SuperAgentFileOperation['action'] = k.includes('add') || k.includes('create') ? 'create' : k.includes('del') ? 'delete' : 'edit';
                        const diffStr = typeof c.diff === 'string' ? c.diff : '';
                        const stats = diffStr ? countUnifiedDiffStats(diffStr) : undefined;
                        return { action, path: String(c.path), ...(stats ?? {}), ...(diffStr ? { diffPreview: diffStr.slice(0, 4000) } : {}) };
                      })
                    : [];
                  await sendRunEvent(dispatch.runId, {
                    type: 'tool.finished',
                    callId: String(it.id),
                    tool: 'fileChange',
                    ok: it.status !== 'failed' && it.status !== 'declined',
                    category: files[0]?.action === 'create' ? 'file_write' : files[0]?.action === 'delete' ? 'file_delete' : 'file_edit',
                    fileOp: files[0],
                    files,
                  });
                } else if (method === 'turn/plan/updated' && Array.isArray(p.plan)) {
                  const entries: SuperAgentPlanEntry[] = p.plan
                    .filter((e: any) => e && typeof (e.step ?? e.content) === 'string')
                    .map((e: any) => ({
                      content: String(e.step ?? e.content),
                      status: String(e.status || '').toLowerCase() === 'completed'
                        ? 'completed'
                        : String(e.status || '').toLowerCase().includes('progress')
                          ? 'in_progress'
                          : 'pending',
                    }));
                  await sendRunEvent(dispatch.runId, { type: 'plan.update', entries });
                } else if (method === 'thread/tokenUsage/updated' && p.tokenUsage?.total) {
                  const t = p.tokenUsage.total;
                  const usage: SuperAgentUsage = {
                    ...(typeof t.inputTokens === 'number' ? { inputTokens: t.inputTokens } : {}),
                    ...(typeof t.outputTokens === 'number' ? { outputTokens: t.outputTokens } : {}),
                    ...(typeof t.totalTokens === 'number' ? { totalTokens: t.totalTokens } : {}),
                  };
                  await sendRunEvent(dispatch.runId, { type: 'usage.update', usage });
                } else if (method === 'turn/completed') {
                  if (p.turn?.error?.message) {
                    await sendRunEvent(dispatch.runId, {
                      type: 'turn.failed',
                      error: String(p.turn.error.message),
                    });
                  } else {
                    await sendRunEvent(dispatch.runId, { type: 'turn.completed' });
                  }
                  rpc?.close();
                  finish();
                } else if (method === 'error' && !p.willRetry) {
                  await sendRunEvent(dispatch.runId, {
                    type: 'turn.failed',
                    error: String(p.error?.message || 'Codex agent failed'),
                  });
                  rpc?.close();
                  finish();
                }
              } catch (err) {
                rpc?.close();
                finish(err instanceof Error ? err : new Error(String(err)));
              }
            },
            err => {
              if (!settled && !runController.signal.aborted) {
                finish(err);
              }
            },
          );

          void (async () => {
            await rpc.request('initialize', {
              clientInfo: { name: 'openmotion_super_agent_bridge', title: 'OpenMotion Bridge', version: BRIDGE_SCRIPT_VERSION },
              capabilities: { experimentalApi: true },
            });
            rpc.send({ method: 'initialized' });
            const threadOpts = {
              cwd: execCwd,
              approvalPolicy: 'on-request',
              sandbox: resolvedWorkingDir ? 'workspace-write' : 'read-only',
              developerInstructions: dispatch.instructions,
              ...(dispatch.model && dispatch.model !== 'default' ? { model: dispatch.model } : {}),
            };
            const threadRes = dispatch.threadId
              ? await rpc.request('thread/resume', { ...threadOpts, threadId: dispatch.threadId })
              : await rpc.request('thread/start', { ...threadOpts, dynamicTools: dispatch.dynamicTools });
            const threadId = String(threadRes?.thread?.id || '');
            if (threadId) {
              await sendRunEvent(dispatch.runId, { type: 'thread.started', threadId });
            }
            if (runController.signal.aborted) {
              rpc.close();
              finish();
              return;
            }
            await rpc.request('turn/start', {
              threadId,
              effort: dispatch.reasoning && dispatch.reasoning !== 'default' ? dispatch.reasoning : null,
              input: [{ type: 'text', text: dispatch.prompt }],
            });
          })().catch(finish);
        });
        return;
      }

      if (dispatch.engine === 'claude' || dispatch.engine === 'openclaude') {
        const mcpConfigPath = path.join(workRoot, `mcp-${randomUUID()}.json`);
        const toolsB64 = Buffer.from(JSON.stringify(dispatch.dynamicTools), 'utf8').toString('base64');
        const mcpConfig = {
          mcpServers: {
            openmotion: {
              type: 'stdio',
              command: process.execPath,
              args: ['--experimental-strip-types', BRIDGE_PATH, '--mcp-relay'],
              cwd: workRoot,
              env: {
                OM_BRIDGE_SERVER: serverUrl,
                OM_BRIDGE_TOKEN: token,
                OM_BRIDGE_RUN_ID: dispatch.runId,
                OM_BRIDGE_TOOLS_B64: toolsB64,
              },
            },
          },
        };
        await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), { mode: 0o600 });
        const runner = options.claudeRunner ?? bridgeClaudeRunner;
        let streamingMsgId = randomUUID();
        const toolInputs = new Map<string, { name: string; args: Record<string, unknown> }>();

        await runner({
          bin,
          cwd: execCwd,
          prompt: dispatch.prompt,
          model: dispatch.model && dispatch.model !== 'default' ? dispatch.model : undefined,
          threadId: dispatch.threadId,
          mcpConfigPath,
          instructions: dispatch.claudeInstructions || dispatch.instructions,
          signal: runController.signal,
          onEvent: async event => {
            if (runController.signal.aborted) return;
            if (event.type === 'system' && typeof event.session_id === 'string') {
              await sendRunEvent(dispatch.runId, { type: 'thread.started', threadId: event.session_id });
            } else if (
              event.type === 'stream_event'
              && event.event?.type === 'content_block_delta'
              && event.event?.delta?.type === 'thinking_delta'
            ) {
              await sendRunEvent(dispatch.runId, {
                type: 'reasoning.delta',
                messageId: 'claude-thinking',
                delta: String(event.event.delta.thinking ?? event.event.delta.text ?? ''),
              });
            } else if (
              event.type === 'stream_event'
              && event.event?.type === 'content_block_delta'
              && event.event?.delta?.type === 'text_delta'
            ) {
              await sendRunEvent(dispatch.runId, {
                type: 'message.delta',
                messageId: streamingMsgId,
                delta: String(event.event.delta.text ?? ''),
              });
            } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
              let fullText = '';
              for (const block of event.message.content) {
                if (block.type === 'thinking') {
                  const text = String(block.thinking ?? block.text ?? '').trim();
                  if (text) {
                    await sendRunEvent(dispatch.runId, {
                      type: 'reasoning.complete',
                      messageId: 'claude-thinking',
                      text,
                    });
                  }
                } else if (block.type === 'text' && typeof block.text === 'string') {
                  fullText += block.text;
                } else if (block.type === 'tool_use' && block.id && block.name && !/^mcp_+openmotion_+/.test(String(block.name))) {
                  const toolName = String(block.name).replace(/^mcp_+openmotion_+/, '');
                  const toolArgs = block.input && typeof block.input === 'object' ? block.input : {};
                  toolInputs.set(block.id, { name: toolName, args: toolArgs });
                  await sendRunEvent(dispatch.runId, {
                    type: 'tool.started',
                    callId: String(block.id),
                    tool: toolName,
                    args: toolArgs,
                  });
                }
              }
              if (fullText) {
                await sendRunEvent(dispatch.runId, {
                  type: 'message.complete',
                  messageId: streamingMsgId,
                  text: fullText,
                });
                streamingMsgId = randomUUID();
              }
            } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
              for (const block of event.message.content) {
                if (block.type !== 'tool_result' || !block.tool_use_id) continue;
                const recorded = toolInputs.get(block.tool_use_id);
                if (!recorded) continue;
                const toolName = recorded.name;
                const toolArgs = recorded.args;
                const rawText = typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
                    : '';
                let parsed: any = rawText;
                try { parsed = rawText ? JSON.parse(rawText) : {}; } catch { /* plain text */ }
                await sendRunEvent(dispatch.runId, {
                  type: 'tool.finished',
                  callId: String(block.tool_use_id),
                  tool: toolName,
                  args: toolArgs,
                  ok: !block.is_error,
                  output: parsed,
                  summary: summarizeBridgeToolOutput(parsed),
                });
              }
            } else if (event.type === 'result') {
              if (event.usage && typeof event.usage === 'object') {
                const u = event.usage;
                const inputTokens = typeof u.input_tokens === 'number' ? u.input_tokens : undefined;
                const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : undefined;
                if (inputTokens !== undefined || outputTokens !== undefined) {
                  await sendRunEvent(dispatch.runId, {
                    type: 'usage.update',
                    usage: {
                      ...(inputTokens !== undefined ? { inputTokens } : {}),
                      ...(outputTokens !== undefined ? { outputTokens } : {}),
                      ...(inputTokens !== undefined && outputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}),
                    },
                  });
                }
              }
              if (event.is_error || event.is_api_error_message) {
                throw new Error(typeof event.result === 'string' ? event.result : 'Claude turn failed');
              }
            }
          },
        });
        if (!runController.signal.aborted) {
          await sendRunEvent(dispatch.runId, { type: 'turn.completed' });
        }
        return;
      }

      // ACP, Pi RPC, and non-interactive CLI fallbacks for remaining local CLIs
      const callbacks = makeBridgeCallbacks(dispatch.runId);
      killActive = () => runController.abort();
      const model = dispatch.model && dispatch.model !== 'default' ? dispatch.model : undefined;
      const reasoning = dispatch.reasoning && dispatch.reasoning !== 'default' ? dispatch.reasoning : undefined;

      if (def && (def.acpArgs !== undefined || def.acpBin)) {
        const toolsB64 = Buffer.from(JSON.stringify(dispatch.dynamicTools), 'utf8').toString('base64');
        const mcpServers: AcpMcpServerEntry[] = dispatch.dynamicTools.length > 0
          ? [
              {
                name: 'openmotion',
                command: process.execPath,
                args: ['--experimental-strip-types', BRIDGE_PATH, '--mcp-relay'],
                env: [
                  { name: 'OM_BRIDGE_SERVER', value: serverUrl },
                  { name: 'OM_BRIDGE_TOKEN', value: token },
                  { name: 'OM_BRIDGE_RUN_ID', value: dispatch.runId },
                  { name: 'OM_BRIDGE_TOOLS_B64', value: toolsB64 },
                ],
              },
            ]
          : [];
        try {
          await runAcpAdapter({
            agentDef: def,
            bin,
            cwd: execCwd,
            prompt: dispatch.prompt,
            instructions: dispatch.instructions,
            model,
            reasoning,
            threadId: dispatch.threadId,
            permissionMode: dispatch.permissionMode,
            mcpServers,
            resolveBin,
            signal: runController.signal,
            callbacks,
          });
        } catch (err) {
          if (err instanceof AcpBootstrapError && def.id === 'antigravity' && !runController.signal.aborted) {
            await runAgyPrintStreamAdapter({
              bin,
              cwd: execCwd,
              prompt: dispatch.prompt,
              instructions: dispatch.instructions,
              model,
              reasoning,
              threadId: dispatch.threadId,
              permissionMode: dispatch.permissionMode,
              signal: runController.signal,
              callbacks,
            });
          } else {
            throw err;
          }
        }
      } else if (def?.id === 'pi') {
        await runPiRpcAdapter({
          bin,
          cwd: execCwd,
          prompt: dispatch.prompt,
          instructions: dispatch.instructions,
          model,
          signal: runController.signal,
          callbacks,
        });
      } else {
        await runCliFallbackAdapter({
          agentDef: def,
          bin,
          cwd: execCwd,
          prompt: dispatch.prompt,
          instructions: dispatch.instructions,
          model,
          signal: runController.signal,
          callbacks,
        });
      }
      if (!runController.signal.aborted) {
        await sendRunEvent(dispatch.runId, { type: 'turn.completed' });
      }
    } catch (error) {
      if (!runController.signal.aborted && !stopped) {
        await sendRunEvent(dispatch.runId, {
          type: 'turn.failed',
          error: sanitizeServiceError(error),
        }).catch(() => {});
      }
    } finally {
      activeRuns.delete(dispatch.runId);
      await rm(workRoot, { recursive: true, force: true }).catch(() => {});
    }
  };

  const handleInspectCommand = async (payload: { requestId?: string; agentId?: string }) => {
    const requestId = String(payload?.requestId || '');
    const agentId = String(payload?.agentId || '');
    if (!requestId || !agentId) return;
    try {
      const agent = await inspectFn(agentId);
      agents = agents.map(item => (item.id === agent.id ? agent : item));
      await postJson('/bridge/events', { type: 'inspect.result', requestId, agent });
    } catch (error) {
      await postJson('/bridge/events', {
        type: 'inspect.result',
        requestId,
        error: sanitizeServiceError(error),
      }).catch(() => {});
    }
  };

  const hbTimer = setInterval(() => {
    if (stopped) return;
    void postJson('/bridge/heartbeat', {
      runtimeId,
      bridgeVersion: BRIDGE_SCRIPT_VERSION,
      agents,
    }).catch(error => log(`Heartbeat warning: ${sanitizeServiceError(error)}`));
  }, heartbeatMs);
  hbTimer.unref();

  let streamReadyResolve: (() => void) | null = null;
  const streamReady = new Promise<void>(resolve => {
    streamReadyResolve = resolve;
  });

  const streamLoop = (async () => {
    let backoffMs = 1000;
    while (!stopped) {
      try {
        const res = await fetch(
          `${serverUrl}${AGENT_RUNTIMES_API}/bridge/stream?runtimeId=${encodeURIComponent(runtimeId)}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'text/event-stream',
            },
            signal: loopController.signal,
          },
        );
        if (!res.ok || !res.body) {
          throw new Error(`Bridge stream rejected (${res.status})`);
        }
        backoffMs = 1000;
        await consumeSseFrames(res.body, async (eventType, dataText) => {
          if (eventType === 'connected') {
            streamReadyResolve?.();
            streamReadyResolve = null;
            return;
          }
          let payload: any;
          try {
            payload = JSON.parse(dataText);
          } catch {
            return;
          }
          if (eventType === 'agent.inspect') {
            void handleInspectCommand(payload);
          } else if (eventType === 'turn.dispatch') {
            void executeDispatchedTurn(payload as AgentRunDispatch);
          } else if (eventType === 'turn.cancel') {
            const run = activeRuns.get(String(payload?.runId || ''));
            if (run) {
              run.controller.abort();
              run.kill();
            }
          }
        });
      } catch (error) {
        streamReadyResolve?.();
        streamReadyResolve = null;
        if (stopped || loopController.signal.aborted) break;
        log(`Bridge stream reconnecting in ${backoffMs}ms: ${sanitizeServiceError(error)}`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(15_000, backoffMs * 2);
      }
    }
  })();

  await Promise.race([
    streamReady,
    new Promise(resolve => setTimeout(resolve, 3_000)),
  ]);

  return {
    runtimeId,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(hbTimer);
      loopController.abort();
      for (const run of activeRuns.values()) {
        run.controller.abort();
        run.kill();
      }
      activeRuns.clear();
      await streamLoop.catch(() => {});
    },
  };
}

function parseCliArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mcp-relay') {
      flags.mcpRelay = true;
    } else if (arg.startsWith('--') && i + 1 < argv.length) {
      flags[arg.slice(2)] = argv[++i];
    }
  }
  return flags;
}

if (isMain(import.meta.url)) {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.mcpRelay) {
    await runMcpRelayFromEnv();
  } else {
    let serverUrl = typeof args.server === 'string' ? args.server : '';
    let token = typeof args.token === 'string' ? args.token : '';
    let name = typeof args.name === 'string' ? args.name : undefined;
    if (typeof args.config === 'string') {
      const cfg = JSON.parse(await readFile(args.config, 'utf8'));
      serverUrl = serverUrl || cfg.serverUrl || '';
      token = token || cfg.token || '';
      name = name || cfg.name;
    }
    if (!serverUrl || !token) {
      console.error('Usage: node --experimental-strip-types gateway/agent-bridge.ts --server <url> --token <token> [--name <label>]');
      process.exit(1);
    }
    const bridge = await startAgentBridge({
      serverUrl,
      token,
      name,
      onLog: msg => console.log(`[openmotion-bridge] ${msg}`),
    });
    const shutdown = async () => {
      await bridge.stop();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}
