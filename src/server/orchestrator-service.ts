import { eventBus } from "@/server/event-bus";
import { startAgentRun } from "@/server/agent-runner";
import { createMessage, getConversation } from "@/server/repositories";
import { registerPendingPlan } from "@/server/dispatch-plan-manager";
import { validatePlan, topologicalWaves, type ParsedTask } from "@/server/tools/orchestrator-tools";
import { newMessageId } from "@/shared/ids";
import type { Message, DispatchPlanItem } from "@/shared/types";

// ---------------------------------------------------------------------------
// Public entry — called from agent-runner or API
// ---------------------------------------------------------------------------

export interface OrchestratorInput {
  conversationId: string;
  orchestratorAgentId: string;
  triggerMessage: Message;
  availableAgentIds: string[];
  orchestratorRunId: string;
}

export async function executeOrchestrator(input: OrchestratorInput): Promise<void> {
  // Stage 1: PLAN — generate demo plan for MVP
  const plan = buildDemoPlan(input.availableAgentIds, input.triggerMessage);

  const planItems: DispatchPlanItem[] = plan.tasks.map((t) => ({
    id: t.id,
    agentId: t.agentId,
    task: t.prompt,
    dependsOn: t.dependsOn
  }));

  // registerPendingPlan publishes SSE + creates resolver promise
  const result = await registerPendingPlan(input.conversationId, input.orchestratorRunId, planItems);

  if (!result.approved) {
    createSystemMessage(input.conversationId, "Plan was rejected by user.");
    return;
  }

  // If revised, merge with original
  const finalPlan: ParsedTask[] = result.revisedPlan
    ? mergeRevisedPlan(plan.tasks, result.revisedPlan)
    : plan.tasks;

  // Stage 2: EXECUTE
  await executeOrchestratorPlan(
    input.conversationId,
    finalPlan,
    input.availableAgentIds,
    input.orchestratorRunId,
    input.triggerMessage
  );
}

// ---------------------------------------------------------------------------
// DAG execution
// ---------------------------------------------------------------------------

export interface TaskResult {
  taskId: string;
  status: "complete" | "failed" | "blocked" | "skipped";
  summary: string;
  childRunId?: string;
}

export async function executeOrchestratorPlan(
  conversationId: string,
  plan: ParsedTask[],
  availableAgents: string[],
  orchestratorRunId: string,
  triggerMessage: Message
): Promise<Map<string, TaskResult>> {
  const results = new Map<string, TaskResult>();

  const validation = validatePlan(plan);
  if (validation) {
    createSystemMessage(conversationId, `Plan validation failed: ${validation}`);
    return results;
  }

  const validTasks = plan.filter((t) => availableAgents.includes(t.agentId));
  const waves = topologicalWaves(validTasks);

  for (const wave of waves) {
    const wavePromises: Promise<void>[] = [];

    for (const task of wave) {
      // Check upstream dependencies
      let shouldSkip = false;
      for (const dep of task.dependsOn) {
        const depResult = results.get(dep);
        if (depResult && depResult.status !== "complete") {
          shouldSkip = true;
          break;
        }
      }

      if (shouldSkip) {
        results.set(task.id, { taskId: task.id, status: "skipped", summary: "Upstream dependency failed." });
        continue;
      }

      wavePromises.push(
        runChildTask(conversationId, task, triggerMessage, orchestratorRunId).then((r) => {
          results.set(task.id, r);
        })
      );
    }

    await Promise.all(wavePromises);
  }

  // Stage 3: AGGREGATE
  generateAggregateMessage(conversationId, results, plan);
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runChildTask(
  conversationId: string,
  task: ParsedTask,
  triggerMessage: Message,
  parentRunId: string
): Promise<TaskResult> {
  eventBus.publish({
    type: "dispatch.start",
    conversationId,
    timestamp: Date.now(),
    parentRunId,
    childRunId: "",
    taskId: task.id,
    agentId: task.agentId
  });

  const childMsg: Message = {
    id: newMessageId(),
    conversationId,
    role: "user",
    agentId: null,
    runId: null,
    parts: [{ type: "text", content: task.prompt }],
    status: "complete",
    mentionedAgentIds: [task.agentId],
    parentMessageId: triggerMessage.id,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const runId = startAgentRun({ conversationId, agentId: task.agentId, triggerMessage: childMsg });

  // Wait for child run to complete (up to 5s for mock adapter)
  await waitForRunEnd(runId, 8000);

  eventBus.publish({
    type: "dispatch.end",
    conversationId,
    timestamp: Date.now(),
    parentRunId,
    childRunId: runId,
    taskId: task.id,
    status: "complete"
  });

  return { taskId: task.id, status: "complete", summary: `Task "${task.title}" completed.`, childRunId: runId };
}

function waitForRunEnd(runId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), timeoutMs);
    const unsub = eventBus.subscribe((entry) => {
      if (entry.event.type === "run.end" && entry.event.type === "run.end") {
        const e = entry.event;
        if (e.type === "run.end" && e.runId === runId) {
          clearTimeout(timeout);
          unsub();
          resolve();
        }
      }
    });
  });
}

