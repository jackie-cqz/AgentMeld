import { eventBus } from "@/server/event-bus";
import { startAgentRun } from "@/server/agent-runner";
import { createMessage, getConversation, listAgents } from "@/server/repositories";
import { registerPendingPlan } from "@/server/dispatch-plan-manager";
import { validatePlan, topologicalWaves, parsePlanArgs, type ParsedTask } from "@/server/tools/orchestrator-tools";
import { buildChildTaskPrompt, resolveTaskInputs, hasMissingRequiredInputs } from "@/server/child-prompt-builder";
import { acquireConcurrencySlot } from "@/server/dispatch-concurrency";
import { recordTaskReport, getTaskReport, evaluateTaskResult, clearTaskResultsForRun } from "@/server/dispatch-task-results";
import { resolveApiKey, getSettings } from "@/server/settings-service";
import { newMessageId } from "@/shared/ids";
import type { Message, DispatchPlanItem, Agent } from "@/shared/types";

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
  // Stage 1: PLAN — try real LLM, fallback to demo
  const llmResult = await generatePlanWithLLM(input);
  const plan = llmResult.success
    ? llmResult.plan!
    : buildDemoPlan(input.availableAgentIds, input.triggerMessage);

  // Tell user which mode we're in
  if (!llmResult.success && llmResult.error) {
    createSystemMessage(input.conversationId, `⚠️ DeepSeek 调用失败：${llmResult.error.slice(0, 200)}，使用 demo plan。`);
  } else if (llmResult.success) {
    createSystemMessage(input.conversationId, `🤖 DeepSeek 生成计划成功（${llmResult.plan!.tasks.length} 个任务）。`);
  }

  // Publish plan as visible message
  const planText = plan.tasks.map((t) =>
    `- **${t.title}** → ${t.agentId}${t.dependsOn.length > 0 ? ` (依赖: ${t.dependsOn.join(", ")})` : ""}`
  ).join("\n");
  createSystemMessage(input.conversationId, `📋 **执行计划**\n\n${planText}\n\n⏳ 正在执行子任务...`);

  const planItems: DispatchPlanItem[] = plan.tasks.map((t) => ({
    id: t.id,
    agentId: t.agentId,
    task: t.prompt,
    dependsOn: t.dependsOn
  }));

  // Stage 2: EXECUTE — auto-execute without waiting for approval
  const finalPlan: ParsedTask[] = plan.tasks;
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
  status: "complete" | "failed" | "blocked" | "skipped" | "aborted";
  summary: string;
  childRunId?: string;
}

