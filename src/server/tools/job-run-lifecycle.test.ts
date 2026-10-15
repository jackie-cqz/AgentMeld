import { afterEach, describe, expect, it } from "vitest";
import { getDatabase } from "@/db/client";
import { startAgentRun, isRunActive } from "@/server/agent-runner";
import { createConversation } from "@/server/conversation-service";
import { createMessage, getRun } from "@/server/repositories";
import { eventBus } from "@/server/event-bus";
import { registerAdapter, clearRegistryForTests } from "@/server/adapters/registry";
import { startCommandJob, controlCommandJob, clearCommandJobsForTests, hasRunningJobs } from "@/server/tools/command-jobs";
import { newMessageId } from "@/shared/ids";
import type { ToolContext } from "@/server/tools/types";

afterEach(async () => { await clearCommandJobsForTests(); clearRegistryForTests(); eventBus.clearForTests(); });
describe("run lifecycle owns background processes", () => {
  it.each([false, true])("cleans unfinished commands before run.end when adapter throws=%s", async throws => {
    getDatabase().prepare("UPDATE agents SET adapter_name = 'mock' WHERE id = 'ag_mock_builder'").run();
    const conversation = createConversation({ mode: "single", agentIds: ["ag_mock_builder"] });
    const triggerMessage = createMessage({ id: newMessageId(), conversationId: conversation.id, role: "user", parts: [{ type: "text", content: "Run fixture verification" }], status: "complete", now: Date.now() });
    let context!: ToolContext; let jobId = ""; let runningAtEnd = true;
    registerAdapter({ name: "mock", async *run(input, signal) {
      context = { conversationId: input.conversationId, agentId: input.agent.id, runId: input.runId, workspacePath: input.workspacePath, abortSignal: signal };
      jobId = startCommandJob(process.execPath, ["-e", "setTimeout(()=>{},10000)"], input.workspacePath, "npm run build", context, 15000).jobId;
      yield { type: "part.start", conversationId: input.conversationId, timestamp: Date.now(), messageId: "", partIndex: 0, part: { type: "text", content: "" } };
      if (throws) throw new Error("Fixture adapter failed");
    } });
    const unsubscribe = eventBus.subscribe(entry => { if (entry.event.type === "run.end") runningAtEnd = hasRunningJobs(entry.event.runId); });
    try {
      const handle = startAgentRun({ conversationId: conversation.id, agentId: "ag_mock_builder", triggerMessage }); await handle.promise;
      expect(getRun(handle.runId)?.status).toBe("failed"); expect(isRunActive(handle.runId)).toBe(false); expect(runningAtEnd).toBe(false);
      expect(await controlCommandJob("read", jobId, 0, 0, context)).toMatchObject({ status: "cancelled", exitCode: null });
    } finally { unsubscribe(); }
  });
});
