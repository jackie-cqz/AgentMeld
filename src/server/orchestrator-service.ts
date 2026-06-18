import { eventBus } from "@/server/event-bus";
import { startAgentRun } from "@/server/agent-runner";
import { consumeStream } from "@/server/consume-stream";
import { getAdapter } from "@/server/adapters/registry";
import type { AdapterInput } from "@/server/adapters/types";
import { createMessage, getConversation, getWorkspaceForConversation, listAgents, getArtifact, updateRunStage, persistOrchestrationTask } from "@/server/repositories";
import { registerPendingPlan } from "@/server/dispatch-plan-manager";
import { cancelPendingQuestionsForRun } from "@/server/pending-questions";
import { validatePlan, topologicalWaves, parsePlanArgs, type ParsedTask } from "@/server/tools/orchestrator-tools";
import { buildChildTaskPrompt, resolveTaskInputs, hasMissingRequiredInputs, type UpstreamArtifact } from "@/server/child-prompt-builder";
import { acquireConcurrencySlot } from "@/server/dispatch-concurrency";
import { recordTaskReport, getTaskReport, clearTaskResultsForRun } from "@/server/dispatch-task-results";
import { compileAndValidateDispatchPlan } from "@/server/dispatch-plan";
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
  /** messageId of the orchestrator's streaming response bubble, so events can target it */
  messageId: string;
}

