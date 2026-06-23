import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { getAdapter, clearRegistryForTests } from "@/server/adapters/registry";
import {
  buildChatCompletionTools,
  findDeployableWorkspacePath,
  isDeployStatusRecord,
  mergeToolArgumentChunk,
  parseToolCallArguments,
  shouldAutoDeployWorkspaceFromText
} from "@/server/adapters/custom-agent-adapter";
import type { AdapterInput } from "@/server/adapters/types";
import type { Agent, Conversation, Workspace, Message } from "@/shared/types";

let tempDir: string;

function buildAdapterInput(overrides?: Partial<AdapterInput>): AdapterInput {
  const agent: Agent = {
    id: "ag_custom_test",
    name: "Test Custom",
    avatar: "🤖",
    description: "Test",
    capabilities: [],
    adapterName: "custom",
    modelProvider: "openai",
    modelId: "gpt-4.1-mini",
    apiKey: null,
    apiBaseUrl: null,
    systemPrompt: "You are a test assistant.",
    toolNames: [],
    isBuiltin: false,
    isConductor: false,
    supportsVision: false,
    createdAt: 1,
    updatedAt: 1
  };

  const conversation: Conversation = {
    id: "conv_test",
    title: "Test",
    mode: "single",
    agentIds: [agent.id],
    fsWriteApprovalMode: "auto",
    pinnedMessageIds: [],
    pinnedAt: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1
  };

  const workspace: Workspace = {
    id: "ws_test",
    conversationId: "conv_test",
    mode: "sandbox",
    rootPath: tempDir,
    boundPath: null,
    createdAt: 1,
    updatedAt: 1
  };

  const triggerMessage: Message = {
    id: "msg_trigger",
    conversationId: "conv_test",
    role: "user",
    agentId: null,
    runId: null,
    parts: [{ type: "text", content: "Hello, how are you?" }],
    status: "complete",
    mentionedAgentIds: [],
    parentMessageId: null,
    createdAt: 1,
    updatedAt: 1
  };

  return {
    conversationId: "conv_test",
    runId: "run_test",
    agent,
    conversation,
    workspace,
    triggerMessage,
    recentMessages: [],
    toolNames: [],
    systemPrompt: "You are a test assistant.",
    workspacePath: "/tmp/ws",
    apiKey: null,
    ...overrides
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-custom-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  clearRegistryForTests();
  ensureDatabase();
});

