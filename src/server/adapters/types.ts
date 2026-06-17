import type { AdapterName, Agent, Conversation, Message, Workspace, StreamEvent } from "@/shared/types";

export interface AdapterInput {
  conversationId: string;
  runId: string;
  agent: Agent;
  conversation: Conversation;
  workspace: Workspace;
  triggerMessage: Message;
  recentMessages: Message[];
  toolNames: string[];
}

export interface AgentPlatformAdapter {
  readonly name: AdapterName;

  run(input: AdapterInput, signal: AbortSignal): AsyncGenerator<StreamEvent>;
}
