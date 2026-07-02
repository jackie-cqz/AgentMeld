import { eventBus } from "@/server/event-bus";
import { startAgentRun } from "@/server/agent-runner";
import { consumeStream } from "@/server/consume-stream";
import { getAdapter } from "@/server/adapters/registry";
import type { AdapterInput } from "@/server/adapters/types";
import { createMessage, getConversation, getWorkspaceForConversation, listAgents, getArtifact, updateRunStage, persistConductorTask, persistConductorPlan, persistOutputBinding, persistConductorConflict } from "@/server/repositories";
import { registerPendingPlan } from "@/server/dispatch-plan-manager";
import { cancelPendingQuestionsForRun } from "@/server/pending-questions";
import { validatePlan, topologicalWaves, parsePlanArgs, type ParsedTask } from "@/server/tools/conductor-tools";
import { buildChildTaskPrompt, resolveTaskInputs, hasMissingRequiredInputs, type UpstreamArtifact } from "@/server/child-prompt-builder";
import { acquireConcurrencySlot } from "@/server/dispatch-concurrency";
import { recordTaskReport, getTaskReport, clearTaskResultsForRun } from "@/server/dispatch-task-results";
import { compileAndValidateDispatchPlan } from "@/server/dispatch-plan";
import { getFileWrites, clearFileWrites, detectWaveConflicts, type RunFileWrites } from "@/server/dispatch-file-writes";
import { clearRunToolEvidence, getRunToolEvidence } from "@/server/dispatch-tool-evidence";
import { evaluateChildTaskResult } from "@/server/task-result-report";
import { resolveApiKey, getSettings } from "@/server/settings-service";
import { newMessageId } from "@/shared/ids";
import type { Message, DispatchPlanItem, Agent } from "@/shared/types";

// ---------------------------------------------------------------------------
// Public entry — called from agent-runner or API
// ---------------------------------------------------------------------------

export interface ConductorInput {
  conversationId: string;
  conductorAgentId: string;
  triggerMessage: Message;
  availableAgentIds: string[];
  conductorRunId: string;
  /** messageId of the conductor's streaming response bubble, so events can target it */
  messageId: string;
}

