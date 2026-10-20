import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// If either collaboration path falls back to Pi directly, these tests fail
// instead of spawning the real pinned CLI.
const piRuntime = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/server/pi/runtime", () => ({
  runPiInvocation: async function* (): AsyncGenerator<never> {
    piRuntime.calls += 1;
    yield* [] as never[];
    throw new Error("The real Pi runtime must not run when another driver is registered.");
  },
}));

import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDatabase, resetDatabaseForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { classifyHumanTurn } from "@/server/collaboration/turn-classifier";
import { resolveHarnessProvider } from "./provider-target";
import { proposeConsultationResponse, requestConsultation } from "@/server/collaboration/consultations";
import { createConversation } from "@/server/conversation-service";
import { createMessage, createRun, getAgent, getRun, getWorkspaceForConversation } from "@/server/repositories";
import type { ToolContext } from "@/server/tools/types";
import type { StreamEvent } from "@/shared/types";
import { newMessageId, newRunId } from "@/shared/ids";
import { registerHarness, unregisterHarness } from "./registry";
import type { HarnessDriver, HarnessInvocationInput, HarnessRunStream } from "./types";

/**
 * Task #25 P1 closes the two remaining Pi-only call sites: human-turn
 * classification and peer consultation. Both must resolve their driver from the
 * identity already in scope, exactly like the harness dispatch tests.
 */
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-collaboration-dispatch-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetDatabaseForTests();
  eventBus.clearForTests();
  ensureDatabase();
  piRuntime.calls = 0;
});

