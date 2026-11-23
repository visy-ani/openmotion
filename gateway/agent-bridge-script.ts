import { AGENT_RUNTIMES_API, BRIDGE_SCRIPT_VERSION } from '../shared/agent-runtimes.ts';
import { localAgents } from '../shared/local-agents.ts';

const SAFE_TOKEN = /^[A-Za-z0-9_-]{12,128}$/;

export function renderBridgeInstallShellScript(options: { serverUrl: string; token: string }): string {
  const token = String(options.token || '').trim();
  if (!SAFE_TOKEN.test(token)) {
    throw new Error('Invalid bridge token');
  }
  const parsed = new URL(options.serverUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Invalid server URL');
  }
  const serverUrl = parsed.origin;
  if (/['"\r\n\0\\$`<>|;&()]/.test(serverUrl)) {
    throw new Error('Server URL contains unsupported shell characters');
  }
  const scriptUrl = `${serverUrl}${AGENT_RUNTIMES_API}/bridge/script`;
  const configJson = JSON.stringify({ serverUrl, token }, null, 2);

  return `#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js (>= 20) is required to run OpenMotion Agent Bridge." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js >= 20 is required (found $(node -v))." >&2
  exit 1
fi

BRIDGE_DIR="\${HOME}/.openmotion-bridge"
mkdir -p "$BRIDGE_DIR"
chmod 700 "$BRIDGE_DIR"

curl -fsSL '${scriptUrl}' -o "$BRIDGE_DIR/openmotion-agent-bridge.mjs"
chmod 600 "$BRIDGE_DIR/openmotion-agent-bridge.mjs"

cat > "$BRIDGE_DIR/config.json" <<'EOF'
${configJson}
EOF
chmod 600 "$BRIDGE_DIR/config.json"

echo "OpenMotion Agent Bridge installed in $BRIDGE_DIR"
exec node "$BRIDGE_DIR/openmotion-agent-bridge.mjs" --config "$BRIDGE_DIR/config.json" "$@"
`;
}

export function renderBridgeInstallPowerShellScript(options: { serverUrl: string; token: string }): string {
  const token = String(options.token || '').trim();
  if (!SAFE_TOKEN.test(token)) {
    throw new Error('Invalid bridge token');
  }
  const parsed = new URL(options.serverUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Invalid server URL');
  }
  const serverUrl = parsed.origin;
  if (/['"\r\n\0\\$`<>|;&()]/.test(serverUrl)) {
    throw new Error('Server URL contains unsupported shell characters');
  }
  const scriptUrl = `${serverUrl}${AGENT_RUNTIMES_API}/bridge/script`;
  const configJson = JSON.stringify({ serverUrl, token }, null, 2);

  return `$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Node.js (>= 20) is required to run OpenMotion Agent Bridge.'
  exit 1
}

$nodeMajor = [int](& node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 20) {
  Write-Error "Node.js >= 20 is required (found $(& node -v))."
  exit 1
}

$bridgeDir = Join-Path $HOME '.openmotion-bridge'
New-Item -ItemType Directory -Force -Path $bridgeDir | Out-Null

$scriptPath = Join-Path $bridgeDir 'openmotion-agent-bridge.mjs'
Invoke-WebRequest -UseBasicParsing -Uri '${scriptUrl}' -OutFile $scriptPath

$configPath = Join-Path $bridgeDir 'config.json'
@'
${configJson}
'@ | Set-Content -Path $configPath -Encoding UTF8

Write-Host "OpenMotion Agent Bridge installed in $bridgeDir"
& node $scriptPath --config $configPath @args
`;
}

export function renderStandaloneBridgeScript(options: {
  defaultServerUrl?: string;
  version?: string;
} = {}): string {
  const defaultServerUrl = options.defaultServerUrl || '';
  const version = options.version || BRIDGE_SCRIPT_VERSION;
  const embeddedAgents = JSON.stringify(localAgents, null, 2);

  return `#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const BRIDGE_VERSION = ${JSON.stringify(version)};
const API_PREFIX = ${JSON.stringify(AGENT_RUNTIMES_API)};
const DEFAULT_SERVER_URL = ${JSON.stringify(defaultServerUrl)};
const LOCAL_AGENTS = ${embeddedAgents};
const SCRIPT_PATH = fileURLToPath(import.meta.url);

const stripAnsi = value => String(value || '').replace(/\\x1b\\[[0-9;]*[a-zA-Z]/g, '');
const validModelId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+ -]{0,199}$/.test(value);

function normalizeAgentModels(input, source = 'cli') {
  const seen = new Set();
  return (Array.isArray(input) ? input : []).flatMap(value => {
    if (!value || value.visibility === 'hide') return [];
    const id = typeof value === 'string' ? value : value.slug ?? value.modelId ?? value.id ?? value.value;
    if (!validModelId(id) || seen.has(id) || id === 'default') return [];
    seen.add(id);
    const title = value.display_name ?? value.name ?? value.label;
    const reasoning = Array.isArray(value.supported_reasoning_levels)
      ? value.supported_reasoning_levels.map(r => r?.effort).filter(validModelId)
      : undefined;
    return [{
      id,
      label: typeof title === 'string' ? title.slice(0, 180) : id,
      source,
      ...(reasoning?.length ? { reasoning } : {}),
    }];
  }).slice(0, 1500);
}

async function resolveBinary(bin) {
  const override = process.env[\`\${bin.toUpperCase()}_BIN\`];
  const names = bin === 'cursor-agent' ? ['cursor-agent', 'agent'] : [bin];
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter).filter(dir => path.isAbsolute(dir)),
    path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), '.bun/bin'),
    path.join(os.homedir(), '.cargo/bin'),
    path.join(os.homedir(), '.npm-global/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(process.platform === 'win32' && process.env.APPDATA ? [path.join(process.env.APPDATA, 'npm')] : []),
  ];
  const candidates = [
    override,
    ...dirs.flatMap(dir =>
      names.flatMap(name =>
        (process.platform === 'win32' ? ['.exe', '.cmd'] : ['']).map(ext => path.join(dir, name + ext)),
      ),
    ),
  ];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

async function agentInvocation(bin, args) {
  if (!/\\.cmd$/i.test(bin)) return { bin, args };
  const source = await readFile(bin, 'utf8');
  const relative = source.match(/"%(?:dp0|~dp0)%?\\\\([^"\\r\\n]+\\.(?:[cm]?js))"/i)?.[1];
  if (!relative || relative.includes('..') || /[%!]/.test(relative)) {
    throw new Error('Unsupported CLI shim; use the official executable');
  }
  return { bin: process.execPath, args: [path.resolve(path.dirname(bin), ...relative.split('\\\\')), ...args] };
}

async function probeCli(bin, args) {
  try {
    const cmd = await agentInvocation(bin, args);
    return await new Promise(resolve =>
      execFile(cmd.bin, cmd.args, { timeout: 12_000, maxBuffer: 12 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) =>
        resolve({ ok: !error, text: stdout || stderr }),
      ),
    );
  } catch {
    return { ok: false, text: '' };
  }
}

function parseAgentModels(kind, raw) {
  const text = stripAnsi(raw);
  if (kind === 'codex') {
    const value = JSON.parse(text);
    return normalizeAgentModels(Array.isArray(value) ? value : value.models ?? []);
  }
  if (kind === 'help') {
    const choices = text.match(/--model[^\\n]*?Currently supported:\\s*\\(([^)]*)\\)/i)?.[1];
    return normalizeAgentModels(choices?.split(',').map(v => v.trim()) ?? []);
  }
  if (kind === 'pi') {
    return normalizeAgentModels(text.split('\\n').flatMap(line => {
      const cells = line.trim().split(/\\s+/);
      return cells.length >= 3 && cells[0] !== 'provider' && /^[\\w-]+$/.test(cells[0]) && validModelId(cells[1])
        ? [\`\${cells[0]}/\${cells[1]}\`]
        : [];
    }));
  }
  return normalizeAgentModels(text.split('\\n').flatMap(line => {
    const id = line.trim().replace(/^[*•-]\\s+/, '').split(/\\s+(?:-|\\()/)[0];
    return /^[\\w][\\w./:@+-]+$/.test(id) && (id.includes('/') || /[.-]/.test(id) || id === 'auto') ? [id] : [];
  }));
}

function parseAgentAuth(ok, raw) {
  try {
    const value = JSON.parse(raw);
    if (typeof value.loggedIn === 'boolean') return value.loggedIn ? 'signed-in' : 'signed-out';
  } catch { /* text CLI */ }
  const text = stripAnsi(raw);
  if (/not (?:logged in|authenticated)|authentication required|please (?:log|sign) in|no credentials|expired token/i.test(text)) {
    return 'signed-out';
  }
  if (ok && /logged in|authenticated/i.test(text)) return 'signed-in';
  return 'unknown';
}

async function discoverQwenModels() {
  const file = process.env.QWEN_SETTINGS_FILE || path.join(os.homedir(), '.qwen/settings.json');
  if ((await stat(file)).size > 1024 * 1024) return [];
  const value = JSON.parse(await readFile(file, 'utf8'));
  const entries = Object.values(value.modelProviders ?? {}).flatMap(list =>
    Array.isArray(list) ? list.map(item => ({ id: item.id, label: item.name })) : [],
  );
  if (typeof value.model === 'string') entries.push({ id: value.model, label: value.model });
  else if (value.model?.name) entries.push({ id: value.model.name, label: value.model.name });
  return normalizeAgentModels(entries);
}

async function discoverAcp(bin, args) {
  const cmd = await agentInvocation(bin, args);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmotion-bridge-acp-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(cmd.bin, cmd.args, { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let finished = false, buffer = '', bytes = 0;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.kill();
        const force = setTimeout(() => child.kill('SIGKILL'), 500);
        force.unref();
        const settle = () => { clearTimeout(force); error ? reject(error) : resolve(value); };
        if (child.exitCode !== null || child.signalCode !== null || !child.pid) settle();
        else child.once('close', settle);
      };
      const timer = setTimeout(() => finish(new Error('Agent model discovery timed out')), 12_000);
      const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.once('error', () => finish(new Error('Could not start Agent model discovery')));
      child.once('exit', () => finish(new Error('Agent closed model discovery')));
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) return finish(new Error('Agent model response is too large'));
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf('\\n');
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.method && msg.id !== undefined) {
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unsupported' } }) + '\\n');
            } else if (msg.error) {
              const auth = /auth|login|sign.?in/i.test(msg.error.message ?? '') ? 'signed-out' : 'unknown';
              if (auth === 'signed-out') finish(undefined, { models: [], auth });
              else finish(new Error('Agent could not list models'));
            } else if (msg.id === 1) {
              send(2, 'session/new', { cwd: directory, mcpServers: [] });
            } else if (msg.id === 2) {
              const result = msg.result ?? {};
              const config = (result.configOptions ?? [])
                .filter(item => item.category === 'model' || item.id === 'model')
                .flatMap(item => (item.options ?? []).flatMap(opt => opt.options ?? [opt]));
              finish(undefined, { models: normalizeAgentModels(result.models?.availableModels ?? config), auth: 'unknown' });
            }
          } catch { /* ignore */ }
        }
      });
      send(1, 'initialize', { protocolVersion: 1, clientInfo: { name: 'openmotion-bridge', version: '1' }, clientCapabilities: {} });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function inspectOneAgent(id) {
  const def = LOCAL_AGENTS.find(item => item.id === id);
  if (!def) throw new Error('Unknown Agent');
  const bin = await resolveBinary(def.bin);
  const result = { ...def, installed: Boolean(bin), auth: 'unknown', models: [], checkedAt: new Date().toISOString() };
  if (!bin) return result;
  const [version, help] = await Promise.all([
    probeCli(bin, ['--version']),
    probeCli(bin, [...(def.startArgs ?? []), '--help']),
  ]);
  result.version = version.ok ? version.text.match(/\\b\\d+\\.\\d+(?:\\.\\d+)?(?:[-+][\\w.-]+)?\\b/)?.[0] : undefined;
  result.modelFlag = help.ok && /--model\\b/.test(help.text) ? '--model' : undefined;
  const authArgs = id === 'codex'
    ? ['login', 'status']
    : ['claude', 'openclaude'].includes(id)
      ? ['auth', 'status']
      : id === 'cursor-agent'
        ? ['status']
        : undefined;
  if (authArgs) {
    const auth = await probeCli(bin, authArgs);
    result.auth = parseAgentAuth(auth.ok, auth.text);
  }
  try {
    if (def.discovery === 'codex') {
      const models = await probeCli(bin, ['debug', 'models']);
      if (!models.ok) throw new Error('Model discovery unavailable');
      result.models = parseAgentModels('codex', models.text);
    } else if (def.discovery === 'claude') {
      result.models = normalizeAgentModels(['sonnet', 'opus', 'haiku'], 'alias');
    } else if (def.discovery === 'qwen') {
      result.models = await discoverQwenModels();
    } else if (def.discovery === 'acp' && def.acpArgs) {
      const data = await discoverAcp(bin, def.acpArgs);
      result.models = data.models;
      if (data.auth !== 'unknown') result.auth = data.auth;
    } else if (def.discovery === 'help') {
      result.models = parseAgentModels('help', help.text);
    } else if (def.modelArgs) {
      const data = await probeCli(bin, def.modelArgs);
      if (!data.ok) throw new Error('Model discovery unavailable');
      result.models = parseAgentModels(def.discovery, data.text);
    }
  } catch {
    result.discoveryError = 'Could not discover models. Sign in or update the Agent, then refresh.';
  }
  return result;
}

async function scanLocalAgents() {
  const eagerIds = new Set(['codex', 'claude']);
  return Promise.all(LOCAL_AGENTS.map(async def => {
    const bin = await resolveBinary(def.bin);
    if (!bin) return { ...def, installed: false, auth: 'unknown', models: [] };
    if (eagerIds.has(def.id)) {
      return inspectOneAgent(def.id).catch(() => ({ ...def, installed: true, auth: 'unknown', models: [] }));
    }
    return { ...def, installed: true, auth: 'unknown', models: [] };
  }));
}

class CodexAppRpc {
  constructor(bin, cwd, onMessage, onClose) {
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = '';
    this.child = spawn(bin, ['app-server', '--listen', 'stdio://'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.resume();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 8_000_000) { this.close(); return; }
      let end;
      while ((end = this.buffer.indexOf('\\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          const pending = this.pending.get(message.id);
          if (!message.method && pending) {
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(message.error.message || 'Agent request failed'));
            else pending.resolve(message.result);
          } else {
            onMessage(message);
          }
        } catch {
          onClose(new Error('Invalid Agent protocol response'));
          this.close();
        }
      }
    });
    const close = () => {
      const error = new Error('Agent connection closed');
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      onClose(error);
    };
    this.child.once('error', close);
    this.child.once('exit', close);
  }
  send(value) {
    if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + '\\n');
  }
  request(method, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(\`Agent \${method} timed out\`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  close() {
    this.child.kill();
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL'); }, 2000);
    timer.unref();
  }
}

async function consumeSse(stream, onFrame) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flushBlock = async block => {
    let eventType = 'message';
    const dataParts = [];
    for (const line of block.split(/\\r?\\n/)) {
      if (!line || line.startsWith(':')) continue;
      const idx = line.indexOf(':');
      const field = idx >= 0 ? line.slice(0, idx) : line;
      const raw = idx >= 0 ? line.slice(idx + 1) : '';
      const val = raw.startsWith(' ') ? raw.slice(1) : raw;
      if (field === 'event') eventType = val || 'message';
      else if (field === 'data') dataParts.push(val);
    }
    if (dataParts.length) await onFrame(eventType, dataParts.join('\\n'));
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const match = buffer.match(/\\r?\\n\\r?\\n/);
        if (!match || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (block.trim()) await flushBlock(block);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function runMcpRelay() {
  const serverUrl = process.env.OM_BRIDGE_SERVER || '';
  const token = process.env.OM_BRIDGE_TOKEN || '';
  const runId = process.env.OM_BRIDGE_RUN_ID || '';
  const tools = JSON.parse(Buffer.from(process.env.OM_BRIDGE_TOOLS_B64 || 'W10=', 'base64').toString('utf8'));
  const reply = obj => process.stdout.write(JSON.stringify(obj) + '\\n');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { continue; }
    if (msg.id === undefined || msg.id === null) continue;
    if (msg.method === 'initialize') {
      reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'openmotion-bridge-mcp', version: BRIDGE_VERSION } } });
    } else if (msg.method === 'tools/list') {
      reply({ jsonrpc: '2.0', id: msg.id, result: { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } });
    } else if (msg.method === 'tools/call') {
      const toolName = String(msg.params?.name || '').replace(/^mcp__openmotion__/, '');
      const toolArgs = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
      try {
        const res = await fetch(\`\${serverUrl}\${API_PREFIX}/bridge/tool-call\`, {
          method: 'POST',
          headers: { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId, callId: String(msg.id), tool: toolName, arguments: toolArgs }),
        });
        const data = await res.json();
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: data.error || JSON.stringify(data.structuredContent ?? {}) }],
            ...(data.structuredContent !== undefined ? { structuredContent: data.structuredContent } : {}),
            ...(!res.ok || data.ok === false ? { isError: true } : {}),
          },
        });
      } catch (err) {
        reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true } });
      }
    } else {
      reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: \`Unsupported method: \${msg.method}\` } });
    }
  }
}

async function runMain() {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mcp-relay') flags.mcpRelay = true;
    else if (args[i].startsWith('--') && i + 1 < args.length) flags[args[i].slice(2)] = args[++i];
  }
  if (flags.mcpRelay) {
    await runMcpRelay();
    return;
  }
  let serverUrl = flags.server || DEFAULT_SERVER_URL;
  let token = flags.token || '';
  let name = flags.name || os.hostname() || 'Local Machine';
  const configDir = path.join(os.homedir(), '.openmotion-bridge');
  if (flags.config) {
    const cfg = JSON.parse(await readFile(flags.config, 'utf8'));
    serverUrl = cfg.serverUrl || serverUrl;
    token = cfg.token || token;
    name = cfg.name || name;
  }
  if (!serverUrl || !token) {
    console.error('Usage: node openmotion-agent-bridge.mjs --server <url> --token <token> [--name <label>]');
    process.exit(1);
  }
  serverUrl = new URL(serverUrl).origin;
  let machineId = '';
  const machineFile = path.join(configDir, 'machine-id');
  try { machineId = (await readFile(machineFile, 'utf8')).trim(); } catch {}
  if (!machineId) {
    machineId = randomUUID();
    await mkdir(configDir, { recursive: true, mode: 0o700 }).catch(() => {});
    await writeFile(machineFile, machineId, { mode: 0o600 }).catch(() => {});
  }

  const postJson = async (apiPath, body, signal) => {
    const res = await fetch(\`\${serverUrl}\${API_PREFIX}\${apiPath}\`, {
      method: 'POST',
      headers: { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    let parsed = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text }; }
    if (!res.ok) throw new Error(parsed?.error || \`Bridge request failed (\${res.status})\`);
    return parsed;
  };

  let agents = await scanLocalAgents();
  const reg = await postJson('/bridge/register', {
    machineId,
    name,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    bridgeVersion: BRIDGE_VERSION,
    agents,
  });
  const runtimeId = reg.runtimeId;
  console.log(\`[openmotion-bridge] Connected "\${name}" (\${runtimeId}) -> \${serverUrl}\`);
  console.log(\`[openmotion-bridge] Installed local Agents: \${agents.filter(a => a.installed).map(a => a.label).join(', ') || 'none detected yet'}\`);

  const activeRuns = new Map();
  let stopped = false;
  const loopController = new AbortController();

  const hb = setInterval(() => {
    if (!stopped) {
      void postJson('/bridge/heartbeat', { runtimeId, bridgeVersion: BRIDGE_VERSION, agents }).catch(() => {});
    }
  }, 15_000);
  hb.unref();

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(hb);
    loopController.abort();
    for (const run of activeRuns.values()) {
      run.controller.abort();
      run.kill();
    }
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const sendEvent = (runId, event) => postJson('/bridge/events', { runId, event });

  const dispatchTurn = async dispatch => {
    const runController = new AbortController();
    let kill = () => {};
    activeRuns.set(dispatch.runId, { controller: runController, kill: () => kill() });
    const workRoot = await mkdtemp(path.join(os.tmpdir(), 'openmotion-bridge-run-'));
    try {
      let resolvedWorkingDir;
      if (typeof dispatch.workingDir === 'string' && dispatch.workingDir.trim()) {
        const rawDir = dispatch.workingDir.trim();
        if (rawDir.includes('\\0') || rawDir.length > 1024 || !path.isAbsolute(rawDir)) {
          await sendEvent(dispatch.runId, { type: 'turn.failed', error: 'Working directory must be an absolute folder path on the bridge machine' });
          return;
        }
        const st = await stat(rawDir).catch(() => null);
        if (!st?.isDirectory()) {
          await sendEvent(dispatch.runId, { type: 'turn.failed', error: \`Working directory does not exist on \${name}: \${rawDir}\` });
          return;
        }
        resolvedWorkingDir = await realpath(rawDir);
      }
      const execCwd = resolvedWorkingDir || workRoot;

      const def = LOCAL_AGENTS.find(item => item.id === dispatch.engine);
      const bin = await resolveBinary(def?.bin || dispatch.engine);
      if (!bin) {
        await sendEvent(dispatch.runId, { type: 'turn.failed', error: \`\${def?.label || dispatch.engine} CLI is not installed on \${name}\` });
        return;
      }
      if (dispatch.engine === 'codex') {
        await new Promise((resolve, reject) => {
          let settled = false;
          let rpc;
          const finish = err => {
            if (settled) return;
            settled = true;
            runController.signal.removeEventListener('abort', onAbort);
            err ? reject(err) : resolve();
          };
          const onAbort = () => { rpc?.close(); finish(); };
          runController.signal.addEventListener('abort', onAbort, { once: true });
          kill = () => rpc?.close();
          rpc = new CodexAppRpc(bin, execCwd, async msg => {
            const { method, params: p = {}, id } = msg;
            try {
              if (method === 'item/tool/call' && id !== undefined) {
                const res = await postJson('/bridge/tool-call', {
                  runId: dispatch.runId,
                  callId: String(p.callId || randomUUID()),
                  tool: String(p.tool || ''),
                  arguments: p.arguments && typeof p.arguments === 'object' ? p.arguments : {},
                }, runController.signal);
                const contentItems = Array.isArray(res.contentItems) && res.contentItems.length
                  ? res.contentItems.map(item => item.type === 'image' && item.imageUrl ? { type: 'inputImage', imageUrl: item.imageUrl } : item.type?.startsWith('input') ? item : { type: 'inputText', text: item.text ?? JSON.stringify(res.structuredContent ?? {}) })
                  : [{ type: 'inputText', text: res.error ? JSON.stringify({ error: res.error }) : JSON.stringify(res.structuredContent ?? {}) }];
                rpc.send({ id, result: { contentItems, success: res.ok !== false } });
              } else if (id !== undefined && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
                rpc.send({ id, result: { decision: dispatch.permissionMode === 'auto' ? 'accept' : 'decline' } });
              } else if (id !== undefined) {
                rpc.send({ id, error: { code: -32601, message: 'Unsupported host request in bridge session' } });
              } else if (method === 'turn/started') {
                await sendEvent(dispatch.runId, { type: 'status.update', phase: 'thinking' });
              } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
                await sendEvent(dispatch.runId, { type: 'reasoning.delta', messageId: String(p.itemId || 'reasoning'), delta: String(p.delta ?? '') });
              } else if (method === 'item/started' && p.item && ['commandExecution', 'fileChange', 'webSearch'].includes(p.item.type)) {
                const it = p.item;
                await sendEvent(dispatch.runId, {
                  type: 'tool.started',
                  callId: String(it.id || randomUUID()),
                  tool: String(it.type),
                  args: it.type === 'commandExecution' ? { command: it.command } : it.type === 'webSearch' ? { query: it.query } : { changes: it.changes },
                });
              } else if (method === 'item/agentMessage/delta') {
                await sendEvent(dispatch.runId, { type: 'message.delta', messageId: String(p.itemId || 'assistant'), delta: String(p.delta ?? '') });
              } else if (method === 'item/completed' && p.item?.type === 'agentMessage') {
                await sendEvent(dispatch.runId, { type: 'message.complete', messageId: String(p.item.id || 'assistant'), text: String(p.item.text ?? '') });
              } else if (method === 'item/completed' && p.item?.type === 'reasoning') {
                const summaryParts = Array.isArray(p.item.summary) ? p.item.summary.map(s => String(s?.text ?? s ?? '')).filter(Boolean) : [];
                const contentParts = Array.isArray(p.item.content) ? p.item.content.map(c => String(c?.text ?? c ?? '')).filter(Boolean) : [];
                const fullText = [p.item.text, ...summaryParts, ...contentParts].filter(Boolean).join('\\n').trim();
                if (fullText) {
                  await sendEvent(dispatch.runId, { type: 'reasoning.complete', messageId: String(p.item.id || 'reasoning'), text: fullText });
                }
              } else if (method === 'item/completed' && p.item?.type === 'commandExecution') {
                const it = p.item;
                const ok = it.status !== 'failed' && it.status !== 'declined' && (typeof it.exitCode !== 'number' || it.exitCode === 0);
                await sendEvent(dispatch.runId, {
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
                const files = Array.isArray(it.changes)
                  ? it.changes.filter(c => c && typeof c.path === 'string').map(c => {
                      const k = String(c.kind || 'update').toLowerCase();
                      const action = k.includes('add') || k.includes('create') ? 'create' : k.includes('del') ? 'delete' : 'edit';
                      const diffStr = typeof c.diff === 'string' ? c.diff : '';
                      let addedLines = 0, removedLines = 0;
                      for (const line of diffStr.split('\\n')) {
                        if (line.startsWith('+') && !line.startsWith('+++')) addedLines++;
                        else if (line.startsWith('-') && !line.startsWith('---')) removedLines++;
                      }
                      return { action, path: String(c.path), ...(diffStr ? { addedLines, removedLines, diffPreview: diffStr.slice(0, 4000) } : {}) };
                    })
                  : [];
                await sendEvent(dispatch.runId, {
                  type: 'tool.finished',
                  callId: String(it.id),
                  tool: 'fileChange',
                  ok: it.status !== 'failed' && it.status !== 'declined',
                  category: files[0]?.action === 'create' ? 'file_write' : files[0]?.action === 'delete' ? 'file_delete' : 'file_edit',
                  fileOp: files[0],
                  files,
                });
              } else if (method === 'turn/plan/updated' && Array.isArray(p.plan)) {
                const entries = p.plan
                  .filter(e => e && typeof (e.step ?? e.content) === 'string')
                  .map(e => ({
                    content: String(e.step ?? e.content),
                    status: String(e.status || '').toLowerCase() === 'completed'
                      ? 'completed'
                      : String(e.status || '').toLowerCase().includes('progress')
                        ? 'in_progress'
                        : 'pending',
                  }));
                await sendEvent(dispatch.runId, { type: 'plan.update', entries });
              } else if (method === 'thread/tokenUsage/updated' && p.tokenUsage?.total) {
                const t = p.tokenUsage.total;
                const usage = {
                  ...(typeof t.inputTokens === 'number' ? { inputTokens: t.inputTokens } : {}),
                  ...(typeof t.outputTokens === 'number' ? { outputTokens: t.outputTokens } : {}),
                  ...(typeof t.totalTokens === 'number' ? { totalTokens: t.totalTokens } : {}),
                };
                await sendEvent(dispatch.runId, { type: 'usage.update', usage });
              } else if (method === 'turn/completed') {
                await sendEvent(dispatch.runId, p.turn?.error?.message ? { type: 'turn.failed', error: String(p.turn.error.message) } : { type: 'turn.completed' });
                rpc.close();
                finish();
              } else if (method === 'error' && !p.willRetry) {
                await sendEvent(dispatch.runId, { type: 'turn.failed', error: String(p.error?.message || 'Codex failed') });
                rpc.close();
                finish();
              }
            } catch (err) {
              rpc.close();
              finish(err);
            }
          }, err => { if (!settled && !runController.signal.aborted) finish(err); });
          void (async () => {
            await rpc.request('initialize', { clientInfo: { name: 'openmotion_bridge', title: 'OpenMotion Bridge', version: BRIDGE_VERSION }, capabilities: { experimentalApi: true } });
            rpc.send({ method: 'initialized' });
            const opts = { cwd: execCwd, approvalPolicy: 'on-request', sandbox: resolvedWorkingDir ? 'workspace-write' : 'read-only', developerInstructions: dispatch.instructions, ...(dispatch.model && dispatch.model !== 'default' ? { model: dispatch.model } : {}) };
            const thr = dispatch.threadId ? await rpc.request('thread/resume', { ...opts, threadId: dispatch.threadId }) : await rpc.request('thread/start', { ...opts, dynamicTools: dispatch.dynamicTools });
            if (thr?.thread?.id) await sendEvent(dispatch.runId, { type: 'thread.started', threadId: String(thr.thread.id) });
            await rpc.request('turn/start', { threadId: thr.thread.id, effort: dispatch.reasoning && dispatch.reasoning !== 'default' ? dispatch.reasoning : null, input: [{ type: 'text', text: dispatch.prompt }] });
          })().catch(finish);
        });
        return;
      }

      if (dispatch.engine === 'claude' || dispatch.engine === 'openclaude') {
        const mcpConfigPath = path.join(workRoot, \`mcp-\${randomUUID()}.json\`);
        const toolsB64 = Buffer.from(JSON.stringify(dispatch.dynamicTools || []), 'utf8').toString('base64');
        await writeFile(mcpConfigPath, JSON.stringify({
          mcpServers: {
            openmotion: {
              type: 'stdio',
              command: process.execPath,
              args: [SCRIPT_PATH, '--mcp-relay'],
              cwd: workRoot,
              env: { OM_BRIDGE_SERVER: serverUrl, OM_BRIDGE_TOKEN: token, OM_BRIDGE_RUN_ID: dispatch.runId, OM_BRIDGE_TOOLS_B64: toolsB64 },
            },
          },
        }), { mode: 0o600 });
        const cliArgs = [
          '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
          '--mcp-config', mcpConfigPath, '--strict-mcp-config', '--allowedTools', 'mcp__openmotion__*',
          '--append-system-prompt', dispatch.claudeInstructions || dispatch.instructions,
          ...(dispatch.model && dispatch.model !== 'default' ? ['--model', dispatch.model] : []),
          ...(dispatch.threadId ? ['--resume', dispatch.threadId] : []),
        ];
        let msgId = randomUUID();
        const toolInputs = new Map();
        await new Promise((resolve, reject) => {
          const child = spawn(bin, cliArgs, { cwd: execCwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
          let buf = '', stderr = '', settled = false, processing = Promise.resolve();
          const fail = err => { if (!settled) { settled = true; reject(err); } };
          const onAbort = () => { child.kill('SIGTERM'); fail(new Error('Agent conversation stopped')); };
          runController.signal.addEventListener('abort', onAbort, { once: true });
          kill = onAbort;
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', c => { stderr = (stderr + c).slice(-8000); });
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', chunk => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\\n')) >= 0) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line) continue;
              try {
                const ev = JSON.parse(line);
                processing = processing.then(async () => {
                  if (ev.type === 'system' && typeof ev.session_id === 'string') {
                    await sendEvent(dispatch.runId, { type: 'thread.started', threadId: ev.session_id });
                  } else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event?.delta?.type === 'text_delta') {
                    await sendEvent(dispatch.runId, { type: 'message.delta', messageId: msgId, delta: String(ev.event.delta.text ?? '') });
                  } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
                    let fullText = '';
                    for (const block of ev.message.content) {
                      if (block.type === 'text' && typeof block.text === 'string') fullText += block.text;
                      else if (block.type === 'tool_use' && block.id && block.name && !String(block.name).startsWith('mcp__openmotion__')) {
                        const toolName = String(block.name).replace(/^mcp__openmotion__/, '');
                        const toolArgs = block.input && typeof block.input === 'object' ? block.input : {};
                        toolInputs.set(block.id, { name: toolName, args: toolArgs });
                        await sendEvent(dispatch.runId, { type: 'tool.started', callId: String(block.id), tool: toolName, args: toolArgs });
                      }
                    }
                    if (fullText) { await sendEvent(dispatch.runId, { type: 'message.complete', messageId: msgId, text: fullText }); msgId = randomUUID(); }
                  } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
                    for (const block of ev.message.content) {
                      if (block.type !== 'tool_result' || !block.tool_use_id) continue;
                      const rec = toolInputs.get(block.tool_use_id);
                      if (!rec) continue;
                      const rawText = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.filter(c => c.type === 'text').map(c => c.text).join('\\n') : '';
                      let parsed = rawText;
                      try { parsed = rawText ? JSON.parse(rawText) : {}; } catch {}
                      await sendEvent(dispatch.runId, { type: 'tool.finished', callId: String(block.tool_use_id), tool: rec.name, args: rec.args, ok: !block.is_error, output: parsed });
                    }
                  } else if (ev.type === 'result' && ev.is_error) {
                    throw new Error(typeof ev.result === 'string' ? ev.result : 'Claude turn failed');
                  }
                }).catch(fail);
              } catch {}
            }
          });
          child.once('error', fail);
          child.once('close', code => {
            runController.signal.removeEventListener('abort', onAbort);
            void processing.then(() => { if (!settled) { settled = true; code ? reject(new Error(stderr.trim() || \`Claude exited (\${code})\`)) : resolve(); } }, fail);
          });
          child.stdin.end(dispatch.prompt);
        });
        await sendEvent(dispatch.runId, { type: 'turn.completed' });
        return;
      }

      const cliArgs = [...(def?.startArgs ?? [])];
      if (dispatch.model && dispatch.model !== 'default' && def?.modelFlag) cliArgs.push(def.modelFlag, dispatch.model);
      const msgId = randomUUID();
      await new Promise((resolve, reject) => {
        const child = spawn(bin, cliArgs, { cwd: execCwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '', stderr = '';
        const onAbort = () => { try { child.kill('SIGTERM'); } catch {} };
        runController.signal.addEventListener('abort', onAbort, { once: true });
        kill = onAbort;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; void sendEvent(dispatch.runId, { type: 'message.delta', messageId: msgId, delta: chunk }).catch(() => {}); });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
        child.once('error', reject);
        child.once('close', code => {
          runController.signal.removeEventListener('abort', onAbort);
          if (runController.signal.aborted) resolve();
          else if (code && !stdout.trim()) reject(new Error(stderr.trim() || \`Agent exited (\${code})\`));
          else resolve();
        });
        child.stdin.end(\`\${dispatch.instructions}\\n\\n\${dispatch.prompt}\\n\`);
      });
      await sendEvent(dispatch.runId, { type: 'turn.completed' });
    } catch (err) {
      if (!runController.signal.aborted && !stopped) {
        await sendEvent(dispatch.runId, { type: 'turn.failed', error: err instanceof Error ? err.message : String(err) }).catch(() => {});
      }
    } finally {
      activeRuns.delete(dispatch.runId);
      await rm(workRoot, { recursive: true, force: true }).catch(() => {});
    }
  };

  let backoff = 1000;
  while (!stopped) {
    try {
      const res = await fetch(\`\${serverUrl}\${API_PREFIX}/bridge/stream?runtimeId=\${encodeURIComponent(runtimeId)}\`, {
        headers: { Authorization: \`Bearer \${token}\`, Accept: 'text/event-stream' },
        signal: loopController.signal,
      });
      if (!res.ok || !res.body) throw new Error(\`Stream failed (\${res.status})\`);
      backoff = 1000;
      await consumeSse(res.body, async (eventType, dataText) => {
        let payload;
        try { payload = JSON.parse(dataText); } catch { return; }
        if (eventType === 'agent.inspect' && payload?.requestId && payload?.agentId) {
          try {
            const agent = await inspectOneAgent(payload.agentId);
            agents = agents.map(a => (a.id === agent.id ? agent : a));
            await postJson('/bridge/events', { type: 'inspect.result', requestId: payload.requestId, agent });
          } catch (err) {
            await postJson('/bridge/events', { type: 'inspect.result', requestId: payload.requestId, error: err instanceof Error ? err.message : String(err) }).catch(() => {});
          }
        } else if (eventType === 'turn.dispatch') {
          void dispatchTurn(payload);
        } else if (eventType === 'turn.cancel') {
          const run = activeRuns.get(String(payload?.runId || ''));
          if (run) { run.controller.abort(); run.kill(); }
        }
      });
    } catch (err) {
      if (stopped || loopController.signal.aborted) break;
      console.error(\`[openmotion-bridge] Reconnecting in \${backoff}ms: \${err instanceof Error ? err.message : String(err)}\`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff = Math.min(15_000, backoff * 2);
    }
  }
}

runMain().catch(err => {
  console.error('[openmotion-bridge]', err);
  process.exit(1);
});
`;
}
