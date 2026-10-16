import type { Agent, Conversation, Message, StreamEvent, Workspace } from "@/shared/types";
import type { ChatMessage } from "@/server/conversation-context";
import type { TaskExecutionContract, TaskExecutionIdentity } from "@/shared/evidence-types";
import type { PiAccessMode } from "./access-profile";

/** One platform-owned invocation; Pi owns the internal messages and tool loop. */
export interface PiInvocationInput {
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
  contextXml?: string;
  /** Conversation-only calls never access live workspace files or acquire its writer lease. */
  accessMode?: PiAccessMode;
  maxTurns?: number;
  timeoutMs?: number;
  /** Receipt for the initial task entering Pi's committed user-message context. */
  onTaskAccepted?: () => void;
  onStage?: (stage: "queued" | "running") => void;
  onContextCaptured?: (snapshot: { packet: string; systemPromptHash: string; toolNames: string[]; accessMode: string }) => void;
  /** Public configuration revision only; never a credential value or hash. */
  providerRevision?: string;
  catalogProvider?: string;
}

export type PiInvocationStream = AsyncGenerator<StreamEvent>;
export type PiProviderSnapshot = Pick<PiInvocationInput, "apiKey" | "apiBaseUrl" | "providerRevision" | "catalogProvider">;
