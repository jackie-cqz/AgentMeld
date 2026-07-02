import { describe, expect, it } from "vitest";
import { correctAgentIds, validatePlan, topologicalWaves, parsePlanArgs } from "@/server/tools/conductor-tools";
import { toolRegistry } from "@/server/tools/registry";
import { clearTaskResultsForRun, getTaskReport, recordTaskArtifact } from "@/server/dispatch-task-results";

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
    if (result.ok) {
      expect(result.value).toMatchObject({
        reasoning: "Test plan",
        correctedCount: 0,
        tasks: [
          {
            id: "t1",
            agentId: "ag_test"
          }
        ]
      });
    }
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

  it("rejects input references to undeclared upstream output keys", async () => {
    const result = await toolRegistry.execute("plan_tasks", {
      reasoning: "Bad output binding",
      tasks: [
        {
          id: "t1",
          agentId: "ag_pm",
          title: "PRD",
          prompt: "Write PRD.",
          expectedOutputs: [{ id: "prd_doc", type: "document" }]
        },
        {
          id: "t2",
          agentId: "ag_designer",
          title: "Style",
          prompt: "Write style guide.",
          dependsOn: ["t1"],
          inputs: [{ fromTaskId: "t1", outputId: "prd_doc" }]
        },
        {
          id: "t3",
          agentId: "ag_frontend",
          title: "Build",
          prompt: "Build app.",
          dependsOn: ["t1", "t2"],
          inputs: [
            { fromTaskId: "t1", outputId: "prd_doc" },
            { fromTaskId: "t2", outputId: "prd_doc" }
          ]
        }
      ]
    }, { conversationId: "c", workspacePath: "/tmp", agentId: "a", runId: "r", abortSignal: new AbortController().signal });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Task "t3" input references unknown output "prd_doc" from task "t2"');
    }
  });
});

describe("correctAgentIds", () => {
  const agents = [
    { id: "ag_frontend", name: "前端工程师", capabilities: ["frontend", "react"] },
    { id: "ag_designer", name: "设计师", capabilities: ["design", "ui"] }
  ];

  it("keeps an already valid agent id unchanged", () => {
    const tasks = [{ agentId: "ag_designer", prompt: "实现 HTML 和 CSS 页面" }];
    const corrected = correctAgentIds(tasks, new Map(), agents);

    expect(corrected).toBe(0);
    expect(tasks[0].agentId).toBe("ag_designer");
  });

  it("corrects a known alias to an available agent", () => {
    const tasks = [{ agentId: "frontend", prompt: "实现页面" }];
    const corrected = correctAgentIds(
      tasks,
      new Map([["frontend", "ag_frontend"]]),
      agents
    );

    expect(corrected).toBe(1);
    expect(tasks[0].agentId).toBe("ag_frontend");
  });
});

describe("report_task_result tool", () => {
  it("is registered in the tool registry", () => {
    const tool = toolRegistry.get("report_task_result");
    expect(tool).toBeDefined();
  });

  it("exposes the verification contract without artifact maps", () => {
    const tool = toolRegistry.get("report_task_result");
    const properties = tool?.parameters.properties as Record<string, unknown>;
    const required = tool?.parameters.required as string[];

    expect(properties.status).toBeDefined();
    expect(properties.summary).toBeDefined();
    expect(properties.acceptanceResults).toBeDefined();
    expect(properties.files).toBeDefined();
    expect(properties.commands).toBeDefined();
    expect(properties.tests).toBeDefined();
    expect(properties.artifacts).toBeUndefined();
    expect(required).toContain("acceptanceResults");
  });

  it("exposes outputKey on write_artifact for strict output binding", () => {
    const tool = toolRegistry.get("write_artifact");
    const properties = tool?.parameters.properties as Record<string, unknown>;

    expect(properties.outputKey).toBeDefined();
  });

  it("accepts a valid complete report", async () => {
    const result = await toolRegistry.execute("report_task_result", {
      status: "complete",
      summary: "All done.",
      acceptanceResults: [{ criterion: "Works", passed: true, evidence: "Tests pass" }]
    }, { conversationId: "c", workspacePath: "/tmp", agentId: "a", runId: "r", abortSignal: new AbortController().signal });

    expect(result.ok).toBe(true);
  });

  it("rejects a complete report that omits task acceptance criteria", async () => {
    const runId = "run_incomplete_acceptance";
    clearTaskResultsForRun(runId);
    const result = await toolRegistry.execute("report_task_result", {
      status: "complete",
      summary: "All done.",
      acceptanceResults: []
    }, {
      conversationId: "c",
      workspacePath: "/tmp",
      agentId: "a",
      runId,
      taskContract: {
        acceptanceCriteria: ["Works"],
        expectedOutputs: []
      },
      abortSignal: new AbortController().signal
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Works");
    expect(getTaskReport(runId)).toBeUndefined();
  });

  it("records a complete report after every task criterion is reported verbatim", async () => {
    const runId = "run_complete_acceptance";
    clearTaskResultsForRun(runId);
    const result = await toolRegistry.execute("report_task_result", {
      status: "complete",
      summary: "All done.",
      acceptanceResults: [
        { criterion: "Works", passed: true, evidence: "The check passed." }
      ]
    }, {
      conversationId: "c",
      workspacePath: "/tmp",
      agentId: "a",
      runId,
      taskContract: {
        acceptanceCriteria: ["Works"],
        expectedOutputs: []
      },
      abortSignal: new AbortController().signal
    });

    expect(result.ok).toBe(true);
    expect(getTaskReport(runId)?.acceptanceResults).toEqual([
      { criterion: "Works", passed: true, evidence: "The check passed." }
    ]);
    clearTaskResultsForRun(runId);
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

  it("merges artifacts recorded from write_artifact outputKey into the final report", async () => {
    const runId = "run_report_artifact_merge";
    clearTaskResultsForRun(runId);
    recordTaskArtifact(runId, "style-guide", "art_style_123");

    const result = await toolRegistry.execute("report_task_result", {
      status: "complete",
      summary: "Style guide completed."
    }, { conversationId: "c", workspacePath: "/tmp", agentId: "a", runId, abortSignal: new AbortController().signal });

    expect(result.ok).toBe(true);
    expect(getTaskReport(runId)?.artifacts).toEqual({ "style-guide": "art_style_123" });
    clearTaskResultsForRun(runId);
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

  it("detects input references to missing upstream outputs", () => {
    const result = validatePlan([
      {
        id: "t1",
        agentId: "a1",
        dependsOn: [],
        expectedOutputs: [{ id: "prd_doc" }]
      },
      {
        id: "t2",
        agentId: "a2",
        dependsOn: ["t1"],
        inputs: [{ fromTaskId: "t1", outputId: "style_guide" }]
      }
    ]);

    expect(result).toBe('Task "t2" input references unknown output "style_guide" from task "t1".');
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

  it("treats dependencies from a previous recovery round as already resolved", () => {
    const tasks = [
      { id: "r1", agentId: "a1", dependsOn: ["t1"], title: "", prompt: "", inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 2 }
    ];
    const waves = topologicalWaves(tasks);
    expect(waves).toHaveLength(1);
    expect(waves[0][0].id).toBe("r1");
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