afterEach(() => {
  resetBootstrapForTests();
  resetClientForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  clearRegistryForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("custom-agent-adapter", () => {
  it("parses standard tool arguments", () => {
    const parsed = parseToolCallArguments(
      JSON.stringify({ type: "document", title: "PRD", content: { content: "# PRD" } })
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.title).toBe("PRD");
    }
  });

  it("unwraps stringified and wrapped DeepSeek tool arguments", () => {
    const nested = JSON.stringify({
      arguments: JSON.stringify({
        type: "document",
        title: "PRD",
        content: { content: "# PRD" }
      })
    });
    const parsed = parseToolCallArguments(JSON.stringify(nested));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args).toEqual({
        type: "document",
        title: "PRD",
        content: { content: "# PRD" }
      });
    }
  });

  it("reports malformed tool arguments instead of replacing them with empty args", () => {
    const parsed = parseToolCallArguments(
      "{\"type\":\"document\",\"title\":\"PRD\",\"content\":"
    );

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("JSON could not be parsed");
      expect(parsed.error).toContain("\\\"type\\\"");
      expect(parsed.serialized).toBe("{}");
    }
  });

  it("identifies tool arguments truncated by the model output limit", () => {
    const parsed = parseToolCallArguments(
      "{\"type\":\"document\",\"title\":\"Long guide\",\"content\":{\"format\":\"markdown\",\"content\":\"# Guide",
      "length"
    );

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain("reached its output limit");
      expect(parsed.error).toContain("split it into multiple artifacts");
    }
  });

  it("repairs a write_artifact document content object missing its opening brace", () => {
    const parsed = parseToolCallArguments(
      "{\"type\":\"document\",\"title\":\"TodoList 应用 PRD\",\"content\": format\": \"markdown\", \"content\": \"# TodoList 应用\\n\\n## 1. 产品概述\"}"
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args).toEqual({
        type: "document",
        title: "TodoList 应用 PRD",
        content: {
          format: "markdown",
          content: "# TodoList 应用\n\n## 1. 产品概述"
        }
      });
    }
  });

  it("repairs write_artifact document content with an unquoted nested object key and raw newlines", () => {
    const parsed = parseToolCallArguments(
      "{\"type\":\"document\",\"title\":\"Todo Lists 产品需求文档 (PRD)\",\"content\": format\":\"markdown\",\"content\":\"# Todo Lists — 产品需求文档 (PRD)\n\n**文档版本**: v1.0  \n**状态**: 初稿\n\n## 1. 产品概述\n打开即用。\"}"
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args).toEqual({
        type: "document",
        title: "Todo Lists 产品需求文档 (PRD)",
        content: {
          format: "markdown",
          content: "# Todo Lists — 产品需求文档 (PRD)\n\n**文档版本**: v1.0  \n**状态**: 初稿\n\n## 1. 产品概述\n打开即用。"
        }
      });
    }
  });

  it("repairs plan_tasks arrays whose task objects are missing opening braces", () => {
    const parsed = parseToolCallArguments(
      "{\"reasoning\":\"按需求、设计、实现、审查链路分派。\",\"tasks\":[id\":\"t1\",\"agentId\":\"ag_pm\",\"title\":\"产出 PRD\",\"prompt\":\"写 Todo Lists PRD\",\"dependsOn\":[],id\":\"t2\",\"agentId\":\"ag_designer\",\"title\":\"产出风格指南\",\"prompt\":\"基于 PRD 设计 UI\",\"dependsOn\":[\"t1\"]]}"
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args).toEqual({
        reasoning: "按需求、设计、实现、审查链路分派。",
        tasks: [
          {
            id: "t1",
            agentId: "ag_pm",
            title: "产出 PRD",
            prompt: "写 Todo Lists PRD",
            dependsOn: []
          },
          {
            id: "t2",
            agentId: "ag_designer",
            title: "产出风格指南",
            prompt: "基于 PRD 设计 UI",
            dependsOn: ["t1"]
          }
        ]
      });
    }
  });

  it("does not repair JSON truncated inside a string", () => {
    const parsed = parseToolCallArguments(
      "{\"type\":\"document\",\"title\":\"TodoList 应用 PRD\",\"content\": format\": \"markdown\", \"content\": \"# TodoList 应用"
    );

    expect(parsed.ok).toBe(false);
  });

  it("recovers minimal report_task_result fields when optional fields are malformed", () => {
    const parsed = parseToolCallArguments(
      "{\"status\":\"complete\",\"summary\":\"为 Todo Lists React 应用设计并输出了完整的极简现代风格指南。\",\"artifacts\": style-guide}",
      null,
      "report_task_result"
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args).toEqual({
        status: "complete",
        summary: "为 Todo Lists React 应用设计并输出了完整的极简现代风格指南。"
      });
    }
  });

  it("keeps the latest cumulative tool argument snapshot", () => {
    const partial = "{\"type\":\"document\"";
    const complete = JSON.stringify({
      type: "document",
      title: "Style guide",
      content: { format: "markdown", content: "# Guide" }
    });

    expect(mergeToolArgumentChunk(partial, complete)).toBe(complete);
    expect(mergeToolArgumentChunk(complete, complete)).toBe(complete);
  });

  it("uses the last complete object when providers concatenate argument snapshots", () => {
    const first = JSON.stringify({
      type: "document",
      title: "Draft",
      content: { format: "markdown", content: "# Draft" }
    });
    const final = JSON.stringify({
      type: "document",
      title: "TODO Lists 风格指南",
      content: { format: "markdown", content: "# Final guide" }
    });

    const parsed = parseToolCallArguments(`${first}\n${final}`);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.title).toBe("TODO Lists 风格指南");
      expect(parsed.args.content).toEqual({
        format: "markdown",
        content: "# Final guide"
      });
    }
  });

  it("does not accept a complete object followed by a truncated snapshot", () => {
    const complete = JSON.stringify({
      type: "document",
      title: "Draft",
      content: { format: "markdown", content: "# Draft" }
    });

    const parsed = parseToolCallArguments(
      `${complete}\n{"type":"document","title":"Final`
    );

    expect(parsed.ok).toBe(false);
  });

  it("constrains Conductor plan agentId to current conversation workers", () => {
    const base = buildAdapterInput();
    const input = buildAdapterInput({
      agent: {
        ...base.agent,
        id: "ag_conductor",
        isConductor: true,
        toolNames: ["plan_tasks"]
      },
      conversation: {
        ...base.conversation,
        mode: "group",
        agentIds: ["ag_conductor", "ag_pm", "ag_frontend"]
      },
      toolNames: ["plan_tasks"]
    });

    const tools = buildChatCompletionTools(input);
    const planTool = tools.find(
      (tool) => tool.type === "function" && tool.function.name === "plan_tasks"
    );
    expect(planTool?.type).toBe("function");
    if (!planTool || planTool.type !== "function") {
      throw new Error("plan_tasks function tool was not built.");
    }
    const parameters = planTool.function.parameters as Record<string, unknown>;
    const properties = parameters.properties as Record<string, unknown>;
    const tasks = properties.tasks as Record<string, unknown>;
    const items = tasks.items as Record<string, unknown>;
    const itemProperties = items.properties as Record<string, unknown>;
    const agentId = itemProperties.agentId as Record<string, unknown>;

    expect(agentId.enum).toEqual(["ag_pm", "ag_frontend"]);
  });

  it("identifies deploy tool results for deploy.status events", () => {
    expect(isDeployStatusRecord({
      id: "dep_ws_123",
      artifactId: "art_123",
      title: "Workspace App",
      version: 1,
      previewPath: "/deployments/dep_ws_123",
      status: "ready",
      sourceType: "workspace",
      createdAt: 1
    })).toBe(true);

    expect(isDeployStatusRecord({
      id: "dep_failed_123",
      artifactId: "workspace",
      title: "Deployment Failed",
      version: 0,
      previewPath: "",
      status: "failed",
      error: "Directory does not contain index.html.",
      createdAt: 1
    })).toBe(true);

    expect(isDeployStatusRecord({
      artifactId: "art_123",
      title: "Regular artifact result"
    })).toBe(false);
  });

  it("detects hallucinated deployment claims for deterministic workspace fallback", () => {
    expect(shouldAutoDeployWorkspaceFromText(
      "✅ 已重新部署成功！\n\n最新预览地址：`/deployments/dep_ws_123`\n[产物: Todo App (id=art_fake)]",
      ["deploy_workspace"],
      false
    )).toBe(true);

    expect(shouldAutoDeployWorkspaceFromText(
      "我先检查一下 workspace。",
      ["deploy_workspace"],
      false
    )).toBe(false);

    expect(shouldAutoDeployWorkspaceFromText(
      "✅ 已重新部署成功！\n/deployments/dep_ws_123",
      ["deploy_workspace"],
      true
    )).toBe(false);
  });

  it("finds a deployable workspace directory with index.html", () => {
    const root = path.join(tempDir, "workspace-auto-deploy");
    fs.mkdirSync(path.join(root, "todo-app"), { recursive: true });
    fs.writeFileSync(path.join(root, "todo-app", "index.html"), "<h1>ok</h1>");

    expect(findDeployableWorkspacePath(root)).toBe("todo-app");
  });

  it("is registered in the adapter registry", () => {
    const adapter = getAdapter("custom");
    expect(adapter).toBeDefined();
    expect(adapter.name).toBe("custom");
  });

  it("yields an error event when no API key is configured", async () => {
    const adapter = getAdapter("custom");
    const input = buildAdapterInput(); // no apiKey set
    const controller = new AbortController();

    const events = [];
    for await (const event of adapter.run(input, controller.signal)) {
      events.push(event);
    }

    // Should yield at least a part.start with error text and run.usage
    const errorMsg = events.find(
      (e) => e.type === "part.start" && "part" in e && (e.part as { type?: string }).type === "text"
    );
    expect(errorMsg).toBeDefined();

    const usage = events.find((e) => e.type === "run.usage");
    expect(usage).toBeDefined();
  });

  it("yields error when no key and no env var set", async () => {
    const adapter = getAdapter("custom");
    // Ensure no env var leakage
    delete process.env.OPENAI_API_KEY;
    const input = buildAdapterInput({ toolNames: ["fs_read"] });
    const controller = new AbortController();

    const events = [];
    for await (const event of adapter.run(input, controller.signal)) {
      events.push(event);
    }

    const partEvents = events.filter((e) => e.type === "part.start");
    expect(partEvents.length).toBeGreaterThan(0);
  });

  it("respects AbortSignal by stopping early", async () => {
    const adapter = getAdapter("custom");
    const input = buildAdapterInput();
    const controller = new AbortController();

    // Abort immediately to test signal handling
    controller.abort();

    const events = [];
    for await (const event of adapter.run(input, controller.signal)) {
      events.push(event);
    }

    // Should stop quickly (the loop checks signal.aborted)
    // With no key, it will yield the error part then return (doesn't hit network)
    expect(events.length).toBeLessThan(10);
  });
});
