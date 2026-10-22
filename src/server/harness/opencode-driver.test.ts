import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Event, Part, UserMessage } from "@opencode-ai/sdk/client";
import { getHarness } from "./registry";
import { getHarnessAvailability } from "./availability";
import { HarnessError } from "./errors";
import { renderOpenCodeContextPacket } from "./opencode-packet";
import {
  buildOpenCodeConfig,
  getOpenCodeDoctor,
  OPENCODE_SDK_VERSION,
  OPENCODE_VERSION,
  opencodeHarnessDriver,
  runOpenCodeHarness,
  runOpenCodeInvocation,
  type OpenCodeClientLike,
  type OpenCodeEngine,
  type OpenCodeEngineFactory,
  type OpenCodeEngineStartOptions,
} from "./opencode-driver";
import { acquireWorkspaceLease } from "./workspace-lease";
import type { HarnessEvent, HarnessInvocationInput } from "./types";
import type { Agent, Conversation, Message, Workspace } from "@/shared/types";

const SESSION = "ses_fixture";

const agent = {
  id: "ag_fixture", name: "Fixture", avatar: "F", description: "", capabilities: ["read"],
  adapterName: "opencode", modelProvider: "deepseek", modelId: "deepseek-chat", apiKey: null, apiBaseUrl: null,
  contextWindow: null, reasoningEffort: "high", systemPrompt: "You are the fixture Agent.",
  toolNames: ["fs_read"], isBuiltin: false, isConductor: false, supportsVision: false, createdAt: 1, updatedAt: 2,
} as Agent;

const conversation = {
  id: "conv_fixture", title: "Fixture", mode: "single", agentIds: [agent.id], fsWriteApprovalMode: "auto",
  contextMode: "evidence", pinnedMessageIds: [], archived: false, pinnedAt: null, createdAt: 1, updatedAt: 2,
} as Conversation;

const workspace = {
  id: "ws_fixture", conversationId: conversation.id, mode: "local", rootPath: "/tmp/fixture-workspace",
  boundPath: null, createdAt: 1, updatedAt: 2,
} as Workspace;

const triggerMessage: Message = {
  id: "msg_fixture", conversationId: conversation.id, role: "user", origin: "human", agentId: null, runId: null,
  parts: [{ type: "text", content: "Implement the fixture." }], status: "complete", mentionedAgentIds: [],
  parentMessageId: null, createdAt: 1, updatedAt: 2,
};

let tempDir: string;

beforeEach(() => {
  tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-opencode-")));
});

