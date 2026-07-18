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
    expect(prompt).toContain("call report_task_result using this contract");
    expect(prompt).toContain('"status":"complete"');
    expect(prompt).toContain('"acceptanceResults":[]');
  });

  it("includes expectedOutputs paragraph when task has outputs", () => {
    const input: BuildChildPromptInput = {
      ...emptyInput,
      task: makeStubTask({
        expectedOutputs: [{ id: "prd", type: "document", required: true }]
      })
    };
    const prompt = buildChildTaskPrompt(input);
    expect(prompt).toContain('expected output ids: ["prd"]');
    expect(prompt).toContain("write_artifact with outputKey");
    expect(prompt).toContain("without outputKey does not satisfy expected_outputs");
    expect(prompt).toContain("Do not repeat artifact ids inside report_task_result");
  });

  it("defines review acceptance as evidence collection rather than a defect-free product", () => {
    const prompt = buildChildTaskPrompt({
      ...emptyInput,
      task: makeStubTask({
        agentId: "ag_reviewer",
        title: "Review implementation",
        prompt: "审查应用并记录缺陷。",
        expectedOutputs: [{ id: "review_report", type: "document", required: true }],
      }),
    });
    expect(prompt).toContain("whether you actually performed that review check");
    expect(prompt).toContain("not whether the reviewed product is defect-free");
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
    expect(prompt).toContain('"criterion":"覆盖目标用户"');
    expect(prompt).toContain('"criterion":"功能列表含优先级"');
    expect(prompt).toContain("report the description text exactly as shown");
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
    expect(prompt).toContain("TARGET PATHS ARE A HARD VERIFICATION CONTRACT");
    expect(prompt).toContain('The required workspace-relative targets are ["index.html","style.css","script.js"]');
    expect(prompt).toContain("every fs_write/fs_patch path");
    expect(prompt).toContain("call fs_list on each target");
  });

  it("normalizes Windows separators in the target path instruction", () => {
    const input: BuildChildPromptInput = {
      ...emptyInput,
      task: makeStubTask({ targetPaths: ["todo-list-app\\src\\"] })
    };
    const prompt = buildChildTaskPrompt(input);
    expect(prompt).toContain('["todo-list-app/src/"]');
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

  it("infers verified upstream inputs from dependsOn output bindings", () => {
    const task = makeStubTask({
      dependsOn: ["r1", "r2"],
      inputs: []
    });
    const bindings = new Map([
      ["r1.prd_doc", "art_prd"],
      ["r2.style_guide", "art_style"],
      ["unrelated.output", "art_other"]
    ]);

    const result = resolveTaskInputs(task, bindings);

    expect(result).toEqual([
      expect.objectContaining({
        fromTaskId: "r1",
        outputId: "prd_doc",
        artifactId: "art_prd",
        missing: false,
        required: true
      }),
      expect.objectContaining({
        fromTaskId: "r2",
        outputId: "style_guide",
        artifactId: "art_style",
        missing: false,
        required: true
      })
    ]);
  });

  it("does not duplicate explicitly declared upstream inputs", () => {
    const task = makeStubTask({
      dependsOn: ["r1"],
      inputs: [{ fromTaskId: "r1", outputId: "prd_doc", required: true, description: "PRD" }]
    });
    const bindings = new Map([["r1.prd_doc", "art_prd"]]);

    const result = resolveTaskInputs(task, bindings);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fromTaskId: "r1",
      outputId: "prd_doc",
      artifactId: "art_prd",
      description: "PRD"
    });
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
