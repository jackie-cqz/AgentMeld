// ---------------------------------------------------------------------------
// P1: Task State types — structured task status for model context
// ---------------------------------------------------------------------------

export interface TaskStateInput {
  key: string;
  artifactId: string;
  title: string;
  available: boolean;
  read: boolean;
}

export interface TaskStateCriterion {
  criterionId: string;
  description: string;
  passed: boolean;
}

export interface TaskState {
  taskId: string;
  planId: string;
  agentId: string;
  role: string | null;
  objective: string;
  executionStatus: "new" | "running" | "retrying" | "blocked" | "complete" | "failed";
  attempt: number;
  requiredInputs: TaskStateInput[];
  availableInputs: TaskStateInput[];
  missingInputs: TaskStateInput[];
  unreadInputs: TaskStateInput[];
  passedCriteria: TaskStateCriterion[];
  failedCriteria: TaskStateCriterion[];
  changedFiles: string[];
  failedCommands: Array<{ command: string; exitCode: number; summary: string }>;
  nextActionHint: string;
}
