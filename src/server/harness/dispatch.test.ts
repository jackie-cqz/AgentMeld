import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Pi's real engine is an installed CLI; the dispatch contract (not Pi's HTTP
// calls) is what these tests own, so substitute the lifecycle fixture. This also
// proves a Pi Agent still runs through the same entry point.
vi.mock("@/server/pi/runtime", async () => ({ runPiInvocation: (await import("@/test/pi-runtime-fixture")).fixturePiInvocation }));
import { stopFixtureRuns } from "@/test/pi-runtime-fixture";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDatabase, resetDatabaseForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { startAgentRun } from "@/server/agent-runner";
import { createConversation } from "@/server/conversation-service";
import { createMessage, getRun, listMessages } from "@/server/repositories";
import type { AdapterName } from "@/shared/types";
import { opencodeHarnessDriver } from "./opencode-driver";
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

afterEach(async () => {
  await stopFixtureRuns();
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

  it("fails a saved opencode Agent as harness_unavailable when no driver is registered", async () => {
    const { conversation, trigger } = seedRun("opencode");
    // The row is still a real, saved choice; simulate a build that does not ship
    // the driver so the unregistered-name contract stays covered.
    unregisterHarness("opencode");
    try {
      expect(getHarness("opencode")).toBeNull();
      const handle = startAgentRun({ conversationId: conversation.id, agentId: "ag_mock_builder", triggerMessage: trigger });
      await handle.promise;

      expect(getRun(handle.runId)).toMatchObject({
        status: "failed",
        errorCategory: "harness_unavailable",
      });
      const failed = listMessages(conversation.id).find((message) => message.role === "agent" && message.runId === handle.runId);
      expect(failed?.status).toBe("error");
      expect(failed?.parts).toContainEqual({
        type: "text",
        content: expect.stringContaining('No execution engine is registered for "opencode".'),
      });
      expect(failed?.parts).toContainEqual({
        type: "text",
        content: expect.stringContaining("Install or enable its harness before running this Agent."),
      });
      // The user must not be sent to a migration that cannot help here.
      expect(JSON.stringify(failed?.parts)).not.toContain("retired");
    } finally {
      registerHarness(opencodeHarnessDriver);
    }
  });

  it("refuses an artifact-producing run before the driver runs when the engine lacks the capability", async () => {
    const { conversation, trigger } = seedRun("opencode");
    // The gate is the contract under test here, not the real engine: stand in a
    // registered driver that honestly declares it cannot carry business tools.
    const calls: HarnessInvocationInput[] = [];
    const limited: HarnessDriver = {
      id: "opencode",
      doctor: () => ({ available: true, version: "fixture" }),
      capabilities: () => ({
        nativeTools: true,
        businessTools: false,
        cancellation: { supported: true, mode: "signal" },
        evidence: false,
        contextPacket: "platform",
        followUp: false,
        streaming: true,
      }),
      run: async function* (input): HarnessRunStream {
        calls.push(input);
        yield { type: "run.started" };
        yield { type: "run.settled", status: "completed" };
      },
      abort: () => false,
    };
    unregisterHarness("opencode");
    registerHarness(limited);
    try {
      const handle = startAgentRun({ conversationId: conversation.id, agentId: "ag_mock_builder", triggerMessage: trigger });
      await handle.promise;

      // The capability gate runs before `run`: a normal Agent run is provisioned
      // with business tools and evidence. The run must fail honestly, without
      // starting the engine, rather than produce output the platform cannot verify.
      expect(calls).toHaveLength(0);
      expect(getRun(handle.runId)).toMatchObject({
        status: "failed",
        errorCategory: "harness_capability",
      });
      const failed = listMessages(conversation.id).find((message) => message.role === "agent" && message.runId === handle.runId);
      expect(failed?.parts).toContainEqual({
        type: "text",
        content: expect.stringContaining('The "opencode" execution engine cannot run this Agent'),
      });
      expect(JSON.stringify(failed?.parts)).not.toContain("retired");
    } finally {
      unregisterHarness("opencode");
      registerHarness(opencodeHarnessDriver);
    }
  });

  it("leaves Pi dispatch untouched", async () => {
    const { conversation, trigger } = seedRun("pi");
    expect(getHarness("pi")).not.toBeNull();

    const handle = startAgentRun({ conversationId: conversation.id, agentId: "ag_mock_builder", triggerMessage: trigger });
    await handle.promise;

    expect(getRun(handle.runId)).toMatchObject({ status: "complete", errorCategory: null });
    const reply = listMessages(conversation.id).find((message) => message.role === "agent" && message.runId === handle.runId);
    expect(reply?.status).toBe("complete");
    expect(reply?.parts).toEqual([{ type: "text", content: "Pi lifecycle fixture response" }]);
  });
});
