import type { Agent, Conversation, Message } from "./types";

/** Shared by the composer and ingress; this chooses recipients, never grants authority. */
export function resolveMessageRecipients(
  conversation: Pick<Conversation, "agentIds" | "mode">,
  agents: Pick<Agent, "id" | "isConductor">[],
  mentionedAgentIds: string[] = [],
  parent?: Pick<Message, "role" | "agentId"> | null
): string[] {
  const members = new Set(conversation.agentIds);
  const existing = new Set(agents.map(agent => agent.id));
  const explicit = [...new Set(mentionedAgentIds)];
  for (const id of explicit) {
    if (!members.has(id) || !existing.has(id)) throw new Error(`Recipient is not a current conversation member: ${id}`);
  }
  if (explicit.length) return explicit;
  if (parent?.role === "agent" && parent.agentId) {
    if (!members.has(parent.agentId) || !existing.has(parent.agentId)) {
      throw new Error("The replied-to Agent is no longer a conversation member. Choose a recipient.");
    }
    return [parent.agentId];
  }
  if (conversation.mode === "single") return conversation.agentIds.filter(id => existing.has(id)).slice(0, 1);
  const conductor = agents.find(agent => agent.isConductor && members.has(agent.id));
  return conductor ? [conductor.id] : [];
}
