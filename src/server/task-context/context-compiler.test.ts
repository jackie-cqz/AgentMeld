// ---------------------------------------------------------------------------
// P3: Context Compiler, Budget, Manifest, Renderer tests
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { classifyCandidate, isForbidden } from "@/server/task-context/context-policy";
import { computeBudget, allocateBudget, isMandatoryOverBudget } from "@/server/task-context/context-budget";
import { buildContextManifest } from "@/server/task-context/context-manifest";
import { renderTaskContextPrompt } from "@/server/task-context/context-renderer";
import { qualifyCandidate } from "@/server/task-context/qualification-filter";
import { scoreCandidate, rankCandidates } from "@/server/task-context/relevance-ranker";
import { compressCandidate } from "@/server/task-context/context-compressor";
import { externalizeCandidate } from "@/server/task-context/context-externalizer";
import { packContext } from "@/server/task-context/context-packer";
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
      blocked: false,
      includedContextItems: [],
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
      blocked: false, includedContextItems: [],
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
      requirements: { constraints: [], expectedOutputs: [] },
      blocked: false, includedContextItems: [],
      upstreamInputs: [],
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

describe("relevance-ranker", () => {
  it("scores required items highest", () => {
    const c = makeCandidate({ required: true });
    const result = scoreCandidate(c, { tier: "mandatory", reason: "test" }, { taskId: "t1", dagDepTaskIds: [], targetPaths: [] });
    expect(result.score).toBeGreaterThanOrEqual(1000);
    expect(result.scoreReasons).toContain("required +1000");
  });

  it("ranks by score descending", () => {
    const high = scoreCandidate(makeCandidate({ id: "high", required: true }), { tier: "mandatory", reason: "x" }, { taskId: "t1", dagDepTaskIds: [], targetPaths: [] });
    const low = scoreCandidate(makeCandidate({ id: "low", category: "recent_message" }), { tier: "optional", reason: "x" }, { taskId: "t1", dagDepTaskIds: [], targetPaths: [] });
    const ranked = rankCandidates([low, high]);
    expect(ranked[0].candidate.id).toBe("high");
  });
});

describe("context-compressor", () => {
  it("compresses artifact refs", () => {
    const c = makeCandidate({ category: "upstream_input", content: { artifactId: "art1", title: "PRD", version: 1 } });
    const result = compressCandidate(c, "high");
    const content = result.compressedContent as { artifactId: string };
    expect(content.artifactId).toBe("art1");
  });
});

describe("context-externalizer", () => {
  it("keeps upstream_input inline (not externalized)", () => {
    const c = makeCandidate({ category: "upstream_input", content: { artifactId: "art_prd", title: "PRD", version: 1 } });
    const result = externalizeCandidate(c);
    // Upstream_input stays as ContextCandidate (not ref) so renderer preserves artifactId
    expect("refType" in result).toBe(false);
    expect((result as ContextCandidate).content).toHaveProperty("artifactId", "art_prd");
  });

  it("externalizes evidence to references", () => {
    const c = makeCandidate({ category: "evidence", content: { evidenceId: "ev1", type: "command_executed" }, tokenEstimate: 500 });
    const result = externalizeCandidate(c);
    if ("refType" in result) {
      expect(result.refType).toBe("evidence");
      expect(result.readTool).toBe("read_evidence");
    }
  });
});

describe("context-packer", () => {
  it("packs mandatory first, then high, then optional", () => {
    const m = makeCandidate({ id: "m1", required: true, tokenEstimate: 100 });
    const h = makeCandidate({ id: "h1", category: "upstream_input", tokenEstimate: 200 });
    const o = makeCandidate({ id: "o1", category: "recent_message", tokenEstimate: 40000 });
    const scored = [
      scoreCandidate(m, classifyCandidate(m.category, m.sourceType, m.required, m.trustLevel), { taskId: "t1", dagDepTaskIds: [], targetPaths: [] }),
      scoreCandidate(h, classifyCandidate(h.category, h.sourceType, h.required, h.trustLevel), { taskId: "t1", dagDepTaskIds: [], targetPaths: [] }),
      scoreCandidate(o, classifyCandidate(o.category, o.sourceType, o.required, o.trustLevel), { taskId: "t1", dagDepTaskIds: [], targetPaths: [] }),
    ];
    const result = packContext(scored, 10000);
    expect(result.packed.map(p => p.id)).toContain("m1");
    expect(result.omitted.length).toBeGreaterThan(0);
  });
});
