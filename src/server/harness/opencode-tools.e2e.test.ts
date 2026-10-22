import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ evidence: [] as EvidenceRecord[] }));
vi.mock("@/server/repositories/evidence-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/repositories/evidence-repository")>();
  return { ...actual, insertEvidence: (record: EvidenceRecord) => { mocks.evidence.push(record); } };
});

import { createAgent } from "@/server/agent-service";
import { createConversation } from "@/server/conversation-service";
import { getTaskArtifacts } from "@/server/dispatch-task-results";
import { getOpenCodeDoctor, runOpenCodeHarness } from "./opencode-driver";
import type { EvidenceRecord } from "@/server/repositories/evidence-repository";
import type { HarnessEvent, HarnessInvocationInput } from "./types";
import type { TaskExecutionIdentity } from "@/shared/evidence-types";
import type { Agent, Conversation, Message, Workspace } from "@/shared/types";

/**
 * A real OpenCode process, a real MCP server and the real platform bridge —
 * with a deterministic local model server standing in for the provider.
 *
 * This is the end-to-end proof for the OpenCode tool transport: the pinned
 * `opencode serve` binary is started by the driver, it spawns the MCP server
 * from the generated config, the model asks for a platform tool, the tool call
 * crosses the invocation-scoped loopback bridge, and the resulting artifact /
 * evidence lands in the platform. Only the model's HTTP responses are scripted,
 * so the run needs no API credential and is repeatable.
 *
 * It is skipped when the pinned OpenCode install is unavailable (CI does not
 * install it); the opt-in real-provider suite remains
 * `opencode-driver.e2e.test.ts`.
 *
 * The first run against a fresh engine home also makes OpenCode install its
 * plugin runtime from npm, so the timeouts below are generous; later runs reuse
 * that cache and settle in seconds.
 */
// The engine home is a cache, not per-run state: OpenCode installs its plugin
// runtime there, and a real install keeps `getDataDir()/opencode` across runs.
// Point it at a stable directory so one machine pays that install once instead of
// once per `vitest run`; the platform's own data directory stays hermetic.
process.env.AGENTMELD_OPENCODE_HOME = path.join(os.tmpdir(), "agentmeld-opencode-e2e-home");

const doctor = getOpenCodeDoctor();
const skipReason = doctor.available ? null : `OpenCode is not installed: ${doctor.detail}`;
if (skipReason) console.info(`[opencode tools e2e] skipped: ${skipReason}`);

interface MockProvider {
  url: string;
  requests: Array<{ tools: string[]; hasToolResult: boolean }>;
  close: () => Promise<void>;
}