afterEach(() => {
  unregisterHarness("mock");
  resetBootstrapForTests();
  resetDatabaseForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const DECISION = { intent: "new_task", targetRunId: null, mode: "execution", reason: "Explicit implementation request." } as const;
const CONSULTATION_ANSWER = "A compact sidebar is preferable; this is a peer opinion.";

type FakeEvents = (input: HarnessInvocationInput, signal: AbortSignal) => StreamEvent[];

function fakeDriver(calls: HarnessInvocationInput[], events: FakeEvents = () => []): HarnessDriver {
  return {
    id: "mock",
    doctor: () => ({ available: true, version: "fixture" }),
    capabilities: () => ({
      nativeTools: true,
      businessTools: true,
      cancellation: { supported: true, mode: "signal" },
      evidence: true,
      contextPacket: "platform",
      followUp: false,
      streaming: true,
    }),
    run: async function* (input, signal): HarnessRunStream {
      calls.push(input);
      for (const event of events(input, signal)) yield event;
    },
    abort: () => false,
  };
}

function classifierInput(adapterName: "mock" | "claude-code"): HarnessInvocationInput {
  const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
  getDatabase().prepare("UPDATE agents SET adapter_name = ? WHERE id = 'ag_mock_builder'").run(adapterName);
  const trigger = createMessage({
    id: newMessageId(),
    conversationId: conversation.id,
    role: "user",
    origin: "human",
    agentId: null,
    runId: null,
    parts: [{ type: "text", content: "Implement the compact sidebar." }],
    status: "complete",
    now: Date.now(),
  });
  const agent = getAgent("ag_mock_builder")!;
  const workspace = getWorkspaceForConversation(conversation.id)!;
  return {
    conversationId: conversation.id,
    runId: "run_classifier",
    agent,
    conversation,
    workspace,
    triggerMessage: trigger,
    context: { systemPrompt: "", packet: { task: "", priorHistory: [], attachments: [] }, recentMessages: [] },
    tools: { names: [], required: [] },
    requirements: {},
    provider: resolveHarnessProvider(agent),
    workspaceRoot: workspace.rootPath,
  };
}

function consultationWorld(adapterName: "mock" | "claude-code") {
  const conversation = createConversation({ mode: "group", agentIds: ["ag_mock_builder", "ag_designer"] });
  getDatabase().prepare("UPDATE agents SET adapter_name = ? WHERE id = 'ag_designer'").run(adapterName);
  const trigger = createMessage({
    id: newMessageId(),
    conversationId: conversation.id,
    role: "user",
    origin: "human",
    parts: [{ type: "text", content: "Discuss the layout; do not modify files." }],
    status: "complete",
    now: Date.now(),
  });
  const source = createRun({
    id: newRunId(),
    conversationId: conversation.id,
    agentId: "ag_mock_builder",
    triggerMessageId: trigger.id,
    status: "running",
    now: Date.now(),
  });
  const controller = new AbortController();
  const workspace = getWorkspaceForConversation(conversation.id)!;
  const ctx: ToolContext = {
    conversationId: conversation.id,
    runId: source.id,
    agentId: source.agentId,
    workspacePath: workspace.rootPath,
    abortSignal: controller.signal,
  };
  const request = { requestKey: "harness-dispatch", targetAgentId: "ag_designer", question: "Is the compact sidebar preferable?", artifactIds: [] };
  return { conversation, source, ctx, request };
}

describe("collaboration dispatch through the harness registry", () => {
  it("classifies a human turn through the Agent's registered driver", async () => {
    const input = classifierInput("mock");
    const calls: HarnessInvocationInput[] = [];
    registerHarness(fakeDriver(calls, (invocation) => [{
      type: "part.delta",
      conversationId: invocation.conversationId,
      timestamp: Date.now(),
      messageId: "",
      partIndex: 0,
      delta: { type: "text.append", text: JSON.stringify(DECISION) },
    }]));

    const decision = await classifyHumanTurn(input, [], new AbortController().signal);

    expect(decision).toEqual(DECISION);
    expect(calls).toHaveLength(1);
    expect(calls[0].agent.adapterName).toBe("mock");
    // The classifier still strips the toolset: it is a context-only turn.
    expect(calls[0].tools.names).toEqual([]);
    expect(calls[0].access).toBe("conversation");
    expect(calls[0].context.systemPrompt).toContain("AGENTMELD_TURN_CLASSIFIER_V1");
    expect(piRuntime.calls).toBe(0);
  });

  it("escalates a retired engine instead of silently classifying with Pi", async () => {
    const input = classifierInput("claude-code");

    await expect(classifyHumanTurn(input, [], new AbortController().signal)).rejects.toMatchObject({
      category: "migration_required",
    });
    expect(piRuntime.calls).toBe(0);
  });

  it("routes a peer consultation through the target Agent's registered driver", async () => {
    const { ctx, request } = consultationWorld("mock");
    const calls: HarnessInvocationInput[] = [];
    registerHarness(fakeDriver(calls, (invocation, signal) => {
      proposeConsultationResponse({
        conversationId: invocation.conversationId,
        runId: invocation.runId,
        agentId: invocation.agent.id,
        workspacePath: invocation.workspaceRoot,
        abortSignal: signal,
      }, "replied", CONSULTATION_ANSWER);
      return [{
        type: "part.start",
        conversationId: invocation.conversationId,
        timestamp: Date.now(),
        messageId: "",
        partIndex: 0,
        part: { type: "text", content: CONSULTATION_ANSWER },
      }];
    }));

    const result = await requestConsultation(request, ctx);

    expect(result.status).toBe("replied");
    expect(result.answer).toBe(CONSULTATION_ANSWER);
    expect(getRun(result.targetRunId!)?.status).toBe("complete");
    expect(calls).toHaveLength(1);
    expect(calls[0].agent.id).toBe("ag_designer");
    expect(calls[0].agent.adapterName).toBe("mock");
    expect(calls[0].runId).toBe(result.targetRunId);
    expect(calls[0].tools.names).toContain("respond_to_consultation");
    expect(piRuntime.calls).toBe(0);
  });

  it("refuses a target engine with no driver instead of falling back to Pi", async () => {
    const { ctx, request } = consultationWorld("claude-code");

    await expect(requestConsultation(request, ctx)).rejects.toThrow("Consultation target");
    expect(piRuntime.calls).toBe(0);
  });
});
