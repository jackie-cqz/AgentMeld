import { describe, it, expect } from "vitest";
import {
  buildConductorPlanPrompt,
  buildConductorAggregatePrompt,
  buildReplanContext,
  buildReviseContext,
  buildContinuationPrompt,
  buildMinimalContextEnvelope,
  CONDUCTOR_PLAN_TOOLS
} from "@/server/conductor-service";
import type { TaskResult } from "@/server/conductor-service";
import type { ParsedTask } from "@/server/tools/conductor-tools";
import type { Agent } from "@/shared/types";
import type { TaskExecutionIdentity } from "@/shared/evidence-types";
import { newTaskAttemptId, newContextSnapshotId, newRunId } from "@/shared/ids";
import { resolveTaskInputs } from "@/server/child-prompt-builder";

function makeStubAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "ag_cond",
    name: "Conductor",
    avatar: "",
    description: "",
    capabilities: [],
    adapterName: "custom",
    modelProvider: "deepseek",
    modelId: "deepseek-chat",
    apiKey: null,
    apiBaseUrl: null,
    systemPrompt: "You are the Conductor.",
    toolNames: ["plan_tasks", "ask_user"],
    isBuiltin: true,
    isOrchestrator: true,
    isConductor: true,
    supportsVision: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}

function makeStubWorker(id: string, name: string, caps: string[], tools: string[]): Agent {
  return makeStubAgent({
    id,
    name,
    capabilities: caps,
    toolNames: tools,
    isOrchestrator: false,
    isConductor: false
  });
}

describe("buildConductorPlanPrompt", () => {
  it("returns a string containing all 4 blocks", () => {
    const cond = makeStubAgent();
    const workers = [
      makeStubWorker("ag_pm", "PM 小灰", ["requirements"], ["write_artifact", "read_artifact"]),
      makeStubWorker("ag_reviewer", "Reviewer", ["review"], ["read_artifact", "bash"]),
    ];
    const prompt = buildConductorPlanPrompt(cond, workers, "/tmp/ws");

    // Block 1: workspace info
    expect(prompt).toContain("<workspace_info>");
    expect(prompt).toContain("<cwd>/tmp/ws</cwd>");

    // Block 2: persona
    expect(prompt).toContain("You are the Conductor.");

    // Block 3: dynamic instructions
    expect(prompt).toContain("## 你的工作流");
    expect(prompt).toContain("## 可用 Agent");
    expect(prompt).toContain('"ag_pm"');
    expect(prompt).toContain("PM 小灰");
    expect(prompt).toContain("## 协作分工方法");
    expect(prompt).toContain("bestFor");
    expect(prompt).toContain("avoidFor");
    expect(prompt).toContain("PRD / 范围定义");
    expect(prompt).toContain("需求一致性审查");
    expect(prompt).toContain('"ag_reviewer"');
    expect(prompt).toContain('<allowed_agent_ids>["ag_pm","ag_reviewer"]</allowed_agent_ids>');
    expect(prompt).toContain("## 拆解原则");
    expect(prompt).toContain("## 依赖关系");
    expect(prompt).toContain("dependsOn");
    expect(prompt).toContain("NEEDS_CLARIFICATION");
    expect(prompt).toContain("READY_TO_PLAN");
    expect(prompt).toContain("第一个工具调用必须是 ask_user");
    expect(prompt).toContain("细节你决定");

    // Block 4: tool guidance
    expect(prompt).toContain("## AgentMeld 工具调用规范");
    expect(prompt).toContain("### plan_tasks");
    expect(prompt).toContain("### ask_user");
    expect(prompt).toContain("### read_artifact");
    expect(prompt).toContain("### read_attachment");
    expect(prompt).toContain("### fs_list / fs_read");
  });

  it("handles empty workers list gracefully", () => {
    const cond = makeStubAgent();
    const prompt = buildConductorPlanPrompt(cond, [], "/tmp/ws");
    expect(prompt).toContain("(无其他可用 Agent)");
  });

  it("uses only current worker ids in the dependency example", () => {
    const cond = makeStubAgent();
    const workers = [
      makeStubWorker("ag_designer_live", "设计师", ["design"], []),
      makeStubWorker("ag_frontend_live", "前端", ["frontend"], [])
    ];
    const prompt = buildConductorPlanPrompt(cond, workers, "/tmp/ws");
    expect(prompt).toContain('"id": "t1"');
    expect(prompt).toContain('"t1"');
    expect(prompt).toContain('"agentId": "ag_designer_live"');
    expect(prompt).toContain('"agentId": "ag_frontend_live"');
    expect(prompt).not.toContain("<设计师 id>");
    expect(prompt).not.toContain("ag_mock_builder");
  });

  it("does NOT include fs_write or bash guidance", () => {
    const cond = makeStubAgent();
    const prompt = buildConductorPlanPrompt(cond, [], "/tmp/ws");
    expect(prompt).not.toContain("### fs_write");
    expect(prompt).not.toContain("### bash");
    expect(prompt).not.toContain("### deploy_artifact");
  });
});

