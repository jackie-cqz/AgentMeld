import { describe, expect, it } from "vitest";
import { externalizeCandidate } from "@/server/task-context/context-externalizer";
import { renderTaskContextPrompt } from "@/server/task-context/context-renderer";
import type { ContextCandidate } from "@/server/task-context/context-candidates";
import type { ContextItem, TaskContextEnvelope } from "@/shared/task-context-types";

function envelope(items: ContextItem[]): TaskContextEnvelope {
  return {
    schemaVersion: 1, policyVersion: "test",
    identity: { conductorRunId: "r1", planId: "p1", planRevision: 1, taskId: "t1", attemptId: "a1", attempt: 1, contextSnapshotId: "ctx1" },
    task: { title: "Fix app", objective: "Fix app", assignedAgentId: "ag1", dependsOn: [] },
    requirements: { constraints: [], expectedOutputs: [] },
    blocked: false, includedContextItems: items, upstreamInputs: [], failureContext: null,
    manifest: [], budget: { maxInputTokens: 1000, requiredTokens: 0, optionalTokens: 100, omittedTokens: 0 }, createdAt: 1,
  };
}

describe("packed context rendering", () => {
  it("renders externalized workspace file references with a read tool", () => {
    const candidate: ContextCandidate = {
      id: "ws1", category: "workspace", sourceType: "targetPath", sourceId: 'src/A&B<".tsx',
      content: { path: 'src/A&B<".tsx' }, trustLevel: "verified", required: false,
      taskIds: ["t1"], namespaces: [], pathRefs: [], criterionIds: [], tokenEstimate: 250, createdAt: 1,
    };
    const reference = externalizeCandidate(candidate);
    expect(reference).toHaveProperty("refType", "file");
    const prompt = renderTaskContextPrompt(envelope([{ ...candidate, content: reference }]));
    expect(prompt).toContain('<file_reference path="src/A&amp;B&lt;&quot;.tsx" readTool="fs_read" />');
  });

  it("renders only packed messages and preserves user request and summary text", () => {
    const prompt = renderTaskContextPrompt(envelope([
      { category: "recent_message", sourceType: "message", sourceId: "msg1", content: "Use <green> & blue", trustLevel: "authoritative", required: true, tokenEstimate: 10 },
      { category: "recent_message", sourceType: "conversation_summary", sourceId: "sum1", content: "Confirmed React", trustLevel: "accepted", required: false, tokenEstimate: 10 },
    ]));
    expect(prompt).toContain('<message source="message">Use &lt;green&gt; &amp; blue</message>');
    expect(prompt).toContain('<message source="conversation_summary">Confirmed React</message>');
    expect(renderTaskContextPrompt(envelope([]))).not.toContain("<recent_messages>");
  });
});
