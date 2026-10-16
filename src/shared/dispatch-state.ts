import type { PendingDispatchPlan } from "./types";

/** Public projection only; compiled prompt/evidence bodies remain server-side. */
export interface DispatchState {
  runId: string;
  conversationId: string;
  messageId: string | null;
  plan: PendingDispatchPlan["plan"];
  taskStatus: Record<string, "pending" | "running" | "complete" | "failed" | "aborted" | "skipped" | "blocked">;
  childRunIds: Record<string, string>;
  attempts: Record<string, number>;
  errors: Record<string, string>;
  reviewStatus?: "pending" | "approved" | "rejected";
  pendingPlanId?: string;
  attemptIdsByTask: Record<string, string[]>;
  activeAttemptByTask: Record<string, string>;
  verificationStatusByTask: Record<string, "checking" | "verified" | "rejected" | "needs_review">;
  contextSummaryByAttempt: Record<string, { tokenEstimate: number; includedCount: number; omittedCount: number }>;
  evidenceCountByAttempt: Record<string, number>;
  verdictSummaryByAttempt: Record<string, { passed: number; failed: number; missing: number; needsReview: number }>;
}
