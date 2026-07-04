// ---------------------------------------------------------------------------
// P3: Context Compiler, Budget, Manifest, Renderer tests
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { classifyCandidate, isForbidden } from "@/server/task-context/context-policy";
import { computeBudget, allocateBudget, isMandatoryOverBudget } from "@/server/task-context/context-budget";
import { buildContextManifest } from "@/server/task-context/context-manifest";
import { renderTaskContextPrompt } from "@/server/task-context/context-renderer";
import { qualifyCandidate } from "@/server/task-context/qualification-filter";
import type { ContextCandidate } from "@/server/task-context/context-candidates";
import type { TaskContextEnvelope } from "@/shared/task-context-types";

function makeCandidate(overrides: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    id: "c1", category: "fact", sourceType: "fact_registry", sourceId: "f1",
    content: { key: "test", value: "hello" },
    trustLevel: "verified", required: false, taskIds: ["t1"], namespaces: ["test"],
    pathRefs: [], criterionIds: [], tokenEstimate: 40, createdAt: 1,
    ...overrides,
  };
}

describe("context-policy", () => {
  it("classifies required items as mandatory", () => {
    const c = makeCandidate({ required: true });
    expect(classifyCandidate(c.category, c.sourceType, c.required, c.trustLevel).tier).toBe("mandatory");
  });

  it("classifies failure as mandatory", () => {
    const c = makeCandidate({ category: "failure", required: false });
    expect(classifyCandidate(c.category, c.sourceType, c.required, c.trustLevel).tier).toBe("mandatory");
  });

  it("classifies task objective as mandatory", () => {
    const c = makeCandidate({ category: "task", required: false });
    expect(classifyCandidate(c.category, c.sourceType, c.required, c.trustLevel).tier).toBe("mandatory");
  });

  it("classifies upstream_input as high", () => {
    const c = makeCandidate({ category: "upstream_input" });
    expect(classifyCandidate(c.category, c.sourceType, c.required, c.trustLevel).tier).toBe("high");
  });

  it("classifies recent_message as optional", () => {
    const c = makeCandidate({ category: "recent_message" });
    expect(classifyCandidate(c.category, c.sourceType, c.required, c.trustLevel).tier).toBe("optional");
  });

  it("forbids reported-level upstream inputs", () => {
    expect(isForbidden("upstream_input", "reported")).toBe(true);
  });

  it("forbids superseded facts", () => {
    expect(isForbidden("fact", "verified", "superseded")).toBe(true);
    expect(isForbidden("fact", "verified", "pending")).toBe(true);
    expect(isForbidden("fact", "verified", "rejected")).toBe(true);
  });

  it("allows active facts", () => {
    expect(isForbidden("fact", "verified", "active")).toBe(false);
  });
});

describe("context-budget", () => {
  it("computes available budget", () => {
    const budget = computeBudget(null, 1000, 2000, 500);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(64000);
  });

  it("returns positive budget for small overhead", () => {
    const budget = computeBudget(null, 5000, 5000, 1000);
    expect(budget).toBeGreaterThan(40000);
  });

  it("mandatory over budget detected", () => {
    expect(isMandatoryOverBudget(70000, 10000)).toBe(true);
    expect(isMandatoryOverBudget(1000, 10000)).toBe(false);
  });

  it("allocates mandatory items regardless of budget", () => {
    const c1 = makeCandidate({ id: "m1", required: true, tokenEstimate: 100 });
    const classified = [{ candidate: c1, tier: classifyCandidate(c1.category, c1.sourceType, c1.required, c1.trustLevel), rank: 1 }];
    const { packed, omitted } = allocateBudget(classified, 50000);
    expect(packed).toHaveLength(1);
    expect(omitted).toHaveLength(0);
  });

  it("omits optional items when budget is tight", () => {
    const mandatory = makeCandidate({ id: "m1", required: true, tokenEstimate: 5000 });
    const optional = makeCandidate({ id: "o1", category: "recent_message", tokenEstimate: 50000 });
    const classified = [
      { candidate: mandatory, tier: classifyCandidate(mandatory.category, mandatory.sourceType, mandatory.required, mandatory.trustLevel), rank: 2 },
      { candidate: optional, tier: classifyCandidate(optional.category, optional.sourceType, optional.required, optional.trustLevel), rank: 1 },
    ];
    const { packed, omitted } = allocateBudget(classified, 10000);
    expect(packed).toHaveLength(1);
    expect(packed[0].id).toBe("m1");
    expect(omitted).toHaveLength(1);
    expect(omitted[0].reason).toBe("budget");
  });

  it("forbidden items are omitted with unverified reason", () => {
    const f = makeCandidate({ id: "f1", category: "fact", trustLevel: "reported" });
    const classified = [
      { candidate: f, tier: { tier: "forbidden" as const, reason: "test" }, rank: 1 },
    ];
    const { packed, omitted } = allocateBudget(classified, 50000);
    expect(packed).toHaveLength(0);
    expect(omitted).toHaveLength(1);
    expect(omitted[0].reason).toBe("unverified");
  });
});

describe("context-manifest", () => {
  it("builds manifest with included and omitted items", () => {
    const inc = makeCandidate({ id: "inc1" });
    const om = makeCandidate({ id: "om1", category: "recent_message" });
    const manifest = buildContextManifest({
      included: [inc],
      omitted: [{ candidate: om, reason: "budget" }],
    });
    expect(manifest).toHaveLength(2);
    const incItem = manifest.find(m => m.id === "inc1");
    const omItem = manifest.find(m => m.id === "om1");
    expect(incItem?.included).toBe(true);
    expect(omItem?.included).toBe(false);
    expect(omItem?.omittedReason).toBe("budget");
  });
});

