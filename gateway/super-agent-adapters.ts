import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import type { AgentDefinition } from '../shared/local-agents.ts';
import {
  classifySuperAgentTool,
  countUnifiedDiffStats,
  type SuperAgentApproval,
  type SuperAgentFileOperation,
  type SuperAgentPermissionMode,
  type SuperAgentPlanEntry,
  type SuperAgentToolEvent,
  type SuperAgentTurnActivity,
  type SuperAgentUsage,
} from '../shared/super-agent.ts';
import { agentInvocation } from './agent-discovery.ts';

export class AcpBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpBootstrapError';
  }
}

export type ProviderAdapterCallbacks = {
  onThreadId: (threadId: string) => Promise<void> | void;
  onStatus: (
    phase: SuperAgentTurnActivity['phase'],
    label?: string,
    activeToolName?: string,
  ) => Promise<void> | void;
  onTitleSuggested?: (title: string) => Promise<void> | void;
  onReasoningDelta: (id: string, delta: string) => Promise<void> | void;
  onReasoningComplete: (id: string, text: string, durationMs?: number) => Promise<void> | void;
  onMessageDelta: (id: string, delta: string) => Promise<void> | void;
  onMessageComplete: (id: string, text: string) => Promise<void> | void;
  onToolStarted: (ev: SuperAgentToolEvent) => Promise<void> | void;
  onToolUpdated: (ev: SuperAgentToolEvent) => Promise<void> | void;
  onToolFinished: (ev: SuperAgentToolEvent, rawResult?: unknown, toolArgs?: Record<string, unknown>) => Promise<void> | void;
  onPlanUpdate: (entries: SuperAgentPlanEntry[]) => Promise<void> | void;
  onUsageUpdate: (usage: SuperAgentUsage) => Promise<void> | void;
  onApprovalRequest: (kind: SuperAgentApproval['kind'], title: string, detail: string) => Promise<boolean>;
};

export type AcpMcpServerEntry = {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
};

export type AcpAdapterOptions = {
  agentDef: AgentDefinition;
  bin: string;
  cwd: string;
  prompt: string;
  instructions?: string;
  model?: string;
  reasoning?: string;
  threadId?: string;
  permissionMode: SuperAgentPermissionMode;
  mcpServers: AcpMcpServerEntry[];
  resolveBin?: (bin: string) => Promise<string | null>;
  signal: AbortSignal;
  callbacks: ProviderAdapterCallbacks;
};

function previewText(value: unknown, max = 2400): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (!str.trim()) return undefined;
    return str.length > max ? `${str.slice(0, max)}\n…` : str;
  } catch {
    return String(value).slice(0, max);
  }
}

