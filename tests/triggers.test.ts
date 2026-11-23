import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { TriggerService } from '../gateway/triggers.ts';
import { startServer } from '../server.ts';
import { MCP_HTTP_PATH } from '../shared/mcp-http.ts';
import { TRIGGERS_API } from '../shared/triggers.ts';
import { fixture } from './fixtures.ts';

test('TriggerService webhook authentication, HMAC verification, and schedule tick execution', () =>
  fixture(async store => {
    const running = await startServer(store, 0, { editor: false });
    const port = (running.server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;

    try {
      // Create webhook trigger via HTTP API
      const createRes = await fetch(`${origin}${TRIGGERS_API}`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'CI Project Create Webhook',
          kind: 'webhook',
          target: {
            kind: 'mcp-tool',
            tool: 'openmotion_create_project',
            arguments: {
              requestId: 'req-trg-{{payload.releaseTag}}',
              projectType: 'natural_language',
              title: 'Triggered: {{payload.releaseTag}}',
              requirements: 'Automated launch variant.',
              namingLanguage: 'en',
            },
          },
        }),
      });
      assert.equal(createRes.status, 201);
      const created = (await createRes.json()) as any;
      assert.match(created.webhookSecret, /^om_trg_/);
      const triggerId = created.trigger.id;

      // Raw webhook secret must not be saved plaintext on disk
      const storedRaw = await readFile(path.join(store.directory, 'triggers/registry.json'), 'utf8');
      assert.equal(storedRaw.includes(created.webhookSecret), false);

      // Unauthenticated request is rejected
      const unauthFire = await fetch(`${origin}${TRIGGERS_API}/${triggerId}/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ releaseTag: 'v1' }),
      });
      assert.equal(unauthFire.status, 403); // No Origin and no webhook auth

      const badBearer = await fetch(`${origin}${TRIGGERS_API}/${triggerId}/fire`, {
        method: 'POST',
        headers: { Authorization: 'Bearer om_trg_wrong', 'Content-Type': 'application/json' },
        body: JSON.stringify({ releaseTag: 'v1' }),
      });
      assert.equal(badBearer.status, 401);

      // Bearer webhook authentication succeeds without Origin header
      const bearerFire = await fetch(`${origin}${TRIGGERS_API}/${triggerId}/fire`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${created.webhookSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ releaseTag: 'v2-0', wait: true }),
      });
      assert.equal(bearerFire.status, 200);
      const bearerResult = (await bearerFire.json()) as any;
      assert.equal(bearerResult.run.state, 'completed');
      assert.equal(bearerResult.run.source, 'webhook');

      // HMAC X-OpenMotion-Signature works with sha256(webhookSecret)
      const bodyStr = JSON.stringify({ releaseTag: 'v2-1', wait: true });
      const hmacKey = createHash('sha256').update(created.webhookSecret).digest('hex');
      const sig = createHmac('sha256', hmacKey).update(bodyStr, 'utf8').digest('hex');
      const hmacFire = await fetch(`${origin}${TRIGGERS_API}/${triggerId}/fire`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenMotion-Signature': `sha256=${sig}`,
        },
        body: bodyStr,
      });
      assert.equal(hmacFire.status, 200);
      const hmacResult = (await hmacFire.json()) as any;
      assert.equal(hmacResult.run.state, 'completed');

      // Manage & execute schedule trigger via openmotion_assets_use action=trigger over /mcp
      const mcpCreate = await fetch(`${origin}${MCP_HTTP_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: {
            name: 'openmotion_assets_use',
            arguments: {
              action: 'trigger',
              trigger: {
                command: 'create',
                name: 'Manual Digest',
                kind: 'manual',
                target: {
                  kind: 'mcp-tool',
                  tool: 'openmotion_get_project',
                  arguments: {},
                },
              },
            },
          },
        }),
      });
      assert.equal(mcpCreate.status, 200);
      const mcpCreated = (await mcpCreate.json()) as any;
      const manualId = mcpCreated.result.structuredContent.trigger.id;

      const mcpFire = await fetch(`${origin}${MCP_HTTP_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'openmotion_assets_use',
            arguments: {
              action: 'trigger',
              trigger: {
                command: 'fire',
                triggerId: manualId,
                wait: true,
              },
            },
          },
        }),
      });
      assert.equal(mcpFire.status, 200);
      const mcpFired = (await mcpFire.json()) as any;
      assert.equal(mcpFired.result.structuredContent.run.state, 'completed');

      // Direct unit verification of schedule tick()
      const schedService = new TriggerService(store.directory);
      const sched = await schedService.create({
        name: 'Hourly Tick',
        kind: 'schedule',
        intervalSeconds: 60,
        target: { kind: 'mcp-tool', tool: 'openmotion_get_project', arguments: {} },
      });
      const fakeHost = {
        callMcpTool: async () => ({ ok: true }),
        contentBatches: () => { throw new Error('unused'); },
        runSuperAgentTurn: async () => { throw new Error('unused'); },
      };
      assert.equal(await schedService.tick(fakeHost, Date.now()), 0);
      assert.equal(await schedService.tick(fakeHost, Date.now() + 120_000), 1);
      const updatedSched = await schedService.get(sched.trigger.id);
      assert.equal(updatedSched.runCount, 1);
      await schedService.close();
    } finally {
      await running.close();
    }
  }));
