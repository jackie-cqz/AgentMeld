import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { loadBenchmarkCases, parseBenchmarkCase } from "./benchmark-case";

const CASES_DIR = path.join(__dirname, "..", "..", "e2e-fixtures");

describe("benchmark case schema", () => {
  it("loads all migrated fixtures", () => {
    const cases = loadBenchmarkCases(CASES_DIR);
    expect(cases).toHaveLength(25);
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

  it("accepts safe workspace seed files and rejects traversal", () => {
    const base = {
      schemaVersion: 1 as const,
      id: "seeded-case",
      title: "Seeded case",
      description: "Starts from an existing project.",
      category: "recovery" as const,
      prompt: "Fix the project.",
      expectedRoles: ["frontend"] as const,
      assertions: [{ id: "frontend-ran", type: "role_executed" as const, role: "frontend" as const, required: true }],
      limits: { maxDurationMs: 1000 },
      tags: [],
    };

    const parsed = parseBenchmarkCase({
      ...base,
      runtime: { workspaceFiles: [{ path: "src/App.tsx", content: "broken source" }] },
    });
    expect(parsed.runtime?.workspaceFiles?.[0].path).toBe("src/App.tsx");

    expect(() => parseBenchmarkCase({
      ...base,
      runtime: { workspaceFiles: [{ path: "../outside.ts", content: "unsafe" }] },
    })).toThrow(/may not traverse outside/);
  });

  it("accepts hidden verifier contracts and rejects undeclared verifier ids", () => {
    const base = {
      schemaVersion: 1 as const,
      id: "hidden-verifier-case",
      title: "Hidden verifier case",
      description: "Runs trusted post-run verification against workspace output.",
      category: "recovery" as const,
      prompt: "Repair the starter project.",
      expectedRoles: ["frontend"] as const,
      limits: { maxDurationMs: 1000 },
      tags: [],
    };
    const parsed = parseBenchmarkCase({
      ...base,
      assertions: [
        { id: "hidden-tests", type: "command_verifier", verifierId: "hidden-tests", required: true },
        { id: "output", type: "workspace_file", path: "src/result.ts", minBytes: 10, required: true },
        { id: "report", type: "structured_output", path: "report.json", format: "json", requiredKeys: ["status"], required: true },
        { id: "protected", type: "no_forbidden_mutation", paths: ["README.md"], required: true },
      ],
      runtime: {
        assetBundle: { root: "tests/e2e-assets/example" },
        verifiers: [{ id: "hidden-tests", command: "node .benchmark/hidden/verify.mjs" }],
      },
    });

    expect(parsed.runtime?.verifiers?.[0].id).toBe("hidden-tests");
    expect(parsed.assertions.map((assertion) => assertion.type)).toEqual([
      "command_verifier", "workspace_file", "structured_output", "no_forbidden_mutation",
    ]);

    expect(() => parseBenchmarkCase({
      ...base,
      assertions: [{ id: "missing", type: "command_verifier", verifierId: "not-declared", required: true }],
      runtime: { assetBundle: { root: "tests/e2e-assets/example" } },
    })).toThrow(/references undeclared verifier/);
  });

  it("rejects unsafe asset roots and duplicate verifier ids", () => {
    const base = {
      schemaVersion: 1 as const,
      id: "invalid-verifier-case",
      title: "Invalid verifier case",
      description: "Rejects ambiguous or unsafe runtime configuration.",
      category: "safety" as const,
      prompt: "Check the workspace.",
      expectedRoles: ["frontend"] as const,
      assertions: [{ id: "frontend-ran", type: "role_executed" as const, role: "frontend" as const, required: true }],
      limits: { maxDurationMs: 1000 },
      tags: [],
    };

    expect(() => parseBenchmarkCase({
      ...base,
      runtime: { assetBundle: { root: "private/hidden-case" } },
    })).toThrow(/must be under tests\/e2e-assets/);

    expect(() => parseBenchmarkCase({
      ...base,
      runtime: {
        verifiers: [
          { id: "same", command: "node one.mjs" },
          { id: "same", command: "node two.mjs" },
        ],
      },
    })).toThrow(/Duplicate verifier id/);
  });

  it("accepts deterministic safety, approval, warning, and fault assertions", () => {
    const parsed = parseBenchmarkCase({
      schemaVersion: 1,
      id: "safety-contract",
      title: "Safety contract",
      description: "Validates safety assertion schemas.",
      category: "safety",
      prompt: "Exercise a blocked command.",
      expectedRoles: ["frontend"],
      assertions: [
        { id: "rejected", type: "tool_rejected", toolName: "bash", role: "frontend", category: "security_policy", required: true },
        { id: "warning", type: "warning_present", code: "tool_claim_without_evidence", role: "frontend", required: true },
        { id: "fault", type: "fault_injected", faultId: "fault-1", required: true },
        { id: "approval", type: "approval_resolved", approvalType: "bash", decision: "approved", role: "frontend", required: true },
      ],
      limits: { maxDurationMs: 1000 },
      tags: [],
    });
    expect(parsed.assertions.map((assertion) => assertion.type)).toEqual([
      "tool_rejected", "warning_present", "fault_injected", "approval_resolved",
    ]);
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

  it("accepts peer consultation assertions and the hidden-element browser step", () => {
    const parsed = parseBenchmarkCase({
      schemaVersion: 1,
      id: "consultation-case",
      title: "Consultation case",
      description: "Requires a peer opinion and verifies the workspace was returned.",
      category: "context_handoff",
      prompt: "Consult the peer, then ship the page.",
      expectedRoles: ["ui", "frontend"],
      assertions: [
        { id: "frontend-ran", type: "role_executed", role: "frontend", required: true },
        { id: "output", type: "output_binding", role: "frontend", outputKey: "web_app", artifactType: "web_app", required: true },
        { id: "consulted", type: "tool_succeeded", toolName: "consult_agent", role: "frontend", required: true },
        { id: "reflected", type: "consultation_reflected", role: "frontend", outputKey: "web_app", artifactType: "web_app", answerPattern: "MELLOW-[0-9]{4}", required: true },
        { id: "lifecycle", type: "consultation_lifecycle", role: "frontend", requirePeerTornDown: true, requireLeaseRestored: true, required: true },
      ],
      limits: { maxDurationMs: 1000 },
      runtime: {
        browserScripts: [{
          id: "title",
          steps: [{ action: "assert_hidden", selector: "[data-testid='todo-item']" }],
        }],
      },
      tags: [],
    });

    expect(parsed.assertions.map((assertion) => assertion.type)).toEqual([
      "role_executed", "output_binding", "tool_succeeded", "consultation_reflected", "consultation_lifecycle",
    ]);
    expect(parsed.runtime?.browserScripts?.[0].steps).toEqual([
      { action: "assert_hidden", selector: "[data-testid='todo-item']" },
    ]);
  });

  it("rejects a consultation assertion with an invalid answer pattern", () => {
    expect(() => parseBenchmarkCase({
      schemaVersion: 1,
      id: "bad-pattern",
      title: "Bad pattern",
      description: "answerPattern must compile.",
      category: "context_handoff",
      prompt: "Consult.",
      expectedRoles: ["frontend"],
      assertions: [
        { id: "frontend-ran", type: "role_executed", role: "frontend", required: true },
        { id: "reflected", type: "consultation_reflected", role: "frontend", outputKey: "web_app", artifactType: "web_app", answerPattern: "MELLOW-[0-9", required: true },
      ],
      limits: { maxDurationMs: 1000 },
      tags: [],
    })).toThrow(/valid regular expression/);
  });
});
