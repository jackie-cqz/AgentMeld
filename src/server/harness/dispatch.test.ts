import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDatabase, resetDatabaseForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { startAgentRun } from "@/server/agent-runner";
import { createConversation } from "@/server/conversation-service";
import { createMessage, getRun, listMessages } from "@/server/repositories";
import type { AdapterName } from "@/shared/types";
import { getHarness, registerHarness, unregisterHarness } from "./registry";
import type { HarnessDriver, HarnessInvocationInput, HarnessRunStream } from "./types";

/**
 * Drives the real run entry point, not a hand-written dispatch loop: this is
 * what proves `agent-runner` resolves a driver instead of assuming Pi.
 */
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-harness-dispatch-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetDatabaseForTests();
  eventBus.clearForTests();
  ensureDatabase();
});

afterEach(() => {
  unregisterHarness("mock");
  resetBootstrapForTests();
  resetDatabaseForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** A one-agent conversation whose builder row claims `adapterName`. */
function seedRun(adapterName: AdapterName) {
  const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
  getDatabase().prepare("UPDATE agents SET adapter_name = ? WHERE id = 'ag_mock_builder'").run(adapterName);
  const trigger = createMessage({
    id: `msg_harness_${conversation.id}`,
    conversationId: conversation.id,
    origin: "human",
    role: "user",
    agentId: null,
    runId: null,
    parts: [{ type: "text", content: "Run the harness contract fixture" }],
    status: "complete",
    now: Date.now(),
  });
  return { conversation, trigger };
}

describe("harness dispatch at the real run entry point", () => {
  it("runs a registered fake driver instead of assuming Pi", async () => {
    const { conversation, trigger } = seedRun("mock");
    const calls: Array<{ input: HarnessInvocationInput; signal: AbortSignal }> = [];
    const fake: HarnessDriver = {
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
        calls.push({ input, signal });
        yield { type: "output.start", blockIndex: 0, kind: "text" };
        yield { type: "output.delta", blockIndex: 0, kind: "text", text: "Fake harness reply" };
        yield { type: "output.end", blockIndex: 0 };
      },
      abort: () => false,
    };
    registerHarness(fake);
    expect(getHarness("mock")).toBe(fake);

    const handle = startAgentRun({ conversationId: conversation.id, agentId: "ag_mock_builder", triggerMessage: trigger });
    await handle.promise;

    expect(calls).toHaveLength(1);
    expect(calls[0].input.runId).toBe(handle.runId);
    expect(calls[0].input.conversationId).toBe(conversation.id);
    expect(calls[0].input.agent.id).toBe("ag_mock_builder");
    expect(calls[0].input.agent.adapterName).toBe("mock");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(getRun(handle.runId)?.status).toBe("complete");
    const reply = listMessages(conversation.id).find((message) => message.role === "agent" && message.runId === handle.runId);
    expect(reply?.parts).toEqual([{ type: "text", content: "Fake harness reply" }]);
  });

  it("fails a retired adapter with the honest migration error and calls no driver", async () => {
    const { conversation, trigger } = seedRun("claude-code");
    // Only Pi is registered in production; a retired name resolves to nothing.
    expect(getHarness("claude-code")).toBeNull();

    const handle = startAgentRun({ conversationId: conversation.id, agentId: "ag_mock_builder", triggerMessage: trigger });
    await handle.promise;

    expect(getRun(handle.runId)).toMatchObject({
      status: "failed",
      errorCategory: "migration_required",
    });
    const failed = listMessages(conversation.id).find((message) => message.role === "agent" && message.runId === handle.runId);
    expect(failed?.status).toBe("error");
    expect(failed?.parts).toContainEqual({
      type: "text",
      content: expect.stringContaining("retired execution engine"),
    });
  });
});