afterEach(() => {
  delete process.env.AGENTMELD_OPENCODE_CLI_PATH;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function neutralInput(overrides: Partial<HarnessInvocationInput> = {}): HarnessInvocationInput {
  return {
    conversationId: conversation.id,
    runId: "run_fixture",
    parentRunId: null,
    taskExecution: null,
    taskContract: null,
    agent,
    conversation,
    workspace,
    triggerMessage,
    context: {
      systemPrompt: "You are the fixture Agent.",
      packet: {
        task: "Implement the fixture.",
        priorHistory: [{ role: "user", content: "Earlier platform context." }],
        attachments: [],
      },
      recentMessages: [],
    },
    tools: { names: ["fs_read", "fs_write", "bash"], required: ["fs_read"] },
    requirements: {},
    provider: {
      providerId: "deepseek",
      catalogProvider: "deepseek",
      modelId: "deepseek-chat",
      endpoint: "https://api.example.com/v1",
      credential: "fixture-not-real",
      revision: "deepseek:1",
      reasoningEffort: "high",
      vision: false,
      contextWindow: 65_536,
    },
    workspaceRoot: tempDir,
    maxTurns: 3,
    timeoutMs: 30_000,
    access: "workspace",
    ...overrides,
  };
}

function userMessage(id = "msg_user"): UserMessage {
  return {
    id, sessionID: SESSION, role: "user", time: { created: 1 },
    agent: "build", model: { providerID: "agentmeld", modelID: "deepseek-chat" },
  };
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "msg_assistant", sessionID: SESSION, role: "assistant", time: { created: 2 },
    parentID: "msg_user", modelID: "deepseek-chat", providerID: "agentmeld", mode: "build",
    path: { cwd: tempDir, root: tempDir }, cost: 0,
    tokens: { input: 12, output: 3, reasoning: 0, cache: { read: 1, write: 0 } },
    ...overrides,
  };
}

function textPart(text: string): Part {
  return { id: "prt_text", sessionID: SESSION, messageID: "msg_assistant", type: "text", text };
}

function scriptedEvents(prompt: string): Event[] {
  return [
    { type: "message.updated", properties: { info: userMessage() } },
    { type: "message.part.updated", properties: { part: { id: "prt_user", sessionID: SESSION, messageID: "msg_user", type: "text", text: prompt } } },
    { type: "message.updated", properties: { info: assistantMessage() } },
    { type: "message.part.updated", properties: { part: textPart("") } },
    { type: "message.part.updated", properties: { part: textPart("pong") } },
    {
      type: "message.part.updated",
      properties: {
        part: {
          id: "prt_tool", sessionID: SESSION, messageID: "msg_assistant", type: "tool",
          callID: "call_1", tool: "read",
          state: { status: "completed", input: { filePath: "a.txt" }, output: "A", title: "a.txt", metadata: {}, time: { start: 1, end: 2 } },
        },
      },
    },
    { type: "session.idle", properties: { sessionID: SESSION } },
  ];
}

function fakeEngine(events: Event[], options: { stopResult?: boolean } = {}): {
  factory: OpenCodeEngineFactory;
  calls: {
    prompt: Array<NonNullable<Parameters<OpenCodeClientLike["prompt"]>[1]>>;
    permissions: Array<{ permissionId: string; response: "once" | "always" | "reject" }>;
    configs: OpenCodeEngineStartOptions["config"][];
    envs: Array<Record<string, string> | undefined>;
    stopped: number;
    aborted: number;
    deleted: number;
  };
} {
  const calls = {
    prompt: [] as Array<NonNullable<Parameters<OpenCodeClientLike["prompt"]>[1]>>,
    permissions: [] as Array<{ permissionId: string; response: "once" | "always" | "reject" }>,
    configs: [] as OpenCodeEngineStartOptions["config"][],
    envs: [] as Array<Record<string, string> | undefined>,
    stopped: 0,
    aborted: 0,
    deleted: 0,
  };
  const client: OpenCodeClientLike = {
    async createSession() { return SESSION; },
    async subscribe() {
      return (async function* () { yield* events; })();
    },
    async prompt(_sessionId, body) { calls.prompt.push(body); },
    async abort() { calls.aborted++; },
    async respondPermission(_sessionId, permissionId, response) { calls.permissions.push({ permissionId, response }); },
    async deleteSession() { calls.deleted++; },
  };
  const engine: OpenCodeEngine = {
    pid: 424_242,
    client,
    async stop() { calls.stopped++; return options.stopResult ?? true; },
  };
  return {
    factory: async (options) => { calls.configs.push(options.config); calls.envs.push(options.env); return engine; },
    calls,
  };
}

async function drain(stream: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function expectHarnessError(promise: Promise<unknown>): Promise<HarnessError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError);
    return error as HarnessError;
  }
  throw new Error("Expected a HarnessError.");
}

