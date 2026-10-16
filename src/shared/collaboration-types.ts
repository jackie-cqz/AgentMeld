export type ConsultationStatus = "requested" | "running" | "replied" | "declined" | "cancelled" | "expired" | "failed";

export interface AgentConsultation {
  id: string;
  conversationId: string;
  sourceRunId: string;
  sourceAgentId: string;
  targetAgentId: string;
  targetRunId: string | null;
  requestKey: string;
  question: string;
  status: ConsultationStatus;
  answer: string | null;
  error: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export type CollaborationIntent = "discussion" | "new_task" | "progress" | "supplement" | "correction" | "cancel" | "clarify";
export type CollaborationAction = Exclude<CollaborationIntent, "clarify">;
export type CollaborationTurnStatus = "received" | "classifying" | "needs_confirmation" | "queued" | "applied" | "rejected" | "cancelled" | "resolved";

export interface CollaborationTurn {
  id: string;
  conversationId: string;
  messageId: string;
  agentId: string;
  runId: string;
  targetRunId: string | null;
  topicMessageId: string;
  intent: CollaborationIntent | null;
  mode: "discussion" | "execution" | null;
  status: CollaborationTurnStatus;
  contextSnapshotId: string | null;
  context: string | null;
  reason: string | null;
  resolvedBy: string | null;
  resolutionMessageId: string | null;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface TaskHandoff {
  id: string;
  conversationId: string;
  sourceAttemptId: string;
  sourceRunId: string;
  sourceAgentId: string;
  targetAgentId: string;
  taskId: string;
  title: string;
  status: "proposed" | "accepted" | "declined" | "cancelled" | "expired";
  executionStatus: "not_started" | "stopping" | "running" | "complete" | "failed" | "interrupted";
  coordinatorRunId: string | null;
  targetRunId: string | null;
  targetAttemptId: string | null;
  decidedBy: string | null;
  error: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}