export async function executeOrchestrator(input: OrchestratorInput): Promise<void> {
  // Stage 1: ASSESS — LLM decides whether this needs a plan or is a simple chat
  const userText = extractTextFromMessage(input.triggerMessage);
  const assessResult = await runOrchestratorAssess(input, userText);

  // Case A: Direct response — LLM answered directly (simple chat, greeting, question)
  if (assessResult.mode === "direct") {
    // Events were already streamed to the frontend via runOrchestratorAssess
    return;
  }

  // Case B: Plan required — proceed with approval → DAG → aggregate
  let plan = assessResult.plan!;
  let reviewing = true;
  let revisionContext = "";

  while (reviewing) {
    // If revising, re-run the assess with feedback
    if (revisionContext) {
      const effectiveText = `${revisionContext}\n\n<original_request>\n${userText}\n</original_request>`;
      const revised = await runOrchestratorAssess(input, effectiveText);
      if (revised.mode === "plan" && revised.plan) {
        plan = revised.plan;
      } else {
        createSystemMessage(input.conversationId, "⚠️ 重新规划失败，使用原计划继续。");
      }
    }

    // ── Layer 2: compileAndValidateDispatchPlan (code validation before approval) ──
    const validationResult = compileAndValidateDispatchPlan(
      plan.tasks,
      input.availableAgentIds,
      input.orchestratorAgentId
    );

    if (typeof validationResult === "string") {
      // Plan rejected — fail the run with clear error
      createSystemMessage(input.conversationId, `❌ Plan 校验失败：${validationResult}`);
      const errorMsg = `Plan validation failed: ${validationResult}`;
      eventBus.publish({
        type: "run.end", conversationId: input.conversationId, timestamp: Date.now(),
        runId: input.orchestratorRunId, status: "failed", error: errorMsg
      });
      return;
    }

    // Validated plan (compiled with auto-deps)
    const compiledPlan = validationResult;

    // Publish plan for review (use validated agent IDs)
    const planText = compiledPlan.map((t) =>
      `- **${t.id}** → ${t.agentId}${t.dependsOn.length > 0 ? ` (依赖: ${t.dependsOn.join(", ")})` : ""}`
    ).join("\n");
    createSystemMessage(input.conversationId, `📋 **执行计划**\n\n${planText}\n\n⏳ 等待审批...（点击上方卡片 approve / reject / revise）`);

    // Build DispatchPlanItem[] from validated compiledPlan
    const planItems: DispatchPlanItem[] = compiledPlan.map((t) => ({
      id: t.id,
      agentId: t.agentId,
      task: t.task,
      dependsOn: t.dependsOn,
      title: t.id,
      prompt: t.task,
      inputs: t.inputs,
      expectedOutputs: t.expectedOutputs,
      acceptanceCriteria: t.acceptanceCriteria,
      targetPaths: t.targetPaths,
      requiredCommands: t.requiredCommands,
      requiredEvidence: t.requiredEvidence
    }));

    const result = await registerPendingPlan(input.conversationId, input.orchestratorRunId, planItems);

    if (!result.approved) {
      createSystemMessage(input.conversationId, "❌ 计划已拒绝，Orchestrator 运行终止。");
      return;
    }

    if (result.feedback) {
      revisionContext = buildReviseContext(result.feedback);
      continue;
    }

    // APPROVE — execute with validated compiled plan
    reviewing = false;
    // Cancel any lingering ask_user questions from the PLAN stage
    cancelPendingQuestionsForRun(input.orchestratorRunId);
    createSystemMessage(input.conversationId, "✅ 计划已批准，正在执行子任务...");

    // Convert validated DispatchPlanItem[] back to ParsedTask[] for execution
    const finalPlan: ParsedTask[] = compiledPlan.map((t) => ({
      id: t.id,
      agentId: t.agentId,
      title: t.id,
      prompt: t.task,
      dependsOn: t.dependsOn,
      inputs: (t.inputs ?? []).map((i) => ({ ...i, required: true })),
      expectedOutputs: (t.expectedOutputs ?? []).map((o) => ({ ...o, required: true })),
      acceptanceCriteria: t.acceptanceCriteria ?? [],
      maxAttempts: 1,
      targetPaths: t.targetPaths,
      requiredCommands: t.requiredCommands,
      requiredEvidence: t.requiredEvidence
    } as ParsedTask));

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

/** Structured conflict info per P0 */
export interface StructuredConflict {
  path: string;
  contributors: Array<{ taskId: string; agentId: string; runId: string; hash: string }>;
  wave: number;
}

export type CompletionStatus = "all_complete" | "partial" | "recovered" | "has_failures";

export async function executeOrchestratorPlan(
  conversationId: string,
  plan: ParsedTask[],
  availableAgents: string[],
  orchestratorRunId: string,
  triggerMessage: Message,
  orchestratorAgentId: string,
  signal?: AbortSignal
): Promise<{ results: Map<string, TaskResult>; completionStatus: CompletionStatus; conflicts: StructuredConflict[] }> {
  const results = new Map<string, TaskResult>();
  const outputBindings = new Map<string, string>();
  const allConflicts: StructuredConflict[] = [];
  const abortSignal = signal ?? new AbortController().signal;

  const validation = validatePlan(plan, availableAgents);
  if (validation) {
    createSystemMessage(conversationId, `Plan validation failed: ${validation}`);
    return { results, completionStatus: "has_failures", conflicts: [] };
  }

  const validTasks = plan.filter((t) => availableAgents.includes(t.agentId));
  const waves = topologicalWaves(validTasks);

  // ── Stage 1: DISPATCH — execute waves with per-wave conflict detection ──
  updateRunStage(orchestratorRunId, "dispatch", Date.now());
  publishDispatchPlan(conversationId, orchestratorRunId, validTasks);

  for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
    const wave = waves[waveIndex];
    if (abortSignal.aborted) {
      for (const task of wave) {
        results.set(task.id, { taskId: task.id, status: "aborted", summary: "Parent run aborted." });
      }
      break;
    }

    // Filter: skip tasks whose upstream dependencies failed/were blocked
    const wavePromises: Promise<void>[] = [];
    for (const task of wave) {
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
        // Publish skip event for skipped dependencies
        eventBus.publish({
          type: "dispatch.task.end", conversationId, timestamp: Date.now(),
          parentRunId: orchestratorRunId, childRunId: "", taskId: task.id,
          agentId: task.agentId, status: "skipped", error: skipReason
        });
        continue;
      }

      wavePromises.push(
        runChildTask(conversationId, task, triggerMessage, orchestratorRunId, outputBindings, abortSignal)
          .then((r) => {
            results.set(task.id, r);
            createSystemMessage(conversationId, `${r.status === "complete" ? "✅" : "❌"} ${task.title}: ${r.summary}`);
            // P1: Persist task result to DB
            persistOrchestrationTask({
              id: `${orchestratorRunId}_${task.id}`,
              orchestratorRunId,
              conversationId,
              taskId: task.id,
              agentId: task.agentId,
              title: task.title,
              status: r.status,
              summary: r.summary,
              childRunId: r.childRunId ?? null,
              attempt: 1,
              now: Date.now()
            });
          })
      );
    }

    await Promise.all(wavePromises);

    // P0.1: Per-wave conflict detection — immediately after wave completes
    const waveRunWrites: RunFileWrites[] = [];
    for (const task of wave) {
      const r = results.get(task.id);
      if (r?.childRunId) {
        const writes = getFileWrites(r.childRunId);
        if (writes.size > 0) {
          waveRunWrites.push({ taskId: task.id, agentId: task.agentId, runId: r.childRunId, writes });
        }
      }
    }

    const waveConflicts = detectWaveConflicts(waveRunWrites);
    if (waveConflicts.length > 0) {
      // P0.2: Build structured conflict results
      const structuredConflicts: StructuredConflict[] = waveConflicts.map((c) => ({
        path: c.path,
        contributors: c.contributors.map((w) => {
          const t = wave.find((x) => x.id === w.taskId);
          const writes = waveRunWrites.find((rw) => rw.runId === w.runId);
          const hash = writes?.writes.get(c.path) ?? "unknown";
          return { taskId: w.taskId, agentId: w.agentId, runId: w.runId, hash };
        }),
        wave: waveIndex
      }));
      allConflicts.push(...structuredConflicts);

      // P0.3: Mark conflicting tasks as blocked, prevent downstream
      const conflictTaskIds = new Set(waveConflicts.flatMap((c) => c.contributors.map((w) => w.taskId)));
      for (const taskId of conflictTaskIds) {
        const existing = results.get(taskId);
        if (existing && existing.status === "complete") {
          results.set(taskId, {
            ...existing,
            status: "blocked",
            summary: `File conflict detected: another task in the same wave wrote to the same file with different content. ${existing.summary}`
          });
        }
      }

      const conflictMsg = waveConflicts.map((c) =>
        `- ${c.path}: ${c.contributors.map((w) => w.taskId).join(", ")}`
      ).join("\n");
      createSystemMessage(conversationId, `⚠️ Wave ${waveIndex} 文件冲突：\n${conflictMsg}`);
    }

    // Clean up file writes for this wave's tasks
    for (const task of wave) {
      const r = results.get(task.id);
      if (r?.childRunId) clearFileWrites(r.childRunId);
    }
  }

  // ── Stage 2: RECOVERY — LLM-driven re-plan for failures ──
  updateRunStage(orchestratorRunId, "recovery", Date.now());
  let recovered = false;
  const hasFailures = Array.from(results.values()).some(
    (r) => r.status === "failed" || r.status === "blocked"
  );

  if (hasFailures && !abortSignal.aborted) {
    createSystemMessage(conversationId, "🔄 检测到失败任务，尝试生成恢复计划...");

    // P0.5: Build replan context from failures, conflicts, and missing artifacts
    const replanContext = buildReplanContext(plan, results);
    const conflictSummary = allConflicts.length > 0
      ? `\n文件冲突：\n${allConflicts.map((c) => `- ${c.path} (wave ${c.wave}): ${c.contributors.map((w) => w.taskId).join(", ")}`).join("\n")}`
      : "";

    const recoveryPrompt = `${replanContext}${conflictSummary}\n\n<original_request>\n${extractTextFromMessage(triggerMessage)}\n</original_request>\n\n请生成只包含修复任务的新计划。已成功的任务不需要重新执行。`;

    // Use the orchestrator to generate a recovery plan
    try {
      const recoveryResult = await generateRecoveryPlan(
        conversationId, orchestratorAgentId, orchestratorRunId,
        recoveryPrompt, plan, results, abortSignal
      );

      if (recoveryResult && recoveryResult.tasks.length > 0) {
        createSystemMessage(conversationId, `🔧 恢复计划：${recoveryResult.tasks.length} 个修复任务`);

        // Execute recovery tasks — they can depend on already-completed tasks
        const recoveryWaves = topologicalWaves(recoveryResult.tasks.filter((t) => availableAgents.includes(t.agentId)));
        for (const wave of recoveryWaves) {
          if (abortSignal.aborted) break;
          const recoveryPromises = wave.map((task) =>
            runChildTask(conversationId, task, triggerMessage, orchestratorRunId, outputBindings, abortSignal)
              .then((r) => {
                results.set(task.id, r);
                createSystemMessage(conversationId, `${r.status === "complete" ? "✅" : "❌"} [恢复] ${task.title}: ${r.summary}`);
                // P1: Persist recovery task result
                persistOrchestrationTask({
                  id: `${orchestratorRunId}_${task.id}`,
                  orchestratorRunId,
                  conversationId,
                  taskId: task.id,
                  agentId: task.agentId,
                  title: task.title,
                  status: r.status,
                  summary: r.summary,
                  childRunId: r.childRunId ?? null,
                  attempt: 1,
                  now: Date.now()
                });
              })
          );
          await Promise.all(recoveryPromises);
        }
        recovered = true;
      }
    } catch {
      createSystemMessage(conversationId, "⚠️ 恢复计划生成失败，将使用已有结果进行聚合。");
    }
  }

  // ── Stage 3: AGGREGATE — accurate completion status ──
  updateRunStage(orchestratorRunId, "aggregate", Date.now());
  const completionStatus = determineCompletionStatus(results, recovered);

  await runAggregateStage(
    conversationId, plan, results, outputBindings,
    orchestratorAgentId, orchestratorRunId, triggerMessage,
    completionStatus, abortSignal
  );

  return { results, completionStatus, conflicts: allConflicts };
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
        // Build upstream artifact references
    const upstreamArtifacts: UpstreamArtifact[] = [];
    for (const ri of resolvedInputs) {
      if (ri.artifactId) {
        const art = getArtifact(ri.artifactId);
        if (art) {
          upstreamArtifacts.push({ id: art.id, type: art.type, title: art.title, version: art.version });
        }
      }
    }
    for (const [, artId] of outputBindings) {
      if (!upstreamArtifacts.some((a) => a.id === artId)) {
        const art = getArtifact(artId);
        if (art) {
          upstreamArtifacts.push({ id: art.id, type: art.type, title: art.title, version: art.version });
        }
      }
    }

    // Build recent conversation snippet
    const recentConversation: Array<{ from: string; content: string }> = [];
    const userText = extractTextFromMessage(triggerMessage);
    if (userText) {
      recentConversation.push({ from: "user", content: userText });
    }

    // Build child prompt with full context
    const prompt = buildChildTaskPrompt({
      task,
      resolvedInputs,
      upstreamArtifacts,
      recentConversation
    });

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
        ? buildContinuationPrompt(prompt, attempt, maxAttempts, finalEvaluation.error ?? "unknown")
        : prompt;

      const attemptMsg: Message = {
        id: newMessageId(), conversationId, role: "user", agentId: null, runId: null,
        parts: [{ type: "text", content: attemptPrompt }], status: "complete",
        mentionedAgentIds: [task.agentId], parentMessageId: triggerMessage.id,
        createdAt: Date.now(), updatedAt: Date.now()
      };

      // P1.4: Publish task.start with attempt number
      eventBus.publish({
        type: "dispatch.task.start",
        conversationId,
        timestamp: Date.now(),
        parentRunId,
        childRunId: "",
        taskId: task.id,
        agentId: task.agentId,
        attempt
      });

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

    // P1.5: Strict output handoff — verify reported artifacts exist in DB
    if (report?.artifacts) {
      for (const [outputKey, artifactId] of Object.entries(report.artifacts)) {
        const art = getArtifact(artifactId);
        if (art && art.conversationId === conversationId) {
          outputBindings.set(`${task.id}.${outputKey}`, artifactId);
        }
        // Invalid or missing artifacts are silently dropped — downstream will see missing input
      }
    }

    // P1.4: Map "blocked" → "failed" for dispatch.end event
    const dispatchStatus: "complete" | "failed" | "aborted" | "skipped" =
      evaluation.status === "blocked" ? "failed" : evaluation.status;

    // P1.4: Publish task.end with agentId
    eventBus.publish({
      type: "dispatch.task.end",
      conversationId,
      timestamp: Date.now(),
      parentRunId,
      childRunId: finalRunId,
      taskId: task.id,
      agentId: task.agentId,
      status: dispatchStatus,
      error: evaluation.error
    });

    // Legacy dispatch.end — keep for backward compatibility
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
  completionStatus: CompletionStatus,
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

  // Build aggregate prompt with completion status
  const statusLabel =
    completionStatus === "all_complete" ? "全部完成 ✅" :
    completionStatus === "recovered" ? "已修复完成 🔧" :
    completionStatus === "partial" ? "部分完成 ⚠️" :
    "仍有失败 ❌";
  const { systemPrompt: baseSystem, userPrompt: aggregateUserPrompt } =
    buildOrchestratorAggregatePrompt(agent, plan, results, outputBindings, triggerMessage, conversationId);
  const aggregateSystemPrompt = `${baseSystem}\n\n## 执行结果\n整体状态：${statusLabel}${completionStatus === "has_failures" ? "\n请明确说明整体未完成，不要把局部成功说成全部完成。" : ""}`;

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

  // Consume aggregate stream — events published directly (aggregate output is self-contained)
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
// Orchestrator assess — flexible LLM call that can produce direct response OR plan
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompt builders — independent, testable pure functions
// ---------------------------------------------------------------------------

/** Tools available to the Orchestrator during the PLAN (assess) stage only */
export const ORCHESTRATOR_PLAN_TOOLS = [
  "plan_tasks",
  "ask_user",
  "read_artifact",
  "read_attachment",
  "fs_list",
  "fs_read"
] as const;

/**
 * Build the complete system prompt for the Orchestrator's PLAN (assess) stage.
 * Four blocks per message-flow-with-prompts-new.md §LLM 调用 #1:
 *   1. Workspace context
 *   2. Orchestrator persona
 *   3. PLAN dynamic instructions (workflow + agents + decomposition + dependencies + example)
 *   4. Tool guidance (cut-down: plan_tasks, ask_user, read_artifact, read_attachment, fs_list, fs_read)
 */
export function buildOrchestratorPlanPrompt(
  agent: Agent,
  otherAgents: Agent[],
  workspacePath: string
): string {
  const agentList = otherAgents.length > 0
    ? otherAgents.map((a) =>
        `- { id: "${a.id}", name: "${a.name}", capabilities: [${a.capabilities.join(", ")}], tools: [${a.toolNames.join(", ")}], description: "${a.description}" }`
      ).join("\n")
    : "(无其他可用 Agent)";

  const blocks: string[] = [];

  // Block 1: Workspace context
  blocks.push(`<workspace_info>
  <cwd>${workspacePath}</cwd>
  <mode>sandbox</mode>
  <note>
    This is an isolated sandbox directory. Files you write here are only visible
    inside this conversation.
  </note>
</workspace_info>`);

  // Block 2: Orchestrator persona
  blocks.push(agent.systemPrompt);

  // Block 3: PLAN dynamic instructions
  blocks.push(`## 你的工作流
1. 阅读用户最新请求与上下文。
2. 如果存在会阻塞正确规划的关键歧义，且能归纳为 2-4 个清晰选项，
   先调用 ask_user 让用户选择；拿到答案后继续。
3. 调用 plan_tasks 工具，输出结构化 plan。
4. 系统会自动执行 plan 并把子任务结果回传给你，由你做最终总结。

## 可用 Agent

${agentList}

## 🚫 agentId 严格规则（违反将直接报错）
agentId 字段只能填写上面「可用 Agent」列表里出现的 id 值，一个字符都不能改。

正确示例：
  "agentId": "ag_mock_builder"   ← 这是列表里「前端工程师」的真实 id
  "agentId": "ag_pm"             ← 这是列表里「PM 小灰」的真实 id

错误示例（系统会拒绝，不要这样写）：
  "agentId": "web_dev"           ← ❌ 列表中不存在
  "agentId": "app_developer"     ← ❌ 列表中不存在
  "agentId": "frontend"          ← ❌ 列表中不存在
  "agentId": "developer"         ← ❌ 列表中不存在
  "agentId": "coder"             ← ❌ 列表中不存在

Agent 名称只是给人看的描述，agentId 才是系统识别的唯一标识。你必须到上面列表里找到匹配的 Agent，复制它的 id 字段的值。

## 拆解原则
- 充分利用每个 Agent 的 capabilities，不要把任务派给不合适的人。
- 每个子任务必须独立可执行（被分派的 Agent 看不到完整群聊上下文，
  必要上下文要写进 task）。
- 计划阶段只能调用 ask_user、plan_tasks 和只读侦察工具
  （fs_list / fs_read / read_artifact / read_attachment）；不要写文件或执行命令。
- 若用户需求已足够明确，不要为了形式感提问，直接 plan_tasks。

## 依赖关系（执行顺序的唯一来源，务必读完）
- 系统【只】按每个任务的 dependsOn 决定顺序：
  dependsOn 为空的任务会【同时并发】启动。
- 若任务 B 需要任务 A 的产物 / 结论 / 输出，
  你【必须】在 B 的 dependsOn 里写上 A 的 id。
- 在 task 文本里写「先做 A」「基于上一步」之类【没有任何效果】
  ——执行顺序只认 dependsOn 字段。
- 只有彼此真正无关、可同时进行的任务才留空 dependsOn；
  拿不准时倾向加依赖（串行更安全）。
- Only declare expectedOutputs when the assigned agent must create a real artifact
  via write_artifact for downstream handoff or user inspection.
- Do NOT declare expectedOutputs for text-only tasks such as review, validation,
  diagnosis, status check, explanation, or summary.
- If a task needs an upstream artifact, declare inputs with fromTaskId and outputId.
- For tasks with quality requirements, add concise acceptanceCriteria.

示例（设计 → 前端 → 审查，逐级依赖；agentId 用上面可用列表里的真实 id）：
tasks: [
  { "id": "t1", "agentId": "<设计师 id>", "task": "产出 UI 设计稿" },
  { "id": "t2", "agentId": "<前端 id>", "task": "按设计稿实现页面",
    "dependsOn": ["t1"] },
  { "id": "t3", "agentId": "<Reviewer id>", "task": "审查 t2 的实现",
    "dependsOn": ["t2"] }
]`);

  // Block 4: Tool guidance (cut-down for PLAN stage — no fs_write, no bash)
  blocks.push(buildPlanStageToolGuidance());

  return blocks.join("\n");
}

/** Tool guidance for PLAN stage only — covers just the 6 allowed tools */
function buildPlanStageToolGuidance(): string {
  const lines: string[] = ["\n## AgentHub 工具调用规范"];
  lines.push("- 需要调用工具时，必须用工具调用通道提交结构化参数，不要把 JSON 示例写进普通回复里假装调用。");
  lines.push("- 字段名必须严格使用工具 schema 里的 camelCase。");
  lines.push("- 不要编造 artifactId、attachmentId、outputKey、文件路径；只能使用上下文里明确给出的 id / 路径。");
  lines.push("- 工具返回 ok:false 或 isError=true 时，先根据错误修正参数；不要继续基于失败结果推进。");

  lines.push("\n### plan_tasks");
  lines.push("用途：Orchestrator 用结构化计划拆分子任务；执行顺序只认 dependsOn 字段。");
  lines.push("正确案例：t2.dependsOn=[\"t1\"]，不要只在 task 文本里写\"基于 t1\"。");
  lines.push("只在确实需要多 Agent 协作时调用此工具——简单对话直接文字回复即可。");

  lines.push("\n### ask_user");
  lines.push("用途：当继续执行前需要用户在有限方案中选择时，发起结构化问答；不要只在普通文本里问。");
  lines.push("正确案例：产品范围不清，调用 ask_user({ questions: [...] })。");
  lines.push("参数规则：每次 1-4 个 questions，每题 2-4 个 options。");
  lines.push("不要滥用：开放式讨论、非关键细节、或可以保守决策时，直接说明假设并继续。");

  lines.push("\n### read_artifact");
  lines.push("用途：需要基于已有产物继续设计、实现、审查或修改时，先读取完整产物内容。");
  lines.push("正确案例：read_artifact({ artifactId: \"art_123\" })。");
  lines.push("常见错误：传 { id: \"art_123\" } 或把 att_* 附件 id 传给 read_artifact。");

  lines.push("\n### read_attachment");
  lines.push("用途：用户上传了文本/文件附件且任务依赖附件内容时，先读取附件；不要只凭文件名猜测。");
  lines.push("常见错误：传 { id: \"att_123\" }；附件用 read_attachment，产物用 read_artifact。");

  lines.push("\n### fs_list / fs_read");
  lines.push("用途：探索 workspace 目录结构和读取文本文件。只读侦察，不能修改。");
  lines.push("fs_list 正确案例：fs_list({ path: \"\" }) 查看根目录。");
  lines.push("fs_read 正确案例：fs_read({ path: \"src/app/page.tsx\" })，上限 1MB / 截断到 50K 字符。");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Prompt builders — P6: Aggregate prompt & P7: Replan / Revise / Continuation
// ---------------------------------------------------------------------------

/**
 * Build the system + user prompts for the Orchestrator's AGGREGATE stage.
 * Extracted from runAggregateStage.
 */
export function buildOrchestratorAggregatePrompt(
  agent: Agent,
  plan: ParsedTask[],
  results: Map<string, TaskResult>,
  outputBindings: Map<string, string>,
  triggerMessage: Message,
  conversationId: string
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `${agent.systemPrompt}

## 当前阶段
你处于「聚合阶段」。所有子任务已执行完成（含成功与失败），结果在 user 消息中以 XML 给出。
请直接给用户输出一条总结消息：
- 简明列出完成 / 失败的任务
- 如果存在 failed / skipped / aborted 任务，必须明确说明整体未完成，不要把局部成功说成全部完成
- 用 <artifact_ref id="art_xxx"/> 形式引用关键产物（如果有）
- 给出明确的下一步建议
不要再调用 plan_tasks，不要把任务再次分派。`;

  const userPrompt = buildAggregatePrompt(conversationId, plan, results, outputBindings, triggerMessage);
  return { systemPrompt, userPrompt };
}

/**
 * Build context for re-planning after a round of failed tasks.
 * Used in multi-round retry within executeOrchestratorPlan.
 */
export function buildReplanContext(
  plan: ParsedTask[],
  results: Map<string, TaskResult>
): string {
  const failedTasks = plan.filter((t) => {
    const r = results.get(t.id);
    return r && r.status === "failed";
  });

  const summary = failedTasks.map((t) => {
    const r = results.get(t.id);
    return `- ${t.id} (${t.title}): ${r?.summary ?? "unknown error"}`;
  }).join("\n");

  return `上一轮以下任务失败：\n${summary}\n\n补救指示：为失败任务修正参数后重试。`;
}

/**
 * Build revision context when the user provides feedback on a plan.
 * Used in executeOrchestrator's revise loop.
 */
export function buildReviseContext(feedback: string): string {
  return `用户对上一个计划的反馈：${feedback}\n请根据反馈重新规划任务。`;
}

/**
 * Build a retry prompt for a child task attempt.
 * Used in runChildTask's retry loop.
 */
export function buildContinuationPrompt(
  basePrompt: string,
  attempt: number,
  maxAttempts: number,
  lastError: string
): string {
  return `${basePrompt}\n\n[Retry ${attempt}/${maxAttempts}] Previous attempt failed: ${lastError}. Fix the issues and try again.`;
}

type AssessResult =
  | { mode: "direct" }
  | { mode: "plan"; plan: { reasoning: string; tasks: ParsedTask[] } };

async function runOrchestratorAssess(
  input: OrchestratorInput,
  userText: string
): Promise<AssessResult> {
  const agents = listAgents();
  const agent = agents.find((a) => a.id === input.orchestratorAgentId);
  if (!agent || agent.adapterName !== "custom") {
    const demoPlan = buildDemoPlan(input.availableAgentIds, input.triggerMessage);
    return { mode: "plan", plan: demoPlan };
  }

  const conversation = getConversation(input.conversationId);
  const workspace = getWorkspaceForConversation(input.conversationId);
  if (!conversation || !workspace) {
    const demoPlan = buildDemoPlan(input.availableAgentIds, input.triggerMessage);
    return { mode: "plan", plan: demoPlan };
  }

  const settings = getSettings();
  const apiKey = resolveApiKey(agent.modelProvider ?? "deepseek", agent.apiKey, settings);
  if (!apiKey) {
    const demoPlan = buildDemoPlan(input.availableAgentIds, input.triggerMessage);
    return { mode: "plan", plan: demoPlan };
  }

  const otherAgents = agents.filter((a) => !a.isOrchestrator && input.availableAgentIds.includes(a.id));
  const workspacePath = workspace.mode === "local" && workspace.boundPath
    ? workspace.boundPath : workspace.rootPath;

  // Build the PLAN stage system prompt from the extracted pure function
  const assessSystemPrompt = buildOrchestratorPlanPrompt(agent, otherAgents, workspacePath);
  const assessToolNames = [...ORCHESTRATOR_PLAN_TOOLS];

  const adapterInput: AdapterInput = {
    conversationId: input.conversationId,
    runId: input.orchestratorRunId,
    agent: { ...agent, toolNames: assessToolNames, systemPrompt: assessSystemPrompt },
    conversation,
    workspace,
    triggerMessage: { ...input.triggerMessage, parts: [{ type: "text", content: userText }] },
    recentMessages: [],
    toolNames: assessToolNames,
    systemPrompt: "",
    workspacePath,
    apiKey
  };

  const adapter = getAdapter(agent.adapterName);
  const signal = AbortSignal.timeout(60000);

  // Stream events AND watch for plan_tasks via onEvent callback
  // We capture on tool.result (success) rather than tool.call, because the tool handler
  // may auto-correct agent IDs before returning success.
  let capturedPlanArgs: { reasoning?: string; tasks?: Array<Record<string, unknown>> } | null = null;
  let capturedPlan: { reasoning: string; tasks: Array<Record<string, unknown>> } | null = null;
  let planCallId: string | null = null;
  let planWasAttempted = false;

  try {
    await consumeStream({
      stream: adapter.run(adapterInput, signal),
      messageId: input.messageId,
      runId: input.orchestratorRunId,
      signal,
      onEvent: (event) => {
        // Remember plan_tasks call args
        if (
          event.type === "tool.call" &&
          "toolName" in event &&
          (event as { toolName: string }).toolName === "plan_tasks"
        ) {
          const args = (event as { args: unknown }).args as { reasoning?: string; tasks?: Array<Record<string, unknown>> };
          if (args?.tasks && Array.isArray(args.tasks) && args.tasks.length > 0) {
            capturedPlanArgs = args;
            planCallId = (event as { callId: string }).callId;
            planWasAttempted = true;
          }
        }

        // When plan_tasks tool.result arrives with success, capture and stop
        if (
          event.type === "tool.result" &&
          "callId" in event &&
          (event as { callId: string }).callId === planCallId &&
          capturedPlanArgs &&
          !(event as { isError?: boolean }).isError
        ) {
          capturedPlan = { reasoning: capturedPlanArgs.reasoning || "Plan", tasks: capturedPlanArgs.tasks! };
          return { stop: true };
        }

        // If plan_tasks failed, clear capture so LLM can retry
        if (
          event.type === "tool.result" &&
          "callId" in event &&
          (event as { callId: string }).callId === planCallId &&
          (event as { isError?: boolean }).isError
        ) {
          capturedPlanArgs = null;
          planCallId = null;
        }
      }
    });
  } catch (err) {
    // If we already captured a plan, the error after capture is irrelevant
    if (capturedPlan) {
      // proceed to plan validation below
    } else {
      // Stream error without a plan — fall back to demo plan
      const errorMsg = err instanceof Error ? err.message : String(err);
      createSystemMessage(input.conversationId, `⚠️ Orchestrator 调用失败：${errorMsg.slice(0, 200)}`);
      const demoPlan = buildDemoPlan(input.availableAgentIds, input.triggerMessage);
      return { mode: "plan", plan: demoPlan };
    }
  }

  // If plan_tasks was captured, validate and return plan mode
  if (capturedPlan) {
    const planResult = parsePlanArgs(capturedPlan);
    if (typeof planResult === "string") {
      createSystemMessage(input.conversationId, `⚠️ Plan 校验失败：${planResult}，使用 demo plan`);
      const demoPlan = buildDemoPlan(input.availableAgentIds, input.triggerMessage);
      return { mode: "plan", plan: demoPlan };
    }
    return { mode: "plan", plan: planResult };
  }

  // Plan was attempted but failed → fall back to demo plan
  if (planWasAttempted) {
    const demoPlan = buildDemoPlan(input.availableAgentIds, input.triggerMessage);
    return { mode: "plan", plan: demoPlan };
  }

  // No plan_tasks detected → LLM responded directly (simple chat)
  return { mode: "direct" };
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

// ---------------------------------------------------------------------------
// P0 helpers: dispatch, recovery, completion status
// ---------------------------------------------------------------------------

function publishDispatchPlan(conversationId: string, orchestratorRunId: string, tasks: ParsedTask[]): void {
  const planItems: DispatchPlanItem[] = tasks.map((t) => ({
    id: t.id, agentId: t.agentId, task: t.prompt, dependsOn: t.dependsOn,
    title: t.title, prompt: t.prompt, inputs: t.inputs, expectedOutputs: t.expectedOutputs,
    acceptanceCriteria: t.acceptanceCriteria, maxAttempts: t.maxAttempts,
    targetPaths: t.targetPaths, requiredCommands: t.requiredCommands, requiredEvidence: t.requiredEvidence
  }));
  eventBus.publish({
    type: "dispatch.plan", conversationId, timestamp: Date.now(),
    runId: orchestratorRunId, plan: planItems
  });
}

/**
 * Generate a recovery plan using the Orchestrator LLM.
 * Only includes fix/replacement tasks; already-successful tasks are preserved.
 */
async function generateRecoveryPlan(
  conversationId: string,
  orchestratorAgentId: string,
  orchestratorRunId: string,
  recoveryPrompt: string,
  originalPlan: ParsedTask[],
  results: Map<string, TaskResult>,
  signal: AbortSignal
): Promise<{ reasoning: string; tasks: ParsedTask[] } | null> {
  const agents = listAgents();
  const agent = agents.find((a) => a.id === orchestratorAgentId);
  if (!agent || agent.adapterName !== "custom") return null;

  const conversation = getConversation(conversationId);
  const workspace = getWorkspaceForConversation(conversationId);
  if (!conversation || !workspace) return null;

  const settings = getSettings();
  const apiKey = resolveApiKey(agent.modelProvider ?? "deepseek", agent.apiKey, settings);
  if (!apiKey) return null;

  const otherAgents = agents.filter((a) => !a.isOrchestrator);
  const workspacePath = workspace.mode === "local" && workspace.boundPath
    ? workspace.boundPath : workspace.rootPath;

  const systemPrompt = `${agent.systemPrompt}

## 当前阶段
你处于「恢复阶段」。上一轮执行中部分任务失败，你需要生成一个修复计划。
- 已成功的任务不需要重新执行。
- 只生成需要修复或替换的任务。
- 修复任务可以使用已有的成功任务作为上游依赖。
- 每个修复任务必须独立可执行。

## 可用 Agent

${otherAgents.map((a) => `- id: "${a.id}", name: "${a.name}", capabilities: [${a.capabilities.join(", ")}]`).join("\n")}

## 🚫 agentId 严格规则
agentId 只能填上面列表里的真实 id 值。❌ 禁止编造：web_dev, app_developer, frontend, developer, coder 等都不在列表中。

## 约束
- 每个任务必须有唯一的 id（使用 r1, r2, ... 避免与原始 t1, t2 冲突）
- dependsOn 可以引用原始任务 id（t1, t2, ...）或修复任务 id（r1, r2, ...）`;

  const adapterInput: AdapterInput = {
    conversationId,
    runId: orchestratorRunId,
    agent: { ...agent, toolNames: ["plan_tasks"], systemPrompt },
    conversation,
    workspace,
    triggerMessage: { id: "", conversationId, role: "user", agentId: null, runId: null,
      parts: [{ type: "text", content: recoveryPrompt }], status: "complete",
      mentionedAgentIds: [], parentMessageId: null, createdAt: Date.now(), updatedAt: Date.now() },
    recentMessages: [],
    toolNames: ["plan_tasks"],
    systemPrompt: "",
    workspacePath,
    apiKey
  };

  const adapter = getAdapter(agent.adapterName);
  let capturedPlan: { reasoning: string; tasks: Array<Record<string, unknown>> } | null = null;

  try {
    for await (const event of adapter.run(adapterInput, signal)) {
      if (
        event.type === "tool.call" &&
        "toolName" in event &&
        (event as { toolName: string }).toolName === "plan_tasks"
      ) {
        const args = (event as { args: unknown }).args as { reasoning?: string; tasks?: Array<Record<string, unknown>> };
        if (args?.tasks && Array.isArray(args.tasks) && args.tasks.length > 0) {
          capturedPlan = { reasoning: args.reasoning || "Recovery", tasks: args.tasks };
          break;
        }
      }
    }
  } catch {
    return null;
  }

  if (!capturedPlan) return null;

  const planResult = parsePlanArgs(capturedPlan);
  if (typeof planResult === "string") return null;

  return planResult;
}

/** P0: Determine accurate completion status after all execution stages */
function determineCompletionStatus(
  results: Map<string, TaskResult>,
  recovered: boolean
): CompletionStatus {
  const statuses = Array.from(results.values()).map((r) => r.status);
  const hasFailures = statuses.some((s) => s === "failed" || s === "blocked");
  const allComplete = statuses.every((s) => s === "complete" || s === "skipped");

  if (allComplete) return recovered ? "recovered" : "all_complete";
  if (hasFailures) return "has_failures";
  return "partial";
}