export async function executeConductor(input: ConductorInput): Promise<void> {
  // Stage 1: ASSESS — LLM decides whether this needs a plan or is a simple chat
  const userText = extractTextFromMessage(input.triggerMessage);
  const assessResult = await runConductorAssess(input, userText);

  // Case A: Direct response — LLM answered directly (simple chat, greeting, question)
  if (assessResult.mode === "direct") {
    // Events were already streamed to the frontend via runConductorAssess
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
      const revised = await runConductorAssess(input, effectiveText);
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
      input.conductorAgentId
    );

    if (typeof validationResult === "string") {
      // Plan rejected — fail the run with clear error
      createSystemMessage(input.conversationId, `❌ Plan 校验失败：${validationResult}`);
      const errorMsg = `Plan validation failed: ${validationResult}`;
      eventBus.publish({
        type: "run.end", conversationId: input.conversationId, timestamp: Date.now(),
        runId: input.conductorRunId, status: "failed", error: errorMsg
      });
      return;
    }

    // Validated plan (compiled with auto-deps)
    const compiledPlan = validationResult;

    // P2: Persist plan to DB
    const planId = `plan_${input.conductorRunId}_${revisionContext ? "rev" : "init"}`;
    persistConductorPlan({
      id: planId, conductorRunId: input.conductorRunId, conversationId: input.conversationId,
      planJson: JSON.stringify(compiledPlan),
      revision: revisionContext ? 1 : 0,
      status: "pending",
      userFeedback: revisionContext || null,
      stageAtCreation: revisionContext ? "review" : "plan",
      now: Date.now()
    });

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
      maxAttempts: t.maxAttempts,
      targetPaths: t.targetPaths,
      requiredCommands: t.requiredCommands,
      requiredEvidence: t.requiredEvidence
    }));

    const result = await registerPendingPlan(input.conversationId, input.conductorRunId, planItems);

    if (!result.approved) {
      createSystemMessage(input.conversationId, "❌ 计划已拒绝，Conductor 运行终止。");
      return;
    }

    if (result.feedback) {
      revisionContext = buildReviseContext(result.feedback);
      continue;
    }

    // APPROVE — execute with validated compiled plan
    reviewing = false;
    // Cancel any lingering ask_user questions from the PLAN stage
    cancelPendingQuestionsForRun(input.conductorRunId);
    createSystemMessage(input.conversationId, "✅ 计划已批准，正在执行子任务...");

    // Convert validated DispatchPlanItem[] back to ParsedTask[] for execution
    const approvedPlan = result.plan ?? compiledPlan;
    const finalPlan: ParsedTask[] = approvedPlan.map((t) => ({
      id: t.id,
      agentId: t.agentId,
      title: t.title ?? t.id,
      prompt: t.task,
      dependsOn: t.dependsOn,
      inputs: (t.inputs ?? []).map((i) => ({ ...i, required: i.required ?? true })),
      expectedOutputs: (t.expectedOutputs ?? []).map((o) => ({ ...o, required: o.required ?? true })),
      acceptanceCriteria: t.acceptanceCriteria ?? [],
      maxAttempts: t.maxAttempts ?? 1,
      targetPaths: t.targetPaths,
      requiredCommands: t.requiredCommands,
      requiredEvidence: t.requiredEvidence
    } as ParsedTask));

    await executeConductorPlan(
      input.conversationId, finalPlan, input.availableAgentIds,
      input.conductorRunId, input.triggerMessage, input.conductorAgentId
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

export async function executeConductorPlan(
  conversationId: string,
  plan: ParsedTask[],
  availableAgents: string[],
  conductorRunId: string,
  triggerMessage: Message,
  conductorAgentId: string,
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
  updateRunStage(conductorRunId, "dispatch", Date.now());
  publishDispatchPlan(conversationId, conductorRunId, validTasks);

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
          parentRunId: conductorRunId, childRunId: "", taskId: task.id,
          agentId: task.agentId, status: "skipped", error: skipReason
        });
        continue;
      }

      wavePromises.push(
        runChildTask(conversationId, task, triggerMessage, conductorRunId, outputBindings, abortSignal)
          .then((r) => {
            results.set(task.id, r);
            createSystemMessage(conversationId, `${r.status === "complete" ? "✅" : "❌"} ${task.title}: ${r.summary}`);
            // P1: Persist task result to DB
            persistConductorTask({
              id: `${conductorRunId}_${task.id}`,
              conductorRunId,
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

      // P2: Persist conflicts to DB
      for (const c of structuredConflicts) {
        persistConductorConflict({
          id: `conflict_${conductorRunId}_${c.path.replace(/[^a-zA-Z0-9]/g, "_")}`,
          conductorRunId, planId: `plan_${conductorRunId}_init`,
          path: c.path, wave: c.wave,
          contributorsJson: JSON.stringify(c.contributors),
          now: Date.now()
        });
      }

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
  updateRunStage(conductorRunId, "recovery", Date.now());
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

    // Use the conductor to generate a recovery plan
    try {
      const recoveryResult = await generateRecoveryPlan(
        conversationId, conductorAgentId, conductorRunId,
        recoveryPrompt, plan, results, abortSignal
      );

      if (recoveryResult && recoveryResult.tasks.length > 0) {
        createSystemMessage(conversationId, `🔧 恢复计划：${recoveryResult.tasks.length} 个修复任务`);

        // Execute recovery tasks — they can depend on already-completed tasks
        const recoveryWaves = topologicalWaves(recoveryResult.tasks.filter((t) => availableAgents.includes(t.agentId)));
        for (const wave of recoveryWaves) {
          if (abortSignal.aborted) break;
          const recoveryPromises = wave.map((task) =>
            runChildTask(conversationId, task, triggerMessage, conductorRunId, outputBindings, abortSignal)
              .then((r) => {
                results.set(task.id, r);
                createSystemMessage(conversationId, `${r.status === "complete" ? "✅" : "❌"} [恢复] ${task.title}: ${r.summary}`);
                // P1: Persist recovery task result
                persistConductorTask({
                  id: `${conductorRunId}_${task.id}`,
                  conductorRunId,
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
  updateRunStage(conductorRunId, "aggregate", Date.now());
  const completionStatus = determineCompletionStatus(results, recovered);

  await runAggregateStage(
    conversationId, plan, results, outputBindings,
    conductorAgentId, conductorRunId, triggerMessage,
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
    let finalReport: ReturnType<typeof getTaskReport>;

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
      const evidence = getRunToolEvidence(attemptRunId);
      finalEvaluation = evaluateChildTaskResult(task, report, evidence);
      finalRunId = attemptRunId;
      finalReport = report;
      clearRunToolEvidence(attemptRunId);
      clearTaskResultsForRun(attemptRunId);

      if (finalEvaluation.status === "complete") break;
    }

    const report = finalReport;
    const evaluation = finalEvaluation;

    // P1.5: Strict output handoff — verify reported artifacts exist in DB
    if (report?.artifacts) {
      for (const [outputKey, artifactId] of Object.entries(report.artifacts)) {
        const art = getArtifact(artifactId);
        if (art && art.conversationId === conversationId) {
          outputBindings.set(`${task.id}.${outputKey}`, artifactId);
          // P2: Persist output binding to DB
          persistOutputBinding({
            conductorRunId: parentRunId, planId: `plan_${parentRunId}_init`,
            producerTaskId: task.id, outputKey, artifactId, now: Date.now()
          });
        }
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
  conductorAgentId: string,
  conductorRunId: string,
  triggerMessage: Message,
  completionStatus: CompletionStatus,
  signal: AbortSignal
): Promise<void> {
  const agents = listAgents();
  const agent = agents.find((a) => a.id === conductorAgentId);
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
    buildConductorAggregatePrompt(agent, plan, results, outputBindings, triggerMessage, conversationId);
  const aggregateSystemPrompt = `${baseSystem}\n\n## 执行结果\n整体状态：${statusLabel}${completionStatus === "has_failures" ? "\n请明确说明整体未完成，不要把局部成功说成全部完成。" : ""}`;

  // Tools: remove plan_tasks and ask_user
  const aggregateTools = agent.toolNames.filter((t) => t !== "plan_tasks" && t !== "ask_user");

  const adapterInput: AdapterInput = {
    conversationId,
    runId: conductorRunId,
    agent: { ...agent, toolNames: aggregateTools, systemPrompt: aggregateSystemPrompt },
    conversation,
    workspace,
    triggerMessage: { ...triggerMessage, parts: [{ type: "text", content: aggregateUserPrompt }] },
    recentMessages: [],
    toolNames: aggregateTools,
    systemPrompt: aggregateSystemPrompt,
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
    "## Conductor 总结", "",
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
    agentId: plan[0]?.agentId ?? "ag_conductor", runId: "",
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
// Conductor assess — flexible LLM call that can produce direct response OR plan
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompt builders — independent, testable pure functions
// ---------------------------------------------------------------------------

/** Tools available to the Conductor during the PLAN (assess) stage only */
export const CONDUCTOR_PLAN_TOOLS = [
  "plan_tasks",
  "ask_user",
  "read_artifact",
  "read_attachment",
  "fs_list",
  "fs_read"
] as const;

/**
 * Build the complete system prompt for the Conductor's PLAN (assess) stage.
 * Four blocks per message-flow-with-prompts-new.md §LLM 调用 #1:
 *   1. Workspace context
 *   2. Conductor persona
 *   3. PLAN dynamic instructions (workflow + agents + decomposition + dependencies + example)
 *   4. Tool guidance (cut-down: plan_tasks, ask_user, read_artifact, read_attachment, fs_list, fs_read)
 */
export function buildConductorPlanPrompt(
  agent: Agent,
  otherAgents: Agent[],
  workspacePath: string
): string {
  const allowedAgentIds = otherAgents.map((worker) => worker.id);
  const agentList = otherAgents.length > 0
    ? otherAgents.map((a) => JSON.stringify(describeAgentForPlanning(a))).join("\n")
    : "(无其他可用 Agent)";
  const exampleTasks = buildPlanTaskExample(otherAgents);

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

  // Block 2: Conductor persona
  blocks.push(agent.systemPrompt);

  // Block 3: PLAN dynamic instructions
  blocks.push(`## 你的工作流
1. 阅读用户最新请求与上下文。
2. 在调用任何工具前，先基于语义判断当前请求属于：
   - NEEDS_CLARIFICATION：存在多个合理方案，且不同选择会显著改变最终产物。
   - READY_TO_PLAN：信息足以形成可靠计划，或用户已明确授权你自行做决定。
3. 对“创建应用 / 网站 / 工具 / 游戏 / 页面”类请求，重点检查：
   核心范围与功能、关键交互或业务规则、视觉方向、技术与交付约束。
   不要求每一项都明确；只关注会改变任务拆分、Agent 分工或验收标准的高影响选择。
4. 如果判断为 NEEDS_CLARIFICATION：
   - 第一个工具调用必须是 ask_user，不能直接调用 plan_tasks。
   - 提出 1-3 个高价值选择题，每题提供互斥且可执行的选项。
   - 不要自行把常见默认值当作用户已经确认的选择。
   例如“帮我做一个番茄时钟”通常仍有计时规则、功能范围或视觉方向等高影响选择，
   应先判断这些选择是否需要用户确认。
5. 如果判断为 READY_TO_PLAN，直接调用 plan_tasks，不要为了形式感提问。
   例如用户已明确“React+TS、25+5、极简、不需要后端”，或明确说“细节你决定”。
6. 系统会自动执行 plan 并把子任务结果回传给你，由你做最终总结。

## 可用 Agent

<available_agents>
${agentList}
</available_agents>

<allowed_agent_ids>${JSON.stringify(allowedAgentIds)}</allowed_agent_ids>

## 协作分工方法
- 先把用户目标拆成「需求 / 设计 / 实现 / 审查 / 资料读取」等职责，再从 <available_agents> 中选择最匹配的 Agent。
- 每个 Agent 条目里的 bestFor 是优先分派方向，avoidFor 是不应分派方向；capabilities 和 tools 共同决定它能否完成任务。
- 需要文档需求、范围、验收标准时优先找产品 / PM 类 Agent。
- 需要视觉语言、组件规范、布局和交互风格时优先找设计 / UI 类 Agent。
- 需要创建或修改网页、组件、源码、运行构建时优先找前端 / 工程类 Agent。
- 需要检查完成度、代码质量、需求一致性或风险时优先找 Reviewer / QA 类 Agent。
- 一个任务只分派给一个最合适的 Agent；不要把同一职责同时派给多个 Agent。
- 多角色链路必须用 dependsOn 串起来，例如 PRD -> 风格指南 -> 实现 -> 审查。
- 如果当前群聊缺少某类 Agent，就用已有最接近能力者降级完成，并在任务 prompt 中说明边界；不要编造新 Agent。

## agentId 严格规则
- 每个 tasks[].agentId 必须逐字复制自 <allowed_agent_ids>。
- 不要填写 Agent 名称、职责名称、能力名称或自行编造的别名。
- 如果没有合适的可用 Agent，不要虚构 ID；应调整计划或直接说明无法分派。
- 提交 plan_tasks 前，逐项检查每个 agentId 都能在 <allowed_agent_ids> 中精确找到。

## 拆解原则
- 充分利用每个 Agent 的 capabilities，不要把任务派给不合适的人。
- 每个子任务必须独立可执行（被分派的 Agent 看不到完整群聊上下文，
  必要上下文要写进 task）。
- 计划阶段只能调用 ask_user、plan_tasks 和只读侦察工具
  （fs_list / fs_read / read_artifact / read_attachment）；不要写文件或执行命令。
- NEEDS_CLARIFICATION 时先 ask_user；READY_TO_PLAN 时直接 plan_tasks。

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

示例（只演示字段和依赖关系，agentId 均来自本次 <allowed_agent_ids>）：
${exampleTasks}`);

  // Block 4: Tool guidance (cut-down for PLAN stage — no fs_write, no bash)
  blocks.push(buildPlanStageToolGuidance());

  return blocks.join("\n");
}

function describeAgentForPlanning(agent: Agent) {
  const profile = inferPlanningProfile(agent);
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    capabilities: agent.capabilities,
    tools: agent.toolNames,
    bestFor: profile.bestFor,
    avoidFor: profile.avoidFor
  };
}

function inferPlanningProfile(agent: Agent): { bestFor: string[]; avoidFor: string[] } {
  const haystack = `${agent.id} ${agent.name} ${agent.description} ${agent.capabilities.join(" ")}`.toLowerCase();
  const hasAny = (keywords: string[]) => keywords.some((keyword) => haystack.includes(keyword));

  if (hasAny(["pm", "product", "requirements", "prd", "产品", "需求"])) {
    return {
      bestFor: ["需求澄清", "PRD / 范围定义", "功能优先级", "验收标准"],
      avoidFor: ["直接实现代码", "最终代码审查"]
    };
  }

  if (hasAny(["designer", "design", "ui", "visual", "style", "设计", "视觉"])) {
    return {
      bestFor: ["视觉方向", "风格指南", "组件规范", "布局与交互细节"],
      avoidFor: ["业务需求裁剪", "直接编写应用代码"]
    };
  }

  if (hasAny(["frontend", "react", "web_app", "html", "css", "javascript", "builder", "前端", "工程"])) {
    return {
      bestFor: ["前端实现", "组件与页面代码", "workspace 文件修改", "构建与部署预览"],
      avoidFor: ["产品范围拍板", "独立视觉规范产出"]
    };
  }

  if (hasAny(["review", "qa", "test", "analysis", "审查", "检查", "测试"])) {
    return {
      bestFor: ["需求一致性审查", "代码/产物质量检查", "风险与缺陷报告"],
      avoidFor: ["创建主要产物", "替代实现任务"]
    };
  }

  return {
    bestFor: ["与自身 capabilities 匹配的专门任务"],
    avoidFor: ["超出 tools 和 capabilities 的任务"]
  };
}

function buildPlanTaskExample(otherAgents: Agent[]): string {
  if (otherAgents.length === 0) {
    return "当前没有可分派 Agent，不要调用 plan_tasks。";
  }

  const tasks = otherAgents.slice(0, 3).map((worker, index) => ({
    id: `t${index + 1}`,
    agentId: worker.id,
    title: `交给 ${worker.name}`,
    prompt: `完成与 ${worker.name} 能力匹配的子任务。`,
    dependsOn: index === 0 ? [] : [`t${index}`]
  }));

  return JSON.stringify({ reasoning: "按能力和依赖顺序分派。", tasks }, null, 2);
}

/** Tool guidance for PLAN stage only — covers just the 6 allowed tools */
function buildPlanStageToolGuidance(): string {
  const lines: string[] = ["\n## AgentMeld 工具调用规范"];
  lines.push("- 需要调用工具时，必须用工具调用通道提交结构化参数，不要把 JSON 示例写进普通回复里假装调用。");
  lines.push("- 字段名必须严格使用工具 schema 里的 camelCase。");
  lines.push("- 不要编造 artifactId、attachmentId、outputKey、文件路径；只能使用上下文里明确给出的 id / 路径。");
  lines.push("- 工具返回 ok:false 或 isError=true 时，先根据错误修正参数；不要继续基于失败结果推进。");

  lines.push("\n### plan_tasks");
  lines.push("用途：Conductor 用结构化计划拆分子任务；执行顺序只认 dependsOn 字段。");
  lines.push("正确案例：t2.dependsOn=[\"t1\"]，不要只在 task 文本里写\"基于 t1\"。");
  lines.push("只在确实需要多 Agent 协作时调用此工具——简单对话直接文字回复即可。");

  lines.push("\n### ask_user");
  lines.push("用途：当多个合理选择会显著改变最终产物、任务拆分或验收标准时，先发起结构化问答。");
  lines.push("判断方式：由你基于用户语义判断 NEEDS_CLARIFICATION 或 READY_TO_PLAN，不依赖固定关键词。");
  lines.push("典型案例：用户只说“帮我做一个番茄时钟”，评估计时规则、功能范围或视觉方向是否需要确认。");
  lines.push("参数规则：每次 1-4 个 questions，每题 2-4 个 options。");
  lines.push("不要滥用：用户已提供足够约束，或明确授权你自行决定时，不要重复询问。");

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
 * Build the system + user prompts for the Conductor's AGGREGATE stage.
 * Extracted from runAggregateStage.
 */
export function buildConductorAggregatePrompt(
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
 * Used in multi-round retry within executeConductorPlan.
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
 * Used in executeConductor's revise loop.
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

function publishConductorFailed(input: ConductorInput, error: string) {
  eventBus.publish({
    type: "run.end",
    conversationId: input.conversationId,
    timestamp: Date.now(),
    runId: input.conductorRunId,
    status: "failed",
    error
  });
}

type AssessResult =
  | { mode: "direct" }
  | { mode: "plan"; plan: { reasoning: string; tasks: ParsedTask[] } };

async function runConductorAssess(
  input: ConductorInput,
  userText: string
): Promise<AssessResult> {
  const agents = listAgents();
  const agent = agents.find((a) => a.id === input.conductorAgentId);
  if (!agent || agent.adapterName !== "custom") {
    createSystemMessage(input.conversationId, "⚠️ Conductor 需要使用 Custom Adapter。");
    publishConductorFailed(input, "Conductor agent is not a custom adapter.");
    return { mode: "direct" };
  }

  const conversation = getConversation(input.conversationId);
  const workspace = getWorkspaceForConversation(input.conversationId);
  if (!conversation || !workspace) {
    createSystemMessage(input.conversationId, "⚠️ 会话或工作区未找到。");
    publishConductorFailed(input, "Conversation or workspace not found.");
    return { mode: "direct" };
  }

  const settings = getSettings();
  const apiKey = resolveApiKey(agent.modelProvider ?? "deepseek", agent.apiKey, settings);
  if (!apiKey) {
    createSystemMessage(input.conversationId, "⚠️ 缺少 DeepSeek API Key，请在设置中配置。");
    publishConductorFailed(input, "No API key configured.");
    return { mode: "direct" };
  }

  const otherAgents = agents.filter((a) => !a.isConductor && input.availableAgentIds.includes(a.id));
  const workspacePath = workspace.mode === "local" && workspace.boundPath
    ? workspace.boundPath : workspace.rootPath;

  // Build the PLAN stage system prompt from the extracted pure function
  const assessSystemPrompt = buildConductorPlanPrompt(agent, otherAgents, workspacePath);
  const assessToolNames = [...CONDUCTOR_PLAN_TOOLS];
  const adapterInput: AdapterInput = {
    conversationId: input.conversationId,
    runId: input.conductorRunId,
    agent: { ...agent, toolNames: assessToolNames, systemPrompt: assessSystemPrompt },
    conversation,
    workspace,
    triggerMessage: { ...input.triggerMessage, parts: [{ type: "text", content: userText }] },
    recentMessages: [],
    toolNames: assessToolNames,
    systemPrompt: assessSystemPrompt,
    workspacePath,
    apiKey
  };

  const adapter = getAdapter(agent.adapterName);
  const signal = AbortSignal.timeout(60000);

  // Stream events AND watch for plan_tasks via onEvent callback
  // We capture on tool.result (success) rather than tool.call, because the tool handler
  // may auto-correct agent IDs before returning success.
  let capturedPlan: { reasoning: string; tasks: Array<Record<string, unknown>> } | null = null;
  let planCallId: string | null = null;
  let planWasAttempted = false;

  try {
    await consumeStream({
      stream: adapter.run(adapterInput, signal),
      messageId: input.messageId,
      runId: input.conductorRunId,
      signal,
      onEvent: (event) => {
        // Remember the call id; the corrected plan arrives in tool.result.
        if (
          event.type === "tool.call" &&
          "toolName" in event &&
          (event as { toolName: string }).toolName === "plan_tasks"
        ) {
          planCallId = (event as { callId: string }).callId;
          planWasAttempted = true;
        }

        // Capture the validated, auto-corrected tasks returned by the tool.
        if (
          event.type === "tool.result" &&
          "callId" in event &&
          (event as { callId: string }).callId === planCallId &&
          !(event as { isError?: boolean }).isError
        ) {
          const toolPlan = readPlanToolResult((event as { result: unknown }).result);
          if (toolPlan) {
            capturedPlan = toolPlan;
            return { stop: true };
          }
        }

        // If plan_tasks failed, clear capture so LLM can retry
        if (
          event.type === "tool.result" &&
          "callId" in event &&
          (event as { callId: string }).callId === planCallId &&
          (event as { isError?: boolean }).isError
        ) {
          planCallId = null;
        }
      }
    });
  } catch (err) {
    // If we already captured a plan, the error after capture is irrelevant
    if (capturedPlan) {
      // proceed to plan validation below
    } else {
      // Stream error without a plan — fail the run
      const errorMsg = err instanceof Error ? err.message : String(err);
      createSystemMessage(input.conversationId, `⚠️ Conductor 调用失败：${errorMsg.slice(0, 200)}`);
      publishConductorFailed(input, `provider: ${errorMsg.slice(0, 200)}`);
      return { mode: "direct" };
    }
  }

  // If plan_tasks was captured, validate and return plan mode
  if (capturedPlan) {
    const planResult = parsePlanArgs(capturedPlan);
    if (typeof planResult === "string") {
      createSystemMessage(input.conversationId, `⚠️ Plan 校验失败：${planResult}`);
      publishConductorFailed(input, `invalid_plan: ${planResult}`);
      return { mode: "direct" };
    }
    return { mode: "plan", plan: planResult };
  }

  // Plan was attempted but failed — fail the run
  if (planWasAttempted) {
    createSystemMessage(input.conversationId, "⚠️ Conductor 未能生成有效计划，请重试或简化需求。");
    publishConductorFailed(input, "conductor_contract: plan_tasks failed");
    return { mode: "direct" };
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

  const workers = availableAgentIds.filter((id) => !id.includes("conductor"));

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

function publishDispatchPlan(conversationId: string, conductorRunId: string, tasks: ParsedTask[]): void {
  const planItems: DispatchPlanItem[] = tasks.map((t) => ({
    id: t.id, agentId: t.agentId, task: t.prompt, dependsOn: t.dependsOn,
    title: t.title, prompt: t.prompt, inputs: t.inputs, expectedOutputs: t.expectedOutputs,
    acceptanceCriteria: t.acceptanceCriteria, maxAttempts: t.maxAttempts,
    targetPaths: t.targetPaths, requiredCommands: t.requiredCommands, requiredEvidence: t.requiredEvidence
  }));
  eventBus.publish({
    type: "dispatch.plan", conversationId, timestamp: Date.now(),
    runId: conductorRunId, plan: planItems
  });
}

/**
 * Generate a recovery plan using the Conductor LLM.
 * Only includes fix/replacement tasks; already-successful tasks are preserved.
 */
async function generateRecoveryPlan(
  conversationId: string,
  conductorAgentId: string,
  conductorRunId: string,
  recoveryPrompt: string,
  originalPlan: ParsedTask[],
  results: Map<string, TaskResult>,
  signal: AbortSignal
): Promise<{ reasoning: string; tasks: ParsedTask[] } | null> {
  const agents = listAgents();
  const agent = agents.find((a) => a.id === conductorAgentId);
  if (!agent || agent.adapterName !== "custom") return null;

  const conversation = getConversation(conversationId);
  const workspace = getWorkspaceForConversation(conversationId);
  if (!conversation || !workspace) return null;

  const settings = getSettings();
  const apiKey = resolveApiKey(agent.modelProvider ?? "deepseek", agent.apiKey, settings);
  if (!apiKey) return null;

  const otherAgents = agents.filter(
    (candidate) => !candidate.isConductor && conversation.agentIds.includes(candidate.id)
  );
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

## agentId 严格规则
- tasks[].agentId 只能逐字复制自上面的可用 Agent id。
- 不要使用 Agent 名称、职责名称、能力名称或自行编造的别名。
- 提交 plan_tasks 前逐项确认 agentId 属于当前可用 Agent 列表。

## 约束
- 每个任务必须有唯一的 id（使用 r1, r2, ... 避免与原始 t1, t2 冲突）
- dependsOn 可以引用原始任务 id（t1, t2, ...）或修复任务 id（r1, r2, ...）`;

  const adapterInput: AdapterInput = {
    conversationId,
    runId: conductorRunId,
    agent: { ...agent, toolNames: ["plan_tasks"], systemPrompt },
    conversation,
    workspace,
    triggerMessage: { id: "", conversationId, role: "user", agentId: null, runId: null,
      parts: [{ type: "text", content: recoveryPrompt }], status: "complete",
      mentionedAgentIds: [], parentMessageId: null, createdAt: Date.now(), updatedAt: Date.now() },
    recentMessages: [],
    toolNames: ["plan_tasks"],
    systemPrompt,
    workspacePath,
    apiKey
  };

  const adapter = getAdapter(agent.adapterName);
  let capturedPlan: { reasoning: string; tasks: Array<Record<string, unknown>> } | null = null;
  let planCallId: string | null = null;

  try {
    for await (const event of adapter.run(adapterInput, signal)) {
      if (
        event.type === "tool.call" &&
        "toolName" in event &&
        (event as { toolName: string }).toolName === "plan_tasks"
      ) {
        planCallId = (event as { callId: string }).callId;
        continue;
      }
      if (
        event.type === "tool.result" &&
        "callId" in event &&
        (event as { callId: string }).callId === planCallId &&
        !(event as { isError?: boolean }).isError
      ) {
        capturedPlan = readPlanToolResult((event as { result: unknown }).result);
        if (capturedPlan) break;
      }
    }
  } catch {
    return null;
  }

  if (!capturedPlan) return null;

  const planResult = parsePlanArgs(capturedPlan);
  if (typeof planResult === "string") return null;

  const resolvedExternalTaskIds = originalPlan
    .filter((task) => results.get(task.id)?.status === "complete")
    .map((task) => task.id);
  const compiled = compileAndValidateDispatchPlan(
    planResult.tasks,
    conversation.agentIds,
    conductorAgentId,
    resolvedExternalTaskIds
  );
  if (typeof compiled === "string") return null;

  return {
    reasoning: planResult.reasoning,
    tasks: compiled.map((task) => ({
      id: task.id,
      agentId: task.agentId,
      title: task.title ?? task.id,
      prompt: task.task,
      dependsOn: task.dependsOn,
      inputs: (task.inputs ?? []).map((input) => ({
        ...input,
        required: input.required ?? true
      })),
      expectedOutputs: (task.expectedOutputs ?? []).map((output) => ({
        ...output,
        required: output.required ?? true
      })),
      acceptanceCriteria: task.acceptanceCriteria ?? [],
      maxAttempts: task.maxAttempts ?? 1,
      targetPaths: task.targetPaths ?? [],
      requiredCommands: task.requiredCommands ?? [],
      requiredEvidence: task.requiredEvidence ?? []
    }))
  };
}

function readPlanToolResult(
  result: unknown
): { reasoning: string; tasks: Array<Record<string, unknown>> } | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.tasks) || record.tasks.length === 0) return null;
  if (!record.tasks.every((task) => typeof task === "object" && task !== null && !Array.isArray(task))) {
    return null;
  }
  return {
    reasoning: typeof record.reasoning === "string" ? record.reasoning : "Plan",
    tasks: record.tasks as Array<Record<string, unknown>>
  };
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
