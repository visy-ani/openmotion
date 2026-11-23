import type { SuperAgentHandoffPayload } from '../../../shared/capability-hub';

export const SUPER_AGENT_HANDOFF_EVENT = 'motion:super-agent-handoff';

let pendingHandoff: SuperAgentHandoffPayload | null = null;

export function queueSuperAgentHandoff(payload: SuperAgentHandoffPayload): void {
  pendingHandoff = payload;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SUPER_AGENT_HANDOFF_EVENT));
  }
}

export function consumeSuperAgentHandoff(): SuperAgentHandoffPayload | null {
  const next = pendingHandoff;
  pendingHandoff = null;
  return next;
}

export function subscribeSuperAgentHandoff(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => listener();
  window.addEventListener(SUPER_AGENT_HANDOFF_EVENT, handler);
  return () => window.removeEventListener(SUPER_AGENT_HANDOFF_EVENT, handler);
}
