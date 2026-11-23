import readline from 'node:readline';

const mcpUrl = process.env.OM_MCP_URL;
const mcpToken = process.env.OM_MCP_TOKEN;

if (!mcpUrl || !mcpToken) {
  process.stderr.write('mcp-http-relay requires OM_MCP_URL and OM_MCP_TOKEN\n');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue: Promise<void> = Promise.resolve();

function writeRpcError(id: unknown, code: number, message: string) {
  if (id === undefined) return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function forwardLine(line: string) {
  let payload: any;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }
  const hasId = payload && typeof payload === 'object' && payload.id !== undefined;
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mcpToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 202 || !hasId) {
      return;
    }
    const text = await res.text();
    if (!res.ok) {
      writeRpcError(payload.id, -32603, text || `MCP HTTP ${res.status}`);
      return;
    }
    if (!text.trim()) return;
    const parsed = JSON.parse(text);
    process.stdout.write(JSON.stringify(parsed) + '\n');
  } catch (error) {
    writeRpcError(payload?.id, -32603, error instanceof Error ? error.message : 'MCP relay request failed');
  }
}

rl.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  queue = queue.then(() => forwardLine(trimmed));
});

rl.on('close', () => {
  void queue.then(() => process.exit(0));
});
