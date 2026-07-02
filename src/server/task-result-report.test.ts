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
