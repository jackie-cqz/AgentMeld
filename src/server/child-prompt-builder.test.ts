import { describe, it, expect } from "vitest";
import {
  buildChildTaskPrompt,
  resolveTaskInputs,
  hasMissingRequiredInputs,
  type BuildChildPromptInput
} from "@/server/child-prompt-builder";
import type { ParsedTask } from "@/server/tools/conductor-tools";

function makeStubTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    id: "t1",
    agentId: "ag_pm",
    title: "写 PRD",
    prompt: "为番茄钟 App 写 PRD。",
    dependsOn: [],
    inputs: [],
    expectedOutputs: [],
    acceptanceCriteria: [],
    maxAttempts: 1,
    ...overrides
  };
}

const emptyInput: BuildChildPromptInput = {
  task: makeStubTask(),
  resolvedInputs: [],
  upstreamArtifacts: [],
  recentConversation: []
};

describe("buildChildTaskPrompt", () => {
  it("produces <context> and <your_task> structure", () => {
    const prompt = buildChildTaskPrompt(emptyInput);
    expect(prompt).toContain("<context>");
    expect(prompt).toContain("</context>");
    expect(prompt).toContain("<your_task>为番茄钟 App 写 PRD。</your_task>");
  });

  it("includes ending paragraph about continuing sub-task", () => {
    const prompt = buildChildTaskPrompt(emptyInput);
    expect(prompt).toContain("You are continuing the same dispatched sub-task");
    expect(prompt).toContain("call report_task_result with");
    expect(prompt).toContain('{"status":"complete","summary":"what you completed"}');
  });

  it("includes expectedOutputs paragraph when task has outputs", () => {
    const input: BuildChildPromptInput = {
      ...emptyInput,
      task: makeStubTask({
        expectedOutputs: [{ id: "prd", type: "document", required: true }]
      })
    };
    const prompt = buildChildTaskPrompt(input);
    expect(prompt).toContain("outputKey equal to that output id");
    expect(prompt).toContain("Do not repeat artifact ids inside report_task_result");
  });

  it("renders required_inputs when resolvedInputs has entries", () => {
    const input: BuildChildPromptInput = {
      ...emptyInput,
      resolvedInputs: [
        { fromTaskId: "t0", outputId: "analysis", required: true, artifactId: "art_001", missing: false },
        { fromTaskId: "t0", outputId: "notes", required: false, missing: true }
      ]
    };
    const prompt = buildChildTaskPrompt(input);
    expect(prompt).toContain("<required_inputs>");
    expect(prompt).toContain('fromTaskId="t0"');
    expect(prompt).toContain('outputId="analysis"');
    expect(prompt).toContain('artifactId="art_001"');
    expect(prompt).toContain("required=\"true\"");
  });

  it("renders expected_outputs block", () => {
    const input: BuildChildPromptInput = {
      ...emptyInput,
      task: makeStubTask({
        expectedOutputs: [
          { id: "prd_doc", type: "document", required: true, description: "PRD 产物" }
        ]
      })
    };
    const prompt = buildChildTaskPrompt(input);
    expect(prompt).toContain("<expected_outputs>");
    expect(prompt).toContain('id="prd_doc"');
    expect(prompt).toContain('type="document"');
    expect(prompt).toContain("PRD 产物");
  });

  it("renders upstream_artifacts block when present", () => {
    const input: BuildChildPromptInput = {
      ...emptyInput,
      upstreamArtifacts: [
        { id: "art_001", type: "document", title: "番茄钟 PRD", version: 1 }
      ]
    };
    const prompt = buildChildTaskPrompt(input);
    expect(prompt).toContain("<upstream_artifacts>");
    expect(prompt).toContain('id="art_001"');
    expect(prompt).toContain('type="document"');
    expect(prompt).toContain('title="番茄钟 PRD"');
    expect(prompt).toContain('version="1"');
  });

  it("renders acceptance_criteria block", () => {
    const input: BuildChildPromptInput = {
      ...emptyInput,
      task: makeStubTask({
        acceptanceCriteria: ["覆盖目标用户", "功能列表含优先级"]
      })
    };
    const prompt = buildChildTaskPrompt(input);
    expect(prompt).toContain("<acceptance_criteria>");
    expect(prompt).toContain("<criterion>覆盖目标用户</criterion>");
    expect(prompt).toContain("<criterion>功能列表含优先级</criterion>");
  });

  it("renders task_evidence_contract with targetPaths", () => {
    const input: BuildChildPromptInput = {
      ...emptyInput,
      task: makeStubTask({
        targetPaths: ["index.html", "style.css", "script.js"]
      })
    };
    const prompt = buildChildTaskPrompt(input);
    expect(prompt).toContain("<task_evidence_contract>");
    expect(prompt).toContain("<target_paths>");
    expect(prompt).toContain("<path>index.html</path>");
    expect(prompt).toContain("<path>style.css</path>");
  });

  it("renders task_evidence_contract with requiredCommands", () => {
    const input: BuildChildPromptInput = {
      ...emptyInput,
      task: makeStubTask({
        requiredCommands: [{ command: "echo 'build passed'", timeoutMs: 5000 }]
      })
    };
    const prompt = buildChildTaskPrompt(input);
    expect(prompt).toContain("<required_commands>");
    expect(prompt).toContain("echo 'build passed'");
    expect(prompt).toContain('timeoutMs="5000"');
  });

  it("renders task_evidence_contract with requiredEvidence", () => {
    const input: BuildChildPromptInput = {
      ...emptyInput,
      task: makeStubTask({
        requiredEvidence: ["列出实际修改文件", "截图证明 UI 正确"]
      })
    };
    const prompt = buildChildTaskPrompt(input);
    expect(prompt).toContain("<required_evidence>");
    expect(prompt).toContain("<item>列出实际修改文件</item>");
  });

  it("renders recent_conversation", () => {
    const input: BuildChildPromptInput = {
      ...emptyInput,
      recentConversation: [
        { from: "user", content: "帮我做一个番茄时钟" },
        { from: "conductor", content: "正在分析任务..." }
      ]
    };
    const prompt = buildChildTaskPrompt(input);
    expect(prompt).toContain("<recent_conversation>");
    expect(prompt).toContain('from="user"');
    expect(prompt).toContain("帮我做一个番茄时钟");
    expect(prompt).toContain('from="conductor"');
  });

  it("does NOT render evidence_contract when no evidence fields set", () => {
    const prompt = buildChildTaskPrompt(emptyInput);
    expect(prompt).not.toContain("<task_evidence_contract>");
  });

  it("does NOT render upstream_artifacts when empty", () => {
    const prompt = buildChildTaskPrompt(emptyInput);
    expect(prompt).not.toContain("<upstream_artifacts>");
  });

  it("escapes XML special characters in metadata fields, preserves raw text in your_task", () => {
    const input: BuildChildPromptInput = {
      ...emptyInput,
      task: makeStubTask({
        prompt: "使用 <div> 标签 & \"class\" 属性",
        acceptanceCriteria: ["检查 > 3 项"]
      })
    };
    const prompt = buildChildTaskPrompt(input);
    // <your_task> content stays raw (readable for LLM)
    expect(prompt).toContain("<div>");
    expect(prompt).toContain("&");
    // acceptance_criteria content IS escaped (XML metadata)
    expect(prompt).toContain("&gt; 3");
  });
});