function generateAggregateMessage(
  conversationId: string,
  results: Map<string, TaskResult>,
  plan: ParsedTask[]
): void {
  const completed = Array.from(results.values()).filter((r) => r.status === "complete").length;
  const failed = Array.from(results.values()).filter((r) => r.status === "failed" || r.status === "blocked").length;
  const skipped = Array.from(results.values()).filter((r) => r.status === "skipped").length;

  const summary = [
    "## Orchestrator 总结",
    "",
    "| 状态 | 数量 |",
    "|------|------|",
    `| ✅ 完成 | ${completed} |`,
    `| ❌ 失败 | ${failed} |`,
    `| ⏭️ 跳过 | ${skipped} |`,
    "",
    "### 任务详情",
    ...plan.map((t) => {
      const r = results.get(t.id);
      const icon = r?.status === "complete" ? "✅" : r?.status === "skipped" ? "⏭️" : "❌";
      return `- ${icon} **${t.title}** — ${r?.summary ?? "pending"}`;
    })
  ].join("\n");

  const message = createMessage({
    id: newMessageId(),
    conversationId,
    role: "agent",
    agentId: plan[0]?.agentId ?? "ag_orchestrator",
    runId: "",
    parts: [{ type: "text", content: summary }],
    status: "complete",
    now: Date.now()
  });

  eventBus.publish({ type: "message.added", conversationId, timestamp: Date.now(), message });
}

function createSystemMessage(conversationId: string, error: string): void {
  const message = createMessage({
    id: newMessageId(),
    conversationId,
    role: "system",
    parts: [{ type: "text", content: `⚠️ ${error}` }],
    status: "complete",
    now: Date.now()
  });
  eventBus.publish({ type: "message.added", conversationId, timestamp: Date.now(), message });
}

// ---------------------------------------------------------------------------
// Demo plan generator (MVP — replaced by LLM when CustomAdapter is wired)
// ---------------------------------------------------------------------------

function buildDemoPlan(availableAgentIds: string[], triggerMsg: Message): { reasoning: string; tasks: ParsedTask[] } {
  const text = triggerMsg.parts
    .filter((p) => p.type === "text")
    .map((p) => p.content)
    .join("\n");

  const workers = availableAgentIds.filter((id) => !id.includes("orchestrator"));

  return {
    reasoning: `Demo plan for: "${text.slice(0, 80)}"`,
    tasks: workers.length > 0
      ? [
          {
            id: "t1",
            agentId: workers[0],
            title: "分析需求",
            prompt: `Analyze: ${text}\n\nCall report_task_result with your findings.`,
            dependsOn: [],
            inputs: [],
            expectedOutputs: [{ id: "analysis", type: "document" as const, required: true }],
            acceptanceCriteria: ["分析完整"],
            maxAttempts: 1
          },
          ...(workers.length > 1
            ? [
                {
                  id: "t2",
                  agentId: workers[1],
                  title: "实现方案",
                  prompt: `Based on the analysis, implement the solution. Call report_task_result when done.`,
                  dependsOn: ["t1"],
                  inputs: [{ fromTaskId: "t1", outputId: "analysis", required: true }],
                  expectedOutputs: [{ id: "implementation", type: "web_app" as const, required: true }],
                  acceptanceCriteria: ["功能可用"],
                  maxAttempts: 1
                }
              ]
            : [])
        ]
      : [
          {
            id: "t1",
            agentId: availableAgentIds[0] ?? "ag_mock_builder",
            title: "执行任务",
            prompt: `Handle: ${text}`,
            dependsOn: [],
            inputs: [],
            expectedOutputs: [],
            acceptanceCriteria: ["任务完成"],
            maxAttempts: 1
          }
        ]
  };
}

function mergeRevisedPlan(original: ParsedTask[], revised: DispatchPlanItem[]): ParsedTask[] {
  return revised.map((item) => {
    const orig = original.find((t) => t.id === item.id);
    return orig
      ? { ...orig, prompt: item.task, dependsOn: item.dependsOn }
      : {
          id: item.id,
          agentId: item.agentId,
          title: item.id,
          prompt: item.task,
          dependsOn: item.dependsOn,
          inputs: [],
          expectedOutputs: [],
          acceptanceCriteria: [],
          maxAttempts: 1
        };
  });
}
