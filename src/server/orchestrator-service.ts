import { eventBus } from "@/server/event-bus";
import { startAgentRun } from "@/server/agent-runner";
import { getAdapter } from "@/server/adapters/registry";
import type { AdapterInput } from "@/server/adapters/types";
import { createMessage, getConversation, getWorkspaceForConversation, listAgents } from "@/server/repositories";
import { registerPendingPlan } from "@/server/dispatch-plan-manager";
import { validatePlan, topologicalWaves, parsePlanArgs, type ParsedTask } from "@/server/tools/orchestrator-tools";
import { buildChildTaskPrompt, resolveTaskInputs, hasMissingRequiredInputs } from "@/server/child-prompt-builder";
import { acquireConcurrencySlot } from "@/server/dispatch-concurrency";
import { recordTaskReport, getTaskReport, clearTaskResultsForRun } from "@/server/dispatch-task-results";
import { compileDispatchPlan, validateDispatchPlan } from "@/server/dispatch-plan";
import { getFileWrites, clearFileWrites, detectWaveConflicts, type RunFileWrites } from "@/server/dispatch-file-writes";
import { evaluateChildTaskResult } from "@/server/task-result-report";
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
  // Stage 1: PLAN — with revise loop
  let reviewing = true;
  let revisionContext = "";

  while (reviewing) {
    // Generate plan (first time: original prompt; revise: with feedback)
    const effectiveUserText = revisionContext
      ? `${revisionContext}\n\n<original_request>\n${extractTextFromMessage(input.triggerMessage)}\n</original_request>`
      : extractTextFromMessage(input.triggerMessage);

    const llmResult = await generatePlanWithLLM(input, effectiveUserText);
    const plan = llmResult.success
      ? llmResult.plan!
      : buildDemoPlan(input.availableAgentIds, input.triggerMessage);

    // Tell user which mode
    if (!llmResult.success && llmResult.error) {
      createSystemMessage(input.conversationId, `⚠️ DeepSeek 调用失败：${llmResult.error.slice(0, 200)}，使用 demo plan。`);
    } else if (llmResult.success && !revisionContext) {
      createSystemMessage(input.conversationId, `🤖 DeepSeek 生成计划成功（${llmResult.plan!.tasks.length} 个任务）。`);
    } else if (llmResult.success) {
      createSystemMessage(input.conversationId, `🔄 根据反馈重新规划（${llmResult.plan!.tasks.length} 个任务）。`);
    }

    // Publish plan for review
    const planText = plan.tasks.map((t) =>
      `- **${t.title}** → ${t.agentId}${t.dependsOn.length > 0 ? ` (依赖: ${t.dependsOn.join(", ")})` : ""}`
    ).join("\n");
    createSystemMessage(input.conversationId, `📋 **执行计划**\n\n${planText}\n\n⏳ 等待审批...（点击上方卡片 approve / reject / revise）`);

    const planItems: DispatchPlanItem[] = plan.tasks.map((t) => ({
      id: t.id, agentId: t.agentId, task: t.prompt, dependsOn: t.dependsOn
    }));

    // Wait for user decision
    const result = await registerPendingPlan(input.conversationId, input.orchestratorRunId, planItems);

    if (!result.approved) {
      // REJECT
      createSystemMessage(input.conversationId, "❌ 计划已拒绝，Orchestrator 运行终止。");
      return;
    }

    if (result.revisedPlan) {
      // REVISE — user gave feedback, re-plan
      const feedback = result.revisedPlan.length > 0 ? result.revisedPlan[0].task : "请调整计划。";
      revisionContext = `用户对上一个计划的反馈：${feedback}\n请根据反馈重新规划任务。`;
      continue; // back to while loop, re-plan
    }

    // APPROVE — execute
    reviewing = false;
    createSystemMessage(input.conversationId, "✅ 计划已批准，正在执行子任务...");

    const finalPlan: ParsedTask[] = result.revisedPlan
      ? mergeRevisedPlan(plan.tasks, result.revisedPlan)
      : plan.tasks;

    await executeOrchestratorPlan(
      input.conversationId, finalPlan, input.availableAgentIds,
      input.orchestratorRunId, input.triggerMessage, input.orchestratorAgentId
    );
  }
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
  orchestratorAgentId: string,
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

  // Stage 3: AGGREGATE — with multi-round support
  const MAX_DISPATCH_ROUNDS = 2;
  let allResults = results;
  for (let round = 1; round <= MAX_DISPATCH_ROUNDS; round++) {
    const hasFailures = Array.from(allResults.values()).some((r) => r.status !== "complete" && r.status !== "skipped");
    if (!hasFailures) break;

    if (round < MAX_DISPATCH_ROUNDS) {
      // Retry failed tasks once
      createSystemMessage(conversationId, `🔄 第 ${round + 1} 轮：重试失败任务...`);
      const failedTasks = plan.filter((t) => {
        const r = allResults.get(t.id);
        return r && r.status === "failed";
      });
      for (const task of failedTasks) {
        const r = await runChildTask(conversationId, task, triggerMessage, orchestratorRunId, outputBindings, abortSignal);
        allResults.set(task.id, r);
      }
    }
  }

  // Code conflict detection — collect per-run file writes and check same-wave conflicts
  const runWrites: RunFileWrites[] = [];
  for (const [, result] of allResults) {
    if (result.childRunId) {
      const writes = getFileWrites(result.childRunId);
      if (writes.size > 0) {
        const task = plan.find((t) => t.id === result.taskId);
        runWrites.push({ taskId: result.taskId, agentId: task?.agentId ?? "", runId: result.childRunId, writes });
      }
    }
  }
  const conflicts = detectWaveConflicts(runWrites);
  if (conflicts.length > 0) {
    const conflictMsg = conflicts.map((c) => `- ${c.path}: ${c.contributors.join(", ")}`).join("\n");
    createSystemMessage(conversationId, `⚠️ 代码冲突检测：\n${conflictMsg}`);
  }

  await runAggregateStage(conversationId, plan, allResults, outputBindings, orchestratorAgentId, orchestratorRunId, triggerMessage, abortSignal);
  return allResults;
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

    // Retry loop — up to maxAttempts
    const maxAttempts = task.maxAttempts || 1;
    let finalRunId = "";
    let finalEvaluation = evaluateChildTaskResult(task, undefined);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptPrompt = attempt > 1
        ? `${prompt}\n\n[Retry ${attempt}/${maxAttempts}] Previous attempt failed: ${finalEvaluation.error ?? "unknown"}. Fix the issues and try again.`
        : prompt;

      const attemptMsg: Message = {
        id: newMessageId(), conversationId, role: "user", agentId: null, runId: null,
        parts: [{ type: "text", content: attemptPrompt }], status: "complete",
        mentionedAgentIds: [task.agentId], parentMessageId: triggerMessage.id,
        createdAt: Date.now(), updatedAt: Date.now()
      };

      const { runId: attemptRunId, promise } = startAgentRun({ conversationId, agentId: task.agentId, triggerMessage: attemptMsg, parentRunId });
      try {
        await promise;
      } catch {
        // Run failed — continue to evaluation
      }

      const report = getTaskReport(attemptRunId);
      finalEvaluation = evaluateChildTaskResult(task, report);
      finalRunId = attemptRunId;

      if (finalEvaluation.status === "complete") break;
    }

    const report = getTaskReport(finalRunId);
    const evaluation = finalEvaluation;

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
      parentRunId, childRunId: finalRunId, taskId: task.id,
      status: dispatchStatus,
      error: evaluation.error
    });

    clearTaskResultsForRun(finalRunId);

    return {
      taskId: task.id,
      status: evaluation.status === "complete" ? "complete" : "failed",
      summary: report?.summary ?? evaluation.error ?? `Task "${task.title}" completed.`,
      childRunId: finalRunId
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

function buildAggregatePrompt(
  conversationId: string,
  plan: ParsedTask[],
  results: Map<string, TaskResult>,
  outputBindings: Map<string, string>,
  triggerMessage: Message
): string {
  const userText = extractTextFromMessage(triggerMessage);
  const lines: string[] = [];

  lines.push(`<user_request>${userText}</user_request>`);
  lines.push("");
  lines.push("<task_results>");

  for (const task of plan) {
    const r = results.get(task.id);
    const status = r?.status ?? "unknown";
    lines.push(`  <result task="${task.id}" agent="${task.agentId}" status="${status}">`);

    if (r?.summary) {
      lines.push(`    <task_report status="${status}">`);
      lines.push(`      <summary>${escapeXml(r.summary)}</summary>`);
      lines.push(`    </task_report>`);
    }

    // Artifact bindings for this task
    for (const [key, artId] of outputBindings) {
      if (key.startsWith(`${task.id}.`)) {
        lines.push(`    <artifact id="${artId}" outputKey="${key}" />`);
      }
    }

    lines.push(`  </result>`);
  }

  lines.push("</task_results>");
  lines.push("");
  lines.push("请基于以上结果给用户输出最终总结消息。");

  return lines.join("\n");
}

async function runAggregateStage(
  conversationId: string,
  plan: ParsedTask[],
  results: Map<string, TaskResult>,
  outputBindings: Map<string, string>,
  orchestratorAgentId: string,
  orchestratorRunId: string,
  triggerMessage: Message,
  signal: AbortSignal
): Promise<void> {
  const agents = listAgents();
  const agent = agents.find((a) => a.id === orchestratorAgentId);
  if (!agent || agent.adapterName !== "custom") {
    // Fallback to template summary
    generateAggregateFallback(conversationId, results, plan, outputBindings);
    return;
  }

  const conversation = getConversation(conversationId);
  const workspace = getWorkspaceForConversation(conversationId);
  if (!conversation || !workspace) {
    generateAggregateFallback(conversationId, results, plan, outputBindings);
    return;
  }

  const settings = getSettings();
  const apiKey = resolveApiKey(agent.modelProvider ?? "deepseek", agent.apiKey, settings);
  if (!apiKey) {
    generateAggregateFallback(conversationId, results, plan, outputBindings);
    return;
  }

  // Build aggregate prompt
  const aggregateSystemPrompt = `${agent.systemPrompt}

## 当前阶段
你处于「聚合阶段」。所有子任务已执行完成（含成功与失败），结果在 user 消息中以 XML 给出。
请直接给用户输出一条总结消息：
- 简明列出完成 / 失败的任务
- 如果存在 failed / skipped / aborted 任务，必须明确说明整体未完成，不要把局部成功说成全部完成
- 用 <artifact_ref id="art_xxx"/> 形式引用关键产物（如果有）
- 给出明确的下一步建议
不要再调用 plan_tasks，不要把任务再次分派。`;

  const aggregateUserPrompt = buildAggregatePrompt(conversationId, plan, results, outputBindings, triggerMessage);

  // Tools: remove plan_tasks and ask_user
  const aggregateTools = agent.toolNames.filter((t) => t !== "plan_tasks" && t !== "ask_user");

  const adapterInput: AdapterInput = {
    conversationId,
    runId: orchestratorRunId,
    agent: { ...agent, toolNames: aggregateTools, systemPrompt: aggregateSystemPrompt },
    conversation,
    workspace,
    triggerMessage: { ...triggerMessage, parts: [{ type: "text", content: aggregateUserPrompt }] },
    recentMessages: [],
    toolNames: aggregateTools,
    systemPrompt: "",
    workspacePath: workspace.mode === "local" && workspace.boundPath ? workspace.boundPath : workspace.rootPath,
    apiKey
  };

  const adapter = getAdapter(agent.adapterName);

  // Consume aggregate stream — publish all events
  for await (const event of adapter.run(adapterInput, signal)) {
    eventBus.publish(event);
  }
}

function generateAggregateFallback(
  conversationId: string,
  results: Map<string, TaskResult>,
  plan: ParsedTask[],
  outputBindings?: Map<string, string>
): void {
  const completed = Array.from(results.values()).filter((r) => r.status === "complete").length;
  const failed = Array.from(results.values()).filter((r) => r.status === "failed" || r.status === "blocked").length;
  const skipped = Array.from(results.values()).filter((r) => r.status === "skipped").length;

  const lines = [
    "## Orchestrator 总结", "",
    "| 状态 | 数量 |", "|------|------|",
    `| ✅ 完成 | ${completed} |`, `| ❌ 失败 | ${failed} |`, `| ⏭️ 跳过 | ${skipped} |`,
    "", "### 任务详情",
    ...plan.map((t) => {
      const r = results.get(t.id);
      const icon = r?.status === "complete" ? "✅" : r?.status === "skipped" ? "⏭️" : "❌";
      return `- ${icon} **${t.title}** (${t.agentId}) — ${r?.summary ?? "pending"}`;
    })
  ];
  if (outputBindings && outputBindings.size > 0) {
    lines.push("", "### 产物输出", ...Array.from(outputBindings.entries()).map(([key, artId]) => `- ${key} → ${artId}`));
  }

  const message = createMessage({
    id: newMessageId(), conversationId, role: "agent",
    agentId: plan[0]?.agentId ?? "ag_orchestrator", runId: "",
    parts: [{ type: "text", content: lines.join("\n") }],
    status: "complete", now: Date.now()
  });
  eventBus.publish({ type: "message.added", conversationId, timestamp: Date.now(), message });
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function extractTextFromMessage(msg: Message): string {
  return msg.parts.filter((p) => p.type === "text").map((p) => p.content).join("\n").trim();
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

async function generatePlanWithLLM(input: OrchestratorInput, overrideText?: string): Promise<{ success: true; plan: { reasoning: string; tasks: ParsedTask[] } } | { success: false; error: string }> {
  try {
    const agents = listAgents();
    const agent = agents.find((a) => a.id === input.orchestratorAgentId);
    if (!agent || agent.adapterName !== "custom") return { success: false, error: "Orchestrator agent is not a custom adapter." };

    const conversation = getConversation(input.conversationId);
    const workspace = getWorkspaceForConversation(input.conversationId);
    if (!conversation || !workspace) return { success: false, error: "Conversation or workspace not found." };

    const settings = getSettings();
    const apiKey = resolveApiKey(agent.modelProvider ?? "deepseek", agent.apiKey, settings);
    if (!apiKey) return { success: false, error: "No DeepSeek API key configured." };

    const otherAgents = agents.filter((a) => !a.isOrchestrator && input.availableAgentIds.includes(a.id));
    const agentList = otherAgents.map((a) =>
      `- id: "${a.id}", name: "${a.name}", description: "${a.description}", capabilities: [${a.capabilities.join(", ")}], tools: [${a.toolNames.join(", ")}]`
    ).join("\n");

    const userText = overrideText ?? input.triggerMessage.parts
      .filter((p) => p.type === "text")
      .map((p) => p.content)
      .join("\n");

    const adapterInput: AdapterInput = {
      conversationId: input.conversationId,
      runId: input.orchestratorRunId,
      agent: {
        ...agent,
        toolNames: ["plan_tasks", "ask_user"], // Plan stage: only these tools
        systemPrompt: `You are a task orchestrator in a multi-agent system. You MUST call plan_tasks with a structured plan. Do NOT output JSON in plain text — use the plan_tasks tool.

## Available Agents
${agentList}

## Planning Rules
- Each task MUST have a unique id (t1, t2, ...).
- agentId MUST be one of the available agent IDs listed above.
- dependsOn lists task IDs that must finish BEFORE this task starts.
- Execution order ONLY follows dependsOn. Writing "do A first" in task text has NO effect.
- Tasks with NO dependsOn run IN PARALLEL. Only omit dependsOn for truly independent tasks.
- When unsure, prefer adding dependencies (serial is safer).
- Each task must be self-contained: the assigned agent does NOT see full group history.
- Do NOT declare expectedOutputs for text-only tasks. Use acceptanceCriteria instead.
- 1-3 well-structured tasks are usually better than many tiny ones.
- If a critical ambiguity blocks planning AND you can formulate 2-4 options, call ask_user first.`
      },
      conversation,
      workspace,
      triggerMessage: { ...input.triggerMessage, parts: [{ type: "text", content: userText }] },
      recentMessages: [],
      toolNames: ["plan_tasks", "ask_user"],
      systemPrompt: "",
      workspacePath: workspace.mode === "local" && workspace.boundPath ? workspace.boundPath : workspace.rootPath,
      apiKey
    };

    const adapter = getAdapter(agent.adapterName);
    const signal = AbortSignal.timeout(45000);

    // Stream events and capture plan_tasks tool call
    let capturedPlan: { reasoning: string; tasks: Array<Record<string, unknown>> } | null = null;
    for await (const event of adapter.run(adapterInput, signal)) {
      if (event.type === "tool.call" && "toolName" in event && (event as { toolName: string }).toolName === "plan_tasks") {
        const args = (event as { args: unknown }).args as { reasoning?: string; tasks?: Array<Record<string, unknown>> };
        if (args?.tasks && Array.isArray(args.tasks) && args.tasks.length > 0) {
          capturedPlan = { reasoning: args.reasoning || "Plan", tasks: args.tasks };
          break; // Stop consuming — plan_tasks is the terminator
        }
      }
    }

    if (!capturedPlan) {
      return { success: false, error: "Orchestrator LLM did not call plan_tasks. It may have replied in text instead of using the tool." };
    }

    const planResult = parsePlanArgs(capturedPlan);
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

interface FileConflict {
  path: string;
  contributors: string[];
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
