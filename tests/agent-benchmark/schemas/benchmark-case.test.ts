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
});