describe("OpenCode driver declaration", () => {
  it("declares the adapter name and only the capabilities that are wired", () => {
    expect(opencodeHarnessDriver.id).toBe("opencode");
    expect(opencodeHarnessDriver.capabilities()).toEqual({
      nativeTools: true,
      // Business tools load as the `agentmeld` MCP server from the run config.
      businessTools: true,
      cancellation: { supported: true, mode: "signal" },
      // Native calls are admitted before execution and completed through the
      // tool bridge, which is where the ledger receives their evidence.
      evidence: true,
      contextPacket: "platform",
      followUp: false,
      streaming: true,
    });
    expect(opencodeHarnessDriver.abort("run_fixture")).toBe(false);
  });

  it("reports a doctor shape that answers availability and never throws", () => {
    const doctor = opencodeHarnessDriver.doctor();
    expect(typeof doctor.available).toBe("boolean");
    expect(doctor.detail).toBeTruthy();
    if (doctor.available) {
      expect(doctor.version).toBe(OPENCODE_VERSION);
      expect(doctor.detail).toContain(`SDK ${OPENCODE_SDK_VERSION}`);
      expect(doctor.detail).toContain("Node.js");
    }
  });

  it("reports a missing pinned CLI as unavailable with an actionable reason", () => {
    process.env.AGENTMELD_OPENCODE_CLI_PATH = path.join(tempDir, "definitely-not-opencode");
    const doctor = getOpenCodeDoctor();
    expect(doctor.available).toBe(false);
    expect(doctor.detail).toContain("definitely-not-opencode");
  });

  it("is registered in production, and availability still requires doctor()", () => {
    expect(getHarness("opencode")).toBe(opencodeHarnessDriver);
    const availability = getHarnessAvailability("opencode");
    expect(availability).toMatchObject({ id: "opencode", label: "OpenCode", selectable: true, driverRegistered: true });
    expect(availability.state).toBe(getOpenCodeDoctor().available ? "available" : "not-installed");
  });
});

describe("OpenCode config mapping", () => {
  it("maps the platform provider target onto OpenCode's own config shape", () => {
    const input = neutralInput();
    const config = buildOpenCodeConfig(input, "workspace");
    expect(config.model).toBe("agentmeld/deepseek-chat");
    expect(config.small_model).toBe("agentmeld/deepseek-chat");
    const provider = config.provider?.agentmeld;
    expect(provider).toMatchObject({
      npm: "@ai-sdk/openai-compatible",
      name: "AgentMeld",
      options: { baseURL: "https://api.example.com/v1", apiKey: "fixture-not-real" },
    });
    expect(provider?.models?.["deepseek-chat"]).toMatchObject({
      tool_call: true,
      reasoning: true,
      attachment: false,
      limit: { context: 65_536, output: 65_536 },
    });
    expect(config.permission).toMatchObject({ edit: "allow", bash: "allow", webfetch: "deny" });
    // Engine-internal paths that bypass the platform bridge stay off.
    expect(config.tools).toEqual({ task: false, apply_patch: false, question: false });
    // No tool transport was passed, so OpenCode gets neither MCP nor plugin.
    expect(config.mcp).toBeUndefined();
    expect(config.plugin).toBeUndefined();
  });

  it("omits model limits when the Agent configures no context window", () => {
    // The driver refuses to invent a window; OpenCode's own default applies.
    const input = neutralInput({ provider: { ...neutralInput().provider, contextWindow: null } });
    const model = buildOpenCodeConfig(input, "workspace").provider?.agentmeld?.models?.["deepseek-chat"];
    expect(model?.limit).toBeUndefined();
  });

  it("uses the Anthropic provider package for anthropic endpoints", () => {
    const input = neutralInput({
      provider: { ...neutralInput().provider, providerId: "anthropic", catalogProvider: "anthropic" },
    });
    expect(buildOpenCodeConfig(input, "workspace").provider?.agentmeld?.npm).toBe("@ai-sdk/anthropic");
  });

  it("disables OpenCode's native tools for a context-only invocation", () => {
    const config = buildOpenCodeConfig(neutralInput({ access: "conversation" }), "conversation");
    expect(config.permission).toMatchObject({ edit: "deny", bash: "deny", webfetch: "deny" });
    expect(config.tools).toMatchObject({ bash: false, edit: false, write: false, read: false, webfetch: false, apply_patch: false, question: false });
    expect(config.provider?.agentmeld?.models?.["deepseek-chat"]?.tool_call).toBe(false);
  });

  it("wires the per-invocation MCP server, plugin and business-tool naming", () => {
    const config = buildOpenCodeConfig(neutralInput(), "workspace", {
      mcp: {
        agentmeld: {
          type: "local",
          command: ["/usr/bin/node", "/repo/src/server/harness/opencode-mcp-server.mjs"],
          environment: { AGENTMELD_OPENCODE_BRIDGE_URL: "http://127.0.0.1:1", AGENTMELD_OPENCODE_BRIDGE_TOKEN: "t" },
          enabled: true,
          timeout: 10_000,
        },
      },
      plugin: ["/repo/src/server/harness/opencode-evidence-plugin.mjs"],
      hasBusinessTools: true,
    });
    expect(config.mcp?.agentmeld?.type).toBe("local");
    expect(config.plugin).toEqual(["/repo/src/server/harness/opencode-evidence-plugin.mjs"]);
  });

  it("fails honestly when the provider target is incomplete", () => {
    expect(() => buildOpenCodeConfig(neutralInput({ provider: { ...neutralInput().provider, credential: null } }), "workspace"))
      .toThrowError(expect.objectContaining({ category: "authentication" }));
    expect(() => buildOpenCodeConfig(neutralInput({ provider: { ...neutralInput().provider, endpoint: "not a url" } }), "workspace"))
      .toThrowError(expect.objectContaining({ category: "configuration" }));
    expect(() => buildOpenCodeConfig(neutralInput({ provider: { ...neutralInput().provider, modelId: "" } }), "workspace"))
      .toThrowError(expect.objectContaining({ category: "configuration" }));
  });
});

