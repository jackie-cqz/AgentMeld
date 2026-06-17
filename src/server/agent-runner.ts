import { ensureDatabase } from "@/db/bootstrap";
import { getAdapter } from "@/server/adapters/registry";
import type { AdapterInput } from "@/server/adapters/types";
import { eventBus } from "@/server/event-bus";
import {
  createArtifact,
  createMessage,
  createRun,
  getAgent,
  getArtifact,
  getConversation,
  getWorkspaceForConversation,
  listMessages,
  updateMessageParts,
  updateMessageStatus,
  updateRunStatus
} from "@/server/repositories";
import { executeOrchestrator } from "@/server/orchestrator-service";
import { newMessageId, newRunId } from "@/shared/ids";
import type { AgentRun, Message, StreamEvent } from "@/shared/types";

// ---------------------------------------------------------------------------
// In-memory abort map — not persisted, dev-server restart clears it.
// ---------------------------------------------------------------------------

const activeRuns = new Map<string, AbortController>();

export function abortRun(runId: string): boolean {
  const controller = activeRuns.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

// ---------------------------------------------------------------------------
// Public entry point — called from conversation-service.sendMessage()
// ---------------------------------------------------------------------------

interface StartRunInput {
  conversationId: string;
  agentId: string;
  triggerMessage: Message;
  runId?: string;
}

export function startAgentRun(input: StartRunInput): string {
  const runId = input.runId ?? newRunId();
  void executeRun({ ...input, runId }).catch((error: unknown) => {
    console.error("Agent run failed", error);
  });
  return runId;
}

// ---------------------------------------------------------------------------
// Core run loop
// ---------------------------------------------------------------------------

interface ExecuteRunInput extends StartRunInput {
  runId: string;
}

async function executeRun(input: ExecuteRunInput): Promise<void> {
  ensureDatabase();

  // 1. Look up entities
  const agent = getAgent(input.agentId);
  if (!agent) {
    createErrorMessage(input.conversationId, input.triggerMessage.id, `Agent "${input.agentId}" not found.`);
    return;
  }

  const conversation = getConversation(input.conversationId);
  if (!conversation) {
    createErrorMessage(input.conversationId, input.triggerMessage.id, "Conversation not found.");
    return;
  }

  const workspace = getWorkspaceForConversation(input.conversationId);
  if (!workspace) {
    createErrorMessage(input.conversationId, input.triggerMessage.id, "Workspace not found.");
    return;
  }

  // 2. Create run record
  const now = Date.now();
  const run: AgentRun = createRun({
    id: input.runId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    triggerMessageId: input.triggerMessage.id,
    status: "running",
    now
  });

  // 3. Abort controller
  const abortController = new AbortController();
  activeRuns.set(run.id, abortController);

  // 4. Publish run.start
  eventBus.publish({
    type: "run.start",
    conversationId: input.conversationId,
    timestamp: now,
    runId: run.id,
    agentId: run.agentId,
    triggerMessageId: run.triggerMessageId,
    parentRunId: run.parentRunId
  });

  // 5. Create agent response message
  let message = createMessage({
    id: newMessageId(),
    conversationId: input.conversationId,
    role: "agent",
    agentId: input.agentId,
    runId: run.id,
    parts: [],
    status: "streaming",
    now
  });

  eventBus.publish({
    type: "message.start",
    conversationId: input.conversationId,
    timestamp: Date.now(),
    messageId: message.id,
    agentId: input.agentId,
    runId: run.id
  });

  // 6. Orchestrator branch: group chat without @ → plan → approve → DAG → aggregate
  if (agent.isOrchestrator && conversation.mode === "group") {
    const availableAgentIds = conversation.agentIds;
    try {
      await executeOrchestrator({
        conversationId: input.conversationId,
        orchestratorAgentId: agent.id,
        triggerMessage: input.triggerMessage,
        availableAgentIds,
        orchestratorRunId: run.id
      });
      const finalUsage: NonNullable<AgentRun["usage"]> = {
        modelId: agent.modelId ?? "orchestrator",
        inputTokens: 0,
        outputTokens: 0
      };
      completeRun(run, message, "complete", null, finalUsage);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : "Orchestrator failed.";
      createErrorMessage(input.conversationId, message.id, `Orchestrator error: ${errorText}`);
      completeRun(run, message, "failed", errorText, { modelId: agent.modelId ?? "orchestrator", inputTokens: 0, outputTokens: 0 });
    }
    activeRuns.delete(run.id);
    return;
  }

  // 7. Normal adapter flow (non-orchestrator agents)
  const recentMessages = listMessages(input.conversationId).slice(-20);
  const adapterInput: AdapterInput = {
    conversationId: input.conversationId,
    runId: run.id,
    agent,
    conversation,
    workspace,
    triggerMessage: input.triggerMessage,
    recentMessages,
    toolNames: agent.toolNames
  };

  // 8. Consume adapter stream
  const adapter = getAdapter(agent.adapterName);
  let lastUsage: NonNullable<AgentRun["usage"]> | null = run.usage;

  try {
    for await (const event of adapter.run(adapterInput, abortController.signal)) {
      if (abortController.signal.aborted) break;

      // Fill in ids that the adapter leaves empty
      const filledEvent = fillEventIds(event, message.id, run.id);
      eventBus.publish(filledEvent);

      // Capture usage if the adapter reports it
      if (filledEvent.type === "run.usage") {
        lastUsage = filledEvent.usage;
      }

      // Apply persistence side-effects
      message = applyEventToState(filledEvent, message);
    }
  } catch (error) {
    const errorText = error instanceof Error ? error.message : "Unknown adapter error.";
    const fallbackUsage: NonNullable<AgentRun["usage"]> = {
      modelId: agent.modelId ?? "unknown",
      inputTokens: 0,
      outputTokens: 0
    };
    createErrorMessage(input.conversationId, message.id, `Agent run failed: ${errorText}`);
    completeRun(run, message, "failed", errorText, lastUsage ?? fallbackUsage);
    activeRuns.delete(run.id);
    return;
  }

  // 9. Finalize
  const finalUsage: NonNullable<AgentRun["usage"]> = lastUsage ?? {
    modelId: agent.modelId ?? "mock",
    inputTokens: 0,
    outputTokens: 0
  };

  completeRun(run, message, abortController.signal.aborted ? "aborted" : "complete", null, finalUsage);
  activeRuns.delete(run.id);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fillEventIds(event: StreamEvent, messageId: string, runId: string): StreamEvent {
  if ("messageId" in event && (event as { messageId?: string }).messageId === "") {
    return { ...event, messageId } as StreamEvent;
  }
  if ("runId" in event && (event as { runId?: string }).runId === "") {
    return { ...event, runId } as StreamEvent;
  }
  return event;
}

function applyEventToState(event: StreamEvent, message: Message): Message {
  const now = Date.now();

  if (event.type === "part.start") {
    const parts = [...message.parts];
    parts[event.partIndex] = event.part;
    updateMessageParts(message.id, parts, now);
    return { ...message, parts, updatedAt: now };
  }

  if (event.type === "part.delta") {
    const parts = [...message.parts];
    const part = parts[event.partIndex];
    if (part && (part.type === "text" || part.type === "thinking" || part.type === "code")) {
      parts[event.partIndex] = { ...part, content: part.content + event.delta.text };
      updateMessageParts(message.id, parts, now);
      return { ...message, parts, updatedAt: now };
    }
  }

  if (event.type === "tool.call") {
    const parts = [...message.parts];
    parts.push({ type: "tool_use", callId: event.callId, toolName: event.toolName, args: event.args });
    updateMessageParts(message.id, parts, now);
    return { ...message, parts, updatedAt: now };
  }

  if (event.type === "tool.result") {
    const parts = [...message.parts];
    parts.push({ type: "tool_result", callId: event.callId, result: event.result, isError: event.isError });
    updateMessageParts(message.id, parts, now);
    return { ...message, parts, updatedAt: now };
  }

  if (event.type === "artifact.create") {
    const art = event.artifact;

    // Only persist if tool didn't already create it (avoids duplicate insert G3)
    const existing = getArtifact(art.id);
    if (!existing) {
      createArtifact({
        id: art.id,
        conversationId: art.conversationId,
        createdByAgentId: art.createdByAgentId,
        type: art.type,
        title: art.title,
        content: art.content,
        version: art.version,
        parentArtifactId: art.parentArtifactId,
        now: art.createdAt
      });
    }

    // Inject artifact_ref part into the message (idempotent — dedupe by artifactId)
    const parts = [...message.parts];
    if (!parts.some((p) => p.type === "artifact_ref" && p.artifactId === art.id)) {
      parts.push({
        type: "artifact_ref",
        artifactId: art.id,
        title: art.title,
        artifactType: art.type
      });
      updateMessageParts(message.id, parts, now);
    }
    return { ...message, parts, updatedAt: now };
  }

  if (event.type === "run.usage") {
    return message; // usage tracked separately on the run
  }

  return message;
}

function completeRun(
  run: AgentRun,
  message: Message,
  status: AgentRun["status"],
  error: string | null,
  usage: NonNullable<AgentRun["usage"]>
): void {
  const now = Date.now();

  updateMessageStatus(message.id, status === "failed" ? "error" : "complete", now);
  updateRunStatus(run.id, status, usage, now);

  eventBus.publish({
    type: "run.usage",
    conversationId: run.conversationId,
    timestamp: now,
    runId: run.id,
    usage
  });

  eventBus.publish({
    type: "message.end",
    conversationId: run.conversationId,
    timestamp: now,
    messageId: message.id,
    status: status === "failed" ? "error" : "complete"
  });

  eventBus.publish({
    type: "run.end",
    conversationId: run.conversationId,
    timestamp: now,
    runId: run.id,
    status,
    error: error ?? undefined
  });
}

function createErrorMessage(conversationId: string, relatedMessageId: string, error: string): void {
  const now = Date.now();
  const message = createMessage({
    id: newMessageId(),
    conversationId,
    role: "system",
    parts: [{ type: "text", content: `⚠️ ${error}` }],
    status: "complete",
    parentMessageId: relatedMessageId,
    now
  });

  eventBus.publish({
    type: "message.added",
    conversationId,
    timestamp: now,
    message
  });
}