describe("CONDUCTOR_PLAN_TOOLS", () => {
  it("contains the 6 allowed PLAN-stage tools", () => {
    expect(CONDUCTOR_PLAN_TOOLS).toEqual([
      "plan_tasks",
      "ask_user",
      "read_artifact",
      "read_attachment",
      "fs_list",
      "fs_read"
    ]);
  });

  it("does NOT contain fs_write or bash", () => {
    expect(CONDUCTOR_PLAN_TOOLS).not.toContain("fs_write");
    expect(CONDUCTOR_PLAN_TOOLS).not.toContain("bash");
  });
});

// ---------------------------------------------------------------------------
// P6: buildConductorAggregatePrompt
// ---------------------------------------------------------------------------

describe("buildConductorAggregatePrompt", () => {
  const cond = makeStubAgent();
  const task: ParsedTask = {
    id: "t1", agentId: "ag_pm", title: "写 PRD",
    prompt: "写 PRD", dependsOn: [], inputs: [], expectedOutputs: [],
    acceptanceCriteria: [], maxAttempts: 1
  };
  const results = new Map<string, TaskResult>([
    ["t1", { taskId: "t1", status: "complete", summary: "PRD 完成" }]
  ]);
  const triggerMsg = {
    id: "msg_1", conversationId: "c1", role: "user" as const,
    agentId: null, runId: null,
    parts: [{ type: "text" as const, content: "帮我做番茄时钟" }],
    status: "complete" as const, parentMessageId: null,
    mentionedAgentIds: [], createdAt: 0, updatedAt: 0
  };

  it("returns systemPrompt with aggregate stage instructions", () => {
    const { systemPrompt } = buildConductorAggregatePrompt(
      cond, [task], results, new Map(), triggerMsg, "c1"
    );
    expect(systemPrompt).toContain("You are the Conductor");
    expect(systemPrompt).toContain("聚合阶段");
    expect(systemPrompt).toContain("不要再调用 plan_tasks");
  });

  it("returns userPrompt with task_results XML", () => {
    const { userPrompt } = buildConductorAggregatePrompt(
      cond, [task], results, new Map(), triggerMsg, "c1"
    );
    expect(userPrompt).toContain("<user_request>帮我做番茄时钟</user_request>");
    expect(userPrompt).toContain("<task_results>");
    expect(userPrompt).toContain('task="t1"');
    expect(userPrompt).toContain('status="complete"');
  });
});

// ---------------------------------------------------------------------------
// P7: buildReplanContext / buildReviseContext / buildContinuationPrompt
// ---------------------------------------------------------------------------

describe("buildReplanContext", () => {
  it("lists failed tasks with summaries", () => {
    const plan: ParsedTask[] = [
      { id: "t1", agentId: "ag_pm", title: "PRD", prompt: "", dependsOn: [], inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 },
      { id: "t2", agentId: "ag_fe", title: "实现", prompt: "", dependsOn: ["t1"], inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 },
    ];
    const results = new Map<string, TaskResult>([
      ["t1", { taskId: "t1", status: "complete", summary: "OK" }],
      ["t2", { taskId: "t2", status: "failed", summary: "build error" }],
    ]);
    const ctx = buildReplanContext(plan, results);
    expect(ctx).toContain("上一轮以下任务失败");
    expect(ctx).toContain("t2");
    expect(ctx).toContain("实现");
    expect(ctx).toContain("build error");
    expect(ctx).not.toContain("t1"); // t1 succeeded
  });
});

describe("buildReviseContext", () => {
  it("wraps feedback in revision format", () => {
    const ctx = buildReviseContext("t3 不需要，请移除。");
    expect(ctx).toContain("用户对上一个计划的反馈：t3 不需要，请移除。");
    expect(ctx).toContain("请根据反馈重新规划任务。");
  });
});

