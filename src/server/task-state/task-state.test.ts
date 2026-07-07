// ---------------------------------------------------------------------------
// P1: Task State tests
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildTaskState } from "@/server/task-state/task-state-builder";
import type { ParsedTask } from "@/server/tools/conductor-tools";
import type { ResolvedInput } from "@/server/child-prompt-builder";

const baseTask: ParsedTask = {
  id: "t3", agentId: "ag_frontend", title: "Implement Todo App",
  prompt: "Build the todo app with React", dependsOn: ["t1", "t2"],
  inputs: [
    { fromTaskId: "t1", outputId: "prd", required: true },
    { fromTaskId: "t2", outputId: "style-guide", required: true },
  ],
  expectedOutputs: [{ id: "web_app", type: "web_app", required: true }],
  acceptanceCriteria: ["Build passes", "Deployment ready"],
  maxAttempts: 2,
};

const resolvedWithMissing: ResolvedInput[] = [
  { fromTaskId: "t1", outputId: "prd", required: true, artifactId: "art_prd", missing: false, description: "PRD" },
  { fromTaskId: "t2", outputId: "style-guide", required: true, artifactId: "", missing: true, description: "Style Guide" },
];

const resolvedAllAvailable: ResolvedInput[] = [
  { fromTaskId: "t1", outputId: "prd", required: true, artifactId: "art_prd", missing: false, description: "PRD" },
  { fromTaskId: "t2", outputId: "style-guide", required: true, artifactId: "art_style", missing: false, description: "Style Guide" },
];

describe("buildTaskState", () => {
  it("identifies missing inputs", () => {
    const state = buildTaskState({
      task: baseTask, resolvedInputs: resolvedWithMissing,
      attemptId: "ta_test", attempt: 1, agentCapabilities: ["react"],
    });
    expect(state.missingInputs.length).toBe(1);
    expect(state.missingInputs[0].key).toBe("t2.style-guide");
    expect(state.executionStatus).toBe("blocked");
  });

  it("identifies available inputs", () => {
    const state = buildTaskState({
      task: baseTask, resolvedInputs: resolvedAllAvailable,
      attemptId: "ta_test", attempt: 1, agentCapabilities: ["react"],
    });
    expect(state.availableInputs.length).toBe(2);
    expect(state.missingInputs.length).toBe(0);
  });

  it("marks executionStatus as retrying for attempt > 1", () => {
    const state = buildTaskState({
      task: baseTask, resolvedInputs: resolvedAllAvailable,
      attemptId: "ta_test", attempt: 2, agentCapabilities: ["react"],
      previousAttemptId: "ta_prev", previousError: "build failed",
    });
    expect(state.executionStatus).toBe("retrying");
  });

  it("detects frontend role from capabilities", () => {
    const state = buildTaskState({
      task: baseTask, resolvedInputs: [],
      attemptId: "ta_test", attempt: 1, agentCapabilities: ["react", "frontend"],
    });
    expect(state.role).toBe("frontend");
  });

  it("generates next action hint for unread inputs", () => {
    const state = buildTaskState({
      task: baseTask, resolvedInputs: resolvedAllAvailable,
      attemptId: "ta_test", attempt: 1, agentCapabilities: ["react"],
    });
    // Inputs are available but not read (no artifact_read evidence in test DB)
    expect(state.unreadInputs.length).toBe(2);
    expect(state.nextActionHint).toContain("Read");
  });

  it("generates next action hint for missing inputs", () => {
    const state = buildTaskState({
      task: baseTask, resolvedInputs: resolvedWithMissing,
      attemptId: "ta_test", attempt: 1, agentCapabilities: ["react"],
    });
    expect(state.nextActionHint).toContain("Missing");
    expect(state.nextActionHint).toContain("cannot proceed");
  });

  it("requiredInputs includes all declared inputs", () => {
    const state = buildTaskState({
      task: baseTask, resolvedInputs: resolvedAllAvailable,
      attemptId: "ta_test", attempt: 1, agentCapabilities: [],
    });
    expect(state.requiredInputs.length).toBe(2);
  });

  it("returns empty criteria arrays when no verdicts", () => {
    const state = buildTaskState({
      task: baseTask, resolvedInputs: [],
      attemptId: "ta_nonexistent", attempt: 1, agentCapabilities: [],
    });
    expect(state.passedCriteria.length).toBe(0);
    expect(state.failedCriteria.length).toBe(0);
  });
});