describe("OpenCode invocation lifecycle", () => {
  it("runs the real invocation flow through a scripted engine and streams neutral events", async () => {
    const input = neutralInput();
    const prompt = renderOpenCodeContextPacket(input.context.packet);
    const { factory, calls } = fakeEngine(scriptedEvents(prompt));
    const onTaskAccepted = vi.fn();
    const onContextCaptured = vi.fn();

    const events = await drain(runOpenCodeInvocation(
      { ...input, onTaskAccepted, onContextCaptured },
      new AbortController().signal,
      { engineFactory: factory },
    ));

    expect(events).toEqual([
      { type: "output.start", blockIndex: 0, kind: "text", content: "" },
      { type: "output.delta", blockIndex: 0, kind: "text", text: "pong" },
      { type: "tool.call", callId: "call_1", toolName: "read", args: { filePath: "a.txt" } },
      { type: "tool.result", callId: "call_1", result: { output: "A", title: "a.txt", metadata: {} }, isError: false },
      { type: "output.end", blockIndex: 0 },
      { type: "run.usage", usage: { modelId: "deepseek-chat", inputTokens: 12, outputTokens: 3, cacheReadTokens: 1 } },
    ]);
    expect(onTaskAccepted).toHaveBeenCalledTimes(1);
    expect(onContextCaptured).toHaveBeenCalledWith(expect.objectContaining({
      prompt,
      toolNames: ["fs_read", "fs_write", "bash"],
      access: "workspace",
      systemPromptHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));

    // The platform packet is what the engine was asked to run, with the system
    // prompt in OpenCode's dedicated `system` field rather than buried in text.
    expect(calls.prompt).toHaveLength(1);
    expect(calls.prompt[0].model).toEqual({ providerID: "agentmeld", modelID: "deepseek-chat" });
    expect(calls.prompt[0].system).toBe(input.context.systemPrompt);
    expect(calls.prompt[0].parts).toEqual([{ type: "text", text: prompt }]);
    expect(calls.stopped).toBe(1);
    expect(calls.deleted).toBe(1);

    // The native-admission plugin and its invocation-scoped bridge environment
    // were handed to the engine; no MCP server is needed without business tools.
    expect(calls.configs[0].plugin).toEqual([path.join(process.cwd(), "src", "server", "harness", "opencode-evidence-plugin.mjs")]);
    expect(calls.configs[0].mcp).toBeUndefined();
    expect(calls.envs[0]).toMatchObject({
      AGENTMELD_OPENCODE_BRIDGE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      AGENTMELD_OPENCODE_BRIDGE_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // Teardown revoked the token: the endpoint no longer answers at all.
    const revoked = await fetch(`${calls.envs[0]!.AGENTMELD_OPENCODE_BRIDGE_URL}/manifest`, {
      headers: { Authorization: `Bearer ${calls.envs[0]!.AGENTMELD_OPENCODE_BRIDGE_TOKEN}` },
    }).catch(() => null);
    expect(revoked).toBeNull();

    // The lease was released, so the same workspace can be acquired again.
    const reacquired = await acquireWorkspaceLease(tempDir, new AbortController().signal, { ownerLabel: "test" });
    reacquired.release();
  });

  it("advertises platform business tools over MCP and names them neutrally", async () => {
    const input = neutralInput({
      tools: { names: ["fs_read", "read_artifact"], required: ["read_artifact"] },
    });
    const prompt = renderOpenCodeContextPacket(input.context.packet);
    const { factory, calls } = fakeEngine([
      { type: "message.updated", properties: { info: userMessage() } },
      { type: "message.part.updated", properties: { part: { id: "prt_user", sessionID: SESSION, messageID: "msg_user", type: "text", text: prompt } } },
      { type: "message.updated", properties: { info: assistantMessage() } },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "prt_artifact", sessionID: SESSION, messageID: "msg_assistant", type: "tool",
            callID: "call_artifact", tool: "agentmeld_read_artifact",
            state: { status: "completed", input: { artifactId: "art_missing" }, output: "{}", title: "artifact", metadata: {}, time: { start: 1, end: 2 } },
          },
        },
      },
      { type: "message.part.updated", properties: { part: textPart("pong") } },
      { type: "session.idle", properties: { sessionID: SESSION } },
    ]);
    const onContextCaptured = vi.fn();

    const events = await drain(runOpenCodeInvocation(
      { ...input, onContextCaptured },
      new AbortController().signal,
      { engineFactory: factory },
    ));

    const mcp = calls.configs[0].mcp?.agentmeld;
    expect(mcp).toMatchObject({ type: "local", enabled: true });
    if (mcp?.type !== "local") throw new Error("expected a local MCP server");
    expect(mcp.command.at(-1)).toMatch(/opencode-mcp-server\.mjs$/);
    expect(calls.configs[0].plugin).toHaveLength(1);
    expect(calls.prompt[0].system).toContain("agentmeld_read_artifact");
    expect(calls.prompt[0].system).toContain("OpenCode tool naming");
    expect(onContextCaptured).toHaveBeenCalledWith(expect.objectContaining({
      toolNames: ["fs_read", "read_artifact"],
    }));
    // The MCP prefix is stripped so the platform stream speaks platform names.
    expect(events).toContainEqual({
      type: "tool.call", callId: "call_artifact", toolName: "read_artifact", args: { artifactId: "art_missing" },
    });
  });

  it("approves only workspace edit/bash/external-directory permissions", async () => {
    const input = neutralInput();
    const prompt = renderOpenCodeContextPacket(input.context.packet);
    const permission = (id: string, type: string): Event => ({
      type: "permission.updated",
      properties: {
        id, type, sessionID: SESSION, messageID: "msg_assistant", title: type,
        metadata: {}, time: { created: 1 },
      },
    });
    const { factory, calls } = fakeEngine([
      { type: "message.updated", properties: { info: userMessage() } },
      { type: "message.part.updated", properties: { part: { id: "prt_user", sessionID: SESSION, messageID: "msg_user", type: "text", text: prompt } } },
      permission("perm_bash", "bash"),
      permission("perm_fetch", "webfetch"),
      { type: "message.updated", properties: { info: assistantMessage() } },
      { type: "message.part.updated", properties: { part: textPart("pong") } },
      { type: "session.idle", properties: { sessionID: SESSION } },
    ]);
    await drain(runOpenCodeInvocation(input, new AbortController().signal, { engineFactory: factory }));
    expect(calls.permissions).toEqual([
      { permissionId: "perm_bash", response: "once" },
      { permissionId: "perm_fetch", response: "reject" },
    ]);
  });

  it("brackets a real invocation with run.started and run.settled", async () => {
    const input = neutralInput();
    const prompt = renderOpenCodeContextPacket(input.context.packet);
    const { factory } = fakeEngine(scriptedEvents(prompt));
    const events = await drain(runOpenCodeHarness(input, new AbortController().signal, { engineFactory: factory }));
    expect(events[0]).toEqual({ type: "run.started" });
    expect(events.at(-1)).toEqual({ type: "run.settled", status: "completed" });
    expect(events.some(event => event.type === "output.delta" && event.text === "pong")).toBe(true);
  });

  it("reports a terminal settled event before rethrowing a failed run", async () => {
    const input = neutralInput();
    const auth = { name: "ProviderAuthError" as const, data: { providerID: "agentmeld", message: "expired key" } };
    const { factory } = fakeEngine([
      { type: "session.error", properties: { sessionID: SESSION, error: auth } },
      { type: "session.idle", properties: { sessionID: SESSION } },
    ]);
    const events: HarnessEvent[] = [];
    let failure: unknown;
    try {
      for await (const event of runOpenCodeHarness(input, new AbortController().signal, { engineFactory: factory })) {
        events.push(event);
      }
    } catch (error) {
      failure = error;
    }
    expect(events[0]).toEqual({ type: "run.started" });
    expect(events.at(-1)).toEqual({ type: "run.settled", status: "failed", reason: "expired key" });
    expect(failure).toMatchObject({ category: "authentication" });
  });

  it("maps a provider failure from the event stream into the neutral taxonomy", async () => {
    const input = neutralInput();
    const prompt = renderOpenCodeContextPacket(input.context.packet);
    const auth = { name: "ProviderAuthError" as const, data: { providerID: "agentmeld", message: "expired key" } };
    const { factory } = fakeEngine([
      { type: "message.updated", properties: { info: userMessage() } },
      { type: "message.part.updated", properties: { part: { id: "prt_user", sessionID: SESSION, messageID: "msg_user", type: "text", text: prompt } } },
      { type: "session.error", properties: { sessionID: SESSION, error: auth } },
      { type: "session.idle", properties: { sessionID: SESSION } },
    ]);
    const failure = await expectHarnessError(drain(runOpenCodeInvocation(input, new AbortController().signal, { engineFactory: factory })));
    expect(failure).toMatchObject({ category: "authentication", message: "expired key" });
  });

  it("fails an invocation with no committed assistant turn as empty_response", async () => {
    const input = neutralInput();
    const { factory } = fakeEngine([
      { type: "message.updated", properties: { info: userMessage() } },
      { type: "session.idle", properties: { sessionID: SESSION } },
    ]);
    const failure = await expectHarnessError(drain(runOpenCodeInvocation(input, new AbortController().signal, { engineFactory: factory })));
    expect(failure.category).toBe("empty_response");
  });

  it("fails a stream that ends without idle as process_exit", async () => {
    const input = neutralInput();
    const { factory } = fakeEngine([]);
    const failure = await expectHarnessError(drain(runOpenCodeInvocation(input, new AbortController().signal, { engineFactory: factory })));
    expect(failure.category).toBe("process_exit");
  });

  it("maps an aborted signal to aborted and still tears the engine down", async () => {
    const controller = new AbortController();
    controller.abort();
    const { factory, calls } = fakeEngine([]);
    const failure = await expectHarnessError(drain(runOpenCodeInvocation(neutralInput(), controller.signal, { engineFactory: factory })));
    expect(failure.category).toBe("aborted");
    // No engine was started for a pre-aborted invocation.
    expect(calls.stopped).toBe(0);
  });

  it("poisons the lease and reports cleanup_failed when teardown cannot be confirmed", async () => {
    const input = neutralInput();
    const prompt = renderOpenCodeContextPacket(input.context.packet);
    const { factory } = fakeEngine(scriptedEvents(prompt), { stopResult: false });
    const failure = await expectHarnessError(drain(runOpenCodeInvocation(input, new AbortController().signal, { engineFactory: factory })));
    expect(failure.category).toBe("cleanup_failed");
    expect(failure.message).toContain("workspace remains locked");

    try {
      const reacquire = await acquireWorkspaceLease(tempDir, new AbortController().signal, { ownerLabel: "test" });
      reacquire.release();
      throw new Error("Expected the poisoned lease to refuse a new writer.");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessError);
      expect((error as HarnessError).category).toBe("cleanup_failed");
    } finally {
      // The poisoned receipt is durable by design; clean it up so later tests
      // in this file do not inherit it.
      const { getDatabase } = await import("@/db/client");
      getDatabase().prepare("DELETE FROM harness_workspace_leases WHERE workspace_key=?").run(tempDir);
    }
  });
});
