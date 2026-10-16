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
