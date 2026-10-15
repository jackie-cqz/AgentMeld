import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authedRequest, pairTestOwner, resetTestAuth } from "@/test/auth-test-helper";
import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { getDatabase, resetDatabaseForTests as resetClientForTests } from "@/db/client";
import { POST as retryCompaction } from "@/app/api/context-compaction-jobs/[id]/retry/route";
import { createConversation } from "@/server/conversation-service";
import {
  createCompactionJob,
  failCompactionJob,
  getCompactionJob
} from "@/server/context-compaction-service";
import { startConversationCompaction } from "@/server/context-compaction-runner";
import { eventBus } from "@/server/event-bus";
import { createMessage } from "@/server/repositories";
import { updateSettings } from "@/server/settings-service";
import type { StreamEvent } from "@/shared/types";

let tempDir: string;
let originalFetch: typeof fetch;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-compaction-runner-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  resetTestAuth();
  eventBus.clearForTests();
  ensureDatabase();
  pairTestOwner();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: "## 用户请求\n- 完成上下文压缩" } }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  })) as typeof fetch;
  updateSettings({ deepseekApiKey: "test-key" });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetBootstrapForTests();
  resetClientForTests();
  resetTestAuth();
  delete process.env.AGENTMELD_DATA_DIR;
  eventBus.clearForTests();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("context compaction runner", () => {
  it("links a completed job to the persisted context summary", async () => {
    const conversation = createCompactionConversation();
    const started = startConversationCompaction(conversation.id);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const completed = await waitForJob(started.job.id, "complete");
    expect(completed.resultSummaryId).toMatch(/^ctx_/);

    const summary = getDatabase()
      .prepare("SELECT id FROM conversation_context_summaries WHERE id = ?")
      .get(completed.resultSummaryId) as { id: string } | undefined;
    expect(summary?.id).toBe(completed.resultSummaryId);
  });

  it("persists the same origin it publishes for its system message", async () => {
    // postSystemMessage writes the row with raw SQL rather than createMessage,
    // so the origin is stated twice. When they disagree the live event and the
    // value a client reads after a reload differ, which is silent until
    // something reads the column.
    const conversation = createCompactionConversation();

    const events: StreamEvent[] = [];
    eventBus.subscribe((entry) => {
      events.push(entry.event);
    });

    const started = startConversationCompaction(conversation.id);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await waitForJob(started.job.id, "complete");

    const added = events.filter((event) => event.type === "message.added");
    const systemEvent = added[added.length - 1];
    expect(systemEvent?.type).toBe("message.added");
    if (systemEvent?.type !== "message.added") return;

    expect(systemEvent.message.role).toBe("system");
    expect(systemEvent.message.origin).toBe("internal");

    const row = getDatabase()
      .prepare("SELECT origin FROM messages WHERE id = ?")
      .get(systemEvent.message.id) as { origin: string } | undefined;

    expect(row?.origin).toBe(systemEvent.message.origin);
  });

  it("retry creates and starts a linked job with an incremented attempt", async () => {
    const conversation = createCompactionConversation();
    const oldJobId = "ccj_failed";
    const created = createCompactionJob(
      oldJobId,
      conversation.id,
      "msg_0",
      "msg_2",
      3,
      1,
      "deepseek",
      "deepseek-chat",
      Date.now()
    );
    expect(typeof created).not.toBe("string");
    getDatabase()
      .prepare("UPDATE context_compaction_jobs SET status = 'running' WHERE id = ?")
      .run(oldJobId);
    failCompactionJob(oldJobId, "provider_server", "temporary failure", true, Date.now());

    const response = await retryCompaction(
      authedRequest(`http://localhost/api/context-compaction-jobs/${oldJobId}/retry`, { method: "POST" }),
      { params: Promise.resolve({ id: oldJobId }) }
    );
    expect(response.status).toBe(202);
    const body = await response.json() as { job: { id: string; previousJobId: string | null; attempt: number } };
    expect(body.job.previousJobId).toBe(oldJobId);
    expect(body.job.attempt).toBe(2);

    const completed = await waitForJob(body.job.id, "complete");
    expect(completed.previousJobId).toBe(oldJobId);
  });
});

function createCompactionConversation() {
  const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
  for (let index = 0; index < 12; index++) {
    createMessage({
      id: `msg_${index}`,
      conversationId: conversation.id,
      role: "user",
      parts: [{ type: "text", content: `message ${index}` }],
      status: "complete",
      now: index + 1
    });
  }
  return conversation;
}

async function waitForJob(jobId: string, expectedStatus: "complete" | "failed") {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const job = getCompactionJob(jobId);
    if (job?.status === expectedStatus) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for compaction job ${jobId} to become ${expectedStatus}.`);
}
