import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let tempDir: string;
let originalFetch: typeof fetch;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-conf-compaction-runner-"));
  process.env.AGENTMELD_DATA_DIR = tempDir;
  resetBootstrapForTests();
  resetClientForTests();
  eventBus.clearForTests();
  ensureDatabase();
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
      new Request(`http://localhost/api/context-compaction-jobs/${oldJobId}/retry`, { method: "POST" }),
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
