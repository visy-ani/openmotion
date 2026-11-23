import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { ContentBatchService } from '../gateway/content-batch.ts';
import { startServer } from '../server.ts';
import { CONTENT_BATCH_API } from '../shared/content-batch.ts';
import { MCP_HTTP_PATH } from '../shared/mcp-http.ts';
import { fixture } from './fixtures.ts';

test('ContentBatchService runs mcp-pipeline concurrently, retries failed items, and exports a ZIP bundle', () =>
  fixture(async store => {
    const service = new ContentBatchService(store.directory);
    let failOnce = true;

    const host = {
      callMcpTool: async (_tool: string, args: Record<string, unknown>) => {
        if (args.title === 'Variant B' && failOnce) {
          failOnce = false;
          throw new Error('Transient render error');
        }
        return { projectId: `proj-${String(args.title)}`, revision: 'r1' };
      },
      runAgentOptimization: async (_batch: any, item: any) => ({
        chatId: `chat-${item.id}`,
        summary: `Polished ${item.label}`,
      }),
    };

    try {
      const { batch } = await service.create(
        {
          title: 'Product Launch Variants',
          mode: 'mcp-pipeline',
          concurrency: 2,
          sharedVariables: { brand: 'OpenMotion' },
          pipeline: [
            {
              id: 'create',
              tool: 'openmotion_create_project',
              arguments: {
                title: '{{item.variables.headline}}',
                brand: '{{shared.brand}}',
              },
            },
          ],
          items: [
            { id: 'v1', label: 'Variant A', variables: { headline: 'Variant A' } },
            { id: 'v2', label: 'Variant B', variables: { headline: 'Variant B' } },
            { id: 'v3', label: 'Variant C', variables: { headline: 'Variant C' } },
          ],
          autoStart: true,
          wait: true,
        },
        host,
      );

      assert.equal(batch.state, 'partial');
      assert.equal(batch.counts.completed, 2);
      assert.equal(batch.counts.failed, 1);

      const retried = await service.retryFailed(batch.id, host, { wait: true });
      assert.equal(retried.state, 'completed');
      assert.equal(retried.counts.completed, 3);
      assert.equal(retried.counts.failed, 0);

      const bundle = await service.exportBundle(batch.id);
      assert.ok(bundle.bytes > 0);
      assert.equal(bundle.entries, 5); // manifest + summary + 3 items
      assert.ok(existsSync(bundle.archivePath));
    } finally {
      await service.close();
    }
  }));

test('Batch optimization works identically via HTTP routes and openmotion_assets_use action=batch over MCP', () =>
  fixture(async store => {
    const running = await startServer(store, 0, { editor: false });
    const port = (running.server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;

    try {
      // Create & run a batch via openmotion_assets_use MCP tool over /mcp
      const mcpRes = await fetch(`${origin}${MCP_HTTP_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'openmotion_assets_use',
            arguments: {
              action: 'batch',
              batch: {
                command: 'create',
                title: 'MCP Batch Catalog Sync',
                mode: 'mcp-pipeline',
                concurrency: 2,
                autoStart: true,
                wait: true,
                pipeline: [
                  { id: 'list', tool: 'openmotion_get_project', arguments: {} },
                ],
                items: [
                  { id: 'a1', label: 'Region US' },
                  { id: 'a2', label: 'Region JP' },
                ],
              },
            },
          },
        }),
      });
      assert.equal(mcpRes.status, 200);
      const mcpPayload = (await mcpRes.json()) as any;
      const createdBatch = mcpPayload.result.structuredContent.batch;
      assert.equal(createdBatch.state, 'completed');
      assert.equal(createdBatch.counts.completed, 2);

      // List & export the same batch through Studio HTTP endpoints
      const listRes = await fetch(`${origin}${CONTENT_BATCH_API}`);
      assert.equal(listRes.status, 200);
      const listData = (await listRes.json()) as any;
      assert.ok(listData.batches.some((item: any) => item.id === createdBatch.id));

      const exportRes = await fetch(`${origin}${CONTENT_BATCH_API}/${createdBatch.id}/export`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(exportRes.status, 200);
      const exportData = (await exportRes.json()) as any;
      assert.match(exportData.bundle.downloadUrl, /\/bundles\/[a-f0-9-]+\/file$/);

      const zipRes = await fetch(`${origin}${exportData.bundle.downloadUrl}`);
      assert.equal(zipRes.status, 200);
      assert.equal(zipRes.headers.get('content-type'), 'application/zip');
    } finally {
      await running.close();
    }
  }));