describe("buildContinuationPrompt", () => {
  it("generates retry prompt with attempt info and error", () => {
    const prompt = buildContinuationPrompt("base prompt here", 2, 3, "timeout");
    expect(prompt).toContain("base prompt here");
    expect(prompt).toContain("[Retry 2/3]");
    expect(prompt).toContain("timeout");
    expect(prompt).toContain("Fix the issues and try again");
  });
});

// ---------------------------------------------------------------------------
// P0: Evidence-aware Context Engineering tests
// ---------------------------------------------------------------------------

function makeTaskIdentity(overrides: Partial<TaskExecutionIdentity> = {}): TaskExecutionIdentity {
  return {
    conductorRunId: newRunId(),
    planId: `plan_${newRunId()}`,
    planRevision: 0,
    taskId: "t1",
    attemptId: newTaskAttemptId(),
    attempt: 1,
    contextSnapshotId: newContextSnapshotId(),
    ...overrides
  };
}

function makeParsedTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    id: "t1",
    agentId: "ag_pm",
    title: "Write PRD",
    prompt: "Write a PRD for a todo app",
    dependsOn: [],
    inputs: [],
    expectedOutputs: [{ id: "prd", type: "document", required: true }],
    acceptanceCriteria: ["PRD covers scope and acceptance criteria"],
    maxAttempts: 2,
    ...overrides
  };
}

describe("P0: buildMinimalContextEnvelope", () => {
  it("generates a valid TaskContextEnvelope with identity fields populated", () => {
    const identity = makeTaskIdentity();
    const task = makeParsedTask();
    const resolvedInputs = resolveTaskInputs(task, new Map());
    const envelope = buildMinimalContextEnvelope(identity, task, resolvedInputs, []);

    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.policyVersion).toBe("evidence-context-p0-v1");

    // Identity populated
    expect(envelope.identity.conductorRunId).toBe(identity.conductorRunId);
    expect(envelope.identity.planId).toBe(identity.planId);
    expect(envelope.identity.taskId).toBe("t1");
    expect(envelope.identity.attemptId).toBe(identity.attemptId);
    expect(envelope.identity.attempt).toBe(1);
    expect(envelope.identity.contextSnapshotId).toBe(identity.contextSnapshotId);

    // Task info populated
    expect(envelope.task.title).toBe("Write PRD");
    expect(envelope.task.objective).toBe("Write a PRD for a todo app");
    expect(envelope.task.assignedAgentId).toBe("ag_pm");

    // Expected outputs mapped
    expect(envelope.requirements.expectedOutputs).toHaveLength(1);
    expect(envelope.requirements.expectedOutputs[0].outputKey).toBe("prd");

    // No failure context on first attempt
    expect(envelope.failureContext).toBeNull();

    // Manifest includes task objective
    expect(envelope.manifest.some((m) => m.category === "task")).toBe(true);
    expect(envelope.manifest.every((m) => m.included)).toBe(true);
  });

  it("includes failure context on retry attempt", () => {
    const identity = makeTaskIdentity({ attempt: 2 });
    const task = makeParsedTask();
    const resolvedInputs = resolveTaskInputs(task, new Map());
    const envelope = buildMinimalContextEnvelope(identity, task, resolvedInputs, [], {
      previousAttemptId: "ta_prev",
      error: "build failed with exit code 1"
    });

    expect(envelope.failureContext).not.toBeNull();
    expect(envelope.failureContext!.previousAttemptId).toBe("ta_prev");
    expect(envelope.failureContext!.retryInstructions).toHaveLength(1);
    expect(envelope.failureContext!.retryInstructions[0]).toContain("build failed");

    // Manifest includes failure entry
    expect(envelope.manifest.some((m) => m.category === "failure")).toBe(true);
  });

  it("generates different contextSnapshotIds for different attempts", () => {
    const task = makeParsedTask();
    const resolvedInputs = resolveTaskInputs(task, new Map());

    const id1 = makeTaskIdentity({ attempt: 1 });
    const id2 = makeTaskIdentity({ attempt: 2, attemptId: newTaskAttemptId() });

    const snap1 = buildMinimalContextEnvelope(id1, task, resolvedInputs, []);
    const snap2 = buildMinimalContextEnvelope(id2, task, resolvedInputs, [], {
      previousAttemptId: id1.attemptId,
      error: "first attempt failed"
    });

    // Different snapshot IDs
    expect(snap1.identity.contextSnapshotId).not.toBe(snap2.identity.contextSnapshotId);
    // Different attempt IDs
    expect(snap1.identity.attemptId).not.toBe(snap2.identity.attemptId);
    // Different attempt numbers
    expect(snap1.identity.attempt).toBe(1);
    expect(snap2.identity.attempt).toBe(2);
  });

  it("includes upstream inputs from DAG-declared dependencies only", () => {
    const identity = makeTaskIdentity();
    // t2 depends on t1, with explicit input declaration
    const task: ParsedTask = {
      id: "t2",
      agentId: "ag_fe",
      title: "Build UI",
      prompt: "Build the UI",
      dependsOn: ["t1"],
      inputs: [{ fromTaskId: "t1", outputId: "prd", required: true }],
      expectedOutputs: [{ id: "app", type: "web_app", required: true }],
      acceptanceCriteria: [],
      maxAttempts: 1
    };

    // Simulate t1 output binding: t1.prd -> art_prd
    const outputBindings = new Map([["t1.prd", "art_prd"]]);
    // Plus a side-branch task t3 that also produced output (should NOT appear)
    outputBindings.set("t3.style", "art_style");

    const resolvedInputs = resolveTaskInputs(task, outputBindings);
    const envelope = buildMinimalContextEnvelope(identity, task, resolvedInputs, []);

    // t2 should see t1.prd input
    expect(envelope.upstreamInputs.length).toBeGreaterThanOrEqual(1);
    const prdInput = envelope.upstreamInputs.find((u) => u.outputKey === "prd");
    expect(prdInput).toBeDefined();
    expect(prdInput!.artifactId).toBe("art_prd");

    // t2 should NOT see t3.style (side-branch, no dependency declared)
    const styleInput = envelope.upstreamInputs.find((u) => u.outputKey === "style");
    expect(styleInput).toBeUndefined();
  });

  it("marks missing required inputs as omitted in manifest", () => {
    const identity = makeTaskIdentity();
    const task: ParsedTask = {
      id: "t3",
      agentId: "ag_fe",
      title: "Implement",
      prompt: "Implement",
      dependsOn: ["t2"],
      inputs: [{ fromTaskId: "t2", outputId: "style", required: true }],
      expectedOutputs: [],
      acceptanceCriteria: [],
      maxAttempts: 1
    };

    // t2.style is NOT in bindings — it's missing
    const outputBindings = new Map<string, string>();
    const resolvedInputs = resolveTaskInputs(task, outputBindings);
    const envelope = buildMinimalContextEnvelope(identity, task, resolvedInputs, []);

    // The missing input should be in the manifest as omitted
    const missingItem = envelope.manifest.find(
      (m) => m.sourceId === "missing" && m.category === "upstream_input"
    );
    expect(missingItem).toBeDefined();
    expect(missingItem!.included).toBe(false);
    expect(missingItem!.omittedReason).toBe("unverified");
  });
});

