import { describe, it, expect } from "vitest";
import {
  buildConductorPlanPrompt,
  buildConductorAggregatePrompt,
  buildReplanContext,
  buildReviseContext,
  buildContinuationPrompt,
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
