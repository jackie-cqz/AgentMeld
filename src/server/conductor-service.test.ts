import { describe, it, expect } from "vitest";
import {
  buildConductorPlanPrompt,
  buildConductorAggregatePrompt,
  bindRecoveryTasksToOriginalPlan,
  buildReplanContext,
  buildReviseContext,
  buildContinuationPrompt,
  enforceExplicitFrameworkContracts,
  CONDUCTOR_PLAN_TOOLS
} from "@/server/conductor-service";
import type { TaskResult } from "@/server/conductor-service";
import type { ParsedTask } from "@/server/tools/conductor-tools";
import type { Agent } from "@/shared/types";

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
    expect(prompt).toContain("用户明确指定两个或以上角色");
    expect(prompt).toContain("你必须调用 plan_tasks");

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
  it("lists failed tasks with summaries and passed tasks", () => {
    const plan: ParsedTask[] = [
      { id: "t1", agentId: "ag_pm", title: "PRD", prompt: "", dependsOn: [], inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 },
      { id: "t2", agentId: "ag_fe", title: "实现", prompt: "", dependsOn: ["t1"], inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1 },
    ];
    const results = new Map<string, TaskResult>([
      ["t1", { taskId: "t1", status: "complete", summary: "OK" }],
      ["t2", { taskId: "t2", status: "failed", summary: "build error" }],
    ]);
    const ctx = buildReplanContext(plan, results);
    // P5: New format includes execution summary with counts
    expect(ctx).toContain("上一轮执行结果：1 失败, 1 成功");
    expect(ctx).toContain("失败任务（含验收详情）");
    expect(ctx).toContain("已完成任务");
    expect(ctx).toContain("t2");
    expect(ctx).toContain("实现");
    expect(ctx).toContain("build error");
    // t1 now appears in "已完成任务" section
    expect(ctx).toContain("t1");
    expect(ctx).toContain("✅ 已完成");
    expect(ctx).toContain("补救指示");
  });
});

describe("bindRecoveryTasksToOriginalPlan", () => {
  it("inherits the original task contract and rejects model-invented target paths", () => {
    const original: ParsedTask = {
      id: "t3",
      agentId: "ag_frontend",
      title: "实现应用",
      prompt: "基于 PRD 和风格指南实现应用。",
      dependsOn: ["t1", "t2"],
      inputs: [
        { fromTaskId: "t1", outputId: "prd", required: true },
        { fromTaskId: "t2", outputId: "style_guide", required: true }
      ],
      expectedOutputs: [
        { id: "web_app", type: "web_app", required: true }
      ],
      acceptanceCriteria: ["构建通过", "部署成功"],
      maxAttempts: 1,
      taskIntent: "delivery",
      contractProfile: "standard",
      contractSelectionReason: "required output web_app is explicitly declared",
      contractSelectionVersion: "role-contract-intent-v1",
      targetPaths: [],
      requiredCommands: [{ command: "npm run build" }],
      requiredEvidence: ["部署产物"]
    };
    const proposed: ParsedTask = {
      id: "r1",
      replacesTaskId: "t3",
      agentId: "ag_other",
      title: "修复实现",
      prompt: "修复并重新部署。",
      dependsOn: [],
      inputs: [],
      expectedOutputs: [],
      acceptanceCriteria: [],
      maxAttempts: 2,
      targetPaths: ["C:\\absolute\\workspace"],
      requiredCommands: [],
      requiredEvidence: []
    };
    const results = new Map<string, TaskResult>([
      ["t1", { taskId: "t1", status: "complete", summary: "ok" }],
      ["t2", { taskId: "t2", status: "complete", summary: "ok" }],
      ["t3", { taskId: "t3", status: "failed", summary: "missing report" }]
    ]);

    const [bound] = bindRecoveryTasksToOriginalPlan([proposed], [original], results);

    expect(bound.replacesTaskId).toBe("t3");
    expect(bound.agentId).toBe("ag_frontend");
    expect(bound.dependsOn).toEqual(["t1", "t2"]);
    expect(bound.inputs).toEqual(original.inputs);
    expect(bound.expectedOutputs).toEqual(original.expectedOutputs);
    expect(bound.acceptanceCriteria).toEqual(original.acceptanceCriteria);
    expect(bound.targetPaths).toEqual([]);
    expect(bound.requiredCommands).toEqual(original.requiredCommands);
    expect(bound.requiredEvidence).toEqual(original.requiredEvidence);
    expect(bound.taskIntent).toBe("delivery");
    expect(bound.contractProfile).toBe("standard");
    expect(bound.contractSelectionReason).toBe(original.contractSelectionReason);
    expect(bound.contractSelectionVersion).toBe("role-contract-intent-v1");
    expect(bound.prompt).toContain(original.prompt);
    expect(bound.prompt).toContain(proposed.prompt);
  });

  it("does not bind recovery work to skipped downstream tasks", () => {
    const failed: ParsedTask = {
      id: "t1", agentId: "ag_frontend", title: "实现", prompt: "实现",
      dependsOn: [], inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1
    };
    const skipped: ParsedTask = {
      id: "t2", agentId: "ag_reviewer", title: "审查", prompt: "审查",
      dependsOn: ["t1"], inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1
    };
    const proposed: ParsedTask = {
      id: "r1", replacesTaskId: "t2", agentId: "ag_reviewer", title: "恢复审查", prompt: "恢复",
      dependsOn: [], inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1
    };
    const results = new Map<string, TaskResult>([
      ["t1", { taskId: "t1", status: "failed", summary: "failed" }],
      ["t2", { taskId: "t2", status: "skipped", summary: "upstream failed" }]
    ]);

    const [bound] = bindRecoveryTasksToOriginalPlan([proposed], [failed, skipped], results);
    expect(bound.replacesTaskId).toBe("t1");
    expect(bound.agentId).toBe("ag_frontend");
  });
});

describe("enforceExplicitFrameworkContracts", () => {
  const webTask = (): ParsedTask => ({
    id: "t3",
    agentId: "ag_frontend",
    title: "实现应用",
    prompt: "实现并部署应用。",
    dependsOn: [],
    inputs: [],
    expectedOutputs: [{ id: "web_app", type: "web_app", required: true }],
    acceptanceCriteria: [],
    maxAttempts: 1,
    targetPaths: ["src"],
    requiredCommands: [],
    requiredEvidence: []
  });

  it("turns an explicitly requested React stack into a hard execution contract", () => {
    const [result] = enforceExplicitFrameworkContracts(
      [webTask()],
      "请使用 React + Vite 实现 Todo 应用"
    );

    expect(result.targetPaths).toEqual(["src", "package.json"]);
    expect(result.requiredCommands).toContainEqual({
      command: "npm run build",
      timeoutMs: 120_000
    });
    expect(result.prompt).toContain("## 平台显式框架契约");
    expect(result.prompt).toContain("React / Vite");
    expect(result.prompt).toContain("不得降级成单文件静态 HTML");
    expect(result.prompt).toContain("deploy_workspace");
    expect(result.prompt).toContain("report_task_result");
  });

  it("does not alter non-web tasks or infer a framework that the user did not request", () => {
    const documentTask: ParsedTask = {
      ...webTask(),
      id: "t1",
      expectedOutputs: [{ id: "prd", type: "document", required: true }]
    };

    expect(enforceExplicitFrameworkContracts([documentTask], "使用 React 实现应用"))
      .toEqual([documentTask]);
    expect(enforceExplicitFrameworkContracts([webTask()], "实现一个 Todo 应用"))
      .toEqual([webTask()]);
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