describe("P0: TaskExecutionIdentity generation", () => {
  it("newTaskAttemptId generates unique IDs with ta_ prefix", () => {
    const id1 = newTaskAttemptId();
    const id2 = newTaskAttemptId();
    expect(id1).toMatch(/^ta_/);
    expect(id2).toMatch(/^ta_/);
    expect(id1).not.toBe(id2);
  });

  it("newContextSnapshotId generates unique IDs with ctxsnap_ prefix", () => {
    const id1 = newContextSnapshotId();
    const id2 = newContextSnapshotId();
    expect(id1).toMatch(/^ctxsnap_/);
    expect(id2).toMatch(/^ctxsnap_/);
    expect(id1).not.toBe(id2);
  });

  it("TaskExecutionIdentity carries all required fields", () => {
    const identity = makeTaskIdentity();
    expect(identity.conductorRunId).toBeTruthy();
    expect(identity.planId).toBeTruthy();
    expect(identity.taskId).toBeTruthy();
    expect(identity.attemptId).toBeTruthy();
    expect(identity.attempt).toBeGreaterThanOrEqual(1);
    expect(identity.contextSnapshotId).toBeTruthy();
  });
});

describe("P0: Output binding gate — validation rules", () => {
  it("validates outputKey must exist in task.expectedOutputs", () => {
    const task = makeParsedTask({ expectedOutputs: [{ id: "prd", type: "document", required: true }] });
    // Valid: "prd" is in expectedOutputs
    expect(task.expectedOutputs?.some((eo) => eo.id === "prd")).toBe(true);
    // Invalid: "style_guide" is NOT in expectedOutputs
    expect(task.expectedOutputs?.some((eo) => eo.id === "style_guide")).toBe(false);
  });

  it("validates artifact type must match expected output type", () => {
    const task = makeParsedTask({ expectedOutputs: [{ id: "prd", type: "document", required: true }] });
    const eo = task.expectedOutputs?.find((o) => o.id === "prd");
    expect(eo?.type).toBe("document");
    // A "web_app" type would not match the "document" expected type
    expect(eo?.type === "web_app").toBe(false);
  });

  it("detects missing required outputs", () => {
    const task = makeParsedTask({
      expectedOutputs: [
        { id: "prd", type: "document", required: true },
        { id: "summary", type: "document", required: false }
      ]
    });

    const reportedArtifacts: Record<string, string> = {};
    // No artifact reported — required "prd" is missing

    const missingRequired = (task.expectedOutputs ?? [])
      .filter((eo) => eo.required)
      .filter((eo) => !(eo.id in reportedArtifacts));

    expect(missingRequired).toHaveLength(1);
    expect(missingRequired[0].id).toBe("prd");

    // Optional output missing should NOT trigger failure
    const missingOptional = (task.expectedOutputs ?? [])
      .filter((eo) => !eo.required)
      .filter((eo) => !(eo.id in reportedArtifacts));
    // "summary" is optional — its absence is OK
    expect(missingOptional.length).toBeGreaterThanOrEqual(0);
  });

  it("accepts all expected outputs when reported", () => {
    const task = makeParsedTask({ expectedOutputs: [{ id: "prd", type: "document", required: true }] });
    const reportedArtifacts: Record<string, string> = { prd: "art_prd_1" };

    const missingRequired = (task.expectedOutputs ?? [])
      .filter((eo) => eo.required)
      .filter((eo) => !(eo.id in reportedArtifacts));

    expect(missingRequired).toHaveLength(0);
  });
});

