import { describe, expect, it } from "vitest";
import { validatePlan, topologicalWaves, parsePlanArgs, planArgsSchema, reportSchema } from "@/server/tools/orchestrator-tools";
import { toolRegistry } from "@/server/tools/registry";

describe("plan_tasks tool", () => {
  it("is registered in the tool registry", () => {
    const tool = toolRegistry.get("plan_tasks");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("plan_tasks");
  });

  it("accepts a valid plan", async () => {
    const result = await toolRegistry.execute("plan_tasks", {
      reasoning: "Test plan",
      tasks: [{ id: "t1", agentId: "ag_test", title: "Task 1", prompt: "Do something." }]
    }, { conversationId: "c", workspacePath: "/tmp", agentId: "a", runId: "r", abortSignal: new AbortController().signal });

    expect(result.ok).toBe(true);
  });

  it("rejects plan with duplicate task IDs", async () => {
    const result = await toolRegistry.execute("plan_tasks", {
      reasoning: "Bad",
      tasks: [
        { id: "t1", agentId: "ag_1", title: "A", prompt: "x" },
        { id: "t1", agentId: "ag_2", title: "B", prompt: "y" }
      ]
    }, { conversationId: "c", workspacePath: "/tmp", agentId: "a", runId: "r", abortSignal: new AbortController().signal });

    expect(result.ok).toBe(false);
  });

  it("rejects plan with circular dependency", async () => {
    const result = await toolRegistry.execute("plan_tasks", {
      reasoning: "Cycle",
      tasks: [
        { id: "t1", agentId: "a1", title: "A", prompt: "x", dependsOn: ["t2"] },
        { id: "t2", agentId: "a2", title: "B", prompt: "y", dependsOn: ["t1"] }
      ]
    }, { conversationId: "c", workspacePath: "/tmp", agentId: "a", runId: "r", abortSignal: new AbortController().signal });

    expect(result.ok).toBe(false);
  });

  it("rejects plan with self-dependency", async () => {
    const result = await toolRegistry.execute("plan_tasks", {
      reasoning: "Self",
      tasks: [{ id: "t1", agentId: "a1", title: "A", prompt: "x", dependsOn: ["t1"] }]
    }, { conversationId: "c", workspacePath: "/tmp", agentId: "a", runId: "r", abortSignal: new AbortController().signal });

    expect(result.ok).toBe(false);
  });

  it("rejects empty plan", async () => {
    const result = await toolRegistry.execute("plan_tasks", {
      reasoning: "Empty",
      tasks: []
    }, { conversationId: "c", workspacePath: "/tmp", agentId: "a", runId: "r", abortSignal: new AbortController().signal });

    expect(result.ok).toBe(false);
  });
});

describe("report_task_result tool", () => {
  it("is registered in the tool registry", () => {
    const tool = toolRegistry.get("report_task_result");
    expect(tool).toBeDefined();
  });

  it("accepts a valid complete report", async () => {
    const result = await toolRegistry.execute("report_task_result", {
      status: "complete",
      summary: "All done.",
      acceptanceResults: [{ criterion: "Works", passed: true, evidence: "Tests pass" }]
    }, { conversationId: "c", workspacePath: "/tmp", agentId: "a", runId: "r", abortSignal: new AbortController().signal });

    expect(result.ok).toBe(true);
  });

  it("accepts a failed report", async () => {
    const result = await toolRegistry.execute("report_task_result", {
      status: "failed",
      summary: "Could not complete.",
      blockers: ["Missing dependency"]
    }, { conversationId: "c", workspacePath: "/tmp", agentId: "a", runId: "r", abortSignal: new AbortController().signal });

    expect(result.ok).toBe(true);
  });

  it("rejects invalid status", async () => {
    const result = await toolRegistry.execute("report_task_result", {
      status: "pending",
      summary: "x"
    }, { conversationId: "c", workspacePath: "/tmp", agentId: "a", runId: "r", abortSignal: new AbortController().signal });

    expect(result.ok).toBe(false);
  });
});

describe("validatePlan", () => {
  it("returns null for a valid plan", () => {
    const result = validatePlan([
      { id: "t1", agentId: "a1", dependsOn: [] },
      { id: "t2", agentId: "a2", dependsOn: ["t1"] }
    ]);
    expect(result).toBeNull();
  });

  it("detects duplicate IDs", () => {
    const result = validatePlan([
      { id: "t1", agentId: "a1", dependsOn: [] },
      { id: "t1", agentId: "a2", dependsOn: [] }
    ]);
    expect(result).toContain("Duplicate");
  });

  it("detects unknown dependency", () => {
    const result = validatePlan([
      { id: "t1", agentId: "a1", dependsOn: ["t_missing"] }
    ]);
    expect(result).toContain("unknown");
  });

  it("detects self-dependency", () => {
    const result = validatePlan([
      { id: "t1", agentId: "a1", dependsOn: ["t1"] }
    ]);
    expect(result).toContain("itself");
  });

  it("detects circular dependency", () => {
    const result = validatePlan([
      { id: "t1", agentId: "a1", dependsOn: ["t3"] },
      { id: "t2", agentId: "a2", dependsOn: ["t1"] },
      { id: "t3", agentId: "a3", dependsOn: ["t2"] }
    ]);
    expect(result).toContain("circular");
  });

  it("rejects empty plan", () => {
    const result = validatePlan([]);
    expect(result).toContain("at least one");
  });
});

describe("topologicalWaves", () => {
  it("sorts independent tasks into a single wave", () => {
    const tasks = [
      { id: "t1", agentId: "a1", dependsOn: [], title: "", prompt: "", inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 },
      { id: "t2", agentId: "a2", dependsOn: [], title: "", prompt: "", inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 }
    ];
    const waves = topologicalWaves(tasks);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(2);
  });

  it("splits dependent tasks into sequential waves", () => {
    const tasks = [
      { id: "t1", agentId: "a1", dependsOn: [], title: "", prompt: "", inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 },
      { id: "t2", agentId: "a2", dependsOn: ["t1"], title: "", prompt: "", inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 },
      { id: "t3", agentId: "a3", dependsOn: ["t2"], title: "", prompt: "", inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 }
    ];
    const waves = topologicalWaves(tasks);
    expect(waves).toHaveLength(3);
    expect(waves[0][0].id).toBe("t1");
    expect(waves[1][0].id).toBe("t2");
    expect(waves[2][0].id).toBe("t3");
  });

  it("puts multiple tasks in the same wave when dependencies are met", () => {
    const tasks = [
      { id: "t1", agentId: "a1", dependsOn: [], title: "", prompt: "", inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 },
      { id: "t2", agentId: "a2", dependsOn: ["t1"], title: "", prompt: "", inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 },
      { id: "t3", agentId: "a3", dependsOn: ["t1"], title: "", prompt: "", inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 }
    ];
    const waves = topologicalWaves(tasks);
    expect(waves).toHaveLength(2);
    expect(waves[0]).toHaveLength(1); // t1
    expect(waves[1]).toHaveLength(2); // t2, t3 in parallel
  });
});

describe("parsePlanArgs", () => {
  it("parses valid args", () => {
    const result = parsePlanArgs({
      reasoning: "Test",
      tasks: [{ id: "t1", agentId: "a1", title: "T", prompt: "P" }]
    });
    expect(typeof result).not.toBe("string");
    if (typeof result !== "string") {
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].maxAttempts).toBe(1); // default
    }
  });

  it("returns error string for invalid args", () => {
    const result = parsePlanArgs({ reasoning: "Bad", tasks: "not-an-array" });
    expect(typeof result).toBe("string");
  });
});
