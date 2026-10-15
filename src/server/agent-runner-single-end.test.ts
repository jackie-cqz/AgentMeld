import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { startAgentRun, isRunActive } from "@/server/agent-runner";
import { createMessage, createConversation, getRun, listMessages } from "@/server/repositories";
import { createWorkspace } from "@/server/conversation-service";
import { failConductor } from "@/server/conductor-service";
import type { StreamEvent } from "@/shared/types";

/** The run owner alone settles a Conductor failure, including its empty message. */
const { executeConductorMock } = vi.hoisted(() => ({ executeConductorMock: vi.fn() }));

vi.mock("@/server/conductor-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/conductor-service")>();
  return {
    ...actual,
    executeConductor: (...args: unknown[]) => executeConductorMock(...args)
  };
});

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentmeld-single-end-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetDatabaseForTests();
  eventBus.clearForTests();
  ensureDatabase();

  executeConductorMock.mockReset();
  executeConductorMock.mockImplementation(
    async () => {
      failConductor("Plan validation failed");
    }
  );
});

afterEach(() => {
  resetBootstrapForTests();
  resetDatabaseForTests();
  delete process.env.AGENTMELD_DATA_DIR;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("a conductor run whose planning fails", () => {
  it("ends once, as failed — not once as failed and again as complete", async () => {
    const events: StreamEvent[] = [];
    const unsub = eventBus.subscribe((entry) => events.push(entry.event));

    const { conversationId } = seedConductorConversation();
    const handle = startAgentRun({
      conversationId,
      agentId: "ag_mock_conductor",
      triggerMessage: seedTriggerMessage(conversationId)
    });

    await handle.promise;
    unsub();

    const ends = events.filter(
      (event) => event.type === "run.end" && event.runId === handle.runId
    );
    // The bug was two of these, the second overriding the first.
    expect(ends).toHaveLength(1);
    expect(ends[0].type === "run.end" && ends[0].status).toBe("failed");

    // And the record agrees with the group, instead of contradicting it.
    expect(getRun(handle.runId)?.status).toBe("failed");
    expect(isRunActive(handle.runId)).toBe(false);
    expect(events.filter(event => event.type === "message.end")).toHaveLength(1);
    expect(listMessages(conversationId).find(message => message.role === "agent")).toMatchObject({ status: "error", parts: [{ type: "text", content: "Plan validation failed" }] });
  });
});

/** A group conversation with the conductor, and the workspace a run needs. */
function seedConductorConversation(): { conversationId: string } {
  const id = `conv_single_end_${Math.random().toString(36).slice(2, 8)}`;
  createConversation({
    id,
    title: "conductor",
    mode: "group",
    agentIds: ["ag_mock_conductor", "ag_pm"],
    fsWriteApprovalMode: "auto",
    now: Date.now()
  });
  // Without a workspace the run exits early and never reaches the conductor.
  createWorkspace(id, Date.now());
  return { conversationId: id };
}

function seedTriggerMessage(conversationId: string) {
  return createMessage({
    id: `msg_trigger_${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    role: "user",
    agentId: null,
    parts: [{ type: "text", content: "做个东西" }],
    status: "complete",
    now: Date.now()
  });
}
