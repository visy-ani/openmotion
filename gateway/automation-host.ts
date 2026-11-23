import { randomUUID } from 'node:crypto';
import type { Phase1Service } from '../phase1.ts';
import {
  resolveBatchTemplate,
  type BatchItemOutputRef,
  type BatchItemRecord,
  type ContentBatchJob,
} from '../shared/content-batch.ts';
import type { TriggerTarget } from '../shared/triggers.ts';
import type { WorkspaceStore } from '../workspace.ts';
import { contentBatchesFor } from './content-batch.ts';
import { superAgentConversations } from './super-agent.ts';
import type { TriggerExecutionHost } from './triggers.ts';

function buildBatchItemPrompt(batch: ContentBatchJob, item: BatchItemRecord): string {
  const context = {
    item,
    shared: batch.sharedVariables,
    batch: { id: batch.id, title: batch.title },
  };
  const basePrompt = item.prompt || batch.promptTemplate || `Optimize "${item.label}" using OpenMotion MCP tools.`;
  const resolvedPrompt = resolveBatchTemplate(basePrompt, context);
  const criteria = item.criteria?.length ? item.criteria : batch.criteria;
  const parts = [
    `[Batch Content Optimization: ${batch.title}]`,
    `Item: ${item.label} (${item.id})`,
    resolvedPrompt,
  ];
  if (item.target) {
    parts.push(`Target: ${JSON.stringify(item.target)}`);
  }
  if (Object.keys(item.variables).length > 0 || Object.keys(batch.sharedVariables).length > 0) {
    parts.push(`Parameters: ${JSON.stringify({ ...batch.sharedVariables, ...item.variables })}`);
  }
  if (criteria.length > 0) {
    parts.push('Optimization Criteria:\n' + criteria.map((line, i) => `${i + 1}. ${line}`).join('\n'));
  }
  parts.push(
    'Execute the required OpenMotion MCP tools directly, save revision-checked results, and call openmotion_present_artifact for every created or updated deliverable.',
  );
  return parts.join('\n\n');
}

export function createAutomationHost(options: {
  store: WorkspaceStore;
  origin: () => string;
  phase1: () => Phase1Service;
  runtimeRoot?: string;
}): TriggerExecutionHost {
  const { store, origin, phase1, runtimeRoot } = options;

  return {
    callMcpTool: (tool, args) => phase1().call(tool, args),
    contentBatches: () => contentBatchesFor(store),
    runAgentOptimization: async (batch, item, signal) => {
      const manager = superAgentConversations(store);
      const chat = await manager.create({
        title: `[Batch] ${item.label}`.slice(0, 120),
        engine: batch.agentConfig?.engine as any,
        runtimeId: batch.agentConfig?.runtimeId,
        model: batch.agentConfig?.model,
        permissionMode: batch.agentConfig?.permissionMode ?? 'auto',
      });
      const prompt = buildBatchItemPrompt(batch, item);
      await manager.start(
        chat.id,
        {
          text: prompt,
          requestId: `batch-sa-${randomUUID().slice(0, 16)}`,
          engine: batch.agentConfig?.engine as any,
          runtimeId: batch.agentConfig?.runtimeId,
          model: batch.agentConfig?.model,
          reasoning: batch.agentConfig?.reasoning,
          permissionMode: batch.agentConfig?.permissionMode ?? 'auto',
        },
        {
          origin: origin(),
          phase1,
          runtimeRoot,
        },
      );
      const finalChat = await manager.waitForChat(chat.id, signal);
      if (finalChat.state === 'failed') {
        throw new Error(finalChat.error || 'Super Agent turn failed');
      }
      if (finalChat.state === 'cancelled') {
        throw new Error('Super Agent turn cancelled');
      }
      const lastAssistant = [...finalChat.messages].reverse().find(msg => msg.role === 'assistant');
      const outputs: BatchItemOutputRef[] = finalChat.artifacts.map(art => ({
        kind: art.kind,
        id: art.projectId ?? art.assetId ?? art.kitId ?? art.jobId ?? art.id,
        ...(art.versionId ? { versionId: art.versionId } : {}),
        ...(art.revision ? { revision: art.revision } : {}),
        ...(art.title ? { title: art.title } : {}),
        ...(art.url ? { url: art.url } : {}),
        ...(art.downloadUrl ? { downloadUrl: art.downloadUrl } : {}),
        chatId: finalChat.id,
      }));
      return {
        chatId: finalChat.id,
        ...(lastAssistant?.text ? { summary: lastAssistant.text.slice(0, 2000) } : {}),
        outputs,
      };
    },
    runSuperAgentTurn: async (
      target: Extract<TriggerTarget, { kind: 'super-agent' }>,
      _payload,
    ) => {
      const manager = superAgentConversations(store);
      const chat = await manager.create({
        title: `[Trigger] ${target.prompt.slice(0, 60)}`,
        engine: target.engine as any,
        runtimeId: target.runtimeId,
        model: target.model,
        permissionMode: 'auto',
      });
      await manager.start(
        chat.id,
        {
          text: target.prompt,
          requestId: `trg-sa-${randomUUID().slice(0, 16)}`,
          engine: target.engine as any,
          runtimeId: target.runtimeId,
          model: target.model,
          reasoning: target.reasoning,
          permissionMode: 'auto',
        },
        {
          origin: origin(),
          phase1,
          runtimeRoot,
        },
      );
      const finalChat = await manager.waitForChat(chat.id);
      if (finalChat.state === 'failed') {
        throw new Error(finalChat.error || 'Super Agent turn failed');
      }
      if (finalChat.state === 'cancelled') {
        throw new Error('Super Agent turn cancelled');
      }
      const lastAssistant = [...finalChat.messages].reverse().find(msg => msg.role === 'assistant');
      return {
        chatId: finalChat.id,
        ...(lastAssistant?.text ? { summary: lastAssistant.text.slice(0, 1000) } : {}),
      };
    },
  };
}
