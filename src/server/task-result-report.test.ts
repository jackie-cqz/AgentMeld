import { describe, expect, it } from "vitest";
import type { DispatchTaskReport } from "@/server/dispatch-task-results";
import { evaluateChildTaskResult, type TaskEvidence } from "@/server/task-result-report";
import type { ParsedTask } from "@/server/tools/conductor-tools";

function task(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    id: "t1",
    agentId: "ag_worker",
    title: "Implement",
    prompt: "Implement the requested change.",
    dependsOn: [],
    inputs: [],
    expectedOutputs: [],
    acceptanceCriteria: [],
    maxAttempts: 1,
    targetPaths: [],
    requiredCommands: [],
    requiredEvidence: [],
    ...overrides
  };
}

function report(overrides: Partial<DispatchTaskReport> = {}): DispatchTaskReport {
  return {
    taskId: "t1",
    runId: "run_child",
    status: "complete",
    summary: "Implementation complete.",
    acceptanceResults: [],
    blockers: [],
    artifacts: {},
    files: [],
    commands: [],
    tests: [],
    ...overrides
  };
}

function evidence(overrides: Partial<TaskEvidence> = {}): TaskEvidence {
  return {
    fileWrites: [],
    commands: [],
    ...overrides
  };
}

describe("evaluateChildTaskResult evidence gates", () => {
  it("accepts a complete report that covers every criterion verbatim", () => {
    const result = evaluateChildTaskResult(
      task({ acceptanceCriteria: ["覆盖全部功能", "包含验收标准"] }),
      report({
        acceptanceResults: [
          { criterion: "覆盖全部功能", passed: true, evidence: "PRD 功能表覆盖四项需求。" },
          { criterion: "包含验收标准", passed: true, evidence: "PRD 包含 AC-01 至 AC-17。" }
        ]
      }),
      evidence()
    );

    expect(result.status).toBe("complete");
  });

  it("fails closed when a declared criterion is omitted", () => {
    const result = evaluateChildTaskResult(
      task({ acceptanceCriteria: ["覆盖全部功能"] }),
      report({ acceptanceResults: [] }),
      evidence()
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("验收标准漏报");
  });

  it("accepts semantically equivalent acceptance result wording", () => {
    const result = evaluateChildTaskResult(
      task({
        acceptanceCriteria: [
          "番茄时钟核心功能完整（25分钟工作/5分钟短休息/15分钟长休息）",
          "有开始/暂停/重置交互按钮"
        ]
      }),
      report({
        acceptanceResults: [
          {
            criterion: "番茄时钟核心功能：25分钟工作 + 5分钟短休息 + 15分钟长休息",
            passed: true,
            evidence: "App.jsx 定义了 focus、shortBreak、longBreak 三种模式。"
          },
          {
            criterion: "开始、暂停和重置按钮均可交互",
            passed: true,
            evidence: "界面提供主控制按钮和重置按钮。"
          }
        ]
      }),
      evidence()
    );

    expect(result.status).toBe("complete");
  });

  it("does not require auto-verified contract criteria in the child report", () => {
    const artifactCriterion = JSON.stringify({
      id: "contract-prd-created",
      description: "PRD 产物已创建",
      required: true,
      validator: { type: "artifact_exists", outputKey: "prd", artifactType: "document" }
    });

    const result = evaluateChildTaskResult(
      task({ acceptanceCriteria: ["覆盖全部功能", artifactCriterion] }),
      report({
        acceptanceResults: [
          { criterion: "覆盖全部功能", passed: true, evidence: "PRD 覆盖了完整需求。" }
        ]
      }),
      evidence()
    );

    expect(result.status).toBe("complete");
  });

  it("fails when a declared target path has no file evidence", () => {
    const result = evaluateChildTaskResult(
      task({ targetPaths: ["src/app.ts"] }),
      report(),
      evidence()
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("src/app.ts");
  });

  it("accepts target path evidence from an actual fs_write", () => {
    const result = evaluateChildTaskResult(
      task({ targetPaths: ["src"] }),
      report(),
      evidence({
        fileWrites: [{ path: "src/app.ts", action: "created" }]
      })
    );

    expect(result.status).toBe("complete");
  });

  it("fails when a required command did not complete successfully", () => {
    const result = evaluateChildTaskResult(
      task({ requiredCommands: [{ command: "pnpm build" }] }),
      report(),
      evidence({
        commands: [{
          command: "pnpm build",
          exitCode: 1,
          timedOut: false,
          isError: false
        }]
      })
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("命令证据失败");
  });

  it("ignores an earlier failed shell separator command when a later equivalent command succeeds", () => {
    const result = evaluateChildTaskResult(
      task({ requiredCommands: [{ command: "pnpm build" }] }),
      report(),
      evidence({
        commands: [
          {
            command: "cd pomodoro-app && pnpm build 2>&1",
            exitCode: 1,
            timedOut: false,
            isError: false
          },
          {
            command: "cd pomodoro-app; pnpm build",
            exitCode: 0,
            timedOut: false,
            isError: false
          }
        ]
      })
    );

    expect(result.status).toBe("complete");
  });

  it("accepts a required command backed by successful actual evidence", () => {
    const result = evaluateChildTaskResult(
      task({ requiredCommands: [{ command: "pnpm build" }] }),
      report(),
      evidence({
        commands: [{
          command: "pnpm   build",
          exitCode: 0,
          timedOut: false,
          isError: false
        }]
      })
    );

    expect(result.status).toBe("complete");
  });

  it("accepts matching structured report evidence when no managed tool trace exists", () => {
    const result = evaluateChildTaskResult(
      task({
        targetPaths: ["dist/index.html"],
        requiredCommands: [{ command: "pnpm build" }],
        requiredEvidence: ["构建产物可访问"]
      }),
      report({
        summary: "构建产物可访问。",
        files: [{ path: "dist/index.html", action: "created" }],
        commands: [{ command: "pnpm build", exitCode: 0, passed: true }]
      }),
      evidence()
    );

    expect(result.status).toBe("complete");
  });

  it("fails when required human-readable evidence is omitted", () => {
    const result = evaluateChildTaskResult(
      task({ requiredEvidence: ["说明浏览器验证结果"] }),
      report(),
      evidence()
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("说明浏览器验证结果");
  });
});