describe("resolveTaskInputs", () => {
  it("returns empty array when task has no inputs", () => {
    const task = makeStubTask();
    const result = resolveTaskInputs(task, new Map());
    expect(result).toEqual([]);
  });

  it("marks input as missing when binding not in outputBindings", () => {
    const task = makeStubTask({
      inputs: [{ fromTaskId: "t0", outputId: "prd", required: true }]
    });
    const result = resolveTaskInputs(task, new Map());
    expect(result[0].missing).toBe(true);
  });

  it("resolves artifactId from outputBindings", () => {
    const task = makeStubTask({
      inputs: [{ fromTaskId: "t0", outputId: "prd", required: true }]
    });
    const bindings = new Map([["t0.prd", "art_001"]]);
    const result = resolveTaskInputs(task, bindings);
    expect(result[0].missing).toBe(false);
    expect(result[0].artifactId).toBe("art_001");
  });
});

describe("hasMissingRequiredInputs", () => {
  it("returns false for empty array", () => {
    expect(hasMissingRequiredInputs([])).toBe(false);
  });

  it("returns true when a required input is missing", () => {
    expect(hasMissingRequiredInputs([
      { fromTaskId: "t0", outputId: "prd", required: true, missing: true }
    ])).toBe(true);
  });

  it("returns false when missing inputs are not required", () => {
    expect(hasMissingRequiredInputs([
      { fromTaskId: "t0", outputId: "prd", required: false, missing: true }
    ])).toBe(false);
  });
});