/** A minimal OpenAI-compatible SSE endpoint that asks for one tool, then answers. */
async function mockProvider(toolName: string, args: Record<string, unknown>): Promise<MockProvider> {
  const requests: MockProvider["requests"] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      let parsed: { tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role?: string }> } = {};
      try { parsed = JSON.parse(body); } catch { /* the SDK always sends JSON */ }
      const tools = (parsed.tools ?? []).flatMap(tool => tool.function?.name ? [tool.function.name] : []);
      const hasToolResult = (parsed.messages ?? []).some(message => message.role === "tool");
      requests.push({ tools, hasToolResult });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => {
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl-agentmeld-e2e", object: "chat.completion.chunk", created: Date.now(), model: "mock",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`);
      };
      chunk({ role: "assistant", content: "" });
      if (!hasToolResult) {
        // The MCP server name is part of the exposed tool name; native tools
        // are unprefixed. Match either so one script drives both cases.
        const exposed = tools.find(name => name === toolName || name.endsWith(`_${toolName}`));
        if (!exposed) {
          chunk({ content: `tool ${toolName} was not exposed` }, "stop");
        } else {
          chunk({ tool_calls: [{ index: 0, id: "call_e2e", type: "function", function: { name: exposed, arguments: JSON.stringify(args) } }] }, "tool_calls");
        }
      } else {
        chunk({ content: "done" }, "stop");
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock provider did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

let tempDir: string;
let agent: Agent;
let conversation: Conversation;
let workspace: Workspace;
const providers: MockProvider[] = [];

const taskExecution: TaskExecutionIdentity = {
  conductorRunId: "run_conductor_e2e", planId: "plan_e2e", planRevision: 0,
  taskId: "task_e2e", attemptId: "attempt_e2e", attempt: 1, contextSnapshotId: "snapshot_e2e",
};

beforeAll(() => {
  if (skipReason) return;
  tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-opencode-tools-")));
  agent = createAgent({ name: "OpenCode tools e2e", adapterName: "opencode", modelId: "mock", toolNames: [] });
  conversation = createConversation({ mode: "single", agentIds: [agent.id], fsWriteApprovalMode: "auto" });
  workspace = {
    id: "ws_opencode_tools_e2e", conversationId: conversation.id, mode: "local", rootPath: tempDir,
    boundPath: null, createdAt: 1, updatedAt: 2,
  } as Workspace;
});

afterAll(async () => {
  await Promise.all(providers.splice(0).map(entry => entry.close()));
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function input(providerUrl: string, toolNames: string[]): HarnessInvocationInput {
  const triggerMessage: Message = {
    id: "msg_e2e", conversationId: conversation.id, role: "user", origin: "human", agentId: null, runId: null,
    parts: [{ type: "text", content: "Use the requested tool." }], status: "complete", mentionedAgentIds: [],
    parentMessageId: null, createdAt: 1, updatedAt: 2,
  };
  return {
    conversationId: conversation.id,
    runId: `run_e2e_${Date.now()}`,
    parentRunId: null,
    taskExecution,
    taskContract: {
      acceptanceCriteria: ["fixture"],
      expectedOutputs: [{ outputKey: "note", type: "document", required: true }],
    },
    agent,
    conversation,
    workspace,
    triggerMessage,
    context: {
      systemPrompt: "You are a terse test assistant. Use the provided tools when asked.",
      packet: { task: "Produce the requested output with the platform tool.", priorHistory: [], attachments: [] },
      recentMessages: [],
    },
    tools: { names: toolNames, required: toolNames },
    requirements: { businessTools: true, nativeTools: toolNames.some(name => name.startsWith("fs_") || name === "bash"), evidence: true, cancellation: true, contextPacket: "platform" },
    provider: {
      providerId: "mock", catalogProvider: "mock", modelId: "mock",
      endpoint: providerUrl, credential: "not-a-real-credential", revision: "mock:1",
      reasoningEffort: null, vision: false, contextWindow: null,
    },
    workspaceRoot: tempDir,
    // Generous: the first run in a fresh home also installs OpenCode's plugin
    // runtime. The driver's own timeout must not cut that install short.
    timeoutMs: 600_000,
    access: "workspace",
  };
}

async function run(invocation: HarnessInvocationInput): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of runOpenCodeHarness(invocation, new AbortController().signal)) events.push(event);
  return events;
}

describe.skipIf(skipReason !== null)("OpenCode tool transport end-to-end", () => {
  it("calls a platform business tool and lands an artifact + evidence", async () => {
    const provider = await mockProvider("write_artifact", {
      type: "document",
      title: "E2E artifact",
      content: "# From a real OpenCode run",
      outputKey: "note",
    });
    providers.push(provider);
    const invocation = input(provider.url, ["write_artifact"]);
    const events = await run(invocation);

    const call = events.find((event): event is Extract<HarnessEvent, { type: "tool.call" }> => event.type === "tool.call");
    expect(call).toMatchObject({ toolName: "write_artifact" });
    const result = events.find((event): event is Extract<HarnessEvent, { type: "tool.result" }> => event.type === "tool.result");
    expect(result?.isError).toBe(false);
    expect(events.at(-1)).toEqual({ type: "run.settled", status: "completed" });
    expect(events.some(event => event.type === "output.delta" && event.kind === "text" && event.text === "done")).toBe(true);

    // Artifact binding: the bridge committed outputKey -> artifactId for the run.
    const artifacts = getTaskArtifacts(invocation.runId);
    expect(Object.keys(artifacts)).toEqual(["note"]);
    expect(artifacts.note).toMatch(/^art_/);
    expect(mocks.evidence.some(record => record.childRunId === invocation.runId && record.type === "artifact_created")).toBe(true);
    // The model saw the MCP-prefixed tool; the platform never did.
    expect(provider.requests[0].tools).toContain("agentmeld_write_artifact");
  }, 600_000);

  it("admits a native write and records its hash as evidence", async () => {
    const target = path.join(tempDir, "native-e2e.txt");
    const provider = await mockProvider("write", { filePath: target, content: "native bytes" });
    providers.push(provider);
    const invocation = input(provider.url, ["fs_write"]);
    const events = await run(invocation);

    expect(fs.readFileSync(target, "utf8")).toBe("native bytes");
    const result = events.find((event): event is Extract<HarnessEvent, { type: "tool.result" }> => event.type === "tool.result");
    expect(result?.isError).toBe(false);
    const record = mocks.evidence.find(entry => entry.childRunId === invocation.runId && entry.type === "file_written");
    expect(record).toBeDefined();
    expect(record).toMatchObject({ status: "valid", subjectId: "native-e2e.txt" });
    expect(JSON.parse(record!.payloadJson)).toMatchObject({ path: "native-e2e.txt", action: "created" });
  }, 300_000);

  it("admits a native command and records command evidence", async () => {
    const target = path.join(tempDir, "command-e2e.txt");
    const provider = await mockProvider("bash", { command: `printf command-bytes > ${target}` });
    providers.push(provider);
    const invocation = input(provider.url, ["bash"]);
    await run(invocation);

    expect(fs.readFileSync(target, "utf8")).toBe("command-bytes");
    expect(mocks.evidence.some(record => record.childRunId === invocation.runId && record.type === "command_executed")).toBe(true);
  }, 300_000);
});