function normalizeUsage(raw: any): SuperAgentUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const inputTokens = typeof raw.inputTokens === 'number'
    ? raw.inputTokens
    : typeof raw.input_tokens === 'number'
      ? raw.input_tokens
      : undefined;
  const outputTokens = typeof raw.outputTokens === 'number'
    ? raw.outputTokens
    : typeof raw.output_tokens === 'number'
      ? raw.output_tokens
      : undefined;
  const thoughtTokens = typeof raw.thoughtTokens === 'number'
    ? raw.thoughtTokens
    : typeof raw.thought_tokens === 'number'
      ? raw.thought_tokens
      : undefined;
  const totalTokens = typeof raw.totalTokens === 'number'
    ? raw.totalTokens
    : typeof raw.total_tokens === 'number'
      ? raw.total_tokens
      : typeof raw.used === 'number'
        ? raw.used
        : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(thoughtTokens !== undefined ? { thoughtTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function extractAcpDiffs(content: unknown): Array<{ path?: string; oldText?: string; newText?: string }> {
  if (!Array.isArray(content)) return [];
  const diffs: Array<{ path?: string; oldText?: string; newText?: string }> = [];
  for (const item of content) {
    if (item && typeof item === 'object' && item.type === 'diff' && typeof item.path === 'string') {
      diffs.push({
        path: item.path,
        oldText: typeof item.oldText === 'string' ? item.oldText : '',
        newText: typeof item.newText === 'string' ? item.newText : '',
      });
    }
  }
  return diffs;
}

function extractAcpTextOutput(rawOutput: unknown, content: unknown): { text?: string; parsed?: unknown } {
  const parts: string[] = [];
  if (typeof rawOutput === 'string' && rawOutput.trim()) {
    parts.push(rawOutput.trim());
  } else if (rawOutput && typeof rawOutput === 'object') {
    const obj = rawOutput as Record<string, any>;
    if (typeof obj.output === 'string' && obj.output.trim()) parts.push(obj.output.trim());
    else if (typeof obj.stdout === 'string' && obj.stdout.trim()) parts.push(obj.stdout.trim());
    else if (typeof obj.stderr === 'string' && obj.stderr.trim()) parts.push(obj.stderr.trim());
    else if (typeof obj.text === 'string' && obj.text.trim()) parts.push(obj.text.trim());
    else if (Array.isArray(obj.content)) {
      for (const block of obj.content) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
    } else if (Array.isArray(obj.result?.content)) {
      for (const block of obj.result.content) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
    }
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'content' && block.content?.type === 'text' && typeof block.content.text === 'string') {
        parts.push(block.content.text);
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  const combined = parts.join('\n').trim();
  let parsed: unknown = rawOutput;
  if (combined) {
    try {
      parsed = JSON.parse(combined);
    } catch {
      parsed = rawOutput && typeof rawOutput === 'object' ? rawOutput : combined;
    }
  }
  return {
    ...(combined ? { text: combined } : {}),
    parsed,
  };
}

function unwrapToolNameAndArgs(
  rawName: string,
  rawArgs: Record<string, unknown>,
  metaTitle?: string,
  metaToolName?: string,
): { toolName: string; args: Record<string, unknown> } {
  let cleanName = (rawName || '').trim();
  if (!cleanName || cleanName === 'tool') {
    if (typeof metaToolName === 'string' && metaToolName.trim()) {
      cleanName = metaToolName.trim();
    } else if (typeof metaTitle === 'string') {
      const match = metaTitle.match(/(?:mcp_+openmotion_+)?(openmotion_[a-z0-9_]+)/);
      if (match) cleanName = match[1];
    }
  }
  if (!cleanName) cleanName = 'tool';
  if (cleanName === 'call_mcp_tool') {
    const innerTool = typeof rawArgs.ToolName === 'string'
      ? rawArgs.ToolName
      : typeof rawArgs.toolName === 'string'
        ? rawArgs.toolName
        : '';
    const innerArgsRaw = rawArgs.Arguments ?? rawArgs.arguments;
    let innerArgs: Record<string, unknown> = {};
    if (typeof innerArgsRaw === 'string') {
      try {
        const parsed = JSON.parse(innerArgsRaw);
        if (parsed && typeof parsed === 'object') innerArgs = parsed as Record<string, unknown>;
      } catch {
        innerArgs = rawArgs;
      }
    } else if (innerArgsRaw && typeof innerArgsRaw === 'object') {
      innerArgs = innerArgsRaw as Record<string, unknown>;
    }
    if (innerTool) {
      return {
        toolName: innerTool.replace(/^mcp_+openmotion_+/, ''),
        args: innerArgs,
      };
    }
  }
  return {
    toolName: cleanName.replace(/^mcp_+openmotion_+/, ''),
    args: rawArgs,
  };
}

function extractExitCode(rawOutput: unknown): number | undefined {
  if (!rawOutput || typeof rawOutput !== 'object') return undefined;
  const obj = rawOutput as Record<string, unknown>;
  if (typeof obj.exitCode === 'number') return obj.exitCode;
  if (typeof obj.exit_code === 'number') return obj.exit_code;
  if (typeof obj.output === 'string') {
    const match = obj.output.match(/Command exited with code (-?\d+)/i);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function pickConfigValues(configOptions: unknown): { modelOpt?: any; thoughtOpt?: any } {
  if (!Array.isArray(configOptions)) return {};
  let modelOpt: any;
  let thoughtOpt: any;
  for (const opt of configOptions) {
    if (!opt || typeof opt !== 'object') continue;
    const cat = String((opt as any).category || '').toLowerCase();
    const id = String((opt as any).id || '').toLowerCase();
    if (!modelOpt && (cat === 'model' || id === 'model')) modelOpt = opt;
    if (!thoughtOpt && (cat === 'thought_level' || id === 'thought_level' || id === 'reasoning' || id === 'effort')) {
      thoughtOpt = opt;
    }
  }
  return { modelOpt, thoughtOpt };
}

function resolveAcpModelAndEffort(
  requestedModel: string | undefined,
  requestedReasoning: string | undefined,
  configOptions: unknown,
): { configModelValue?: string; directModelId?: string; effortValue?: string } {
  const { modelOpt, thoughtOpt } = pickConfigValues(configOptions);
  const effortChoices: string[] = Array.isArray(thoughtOpt?.options)
    ? thoughtOpt.options.map((o: any) => String(o?.value ?? o?.id ?? '')).filter(Boolean)
    : [];
  const modelChoices: string[] = Array.isArray(modelOpt?.options)
    ? modelOpt.options.map((o: any) => String(o?.value ?? o?.id ?? '')).filter(Boolean)
    : [];

  let effortValue = requestedReasoning && requestedReasoning !== 'default' ? requestedReasoning : undefined;
  let configModelValue: string | undefined;
  let directModelId: string | undefined;

  if (requestedModel && requestedModel !== 'default') {
    directModelId = requestedModel;
    if (modelChoices.includes(requestedModel)) {
      configModelValue = requestedModel;
    } else {
      const suffixMatch = requestedModel.match(/^(.+)-(low|medium|high|xhigh|max)$/i);
      if (suffixMatch) {
        const [, base, effort] = suffixMatch;
        if (modelChoices.includes(base)) {
          configModelValue = base;
          if (!effortValue && (!effortChoices.length || effortChoices.includes(effort.toLowerCase()))) {
            effortValue = effort.toLowerCase();
          }
        }
      }
    }
  }

  return { configModelValue, directModelId, effortValue };
}

function choosePermissionOption(
  options: unknown,
  accepted: boolean,
): string | undefined {
  if (!Array.isArray(options)) return undefined;
  const list = options.filter((o): o is Record<string, any> => Boolean(o && typeof o === 'object'));
  if (accepted) {
    const allowOnce = list.find(o => o.kind === 'allow_once' || /allow.?once|approve/i.test(String(o.optionId || o.name || '')));
    const allowAny = list.find(o => String(o.kind || '').startsWith('allow'));
    return (allowOnce ?? allowAny ?? list[0])?.optionId;
  }
  const rejectOnce = list.find(o => o.kind === 'reject_once' || /reject|deny|decline/i.test(String(o.optionId || o.name || '')));
  const rejectAny = list.find(o => String(o.kind || '').startsWith('reject'));
  return (rejectOnce ?? rejectAny ?? list.at(-1))?.optionId;
}

async function runSingleAcpAttempt(
  bin: string,
  args: string[],
  opts: AcpAdapterOptions,
): Promise<void> {
  opts.signal.throwIfAborted();
  const command = await agentInvocation(bin, args);
  const { callbacks, cwd, mcpServers, model, reasoning, threadId, permissionMode, instructions, prompt, signal } = opts;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let seq = 0;
    const pending = new Map<number, { resolve: (val: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
    let buffer = '';
    let stderr = '';
    let settled = false;
    let acpSessionId: string | null = null;
    let promptStarted = false;
    let replaySuppress = false;
    let queue: Promise<unknown> = Promise.resolve();

    let thoughtId = randomUUID();
    let thoughtText = '';
    let thoughtStartedAt = 0;
    let msgId = randomUUID();
    let msgText = '';
    const toolsById = new Map<string, { event: SuperAgentToolEvent; startedAt: number; rawName: string; rawArgs: Record<string, unknown>; cleanArgs: Record<string, unknown> }>();

    const cleanupTimers = () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
      }
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      cleanupTimers();
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      const force = setTimeout(() => { try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* ignore */ } }, 1500);
      force.unref();
      if (!promptStarted && !signal.aborted && !(err instanceof AcpBootstrapError)) {
        reject(new AcpBootstrapError(err.message));
      } else {
        reject(err);
      }
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      cleanupTimers();
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      const force = setTimeout(() => { try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* ignore */ } }, 1000);
      force.unref();
      resolve();
    };

    const sendRaw = (payload: unknown) => {
      if (!child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write(JSON.stringify(payload) + '\n');
      }
    };

    const request = (method: string, params: unknown, timeoutMs = 45_000): Promise<any> => {
      const id = ++seq;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`${opts.agentDef.label} ACP "${method}" timed out`));
        }, timeoutMs);
        timer.unref();
        pending.set(id, { resolve: res, reject: rej, timer });
        sendRaw({ jsonrpc: '2.0', id, method, params });
      });
    };

    const onAbort = () => {
      if (acpSessionId) {
        sendRaw({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: acpSessionId } });
      }
      fail(new Error('Agent conversation stopped'));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    const flushThought = async () => {
      if (!thoughtText) return;
      const elapsed = thoughtStartedAt ? Math.max(0, Date.now() - thoughtStartedAt) : undefined;
      await callbacks.onReasoningComplete(thoughtId, thoughtText, elapsed);
      thoughtId = randomUUID();
      thoughtText = '';
      thoughtStartedAt = 0;
    };

    const flushAssistantText = async () => {
      if (!msgText) return;
      await callbacks.onMessageComplete(msgId, msgText);
      msgId = randomUUID();
      msgText = '';
    };

    const handleSessionUpdate = async (update: any) => {
      if (!update || typeof update !== 'object' || replaySuppress) return;
      const kind = String(update.sessionUpdate || '');

      if (kind === 'agent_thought_chunk') {
        const delta = typeof update.content?.text === 'string' ? update.content.text : '';
        if (!delta) return;
        if (!thoughtStartedAt) thoughtStartedAt = Date.now();
        thoughtText += delta;
        await callbacks.onStatus('thinking');
        await callbacks.onReasoningDelta(thoughtId, delta);
        return;
      }

      if (kind === 'agent_message_chunk') {
        const delta = typeof update.content?.text === 'string' ? update.content.text : '';
        if (!delta) return;
        await flushThought();
        msgText += delta;
        await callbacks.onStatus('streaming');
        await callbacks.onMessageDelta(msgId, delta);
        return;
      }

      if (kind === 'plan' && Array.isArray(update.entries)) {
        const entries: SuperAgentPlanEntry[] = update.entries
          .filter((e: any) => e && typeof e.content === 'string')
          .map((e: any) => ({
            content: String(e.content),
            status: e.status === 'completed' || e.status === 'in_progress' ? e.status : 'pending',
            ...(e.priority === 'low' || e.priority === 'medium' || e.priority === 'high' ? { priority: e.priority } : {}),
          }));
        await callbacks.onPlanUpdate(entries);
        return;
      }

      if (kind === 'usage_update') {
        const usage = normalizeUsage(update);
        if (usage) await callbacks.onUsageUpdate(usage);
        return;
      }

      if (kind === 'session_info_update' && typeof update.title === 'string' && update.title.trim()) {
        await callbacks.onTitleSuggested?.(update.title.trim());
        return;
      }

      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const callId = String(update.toolCallId || update.id || randomUUID());
        const existing = toolsById.get(callId);
        const rawName = update.name
          ? String(update.name)
          : existing?.rawName && existing.rawName !== 'tool'
            ? existing.rawName
            : existing?.event.tool || 'tool';
        const rawArgs = (update.rawInput && typeof update.rawInput === 'object'
          ? update.rawInput
          : update.args && typeof update.args === 'object'
            ? update.args
            : existing?.rawArgs ?? {}) as Record<string, unknown>;
        const metaToolName = typeof update._meta?.toolName === 'string' ? update._meta.toolName : undefined;
        const unwrapped = unwrapToolNameAndArgs(
          rawName,
          rawArgs,
          typeof update.title === 'string' ? update.title : existing?.event.label,
          metaToolName,
        );
        const toolName = unwrapped.toolName;
        const cleanArgs = Object.keys(unwrapped.args).length > 0 ? unwrapped.args : existing?.cleanArgs ?? unwrapped.args;
        const acpDiffs = extractAcpDiffs(update.content);
        const classified = classifySuperAgentTool(toolName, cleanArgs, {
          kind: typeof update.kind === 'string' ? update.kind : undefined,
          title: typeof update.title === 'string' ? update.title : existing?.event.label,
          locations: Array.isArray(update.locations) ? update.locations : undefined,
          diffs: acpDiffs,
        });
        const statusStr = String(update.status || 'in_progress').toLowerCase();
        const isDone = statusStr === 'completed' || statusStr === 'failed' || statusStr === 'error' || statusStr === 'cancelled';
        const isOk = statusStr !== 'failed' && statusStr !== 'error' && statusStr !== 'cancelled';

        if (!existing) {
          await flushThought();
          await flushAssistantText();
          const startedAt = Date.now();
          const ev: SuperAgentToolEvent = {
            callId,
            tool: toolName,
            label: classified.label,
            status: isDone ? (isOk ? 'completed' : 'failed') : 'running',
            category: classified.category,
            ...(classified.command ? { command: classified.command } : {}),
            ...(classified.fileOp ? { fileOp: classified.fileOp } : {}),
            ...(classified.files ? { files: classified.files } : {}),
            ...(classified.summary ? { summary: classified.summary } : {}),
            inputPreview: previewText(cleanArgs, 1800),
            startedAt,
          };
          toolsById.set(callId, { event: ev, startedAt, rawName, rawArgs, cleanArgs });
          await callbacks.onStatus('tool', ev.label, toolName);
          await callbacks.onToolStarted(ev);
          if (!isDone) return;
        }

        const record = toolsById.get(callId)!;
        record.rawName = rawName;
        record.rawArgs = rawArgs;
        record.cleanArgs = cleanArgs;
        const { text: outText, parsed } = extractAcpTextOutput(update.rawOutput, update.content);
        const exitCode = extractExitCode(update.rawOutput);
        const now = Date.now();
        const mergedFiles: SuperAgentFileOperation[] | undefined = classified.files ?? record.event.files;
        const mergedFileOp = mergedFiles?.[0] ?? classified.fileOp ?? record.event.fileOp;
        const updatedEvent: SuperAgentToolEvent = {
          ...record.event,
          tool: toolName,
          label: classified.label || record.event.label,
          category: classified.category || record.event.category,
          ...(classified.command ?? record.event.command ? { command: classified.command ?? record.event.command } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(mergedFileOp ? { fileOp: mergedFileOp } : {}),
          ...(mergedFiles ? { files: mergedFiles } : {}),
          summary: classified.summary || record.event.summary,
          status: isDone ? (isOk ? 'completed' : 'failed') : 'running',
          ...(outText || update.rawOutput !== undefined ? { outputPreview: previewText(parsed ?? outText ?? update.rawOutput, 2400) } : {}),
          ...(isDone ? { finishedAt: now, durationMs: Math.max(0, now - record.startedAt) } : {}),
        };
        record.event = updatedEvent;
        if (isDone) {
          await callbacks.onToolFinished(updatedEvent, parsed, record.cleanArgs);
        } else {
          await callbacks.onStatus('tool', updatedEvent.label, toolName);
          await callbacks.onToolUpdated(updatedEvent);
        }
      }
    };

    const handleServerRequest = async (msg: any) => {
      const id = msg.id;
      const method = String(msg.method || '');
      const params = msg.params ?? {};
      if (method === 'session/request_permission') {
        const rawCall = params.toolCall ?? {};
        const title = String(rawCall.title || rawCall.name || 'Permission requested');
        const kind: SuperAgentApproval['kind'] =
          rawCall.kind === 'edit' || rawCall.kind === 'delete' || rawCall.kind === 'move'
            ? 'file'
            : rawCall.kind === 'execute'
              ? 'command'
              : 'tool';
        if (permissionMode === 'auto') {
          const optId = choosePermissionOption(params.options, true);
          sendRaw({
            jsonrpc: '2.0',
            id,
            result: optId ? { outcome: { outcome: 'selected', optionId: optId } } : { outcome: { outcome: 'cancelled' } },
          });
          return;
        }
        await callbacks.onStatus('waiting_approval', title);
        const accepted = await callbacks.onApprovalRequest(kind, title, JSON.stringify(rawCall, null, 2));
        const optId = choosePermissionOption(params.options, accepted);
        sendRaw({
          jsonrpc: '2.0',
          id,
          result: optId ? { outcome: { outcome: 'selected', optionId: optId } } : { outcome: { outcome: 'cancelled' } },
        });
        return;
      }
      sendRaw({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported host method: ${method}` } });
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16_000_000) {
        fail(new Error('Agent stream output exceeded limit'));
        return;
      }
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.method && msg.id !== undefined) {
          queue = queue.then(() => handleServerRequest(msg)).catch(err => fail(err instanceof Error ? err : new Error(String(err))));
        } else if (msg.id !== undefined && pending.has(msg.id)) {
          const entry = pending.get(msg.id)!;
          pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) {
            entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            entry.resolve(msg.result);
          }
        } else if (msg.method === 'session/update' && msg.params?.update) {
          queue = queue
            .then(() => handleSessionUpdate(msg.params.update))
            .catch(err => fail(err instanceof Error ? err : new Error(String(err))));
        }
      }
    });

    child.once('error', err => fail(err));
    child.once('exit', code => {
      void queue.then(() => {
        if (settled) return;
        const msg = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' ');
        fail(new Error(msg || `${opts.agentDef.label} ACP exited unexpectedly (${code ?? 'signal'})`));
      });
    });

    void (async () => {
      await callbacks.onStatus('connecting', opts.agentDef.label);
      const initResult = await request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'openmotion_super_agent', version: '1.0.0' },
        clientCapabilities: {},
      }, 20_000);
      const caps = initResult?.agentCapabilities ?? {};
      const canLoad = Boolean(caps.loadSession || caps.load_session || caps.sessionCapabilities?.load || caps.sessionCapabilities?.resume);

      let sessionResult: any;
      if (threadId && canLoad) {
        replaySuppress = true;
        try {
          const loadMethod = caps.sessionCapabilities?.resume ? 'session/resume' : 'session/load';
          sessionResult = await request(loadMethod, { sessionId: threadId, cwd, mcpServers }, 20_000);
          acpSessionId = threadId;
        } catch {
          acpSessionId = null;
        } finally {
          replaySuppress = false;
        }
      }

      const isFreshSession = !acpSessionId;
      if (!acpSessionId) {
        sessionResult = await request('session/new', { cwd, mcpServers }, 25_000);
        acpSessionId = String(sessionResult?.sessionId || '');
        if (!acpSessionId) throw new Error(`${opts.agentDef.label} ACP did not return a sessionId`);
        await callbacks.onThreadId(acpSessionId);
      }

      const { configModelValue, directModelId, effortValue } = resolveAcpModelAndEffort(
        model,
        reasoning,
        sessionResult?.configOptions,
      );
      const { modelOpt, thoughtOpt } = pickConfigValues(sessionResult?.configOptions);

      if (configModelValue && modelOpt?.id) {
        await request('session/set_config_option', {
          sessionId: acpSessionId,
          configId: modelOpt.id,
          value: configModelValue,
        }, 8_000).catch(() => {});
      } else if (directModelId) {
        await request('session/set_model', {
          sessionId: acpSessionId,
          modelId: directModelId,
        }, 8_000).catch(() => {});
      }
      if (effortValue && thoughtOpt?.id) {
        await request('session/set_config_option', {
          sessionId: acpSessionId,
          configId: thoughtOpt.id,
          value: effortValue,
        }, 8_000).catch(() => {});
      }

      promptStarted = true;
      await callbacks.onStatus('thinking');
      const fullText = isFreshSession && instructions
        ? `${instructions}\n\n${prompt}`
        : prompt;
      const promptResult = await request('session/prompt', {
        sessionId: acpSessionId,
        prompt: [{ type: 'text', text: fullText }],
      }, 25 * 60_000);

      await queue;
      await flushThought();
      await flushAssistantText();
      const usage = normalizeUsage(promptResult?.usage);
      if (usage) await callbacks.onUsageUpdate(usage);
      const stopReason = typeof promptResult?.stopReason === 'string' ? promptResult.stopReason : '';
      if (stopReason === 'cancelled' && !signal.aborted) {
        throw new Error('Agent run was cancelled before finishing. Click Continue to resume.');
      }
      if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
        throw new Error('Agent reached its turn limit before finishing. Click Continue to keep going.');
      }
      succeed();
    })().catch(err => {
      if (!promptStarted && err instanceof Error) {
        fail(err);
      } else {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

export async function runAcpAdapter(opts: AcpAdapterOptions): Promise<void> {
  const { agentDef } = opts;
  let acpBin = opts.bin;
  if (agentDef.acpBin && opts.resolveBin) {
    const resolved = await opts.resolveBin(agentDef.acpBin).catch(() => null);
    if (resolved) acpBin = resolved;
  }

  const baseCandidates: string[][] = [
    agentDef.acpArgs ?? ['acp'],
    ...(agentDef.acpFallbacks ?? []),
  ];

  let lastError: Error | null = null;
  for (let i = 0; i < baseCandidates.length; i++) {
    const baseArgs = [...baseCandidates[i]];
    if (agentDef.id === 'antigravity' && opts.permissionMode === 'auto' && !baseArgs.includes('--dangerously-skip-permissions')) {
      baseArgs.push('--dangerously-skip-permissions');
    }
    try {
      await runSingleAcpAttempt(acpBin, baseArgs, opts);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!(err instanceof AcpBootstrapError) || opts.signal.aborted) {
        throw lastError;
      }
    }
  }

  if (lastError) throw lastError;
}

/**
 * Print-mode JSONL fallback for Antigravity CLI (`agy --output-format stream-json -p=...`).
 */
export async function runAgyPrintStreamAdapter(opts: {
  bin: string;
  cwd: string;
  prompt: string;
  instructions?: string;
  model?: string;
  reasoning?: string;
  threadId?: string;
  permissionMode: SuperAgentPermissionMode;
  signal: AbortSignal;
  callbacks: ProviderAdapterCallbacks;
}): Promise<void> {
  opts.signal.throwIfAborted();
  const fullPrompt = opts.instructions ? `${opts.instructions}\n\n${opts.prompt}` : opts.prompt;
  const args = [
    '--output-format', 'stream-json',
    ...(opts.permissionMode === 'auto' ? ['--dangerously-skip-permissions'] : []),
    ...(opts.model && opts.model !== 'default' ? ['--model', opts.model] : []),
    ...(opts.reasoning && opts.reasoning !== 'default' ? ['--effort', opts.reasoning] : []),
    ...(opts.threadId ? ['--conversation', opts.threadId] : []),
    `-p=${fullPrompt}`,
  ];

  await opts.callbacks.onStatus('connecting', 'Antigravity');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opts.bin, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buffer = '';
    let stderr = '';
    let settled = false;
    let queue: Promise<unknown> = Promise.resolve();
    const stepBuffers = new Map<number, { id: string; text: string; startedAt: number; rawTool?: any; cleanArgs?: Record<string, unknown> }>();
    let finalResponseSent = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener('abort', onAbort);
      reject(err);
    };
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      fail(new Error('Agent conversation stopped'));
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const processLine = async (ev: any) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.event === 'init' && typeof ev.conversation_id === 'string') {
        await opts.callbacks.onThreadId(ev.conversation_id);
        await opts.callbacks.onStatus('thinking');
        return;
      }
      if (ev.event === 'step_update' && ev.step_update) {
        const s = ev.step_update;
        const idx = Number(s.step_index ?? 0);
        const stepType = String(s.step_type || '');
        const state = String(s.state || '');

        if (stepType === 'tool') {
          const toolName = String(s.tool_name || s.tool_info?.name || 'tool');
          const toolArgs = (s.tool_info?.parameters && typeof s.tool_info.parameters === 'object'
            ? s.tool_info.parameters
            : {}) as Record<string, unknown>;
          const { toolName: unwrappedName, args: cleanArgs } = unwrapToolNameAndArgs(toolName, toolArgs);
          const classified = classifySuperAgentTool(unwrappedName, cleanArgs);
          let entry = stepBuffers.get(idx);
          if (!entry) {
            const startedAt = Date.now();
            const callId = `agy-step-${idx}`;
            const toolEv: SuperAgentToolEvent = {
              callId,
              tool: unwrappedName,
              label: classified.label,
              status: 'running',
              category: classified.category,
              ...(classified.command ? { command: classified.command } : {}),
              ...(classified.fileOp ? { fileOp: classified.fileOp } : {}),
              ...(classified.files ? { files: classified.files } : {}),
              ...(classified.summary ? { summary: classified.summary } : {}),
              inputPreview: previewText(cleanArgs, 1800),
              startedAt,
            };
            entry = { id: callId, text: '', startedAt, rawTool: toolEv, cleanArgs };
            stepBuffers.set(idx, entry);
            await opts.callbacks.onStatus('tool', toolEv.label, unwrappedName);
            await opts.callbacks.onToolStarted(toolEv);
          }
          if (state === 'DONE' || state === 'ERROR') {
            const now = Date.now();
            const ok = state === 'DONE';
            const outText = typeof s.tool_info?.output === 'string' ? s.tool_info.output : undefined;
            const exitCode = extractExitCode(s.tool_info);
            const doneEv: SuperAgentToolEvent = {
              ...(entry.rawTool as SuperAgentToolEvent),
              status: ok ? 'completed' : 'failed',
              ...(exitCode !== undefined ? { exitCode } : {}),
              ...(outText ? { outputPreview: previewText(outText, 2400) } : {}),
              finishedAt: now,
              durationMs: typeof s.duration_seconds === 'number' ? Math.round(s.duration_seconds * 1000) : Math.max(0, now - entry.startedAt),
            };
            await opts.callbacks.onToolFinished(doneEv, s.tool_info?.output, entry.cleanArgs);
          }
          return;
        }

        if (stepType === 'agent_response') {
          let entry = stepBuffers.get(idx);
          if (!entry) {
            entry = { id: `agy-msg-${idx}-${randomUUID().slice(0, 6)}`, text: '', startedAt: Date.now() };
            stepBuffers.set(idx, entry);
          }
          if (typeof s.text_delta === 'string' && s.text_delta) {
            entry.text += s.text_delta;
            await opts.callbacks.onStatus('streaming');
            await opts.callbacks.onMessageDelta(entry.id, s.text_delta);
          }
          if (state === 'DONE' && entry.text.trim()) {
            finalResponseSent = true;
            await opts.callbacks.onMessageComplete(entry.id, entry.text);
          }
          const usage = normalizeUsage(s.usage);
          if (usage) await opts.callbacks.onUsageUpdate(usage);
          return;
        }
      }
      if (ev.event === 'result' && ev.result) {
        const r = ev.result;
        if (!finalResponseSent && typeof r.response === 'string' && r.response.trim()) {
          await opts.callbacks.onMessageComplete(`agy-result-${randomUUID().slice(0, 8)}`, r.response);
        }
        const usage = normalizeUsage(r.usage);
        if (usage) await opts.callbacks.onUsageUpdate(usage);
        if (r.status && r.status !== 'SUCCESS') {
          throw new Error(typeof r.error === 'string' ? r.error : `Antigravity returned status ${r.status}`);
        }
      }
    };

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          queue = queue.then(() => processLine(parsed)).catch(err => fail(err instanceof Error ? err : new Error(String(err))));
        } catch {
          /* ignore non-JSON diagnostic lines */
        }
      }
    });
    child.once('error', err => fail(err));
    child.once('close', code => {
      opts.signal.removeEventListener('abort', onAbort);
      void queue.then(() => {
        if (settled) return;
        settled = true;
        if (code && code !== 0 && !finalResponseSent) {
          reject(new Error(stderr.trim() || `Antigravity exited with status ${code}`));
        } else {
          resolve();
        }
      }, fail);
    });
  });
}

/**
 * Pi coding agent RPC mode (`pi --mode rpc`).
 */
export async function runPiRpcAdapter(opts: {
  bin: string;
  cwd: string;
  prompt: string;
  instructions?: string;
  model?: string;
  signal: AbortSignal;
  callbacks: ProviderAdapterCallbacks;
}): Promise<void> {
  opts.signal.throwIfAborted();
  const args = [
    '--mode', 'rpc',
    '--no-session',
    ...(opts.model && opts.model !== 'default' ? ['--model', opts.model] : []),
  ];
  const command = await agentInvocation(opts.bin, args);

  await opts.callbacks.onStatus('connecting', 'Pi');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.bin, command.args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let settled = false;
    let stderr = '';
    const msgId = randomUUID();
    let msgText = '';
    const toolsById = new Map<string, { event: SuperAgentToolEvent; startedAt: number; args: Record<string, unknown> }>();

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener('abort', onAbort);
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      try { child.stdin.write(JSON.stringify({ id: 'abort-1', type: 'abort' }) + '\n'); } catch { /* ignore */ }
      finish(new Error('Agent conversation stopped'));
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    let queue: Promise<unknown> = Promise.resolve();
    rl.on('line', line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: any;
      try { ev = JSON.parse(trimmed); } catch { return; }
      queue = queue.then(async () => {
        if (ev.type === 'message_update' && ev.assistantMessageEvent) {
          const sub = ev.assistantMessageEvent;
          if (sub.type === 'text_delta' && typeof sub.delta === 'string') {
            msgText += sub.delta;
            await opts.callbacks.onStatus('streaming');
            await opts.callbacks.onMessageDelta(msgId, sub.delta);
          }
        } else if (ev.type === 'tool_execution_start') {
          const callId = String(ev.toolCallId || randomUUID());
          const toolName = String(ev.toolName || 'tool');
          const args = (ev.args && typeof ev.args === 'object' ? ev.args : {}) as Record<string, unknown>;
          const classified = classifySuperAgentTool(toolName, args);
          const startedAt = Date.now();
          const toolEv: SuperAgentToolEvent = {
            callId,
            tool: toolName,
            label: classified.label,
            status: 'running',
            category: classified.category,
            ...(classified.command ? { command: classified.command } : {}),
            ...(classified.fileOp ? { fileOp: classified.fileOp } : {}),
            ...(classified.files ? { files: classified.files } : {}),
            ...(classified.summary ? { summary: classified.summary } : {}),
            inputPreview: previewText(args, 1800),
            startedAt,
          };
          toolsById.set(callId, { event: toolEv, startedAt, args });
          await opts.callbacks.onStatus('tool', toolEv.label, toolName);
          await opts.callbacks.onToolStarted(toolEv);
        } else if (ev.type === 'tool_execution_end') {
          const callId = String(ev.toolCallId || '');
          const rec = toolsById.get(callId);
          if (rec) {
            const now = Date.now();
            const ok = !ev.isError;
            await opts.callbacks.onToolFinished({
              ...rec.event,
              status: ok ? 'completed' : 'failed',
              outputPreview: previewText(ev.result, 2400),
              finishedAt: now,
              durationMs: Math.max(0, now - rec.startedAt),
            }, ev.result, rec.args);
          }
        } else if (ev.type === 'agent_end' || (ev.type === 'response' && ev.command === 'prompt' && ev.success === false)) {
          if (ev.success === false) {
            throw new Error(ev.error || 'Pi agent failed');
          }
          if (msgText) await opts.callbacks.onMessageComplete(msgId, msgText);
          finish();
        }
      }).catch(err => finish(err instanceof Error ? err : new Error(String(err))));
    });

    child.once('error', finish);
    child.once('close', code => {
      void queue.then(() => {
        if (settled) return;
        if (code && code !== 0 && !msgText.trim()) {
          finish(new Error(stderr.trim() || `Pi exited (${code})`));
        } else {
          void Promise.resolve(msgText ? opts.callbacks.onMessageComplete(msgId, msgText) : undefined)
            .then(() => finish(), finish);
        }
      });
    });

    const fullPrompt = opts.instructions ? `${opts.instructions}\n\n${opts.prompt}` : opts.prompt;
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ id: 'prompt-1', type: 'prompt', message: fullPrompt }) + '\n');
  });
}

/**
 * Clean non-interactive fallback for CLIs without structured RPC/ACP (e.g., Aider or custom scripts).
 */
export async function runCliFallbackAdapter(opts: {
  agentDef?: AgentDefinition;
  bin: string;
  cwd: string;
  prompt: string;
  instructions?: string;
  model?: string;
  signal: AbortSignal;
  callbacks: ProviderAdapterCallbacks;
}): Promise<void> {
  opts.signal.throwIfAborted();
  const fullPrompt = opts.instructions ? `${opts.instructions}\n\n${opts.prompt}` : opts.prompt;
  const isAider = opts.agentDef?.id === 'aider';
  const args = [...(opts.agentDef?.startArgs ?? [])];
  if (opts.model && opts.model !== 'default' && opts.agentDef?.modelFlag) {
    args.push(opts.agentDef.modelFlag, opts.model);
  }
  if (isAider) {
    args.push('--yes-always', '--no-auto-commits', '--no-pretty', '--message', fullPrompt);
  }

  const command = await agentInvocation(opts.bin, args);
  await opts.callbacks.onStatus('connecting', opts.agentDef?.label || 'Agent');
  const msgId = randomUUID();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      if (!settled) {
        settled = true;
        reject(new Error('Agent conversation stopped'));
      }
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      void opts.callbacks.onStatus('streaming');
      void opts.callbacks.onMessageDelta(msgId, chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.once('error', err => {
      opts.signal.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.once('close', code => {
      opts.signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      if (opts.signal.aborted) {
        resolve();
        return;
      }
      if (code && code !== 0 && !stdout.trim()) {
        const detail = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' ');
        reject(new Error(detail || `${opts.agentDef?.label ?? 'Agent'} exited with code ${code ?? 'unknown'}`));
        return;
      }
      void Promise.resolve(stdout.trim() ? opts.callbacks.onMessageComplete(msgId, stdout) : undefined)
        .then(() => resolve(), reject);
    });

    child.stdin.on('error', () => {});
    if (isAider) {
      child.stdin.end();
    } else {
      child.stdin.end(`${fullPrompt}\n`);
    }
  });
}