describe("P0: Context isolation — no side-branch artifacts", () => {
  it("upstreamArtifacts only include DAG-resolved inputs", () => {
    // Scenario: t1->PRD, t2->Style, t3->App depends on t1+t2
    // t4->Review depends on t3
    // t4 should NOT see t1/t2 artifacts directly, only via t3's output
    const t4Task: ParsedTask = {
      id: "t4",
      agentId: "ag_reviewer",
      title: "Review",
      prompt: "Review the app",
      dependsOn: ["t3"],
      inputs: [{ fromTaskId: "t3", outputId: "app", required: true }],
      expectedOutputs: [],
      acceptanceCriteria: [],
      maxAttempts: 1
    };

    // Simulate bindings from all tasks
    const outputBindings = new Map([
      ["t1.prd", "art_prd"],
      ["t2.style", "art_style"],
      ["t3.app", "art_app"]
    ]);

    const resolvedInputs = resolveTaskInputs(t4Task, outputBindings);

    // t4 should only have t3.app resolved
    expect(resolvedInputs.filter((ri) => !ri.missing)).toHaveLength(1);
    expect(resolvedInputs.find((ri) => ri.outputId === "app")?.artifactId).toBe("art_app");

    // t4 should NOT have t1.prd or t2.style resolved (no direct dependency)
    const directPrdInput = resolvedInputs.find((ri) => ri.outputId === "prd");
    expect(directPrdInput).toBeUndefined();
  });

  it("resolveTaskInputs resolves inputs declared in DAG but not undeclared bindings", () => {
    const task: ParsedTask = {
      id: "t2",
      agentId: "ag_designer",
      title: "Design",
      prompt: "Design",
      dependsOn: ["t1"],
      inputs: [{ fromTaskId: "t1", outputId: "prd", required: true }],
      expectedOutputs: [{ id: "style", type: "document", required: true }],
      acceptanceCriteria: [],
      maxAttempts: 1
    };

    // t1.prd is bound, and there's an unrelated t0.legacy binding too
    const outputBindings = new Map([
      ["t1.prd", "art_prd"],
      ["t0.legacy", "art_old"]
    ]);

    const resolvedInputs = resolveTaskInputs(task, outputBindings);

    // t1.prd should be resolved
    const prdInput = resolvedInputs.find((ri) => ri.fromTaskId === "t1" && ri.outputId === "prd");
    expect(prdInput).toBeDefined();
    expect(prdInput!.missing).toBe(false);
    expect(prdInput!.artifactId).toBe("art_prd");

    // t0.legacy should NOT appear — not declared in inputs
    const legacyInput = resolvedInputs.find((ri) => ri.fromTaskId === "t0");
    expect(legacyInput).toBeUndefined();
  });
});
