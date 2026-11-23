export const MCP_HTTP_PATH = '/mcp';
export const MCP_TOKENS_API = '/motion-api/mcp/tokens';
export const MCP_STATUS_API = '/motion-api/mcp/status';
export const MCP_TOKEN_PREFIX = 'om_mcp_';

export type McpTokenScope = 'read' | 'write' | 'admin';

export type McpTokenSummary = {
  id: string;
  label: string;
  prefix: string;
  scope: McpTokenScope;
  createdAt: string;
  lastUsedAt?: string;
  revoked?: boolean;
};

export type RemoteMcpConfigSnippets = {
  streamableHttpJson: string;
  cursorJson: string;
  claudeCli: string;
  curlCommand: string;
};

export type CreatedMcpToken = {
  token: string;
  summary: McpTokenSummary;
  endpoint: string;
  configs: RemoteMcpConfigSnippets;
};

export type McpHttpStatus = {
  endpoint: string;
  publicEndpoint: string;
  authRequired: boolean;
  activeSessions: number;
  protocolVersions: readonly string[];
  tokens: McpTokenSummary[];
  configs: RemoteMcpConfigSnippets;
};

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function normalizeMcpTokenLabel(raw: unknown, fallback = 'Remote MCP Client'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[\r\n\t\0]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || fallback;
}

export function normalizeMcpTokenScope(raw: unknown): McpTokenScope {
  if (raw === 'read' || raw === 'write' || raw === 'admin') return raw;
  return 'write';
}

export function buildRemoteMcpConfigs(endpoint: string, token = '<YOUR_OM_MCP_TOKEN>'): RemoteMcpConfigSnippets {
  const authValue = `Bearer ${token}`;
  const streamableHttpJson = JSON.stringify(
    {
      mcpServers: {
        openmotion: {
          type: 'http',
          url: endpoint,
          headers: {
            Authorization: authValue,
          },
        },
      },
    },
    null,
    2,
  );
  const cursorJson = JSON.stringify(
    {
      mcpServers: {
        openmotion: {
          url: endpoint,
          headers: {
            Authorization: authValue,
          },
        },
      },
    },
    null,
    2,
  );
  const claudeCli = `claude mcp add --transport http openmotion ${shellSingleQuote(endpoint)} --header ${shellSingleQuote(`Authorization: ${authValue}`)}`;
  const curlCommand = `curl -fsSL -X POST ${shellSingleQuote(endpoint)} -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H ${shellSingleQuote(`Authorization: ${authValue}`)} -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'`;

  return {
    streamableHttpJson,
    cursorJson,
    claudeCli,
    curlCommand,
  };
}
