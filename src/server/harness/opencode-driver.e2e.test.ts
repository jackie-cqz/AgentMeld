import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Agent, Conversation, Message, Workspace } from "@/shared/types";
import type { HarnessEvent, HarnessInvocationInput } from "./types";
import { getOpenCodeDoctor, runOpenCodeHarness } from "./opencode-driver";

/**
 * A real OpenCode run, skipped unless the machine is explicitly provisioned.
 *
 * The unit suite proves the mapping and lifecycle with a scripted engine. This
 * test is the other half of the evidence: a real `opencode serve` process, a
 * real provider, and the neutral event stream coming back out. It is skipped
 * (with the reason below) on CI and on any machine without the pinned install
 * and a throwaway credential.
 */
const doctor = getOpenCodeDoctor();
const apiKey = process.env.OPENCODE_E2E_API_KEY;
const baseUrl = process.env.OPENCODE_E2E_BASE_URL;
const modelId = process.env.OPENCODE_E2E_MODEL ?? "deepseek-v4-flash";
const providerId = process.env.OPENCODE_E2E_PROVIDER ?? "deepseek";
const skipReason = !doctor.available
  ? `OpenCode is not installed: ${doctor.detail}`
  : !apiKey
    ? "OPENCODE_E2E_API_KEY is not set (this suite makes a real provider request)"
    : !baseUrl
      ? "OPENCODE_E2E_BASE_URL is not set"
      : null;
if (skipReason) console.info(`[opencode e2e] skipped: ${skipReason}`);

let tempDir: string;

beforeAll(() => {
  if (!skipReason) tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-opencode-e2e-")));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

const agent = {
  id: "ag_e2e", name: "E2E Fixture", avatar: "E", description: "", capabilities: [],
  adapterName: "opencode", modelProvider: "deepseek", modelId, apiKey: null, apiBaseUrl: null,
  contextWindow: null, reasoningEffort: null, systemPrompt: "You are a terse test assistant.",
  toolNames: [], isBuiltin: false, isConductor: false, supportsVision: false, createdAt: 1, updatedAt: 2,
} as Agent;

const conversation = {
  id: "conv_e2e", title: "E2E", mode: "single", agentIds: [agent.id], fsWriteApprovalMode: "auto",
  contextMode: "evidence", pinnedMessageIds: [], archived: false, pinnedAt: null, createdAt: 1, updatedAt: 2,
} as Conversation;

const workspace = {
  id: "ws_e2e", conversationId: conversation.id, mode: "local", rootPath: "/tmp",
  boundPath: null, createdAt: 1, updatedAt: 2,
} as Workspace;

const triggerMessage: Message = {
  id: "msg_e2e", conversationId: conversation.id, role: "user", origin: "human", agentId: null, runId: null,
  parts: [{ type: "text", content: "Run the e2e fixture." }], status: "complete", mentionedAgentIds: [],
  parentMessageId: null, createdAt: 1, updatedAt: 2,
};

function input(task: string): HarnessInvocationInput {
  return {
    conversationId: conversation.id,
    runId: "run_e2e",
    parentRunId: null,
    taskExecution: null,
    taskContract: null,
    agent,
    conversation,
    workspace,
    triggerMessage,
    context: {
      systemPrompt: "You are a terse test assistant. Answer exactly as asked.",
      packet: { task, priorHistory: [], attachments: [] },
      recentMessages: [],
    },
    tools: { names: ["fs_read"], required: ["fs_read"] },
    requirements: {},
    provider: {
      providerId,
      catalogProvider: providerId,
      modelId,
      endpoint: baseUrl!,
      credential: apiKey!,
      revision: `${providerId}:e2e`,
      reasoningEffort: null,
      vision: false,
      // Deliberately leave the window unset: the driver must let OpenCode use
      // its own default rather than invent a platform-wide number.
      contextWindow: null,
    },
    workspaceRoot: tempDir,
    timeoutMs: 120_000,
    access: "workspace",
  };
}

function trace(events: HarnessEvent[]): void {
  if (process.env.OPENCODE_E2E_TRACE !== "1") return;
  for (const event of events) {
    if (event.type === "output.start") console.info(`[e2e] output.start #${event.blockIndex} ${event.kind}`);
    else if (event.type === "output.delta") console.info(`[e2e] output.delta #${event.blockIndex} ${event.kind} ${JSON.stringify(event.text)}`);
    else if (event.type === "output.end") console.info(`[e2e] output.end #${event.blockIndex}`);
    else if (event.type === "tool.call") console.info(`[e2e] tool.call ${event.toolName} ${JSON.stringify(event.args)}`);
    else if (event.type === "tool.result") console.info(`[e2e] tool.result isError=${event.isError}`);
    else if (event.type === "run.usage") console.info(`[e2e] run.usage ${JSON.stringify(event.usage)}`);
    else console.info(`[e2e] ${event.type}`);
  }
}

describe.skipIf(skipReason !== null)("OpenCode end-to-end", () => {
  it("streams a real model reply back through HarnessEvent", async () => {
    const events: HarnessEvent[] = [];
    for await (const event of runOpenCodeHarness(
      input("Reply with exactly one word: pong"),
      new AbortController().signal,
    )) {
      events.push(event);
    }

    trace(events);
    expect(events[0]).toEqual({ type: "run.started" });
    expect(events.at(-1)).toEqual({ type: "run.settled", status: "completed" });
    const text = events
      .filter((event): event is Extract<HarnessEvent, { type: "output.delta" }> => event.type === "output.delta" && event.kind === "text")
      .map(event => event.text)
      .join("");
    expect(text.toLowerCase()).toContain("pong");
    expect(events.some(event => event.type === "output.start")).toBe(true);
    expect(events.some(event => event.type === "output.end")).toBe(true);
    expect(events.some(event => event.type === "run.usage")).toBe(true);
  }, 150_000);

  it("streams a real native tool call and result", async () => {
    fs.writeFileSync(path.join(tempDir, "fixture.txt"), "agentmeld-opencode-e2e");
    const events: HarnessEvent[] = [];
    for await (const event of runOpenCodeHarness(
      input("Use the read tool to read fixture.txt, then reply with exactly one word: pong"),
      new AbortController().signal,
    )) {
      events.push(event);
    }

    trace(events);
    const call = events.find((event): event is Extract<HarnessEvent, { type: "tool.call" }> => event.type === "tool.call");
    expect(call).toBeDefined();
    expect(call?.toolName).toBe("read");
    const result = events.find((event): event is Extract<HarnessEvent, { type: "tool.result" }> => event.type === "tool.result" && event.callId === call?.callId);
    expect(result).toBeDefined();
    expect(result?.isError).toBe(false);
  }, 150_000);
});