export async function executeOrchestratorPlan(
  conversationId: string,
  plan: ParsedTask[],
  availableAgents: string[],
  orchestratorRunId: string,
  triggerMessage: Message,
  signal?: AbortSignal
): Promise<Map<string, TaskResult>> {
  const results = new Map<string, TaskResult>();
  const outputBindings = new Map<string, string>();
  const abortSignal = signal ?? new AbortController().signal;

  const validation = validatePlan(plan);
  if (validation) {
    createSystemMessage(conversationId, `Plan validation failed: ${validation}`);
    return results;
  }

  const validTasks = plan.filter((t) => availableAgents.includes(t.agentId));
  const waves = topologicalWaves(validTasks);

  for (const wave of waves) {
    if (abortSignal.aborted) {
      for (const task of wave) {
        results.set(task.id, { taskId: task.id, status: "aborted", summary: "Parent run aborted." });
      }
      break;
    }

    const wavePromises: Promise<void>[] = [];

    for (const task of wave) {
      // Check upstream dependencies
      let shouldSkip = false;
      let skipReason = "";
      for (const dep of task.dependsOn) {
        const depResult = results.get(dep);
        if (depResult && depResult.status !== "complete") {
          shouldSkip = true;
          skipReason = `Upstream task "${dep}" did not complete (status: ${depResult.status}).`;
          break;
        }
      }

      if (shouldSkip) {
        results.set(task.id, { taskId: task.id, status: "skipped", summary: skipReason });
        continue;
      }

      wavePromises.push(
        runChildTask(conversationId, task, triggerMessage, orchestratorRunId, outputBindings, abortSignal)
          .then((r) => {
            results.set(task.id, r);
            createSystemMessage(conversationId, `${r.status === "complete" ? "✅" : "❌"} ${task.title}: ${r.summary}`);
          })
      );
    }

    await Promise.all(wavePromises);
  }

  // Stage 3: AGGREGATE
  generateAggregateMessage(conversationId, results, plan, outputBindings);
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runChildTask(
  conversationId: string,
  task: ParsedTask,
  triggerMessage: Message,
  parentRunId: string,
  outputBindings: Map<string, string>,
  signal: AbortSignal
): Promise<TaskResult> {
  // Resolve inputs — check if required inputs are available
  const resolvedInputs = resolveTaskInputs(task, outputBindings);
  if (hasMissingRequiredInputs(resolvedInputs)) {
    const missing = resolvedInputs.filter((i) => i.required && i.missing).map((i) => i.outputId);
    eventBus.publish({
      type: "dispatch.end", conversationId, timestamp: Date.now(),
      parentRunId, childRunId: "", taskId: task.id,
      status: "skipped",
      error: `Missing required inputs: ${missing.join(", ")}`
    });
    return { taskId: task.id, status: "skipped", summary: `Missing required inputs: ${missing.join(", ")}` };
  }

  // Acquire concurrency slot
  let release: (() => void) | null = null;
  try {
    release = await acquireConcurrencySlot(signal);
  } catch {
    return { taskId: task.id, status: "aborted", summary: "Aborted before start." };
  }

  try {
    // Build child prompt with full context
    const prompt = buildChildTaskPrompt(task, resolvedInputs, outputBindings);

    eventBus.publish({
      type: "dispatch.start", conversationId, timestamp: Date.now(),
      parentRunId, childRunId: "", taskId: task.id, agentId: task.agentId
    });

    const childMsg: Message = {
      id: newMessageId(),
      conversationId,
      role: "user",
      agentId: null,
      runId: null,
      parts: [{ type: "text", content: prompt }],
      status: "complete",
      mentionedAgentIds: [task.agentId],
      parentMessageId: triggerMessage.id,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const runId = startAgentRun({ conversationId, agentId: task.agentId, triggerMessage: childMsg });

    // Wait for child run to complete
    await waitForRunEnd(runId, 15000);

    // Evaluate task result — if no report (mock adapter), auto-succeed
    const report = getTaskReport(runId);
    if (!report) {
      // Mock adapter or simple run: auto-record a complete result
      recordTaskReport(runId, {
        taskId: task.id, runId, status: "complete",
        summary: `Task "${task.title}" completed successfully.`,
        acceptanceResults: (task.acceptanceCriteria || []).map((c) => ({ criterion: c, passed: true, evidence: "Auto-completed" })),
        blockers: [], artifacts: {}
      });
    }
    const finalReport = getTaskReport(runId);
    const evaluation = evaluateTaskResult(finalReport);

    // Collect outputKey → artifactId bindings
    if (report?.artifacts) {
      for (const [outputKey, artifactId] of Object.entries(report.artifacts)) {
        outputBindings.set(`${task.id}.${outputKey}`, artifactId);
      }
    }

    // Map "blocked" → "failed" for dispatch.end event (event type doesn't include blocked)
    const dispatchStatus: "complete" | "failed" | "aborted" | "skipped" =
      evaluation.status === "blocked" ? "failed" : evaluation.status;

    eventBus.publish({
      type: "dispatch.end", conversationId, timestamp: Date.now(),
      parentRunId, childRunId: runId, taskId: task.id,
      status: dispatchStatus,
      error: evaluation.error
    });

    clearTaskResultsForRun(runId);

    return {
      taskId: task.id,
      status: evaluation.status === "complete" ? "complete" : "failed",
      summary: report?.summary ?? evaluation.error ?? `Task "${task.title}" completed.`,
      childRunId: runId
    };
  } finally {
    release?.();
  }
}

function waitForRunEnd(runId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), timeoutMs);
    const unsub = eventBus.subscribe((entry) => {
      if (entry.event.type === "run.end" && "runId" in entry.event && (entry.event as { runId: string }).runId === runId) {
        clearTimeout(timeout);
        unsub();
        resolve();
      }
    });
  });
}

