# Agent Runtimes & Cloud Bridge Architecture

OpenMotion separates the workspace **Control Plane** (UI, conversation persistence, shared tools, project files, assets, templates, Brand Kits, and media gateway) from the **Compute Plane** (where AI Agent CLIs or custom Agent backends run). This allows identical Super Agent workflows across local standalone installs, Docker containers, and cloud-hosted deployments without copying local CLI credentials or requiring inbound ports.

## Execution Runtime Kinds

1. **`local-direct`** (`id: "local"`)
   - Default in local standalone mode (`MOTION_DEPLOYMENT_MODE=local` or `hybrid`).
   - Invokes installed local Agent CLIs directly from the OpenMotion server process (`gateway/super-agent.ts`), including Codex (`app-server`), Claude Code / OpenClaude (`stream-json` + local stdio MCP), and generic CLI fallbacks across the 29 registered clients in [shared/local-agents.ts](../shared/local-agents.ts).
2. **`local-bridge`** (`id: "bridge:<uuid>"`)
   - Outbound-only local worker daemon ([gateway/agent-bridge.ts](../gateway/agent-bridge.ts)) or standalone script (`GET /motion-api/agent-runtimes/bridge/script`, [gateway/agent-bridge-script.ts](../gateway/agent-bridge-script.ts)), with one-line installers for macOS/Linux (`GET /motion-api/agent-runtimes/bridge/install.sh`) and Windows PowerShell (`GET /motion-api/agent-runtimes/bridge/install.ps1`).
   - Runs on the user's workstation or laptop, scans local CLI installations, authenticates outbound with a hashed Bearer bridge token, holds a reverse SSE stream (`GET /motion-api/agent-runtimes/bridge/stream`), receives `turn.dispatch` / `turn.cancel` / `agent.inspect` commands, and forwards tool calls (`POST /motion-api/agent-runtimes/bridge/tool-call`) back to OpenMotion's shared domain tools.
   - Enables a browser connected to a remote, Docker, or cloud OpenMotion deployment to invoke the user's local Codex, Claude Code, or other installed CLI Agents without opening any local firewall port or uploading local login tokens.
   - See [Cross-Platform MCP-First Architecture](cross-platform-mcp-architecture.md) for the full Web + Desktop + Streamable HTTP `/mcp` + Batch Optimization + Triggers design.
3. **`remote-service`** (`id: "service:<uuid>"`)
   - HTTP+SSE adapter ([gateway/agent-service-adapter.ts](../gateway/agent-service-adapter.ts)) implementing the versioned **`openmotion-agent-v1`** protocol.
   - Allows connecting self-hosted Agent clusters, hosted OpenMotion backends, or custom internal Agent services alongside local CLI runtimes in **Settings → Local Agents → Runtimes & Cloud Bridge**.

## Deployment Configuration

| Environment Variable | Values | Purpose |
| --- | --- | --- |
| `MOTION_DEPLOYMENT_MODE` | `local` (default), `hybrid`, `cloud` | In `cloud` mode, `local-direct` is disabled on the server so turns route to `local-bridge` or `remote-service`. |
| `MOTION_PUBLIC_ORIGIN` | `https://app.example.com` | Canonical public URL embedded in generated bridge connect scripts and allowed host checks. |
| `MOTION_ALLOWED_HOSTS` | Comma-separated hostnames | Additional `Host` header hostnames permitted in addition to loopback (`localhost`, `127.0.0.1`, `[::1]`). |
| `MOTION_DISABLE_LOCAL_DIRECT` | `1` to disable | Explicitly disables `local-direct` even in `hybrid` mode. |

## Security Boundaries

- **Hashed bridge tokens:** `POST /motion-api/agent-runtimes/bridge/tokens` returns a raw `om_brg_...` token once and persists only its SHA-256 hex digest (`agents/runtimes.json`, mode `0o600`). Verification uses constant-time `timingSafeEqual`. Revoking a token immediately closes its active SSE streams and rejects pending bridge runs.
- **Strict route scoping:** Browser `Origin` exemption applies only to the five Bearer-authenticated daemon routes (`/motion-api/agent-runtimes/bridge/{register,heartbeat,stream,events,tool-call}`). All `/bridge/events` and `/bridge/tool-call` requests verify `run.tokenId === token.id`.
- **No credential egress:** CLI login credentials never leave the user's machine. Custom remote-service secrets are stored privately in `agents/runtimes.json` (`0o600`), never returned in API responses (`hasCredentials: true` only), and redacted from diagnostics.

## Self-Hosted Agent Service Protocol (`openmotion-agent-v1`)

Any HTTP service implementing these endpoints can be registered in **Settings → Local Agents → Runtimes & Cloud Bridge**:

1. `GET /health`
   - Response `200`: `{ "ok": true, "protocol": "openmotion-agent-v1", "version": "1.0.0" }`
2. `GET /v1/agents`
   - Response `200`: `{ "agents": [{ "id": "custom-agent", "label": "Custom Agent", "auth": "signed-in", "models": [{ "id": "model-1", "label": "Model 1", "reasoning": ["low", "medium", "high"] }] }] }`
3. `POST /v1/runs` (`Accept: text/event-stream`)
   - Request JSON: `{ "protocol": "openmotion-agent-v1", "runId": "...", "chatId": "...", "engine": "...", "model": "...", "reasoning": "...", "threadId": "...", "prompt": "...", "instructions": "...", "dynamicTools": [...], "permissionMode": "on-request" | "auto" }`
   - Streams SSE events:
     - `thread.started`: `{ "type": "thread.started", "threadId": "..." }`
     - `message.delta`: `{ "type": "message.delta", "messageId": "...", "delta": "..." }`
     - `message.complete`: `{ "type": "message.complete", "messageId": "...", "text": "..." }`
     - `tool.call`: `{ "type": "tool.call", "callId": "...", "tool": "openmotion_present_artifact", "arguments": { ... } }` (Control Plane executes the OpenMotion tool and posts the result to `/v1/runs/:runId/tool-results`)
     - `tool.started` / `tool.finished`: optional progress frames for service-internal tools
     - `artifact.upsert`: `{ "type": "artifact.upsert", "artifact": { ... } }`
     - `turn.completed`: `{ "type": "turn.completed" }`
     - `turn.failed`: `{ "type": "turn.failed", "error": "..." }`
4. `POST /v1/runs/:runId/tool-results`
   - Request JSON delivered by OpenMotion: `{ "callId": "...", "ok": true, "contentItems": [...], "structuredContent": ... }`
5. `POST /v1/runs/:runId/cancel`
   - Aborts an in-flight run when the user clicks Stop in Super Agent.
