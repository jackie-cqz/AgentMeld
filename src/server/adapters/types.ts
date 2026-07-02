import type { AdapterName, Agent, Conversation, Message, Workspace, StreamEvent } from "@/shared/types";
import type { ChatMessage } from "@/server/conversation-context";
import type { TaskExecutionIdentity } from "@/shared/evidence-types";
import type { TaskContextEnvelope } from "@/shared/task-context-types";

export interface AdapterInput {
  conversationId: string;
  runId: string;
  parentRunId?: string | null;
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
  /** P0: task execution identity — set for child runs dispatched by Conductor */
  taskExecution?: TaskExecutionIdentity | null;
  /** P0: immutable context snapshot — minimal envelope in P0, full compilation in P2 */
  contextSnapshot?: TaskContextEnvelope | null;
}

export interface AgentPlatformAdapter {
  readonly name: AdapterName;

  run(input: AdapterInput, signal: AbortSignal): AsyncGenerator<StreamEvent>;
}
