import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Pi's real process runtime cannot be started in a unit test (it spawns the
// pinned CLI), so this file spies on its module boundary instead. The driver
// itself is the real one; only `runPiInvocation` is replaced.
const { runPiInvocation } = vi.hoisted(() => ({ runPiInvocation: vi.fn() }));
vi.mock("@/server/pi/runtime", () => ({ runPiInvocation }));

import { getPiDoctor } from "@/server/pi/config";
import { renderPiContextPacket } from "@/server/pi/packet";
import type { PiInvocationInput } from "@/server/pi/types";
import type { Agent, Conversation, Message, StreamEvent, Workspace } from "@/shared/types";
import type { HarnessInvocationInput } from "./types";
import { piHarnessDriver, toPiInvocationInput } from "./pi-driver";

afterEach(() => {
  runPiInvocation.mockReset();
  delete process.env.AGENTMELD_PI_CLI_PATH;
});

const agent = {
  id: "ag_fixture", name: "Fixture", avatar: "F", description: "", capabilities: ["read"],
  adapterName: "pi", modelProvider: "deepseek", modelId: "deepseek-chat", apiKey: null, apiBaseUrl: null,
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

/** A fully-populated neutral invocation, with no Pi vocabulary anywhere. */
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
        attachments: [{ id: "att_fixture", fileName: "spec.txt", mimeType: "text/plain", workspacePath: "spec.txt" }],
      },
      recentMessages: [],
    },
    tools: { names: ["fs_read", "write_artifact"], required: ["write_artifact"] },
    requirements: { nativeTools: true, businessTools: true, evidence: true, cancellation: true, contextPacket: "platform" },
    provider: {
      providerId: "deepseek",
      catalogProvider: "deepseek",
      modelId: "deepseek-chat",
      endpoint: "http://127.0.0.1:1/v1",
      credential: "fixture-not-real",
      revision: "deepseek:1",
    },
    workspaceRoot: "/tmp/fixture-workspace",
    maxTurns: 3,
    timeoutMs: 1234,
    access: "workspace",
    ...overrides,
  };
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("the Pi harness driver", () => {
  it("declares the adapter name old Agent rows already store", () => {
    expect(piHarnessDriver.id).toBe("pi");
  });

  it("maps the neutral invocation onto exactly the Pi input the old call site produced", async () => {
    const event: StreamEvent = {
      type: "part.end",
      conversationId: "conv_fixture",
      timestamp: 1,
      messageId: "",
      partIndex: 0,
    };
    async function* fixtureRun() {
      yield event;
    }
    runPiInvocation.mockImplementation(fixtureRun);

    const onTaskAccepted = vi.fn();
    const onStage = vi.fn();
    const input = neutralInput({ onTaskAccepted, onStage });
    const signal = new AbortController().signal;
    const received = await drain(piHarnessDriver.run(input, signal));

    expect(received).toEqual([event]);
    expect(runPiInvocation).toHaveBeenCalledTimes(1);
    const [calledInput, calledSignal] = runPiInvocation.mock.calls[0] as [PiInvocationInput, AbortSignal];
    expect(calledSignal).toBe(signal);
    // Field-by-field: every neutral field lands on its Pi counterpart, and the
    // platform packet is rendered by Pi's own envelope.
    expect(calledInput).toEqual({
      conversationId: input.conversationId,
      runId: input.runId,
      parentRunId: null,
      taskExecution: null,
      taskContract: null,
      agent: { ...agent, modelProvider: "deepseek", modelId: "deepseek-chat" },
      conversation,
      workspace,
      triggerMessage,
      recentMessages: [],
      toolNames: ["fs_read", "write_artifact"],
      systemPrompt: "You are the fixture Agent.",
      workspacePath: "/tmp/fixture-workspace",
      history: [{ role: "user", content: "Earlier platform context." }],
      prompt: renderPiContextPacket(input.context.packet),
      apiKey: "fixture-not-real",
      apiBaseUrl: "http://127.0.0.1:1/v1",
      providerRevision: "deepseek:1",
      catalogProvider: "deepseek",
      accessMode: "workspace",
      workspaceLease: undefined,
      maxTurns: 3,
      timeoutMs: 1234,
      onTaskAccepted,
      onStage,
      onContextCaptured: undefined,
    });
  });

  it("contains no Pi-shaped fields at the seam", () => {
    const input = neutralInput();
    const forbidden = [
      "apiKey", "apiBaseUrl", "providerRevision", "catalogProvider",
      "contextXml", "taskPacket", "providerSnapshot", "accessMode", "systemPrompt", "toolNames",
    ];
    for (const field of forbidden) expect(input).not.toHaveProperty(field);
    expect(Object.keys(input.provider).sort()).toEqual([
      "catalogProvider", "credential", "endpoint", "modelId", "providerId", "revision",
    ]);
    expect(Object.keys(input.context).sort()).toEqual(["packet", "recentMessages", "systemPrompt"]);
  });

  it("adapts Pi's context receipt back into the neutral receipt", async () => {
    async function* fixtureRun() {
      yield* [] as StreamEvent[];
    }
    runPiInvocation.mockImplementation(fixtureRun);
    const onContextCaptured = vi.fn();
    const input = neutralInput({ onContextCaptured });

    const mapped = toPiInvocationInput(input);
    mapped.onContextCaptured?.({ packet: "rendered-prompt", systemPromptHash: "hash", toolNames: ["fs_read"], accessMode: "conversation" });

    expect(onContextCaptured).toHaveBeenCalledWith({
      prompt: "rendered-prompt",
      systemPromptHash: "hash",
      toolNames: ["fs_read"],
      access: "conversation",
    });
  });

  it("returns Pi's generator directly, so errors and cancellation are not re-shaped", () => {
    const generator = (async function* () { /* drained elsewhere */ })();
    runPiInvocation.mockReturnValue(generator);

    expect(piHarnessDriver.run(neutralInput(), new AbortController().signal)).toBe(generator);
  });

  it("delegates doctor() to the Pi installation check", () => {
    const report = getPiDoctor();
    const doctor = piHarnessDriver.doctor();

    expect(doctor.available).toBe(report.available);
    expect(doctor.version).toBe(report.installedVersion ?? undefined);
    // Mirrors the Pi check rather than inventing a second notion of "healthy".
    if (report.available) expect(doctor.detail).toContain(report.expectedVersion);
    else expect(doctor.detail).toBe(report.error);
  });

  it("reports an unusable installation instead of throwing", () => {
    process.env.AGENTMELD_PI_CLI_PATH = path.join(os.tmpdir(), "agentmeld-missing-pi", "cli.js");

    const doctor = piHarnessDriver.doctor();

    expect(doctor.available).toBe(false);
    expect(doctor.version).toBeUndefined();
    expect(doctor.detail).toBe(getPiDoctor().error);
  });

  it("declares the capability matrix truthfully", () => {
    expect(piHarnessDriver.capabilities()).toEqual({
      // Pi's extension registers its own native tools…
      nativeTools: true,
      // …and reaches the server-side business tools through the bridge.
      businessTools: true,
      // Cancellable only by aborting the signal the caller passed to run().
      cancellation: { supported: true, mode: "signal" },
      // Native outcomes are hashed and business receipts reach the ledger.
      evidence: true,
      // Pi is handed the packet the platform compiles, not one it builds itself.
      contextPacket: "platform",
      followUp: true,
      streaming: true,
    });
  });

  it("does not pretend to abort by run id, because Pi exposes no such entry point", () => {
    // The only cancellation channel is the AbortSignal handed to run().
    expect(piHarnessDriver.capabilities().cancellation).toEqual({ supported: true, mode: "signal" });
    expect(piHarnessDriver.abort("run_pi_driver")).toBe(false);
  });
});
