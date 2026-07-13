import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { clearPendingPlansForTests, registerPendingPlan } from "@/server/dispatch-plan-manager";
import { eventBus } from "@/server/event-bus";
import { clearPendingBashForTests, registerPendingBash } from "@/server/pending-bash";
import { clearPendingQuestionsForTests, registerPendingQuestion } from "@/server/pending-questions";
import { clearPendingWritesForTests, registerPendingWrite } from "@/server/pending-writes";
import { setupTestDatabase } from "@/test/test-database";

import { UserSimulator } from "./user-simulator";

let cleanupDatabase: (() => void) | undefined;
let simulator: UserSimulator | undefined;

beforeAll(() => {
  cleanupDatabase = setupTestDatabase("agentmeld-benchmark-user-");
});

afterAll(() => {
  cleanupDatabase?.();
});

beforeEach(() => {
  eventBus.clearForTests();
});

afterEach(() => {
  simulator?.stop();
  clearPendingQuestionsForTests();
  clearPendingPlansForTests();
  clearPendingWritesForTests();
  clearPendingBashForTests();
  eventBus.clearForTests();
});

describe("UserSimulator", () => {
  it("answers ask_user from a matching Case script", async () => {
    simulator = new UserSimulator({
      questions: [{ match: "视觉风格", answers: { "0": "极简" } }],
    });
    simulator.start();

    const answers = await registerPendingQuestion("conv_user", "ag_pm", "run_user", [{
      header: "视觉风格",
      question: "请选择视觉风格",
      options: [{ label: "极简" }, { label: "活泼" }],
    }]);

    expect(answers).toEqual({ "0": "极简" });
    expect(simulator.getActions()).toEqual([
      expect.objectContaining({ type: "ask_user", decision: "answer", success: true }),
    ]);
  });

  it("uses the first option for an unmatched question by default", async () => {
    simulator = new UserSimulator();
    simulator.start();

    const answers = await registerPendingQuestion("conv_default", "ag_pm", "run_default", [{
      header: "范围",
      question: "选择功能范围",
      options: [{ label: "标准版" }, { label: "精简版" }],
    }]);

    expect(answers).toEqual({ "0": "标准版" });
  });

  it("approves dispatch plans and can reject a matching bash command", async () => {
    simulator = new UserSimulator({
      approvals: [{ type: "bash", match: "npm install", decision: "reject" }],
    });
    simulator.start();

    const planDecision = await registerPendingPlan("conv_plan", "run_plan", [{
      id: "t1",
      agentId: "ag_pm",
      task: "Create PRD",
      dependsOn: [],
    }]);
    const bashDecision = await registerPendingBash(
      "conv_plan",
      "ag_mock_builder",
      "run_builder",
      "npm install",
      "C:\\workspace",
      "Install dependencies",
    );

    expect(planDecision.approved).toBe(true);
    expect(bashDecision).toBe(false);
    expect(simulator.getActions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "dispatch_plan", decision: "approve" }),
      expect.objectContaining({ type: "bash", decision: "reject" }),
    ]));
  });

  it("applies explicit file-write approval scripts", async () => {
    simulator = new UserSimulator({
      approvals: [{ type: "fs_write", match: "src/App.tsx", decision: "approve" }],
      onUnmatchedApproval: "reject",
    });
    simulator.start();

    const approved = await registerPendingWrite(
      "conv_write",
      "ag_mock_builder",
      "run_write",
      "src/App.tsx",
      "C:\\workspace\\src\\App.tsx",
      "old",
      "new",
    );

    expect(approved).toBe(true);
  });
});