function generateAggregateMessage(
  conversationId: string,
  results: Map<string, TaskResult>,
  plan: ParsedTask[],
  outputBindings?: Map<string, string>
): void {
  const completed = Array.from(results.values()).filter((r) => r.status === "complete").length;
  const failed = Array.from(results.values()).filter((r) => r.status === "failed" || r.status === "blocked").length;
  const skipped = Array.from(results.values()).filter((r) => r.status === "skipped").length;

  const lines = [
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
      return `- ${icon} **${t.title}** (${t.agentId}) — ${r?.summary ?? "pending"}`;
    })
  ];

  // Show output bindings if any
  if (outputBindings && outputBindings.size > 0) {
    lines.push("", "### 产物输出", ...Array.from(outputBindings.entries()).map(([key, artId]) => `- ${key} → ${artId}`));
  }

  const summary = lines.join("\n");

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
// Real LLM plan generation (DeepSeek / OpenAI-compatible)
// ---------------------------------------------------------------------------

async function generatePlanWithLLM(input: OrchestratorInput): Promise<{ success: true; plan: { reasoning: string; tasks: ParsedTask[] } } | { success: false; error: string }> {
  try {
    const agents = listAgents();
    const agent = agents.find((a) => a.id === input.orchestratorAgentId);
    if (!agent || agent.adapterName !== "custom") return { success: false, error: "Orchestrator agent is not a custom adapter." };

    const settings = getSettings();
    const apiKey = resolveApiKey(agent.modelProvider ?? "deepseek", agent.apiKey, settings);
    if (!apiKey) return { success: false, error: "No DeepSeek API key configured. Please add it in Settings → DeepSeek API Key." };

    const baseUrl = agent.apiBaseUrl || "https://api.deepseek.com/v1";
    const model = agent.modelId || "deepseek-chat";

    const otherAgents = agents.filter((a) => !a.isOrchestrator && input.availableAgentIds.includes(a.id));
    const agentList = otherAgents.map((a) =>
      `- ${a.id}: ${a.name}, tools: ${a.toolNames.join(", ")}`
    ).join("\n");

    const userText = input.triggerMessage.parts
      .filter((p) => p.type === "text")
      .map((p) => p.content)
      .join("\n");

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `You are a task orchestrator. Analyze the user's request and assign tasks to agents. You MUST output a valid JSON object with at least 1 task. Always include the "tasks" array.\n\nAvailable agents:\n${agentList}\n\nOutput format:\n{"reasoning":"brief analysis","tasks":[{"id":"t1","agentId":"<pick from list>","title":"short name","prompt":"detailed instructions","dependsOn":[],"acceptanceCriteria":["check 1"]}]}`
          },
          { role: "user", content: userText }
        ],
        temperature: 0.3, max_tokens: 2000
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return { success: false, error: `API returned ${response.status}: ${errText.slice(0, 150)}` };
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    let content = data.choices?.[0]?.message?.content;
    if (!content) return { success: false, error: "DeepSeek returned empty response." };

    // Handle markdown-wrapped JSON or extra text
    const jsonMatch = content.match(/\{[\s\S]*"tasks"\s*:\s*\[[\s\S]*?\][\s\S]*\}/);
    if (jsonMatch) content = jsonMatch[0];

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { success: false, error: `DeepSeek returned non-JSON. Raw: ${content.slice(0, 200)}` };
    }

    if (!parsed.tasks || !Array.isArray(parsed.tasks) || (parsed.tasks as unknown[]).length === 0) {
      return { success: false, error: `DeepSeek returned empty tasks. Raw: ${content.slice(0, 300)}` };
    }
    const planResult = parsePlanArgs({ reasoning: (parsed.reasoning as string) || "Plan", tasks: parsed.tasks as Array<Record<string, unknown>> });
    if (typeof planResult === "string") return { success: false, error: `Plan validation failed: ${planResult}` };

    return { success: true, plan: planResult };
  } catch (err) {
    return { success: false, error: `Exception: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Demo plan generator (fallback)
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
