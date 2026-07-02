import type { AdapterName, Agent, Conversation, Message, Workspace, StreamEvent } from "@/shared/types";
import type { ChatMessage } from "@/server/conversation-context";
import type { TaskExecutionContract, TaskExecutionIdentity } from "@/shared/evidence-types";

export interface AdapterInput {
  conversationId: string;
  runId: string;
  parentRunId?: string | null;
  taskExecution?: TaskExecutionIdentity | null;
  taskContract?: TaskExecutionContract | null;
  agent: Agent;
  conversation: Conversation;
  workspace: Workspace;
  triggerMessage: Message;
  recentMessages: Message[];
  toolNames: string[];
  systemPrompt: string;
  workspacePath: string;
  apiKey: string | null;
  apiBaseUrl?: string | null;
  history?: ChatMessage[];
}

export interface AgentPlatformAdapter {
  readonly name: AdapterName;

  run(input: AdapterInput, signal: AbortSignal): AsyncGenerator<StreamEvent>;
}
