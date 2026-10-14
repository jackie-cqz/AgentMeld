import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";
import { eventBus } from "@/server/event-bus";
import { startAgentRun } from "@/server/agent-runner";
import { createMessage, createConversation, getRun } from "@/server/repositories";
import { createWorkspace } from "@/server/conversation-service";
import { publishConductorFailed } from "@/server/conductor-service";
import type { StreamEvent } from "@/shared/types";

/**
 * A run must end once, with one status.
 *
 * The conductor publishes `run.end` with status "failed" when plan validation
 * fails, and then RETURNS rather than throwing — so the runner used to follow it
 * with an unconditional `completeRun(..., "complete")`. One run emitted
 * `run.end` twice, the second saying "complete", and the row ended complete: the
 * web UI reporting success while the channel had just told the group the task
 * failed.
 *
 * `executeConductor` is stubbed to reproduce that exact shape, because it is the
 * shape that matters and driving a real plan-validation failure is not
 * deterministic. The stub does what the real one does on that path: publish a
 * failure and return.
 */
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
  // What the real conductor does when plan validation fails: announce the
  // failure through the shared helper, then RETURN rather than throw. Using the
  // real helper rather than re-publishing the event by hand is the point — the
  // helper is what records the status, and an earlier version of this stub
  // reproduced the old, broken shape and hid the bug it was written for.
  executeConductorMock.mockImplementation(
    async (input: { conversationId: string; conductorRunId: string }) => {
      publishConductorFailed(input as never, "Plan validation failed");
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

    await waitForRunToSettle(handle.runId);
    unsub();

    const ends = events.filter(
      (event) => event.type === "run.end" && event.runId === handle.runId
    );
    // The bug was two of these, the second overriding the first.
    expect(ends).toHaveLength(1);
    expect(ends[0].type === "run.end" && ends[0].status).toBe("failed");

    // And the record agrees with the group, instead of contradicting it.
    expect(getRun(handle.runId)?.status).toBe("failed");
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

async function waitForRunToSettle(runId: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const run = getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
