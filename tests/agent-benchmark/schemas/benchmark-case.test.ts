import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { loadBenchmarkCases, parseBenchmarkCase } from "./benchmark-case";

const CASES_DIR = path.join(__dirname, "..", "..", "e2e-fixtures");

describe("benchmark case schema", () => {
  it("loads all migrated fixtures", () => {
    const cases = loadBenchmarkCases(CASES_DIR);
    expect(cases).toHaveLength(6);
    expect(cases.every((benchmarkCase) => benchmarkCase.schemaVersion === 1)).toBe(true);
  });

  it("rejects the legacy natural-language criteria shape before a run starts", () => {
    expect(() => parseBenchmarkCase({
      id: "legacy-case",
      title: "Legacy",
      description: "Legacy fixture",
      userPrompt: "Do something",
      expectedTasks: ["pm"],
      successCriteria: ["PM creates an artifact"],
      minPassCriteria: 1,
    })).toThrow(/Invalid benchmark case/);
  });

  it("rejects duplicate assertion ids", () => {
    const baseAssertion = {
      id: "same-id",
      type: "role_executed",
      role: "pm",
      required: true,
    };
    expect(() => parseBenchmarkCase({
      schemaVersion: 1,
      id: "duplicate-assertions",
      title: "Duplicate assertions",
      description: "Ensures ids are stable and unique.",
      category: "collaboration",
      prompt: "Create a PRD.",
      expectedRoles: ["pm"],
      assertions: [baseAssertion, baseAssertion],
      limits: { maxDurationMs: 1000 },
      tags: [],
    })).toThrow(/Duplicate assertion id/);
  });

  it("rejects assertions that reference undeclared roles", () => {
    expect(() => parseBenchmarkCase({
      schemaVersion: 1,
      id: "unknown-role-reference",
      title: "Unknown role",
      description: "Ensures roles are declared by the case.",
      category: "collaboration",
      prompt: "Create an app.",
      expectedRoles: ["pm"],
      assertions: [{
        id: "frontend-ran",
        type: "role_executed",
        role: "frontend",
        required: true,
      }],
      limits: { maxDurationMs: 1000 },
      tags: [],
    })).toThrow(/absent from expectedRoles/);
  });

  it("accepts structured ask_user and approval scripts", () => {
    const parsed = parseBenchmarkCase({
      schemaVersion: 1,
      id: "scripted-case",
      title: "Scripted case",
      description: "Exercises unattended user interactions.",
      category: "collaboration",
      prompt: "Create an app.",
      expectedRoles: ["pm"],
      assertions: [{
        id: "pm-ran",
        type: "role_executed",
        role: "pm",
        required: true,
      }],
      limits: { maxDurationMs: 1000 },
      runtime: {
        fsWriteApprovalMode: "review",
        userScript: {
          questions: [{ match: "theme", answers: { "0": "Dark" } }],
          approvals: [{ type: "bash", match: "pnpm install", decision: "approve" }],
          onUnmatchedQuestion: "first_option",
          onUnmatchedApproval: "reject",
        },
      },
      tags: [],
    });

    expect(parsed.runtime?.userScript?.questions?.[0].answers["0"]).toBe("Dark");
    expect(parsed.runtime?.userScript?.approvals?.[0].decision).toBe("approve");
  });

  it("rejects malformed user scripts before a run starts", () => {
    expect(() => parseBenchmarkCase({
      schemaVersion: 1,
      id: "bad-script",
      title: "Bad script",
      description: "Invalid approval decision.",
      category: "collaboration",
      prompt: "Create an app.",
      expectedRoles: ["pm"],
      assertions: [{ id: "pm-ran", type: "role_executed", role: "pm", required: true }],
      limits: { maxDurationMs: 1000 },
      runtime: { userScript: { approvals: [{ type: "bash", decision: "maybe" }] } },
      tags: [],
    })).toThrow(/runtime\.userScript\.approvals/);
  });
});