describe("context-renderer", () => {
  it("renders envelope with task_context XML", () => {
    const envelope: TaskContextEnvelope = {
      schemaVersion: 1,
      policyVersion: "evidence-context-p3-v1",
      identity: { conductorRunId: "r1", planId: "p1", planRevision: 0, taskId: "t1", attemptId: "a1", attempt: 1, contextSnapshotId: "ctx1" },
      task: { title: "Test", objective: "Build a todo app", assignedAgentId: "ag1", dependsOn: [] },
      requirements: { constraints: [], expectedOutputs: [{ outputKey: "app", type: "web_app", required: true }] },
      upstreamInputs: [],
      failureContext: null,
      manifest: [{ id: "m1", category: "task", sourceType: "plan", sourceId: "p1", reason: "objective", required: true, trustLevel: "authoritative", tokenEstimate: 50, included: true, omittedReason: null }],
      budget: { maxInputTokens: 40000, requiredTokens: 100, optionalTokens: 0, omittedTokens: 0 },
      createdAt: 1,
    };
    const prompt = renderTaskContextPrompt(envelope);
    expect(prompt).toContain("<task_context");
    expect(prompt).toContain("context_id=\"ctx1\"");
    expect(prompt).toContain("<objective>Build a todo app</objective>");
    expect(prompt).toContain("<your_task>Build a todo app</your_task>");
    expect(prompt).toContain("report_task_result");
  });

  it("escapes XML special characters", () => {
    const envelope: TaskContextEnvelope = {
      schemaVersion: 1, policyVersion: "v1",
      identity: { conductorRunId: "r1", planId: "p1", planRevision: 0, taskId: "t1", attemptId: "a1", attempt: 1, contextSnapshotId: "c1" },
      task: { title: "T", objective: "A < B && C > D", assignedAgentId: "ag1", dependsOn: [] },
      requirements: { constraints: [], expectedOutputs: [] },
      upstreamInputs: [], failureContext: null,
      manifest: [], budget: { maxInputTokens: 1000, requiredTokens: 0, optionalTokens: 0, omittedTokens: 0 }, createdAt: 1,
    };
    const prompt = renderTaskContextPrompt(envelope);
    expect(prompt).toContain("A &lt; B &amp;&amp; C &gt; D");
  });

  it("renders failure context when present", () => {
    const envelope: TaskContextEnvelope = {
      schemaVersion: 1, policyVersion: "v1",
      identity: { conductorRunId: "r1", planId: "p1", planRevision: 0, taskId: "t1", attemptId: "a1", attempt: 2, contextSnapshotId: "c1" },
      task: { title: "T", objective: "Fix build", assignedAgentId: "ag1", dependsOn: [] },
      requirements: { constraints: [], expectedOutputs: [] }, upstreamInputs: [],
      failureContext: {
        previousAttemptId: "a0", previousChildRunId: "",
        failedCriteria: [], failedEvidenceIds: [],
        failedCommands: [{ command: "pnpm build", exitCode: 1, errorExcerpt: "TS2322", evidenceId: "ev1" }],
        missingOutputs: [], changedFiles: [], retryInstructions: ["Fix type error"],
      },
      manifest: [], budget: { maxInputTokens: 1000, requiredTokens: 0, optionalTokens: 0, omittedTokens: 0 }, createdAt: 1,
    };
    const prompt = renderTaskContextPrompt(envelope);
    expect(prompt).toContain("<failure_context");
    expect(prompt).toContain("pnpm build");
    expect(prompt).toContain("TS2322");
    expect(prompt).toContain("Fix type error");
  });
});

describe("qualification-filter", () => {
  const ctx = { conversationId: "c1", candidateConversationId: "c1", taskId: "t1", dagTaskIds: ["t1", "t2"] };

  it("qualifies same-conversation task candidate", () => {
    const c = makeCandidate({ category: "task", taskIds: ["t1"] });
    expect(qualifyCandidate(c, ctx).qualified).toBe(true);
  });

  it("rejects unrelated DAG branch candidate", () => {
    const c = makeCandidate({ taskIds: ["t5"] });
    const result = qualifyCandidate(c, { ...ctx, dagTaskIds: ["t1", "t2"] });
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reasonCode).toBe("unrelated_dag_branch");
  });

  it("rejects superseded facts", () => {
    const c = makeCandidate({ category: "fact", content: { status: "superseded" }, taskIds: ["t1"] });
    const result = qualifyCandidate(c, ctx);
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reasonCode).toBe("superseded_fact");
  });

  it("rejects unverified upstream inputs", () => {
    const c = makeCandidate({ category: "upstream_input", trustLevel: "reported", taskIds: ["t1"] });
    const result = qualifyCandidate(c, ctx);
    expect(result.qualified).toBe(false);
    if (!result.qualified) expect(result.reasonCode).toBe("unverified_output");
  });

  it("qualifies verified upstream inputs", () => {
    const c = makeCandidate({ category: "upstream_input", trustLevel: "verified", taskIds: ["t1"] });
    expect(qualifyCandidate(c, ctx).qualified).toBe(true);
  });
});
