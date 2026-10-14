import { describe, expect, it } from "vitest";
import { externalizeCandidate } from "@/server/task-context/context-externalizer";
import { renderTaskContextPrompt } from "@/server/task-context/context-renderer";
import type { ContextCandidate } from "@/server/task-context/context-candidates";
import type { ContextItem, TaskContextEnvelope } from "@/shared/task-context-types";

function envelope(
  items: ContextItem[],
  requirements: Partial<TaskContextEnvelope["requirements"]> = {}
): TaskContextEnvelope {
  return {
    schemaVersion: 1, policyVersion: "test",
    identity: { conductorRunId: "r1", planId: "p1", planRevision: 1, taskId: "t1", attemptId: "a1", attempt: 1, contextSnapshotId: "ctx1" },
    task: { title: "Fix app", objective: "Fix app", assignedAgentId: "ag1", dependsOn: [] },
    requirements: {
      constraints: [], expectedOutputs: [],
      acceptanceCriteria: [], targetPaths: [], requiredCommands: [], requiredEvidence: [],
      ...requirements,
    },
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

  // Regression (issue #11): the evidence contract is what evaluateChildTaskResult
  // enforces, and the renderer used to emit an empty <evidence_contract> holding
  // only comments — so group tasks failed on requirements the agent never saw.
  it("renders the evidence contract the evaluator enforces", () => {
    const prompt = renderTaskContextPrompt(envelope([], {
      acceptanceCriteria: ["倒计时以 MM:SS 显示"],
      targetPaths: ["index.html"],
      requiredCommands: [{ command: "npm run build", timeoutMs: 300000 }],
      requiredEvidence: ["关键产物文件路径"],
    }));

    expect(prompt).toContain("<acceptance_criteria>");
    expect(prompt).toContain("<criterion>倒计时以 MM:SS 显示</criterion>");
    expect(prompt).toContain("<target_paths>");
    expect(prompt).toContain("<path>index.html</path>");
    expect(prompt).toContain("<required_commands>");
    expect(prompt).toContain("<command>npm run build</command>");
    expect(prompt).toContain("<required_evidence>");
    expect(prompt).toContain("<item>关键产物文件路径</item>");
  });

  it("omits contract sections a task does not declare", () => {
    const prompt = renderTaskContextPrompt(envelope([]));

    expect(prompt).toContain("<evidence_contract>");
    expect(prompt).not.toContain("<acceptance_criteria>");
    expect(prompt).not.toContain("<target_paths>");
    expect(prompt).not.toContain("<required_commands>");
    expect(prompt).not.toContain("<required_evidence>");
  });

  // Regression: check ⑤ only judges human-reviewed criteria, but the renderer
  // emitted the raw list — so the agent saw auto-verified contract criteria,
  // reported them as results, and check ④ failed the task for a criterion it was
  // never supposed to answer.
  it("renders only the criteria the report is judged on", () => {
    const prompt = renderTaskContextPrompt(envelope([], {
      acceptanceCriteria: [
        '{"id":"contract-artifact-web_app","description":"web_app 产物已创建","required":true,"validator":{"type":"artifact_exists","outputKey":"web_app"}}',
        "倒计时以 MM:SS 显示"
      ],
    }));

    expect(prompt).toContain("<criterion>倒计时以 MM:SS 显示</criterion>");
    expect(prompt).not.toContain("contract-artifact-web_app");
    expect(prompt).not.toContain("validator");
  });
});
