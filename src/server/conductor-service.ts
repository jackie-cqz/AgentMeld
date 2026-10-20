import { eventBus } from "@/server/event-bus";
import { startAgentRun } from "@/server/agent-runner";
import { takeRunRefusalReason } from "@/server/run-refusals";
import { consumeStream } from "@/server/consume-stream";
import { getHarness } from "@/server/harness/registry";
import { assertHarnessSupports } from "@/server/harness/capabilities";
import type { PiInvocationInput, PiProviderSnapshot } from "@/server/pi/types";
import { snapshotPiProvider } from "@/server/pi/config";
import { CONVERSATION_ROSTER_TOOL, provisionedPlatformToolNames } from "@/server/pi/tool-surface";
import { PiRuntimeError } from "@/server/pi/process";
import { createMessage, getConversation, getRun, getMessage, getWorkspaceForConversation, listAgents, getArtifact, updateRunStage, persistConductorTask, persistConductorPlan, persistOutputBinding, supersedeOutputBinding, persistConductorConflict, listOutputBindings } from "@/server/repositories";
import { getDatabase } from "@/db/client";
import { registerPendingPlan } from "@/server/dispatch-plan-manager";
import { cancelPendingQuestionsForRun } from "@/server/pending-questions";
import { validatePlan, topologicalWaves, parsePlanArgs, type ParsedTask } from "@/server/tools/conductor-tools";
import { buildChildTaskPrompt, resolveTaskInputs, resolveVerifiedTaskInputs, renderTaskContextPrompt, hasMissingRequiredInputs, type UpstreamArtifact, type ActiveFactEntry } from "@/server/child-prompt-builder";
import { buildRequirements, compileTaskContext } from "@/server/task-context/context-compiler";
import { getFilteredDefinitionsForAgent } from "@/server/context-facts/fact-agent-dto";
import { buildFactExtractionGuidance } from "@/server/context-facts/conductor-fact-extraction";
import { buildContractGuidance } from "@/server/agent-contracts/contract-resolver";
import { acquireConcurrencySlot } from "@/server/dispatch-concurrency";
import { issueDelegation } from "@/server/delegation";
import { recordTaskReport, getTaskReport, clearTaskResultsForRun } from "@/server/dispatch-task-results";
import { compileAndValidateDispatchPlan } from "@/server/dispatch-plan";
import { getFileWrites, getFileWriteOrder, clearFileWrites, detectWaveConflicts, collapseTaskAttemptWrites, type RunFileWrites } from "@/server/dispatch-file-writes";
import { clearRunToolEvidence, getRunToolEvidence, getTaskToolEvidence } from "@/server/dispatch-tool-evidence";
import { rebuildAllFts } from "@/server/search/context-fts-index";
import { evaluateChildTaskResult } from "@/server/task-result-report";
import { verifyTaskAttempt } from "@/server/verification/verification-engine";
import { upsertCriterionVerdict } from "@/server/repositories/evidence-repository";
import { resolveApiKey, getSettings } from "@/server/settings-service";
import { newMessageId, newTaskAttemptId, newContextSnapshotId } from "@/shared/ids";
import type { Message, MessagePart, StreamEvent, DispatchPlanItem, Agent } from "@/shared/types";
import type { TaskExecutionIdentity } from "@/shared/evidence-types";
import type { TaskContextEnvelope, ContextManifestItem } from "@/shared/task-context-types";
import {
  clearTaskAttemptChildRun,
  createTaskAttempt,
  startTaskAttempt,
  finishTaskAttempt,
  updateTaskAttemptVerification,
  failOpenTaskAttempt,
  insertContextSnapshot,
  listEvidenceForAttempt,
} from "@/server/repositories/evidence-repository";
import { workspaceInfoBlock } from "@/server/tools/capabilities";
import { buildCollaborationHistory } from "@/server/collaboration/conversation-context";
import { acceptedHandoffForAttempt, bindHandoffAttempt, claimHandoff, finishHandoff, getHandoff, validateHandoffPackage } from "@/server/collaboration/handoffs";
import { getTaskAttemptByChildRun, listTaskAttempts } from "@/server/repositories/evidence-repository";

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
  signal?: AbortSignal;
  piConfiguration?: PiProviderSnapshot;
  objectiveContext?: string;
  onTaskAccepted?: () => void;
  onContextCaptured?: PiInvocationInput["onContextCaptured"];
}

function setConductorStage(conversationId: string, runId: string, stage: string): void {
  const now = Date.now();
  updateRunStage(runId, stage, now);
  eventBus.publish({ type: "run.stage", conversationId, timestamp: now, runId, stage });
}

function taskWriterRunIds(runIds: string[]): string[] {
  return [...new Set(runIds.flatMap(runId => [runId, ...(getDatabase().prepare(
    "SELECT target_run_id FROM agent_consultations WHERE source_run_id=? AND target_run_id IS NOT NULL ORDER BY created_at,id"
  ).all(runId) as Array<{ target_run_id: string }>).map(row => row.target_run_id)]))];
}

export async function executeConductor(input: ConductorInput): Promise<void> {
  setConductorStage(input.conversationId, input.conductorRunId, "planning");
  const agent = listAgents().find(agent => agent.id === input.conductorAgentId);
  if (agent) input.piConfiguration ??= snapshotPiProvider(agent);
  // Honest degradation before any stage runs: the Conductor's PLAN, aggregate and
  // recovery stages are all business-tool stages and rely on the platform packet.
  const conductorHarness = agent ? getHarness(agent.adapterName) : null;
  if (conductorHarness) {
    assertHarnessSupports(conductorHarness, { businessTools: true, cancellation: true, contextPacket: "platform" });
  }
  // Stage 0: FACT EXTRACTION — extract structured facts from user message
  const userText = extractTextFromMessage(input.triggerMessage);
  try {
    const { extractFactsForUserTurn } = await import("@/server/context-facts/conductor-fact-extraction");
    const factResult = await extractFactsForUserTurn({
      conversationId: input.conversationId,
      conductorRunId: input.conductorRunId,
      conductorAgent: { id: input.conductorAgentId, isConductor: true } as Agent,
      triggerMessage: input.triggerMessage,
    });
    if (factResult.resolutions.length > 0) {
      console.log(`[conductor] fact extraction: ${factResult.summary}`);
    }
  } catch (err) {
    // Fact extraction failure must never block the Conductor
    console.error("[conductor] fact extraction failed:", err);
  }

  // Stage 1: ASSESS — LLM decides whether this needs a plan or is a simple chat
  const assessResult = await runConductorAssess(input, input.objectiveContext ?? userText);

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
      // Through the shared helper, so recording the failure cannot be forgotten
      // by one call site while others do it.
      failConductor(`Plan validation failed: ${validationResult}`);
      return;
    }

    // Validated plan (compiled with auto-deps)
    const compiledPlan = validationResult;

    // P2: Persist plan to DB — increment revision to avoid unique key conflicts
    let planRevision = 0;
    let planId = `plan_${input.conductorRunId}_init`;
    if (revisionContext) {
      // Count existing plans for this run to determine next revision number
      const existingCount = (getDatabase()
        .prepare("SELECT COUNT(*) as cnt FROM conductor_plans WHERE conductor_run_id = ?")
        .get(input.conductorRunId) as { cnt: number } | undefined)?.cnt ?? 0;
      planRevision = existingCount;
      planId = `plan_${input.conductorRunId}_rev${existingCount}`;
    }
    persistConductorPlan({
      id: planId, conductorRunId: input.conductorRunId, conversationId: input.conversationId,
      planJson: JSON.stringify(compiledPlan),
      revision: planRevision,
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
      requiredEvidence: t.requiredEvidence,
      taskIntent: t.taskIntent,
      contractProfile: t.contractProfile,
      contractSelectionReason: t.contractSelectionReason,
      contractSelectionVersion: t.contractSelectionVersion
    }));

    setConductorStage(input.conversationId, input.conductorRunId, "awaiting_approval");
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
      requiredEvidence: t.requiredEvidence,
      taskIntent: t.taskIntent,
      contractProfile: t.contractProfile,
      contractSelectionReason: t.contractSelectionReason,
      contractSelectionVersion: t.contractSelectionVersion
    } as ParsedTask));

    await executeConductorPlan(
      input.conversationId, finalPlan, input.availableAgentIds,
      input.conductorRunId, planId, input.triggerMessage, input.conductorAgentId,
      input.messageId, input.signal, input.piConfiguration
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
  /** Outcome of the evidence verification, persisted alongside the task result.
   *  Absent for tasks that never ran (skipped/aborted before an attempt). */
  verificationStatus?: "verified" | "rejected" | "not_started";
}

export interface RecoveryTask extends ParsedTask {
  replacesTaskId: string;
}

/**
 * Bind model-proposed recovery work to failed original tasks.
 *
 * The model may decide how to repair a task, but the platform owns the task
 * identity and evidence contract. Inheriting these fields prevents a recovery
 * plan from weakening acceptance criteria or inventing impossible target paths.
 */
export function bindRecoveryTasksToOriginalPlan(
  proposedTasks: ParsedTask[],
  originalPlan: ParsedTask[],
  results: Map<string, TaskResult>
): RecoveryTask[] {
  const failedTasks = originalPlan.filter((task) => {
    const status = results.get(task.id)?.status;
    return status === "failed" || status === "blocked";
  });
  const unmatched = new Set(failedTasks.map((task) => task.id));

  return proposedTasks.flatMap((proposed) => {
    const explicit = proposed.replacesTaskId
      ? failedTasks.find((task) => task.id === proposed.replacesTaskId && unmatched.has(task.id))
      : undefined;
    const candidates = failedTasks.filter((task) => unmatched.has(task.id));
    const original = explicit ?? candidates
      .map((task) => ({
        task,
        score:
          (task.agentId === proposed.agentId ? 100 : 0) +
          task.expectedOutputs.filter((output) =>
            proposed.expectedOutputs.some((candidate) => candidate.id === output.id)
          ).length * 10
      }))
      .sort((left, right) => right.score - left.score)[0]?.task;

    if (!original) return [];
    unmatched.delete(original.id);

    return [{
      ...proposed,
      replacesTaskId: original.id,
      agentId: original.agentId,
      prompt: `${original.prompt}\n\n## 恢复执行补充\n${proposed.prompt}`,
      dependsOn: [...original.dependsOn],
      inputs: original.inputs.map((input) => ({ ...input })),
      expectedOutputs: original.expectedOutputs.map((output) => ({ ...output })),
      acceptanceCriteria: [...original.acceptanceCriteria],
      targetPaths: [...(original.targetPaths ?? [])],
      requiredCommands: (original.requiredCommands ?? []).map((command) => ({ ...command })),
      requiredEvidence: [...(original.requiredEvidence ?? [])],
      taskIntent: original.taskIntent,
      contractProfile: original.contractProfile,
      contractSelectionReason: original.contractSelectionReason,
      contractSelectionVersion: original.contractSelectionVersion,
      maxAttempts: Math.max(1, proposed.maxAttempts)
    }];
  });
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
  planId: string,
  triggerMessage: Message,
  conductorAgentId: string,
  messageId: string,
  signal?: AbortSignal,
  piConfiguration?: PiProviderSnapshot
): Promise<{ results: Map<string, TaskResult>; completionStatus: CompletionStatus; conflicts: StructuredConflict[] }> {
  plan = enforceExplicitFrameworkContracts(plan, extractTextFromMessage(triggerMessage));
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
  setConductorStage(conversationId, conductorRunId, "dispatch");
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
        runChildTask(conversationId, task, triggerMessage, conductorRunId, planId, outputBindings, abortSignal)
          .then((r) => {
            results.set(task.id, r);
            createSystemMessage(conversationId, `${r.status === "complete" ? "✅" : "❌"} ${task.title}: ${r.summary}`);
            // P1: Persist task result to DB
            persistConductorTask({
              id: `${conductorRunId}_${task.id}`,
              conductorRunId,
              conversationId,
              taskId: task.id,
              agentId: r.childRunId ? getRun(r.childRunId)?.agentId ?? task.agentId : task.agentId,
              title: task.title,
              status: r.status,
              summary: r.summary,
              childRunId: r.childRunId ?? null,
              verificationStatus: r.verificationStatus,
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
      const runIds = [...new Set([...listTaskAttempts(conductorRunId, task.id).map(attempt => attempt.childRunId), r?.childRunId].filter((id): id is string => !!id))];
      const attempts = taskWriterRunIds(runIds).map(runId => ({ taskId: task.id, agentId: getRun(runId)?.agentId ?? task.agentId, runId,
        writes: getFileWrites(runId), writeOrder: getFileWriteOrder(runId) }));
      waveRunWrites.push(...collapseTaskAttemptWrites(attempts));
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
          conductorRunId, planId,
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
      const runIds = [...listTaskAttempts(conductorRunId, task.id).map(attempt => attempt.childRunId), r?.childRunId];
      for (const runId of taskWriterRunIds(runIds.filter((id): id is string => !!id))) {
        clearFileWrites(runId);
        clearRunToolEvidence(runId);
        clearTaskResultsForRun(runId);
      }
    }
  }

  // ── Stage 2: RECOVERY — LLM-driven re-plan for failures ──
  setConductorStage(conversationId, conductorRunId, "recovery");
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
        recoveryPrompt, plan, results, abortSignal, piConfiguration
      );

      if (recoveryResult && recoveryResult.tasks.length > 0) {
        createSystemMessage(conversationId, `🔧 恢复计划：${recoveryResult.tasks.length} 个修复任务`);

        // Execute recovery tasks — they can depend on already-completed tasks
        let recoveredTaskCount = 0;
        const recoveryWaves = topologicalWaves(recoveryResult.tasks.filter((t) => availableAgents.includes(t.agentId)));
        for (const wave of recoveryWaves) {
          if (abortSignal.aborted) break;
          const recoveryPromises = wave.map((task) =>
            runChildTask(conversationId, task, triggerMessage, conductorRunId, planId, outputBindings, abortSignal)
              .then((r) => {
                createSystemMessage(conversationId, `${r.status === "complete" ? "✅" : "❌"} [恢复] ${task.title}: ${r.summary}`);
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
                  verificationStatus: r.verificationStatus,
                  attempt: 1,
                  now: Date.now()
                });
                if (r.status !== "complete") return;

                promoteRecoveryResult({
                  task,
                  result: r,
                  results,
                  outputBindings,
                  conductorRunId,
                  planId,
                  conversationId
                });
                recoveredTaskCount++;
              })
          );
          await Promise.all(recoveryPromises);
        }
        if (recoveredTaskCount > 0) {
          recovered = true;
          await resumeSkippedOriginalTasks({
            conversationId,
            plan,
            results,
            triggerMessage,
            conductorRunId,
            planId,
            outputBindings,
            signal: abortSignal
          });
        }
      }
    } catch {
      createSystemMessage(conversationId, "⚠️ 恢复计划生成失败，将使用已有结果进行聚合。");
    }
  }

  // ── Stage 3: AGGREGATE — accurate completion status ──
  setConductorStage(conversationId, conductorRunId, "aggregate");
  const completionStatus = determineCompletionStatus(results, recovered);

  await runAggregateStage(
    conversationId, plan, results, outputBindings,
    conductorAgentId, conductorRunId, triggerMessage,
    completionStatus, messageId, abortSignal, piConfiguration
  );

  return { results, completionStatus, conflicts: allConflicts };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function promoteRecoveryResult(input: {
  task: RecoveryTask;
  result: TaskResult;
  results: Map<string, TaskResult>;
  outputBindings: Map<string, string>;
  conductorRunId: string;
  planId: string;
  conversationId: string;
}): void {
  const {
    task,
    result,
    results,
    outputBindings,
    conductorRunId,
    planId,
    conversationId
  } = input;

  for (const output of task.expectedOutputs) {
    const artifactId = outputBindings.get(`${task.id}.${output.id}`);
    if (!artifactId) continue;
    outputBindings.set(`${task.replacesTaskId}.${output.id}`, artifactId);
  }

  const promotedResult: TaskResult = {
    ...result,
    taskId: task.replacesTaskId,
    summary: `[恢复任务 ${task.id}] ${result.summary}`
  };
  results.set(task.replacesTaskId, promotedResult);
  persistConductorTask({
    id: `${conductorRunId}_${task.replacesTaskId}`,
    conductorRunId,
    conversationId,
    taskId: task.replacesTaskId,
    agentId: task.agentId,
    title: task.title,
    status: promotedResult.status,
    summary: promotedResult.summary,
    childRunId: promotedResult.childRunId ?? null,
    verificationStatus: promotedResult.verificationStatus,
    attempt: 2,
    now: Date.now()
  });
}

async function resumeSkippedOriginalTasks(input: {
  conversationId: string;
  plan: ParsedTask[];
  results: Map<string, TaskResult>;
  triggerMessage: Message;
  conductorRunId: string;
  planId: string;
  outputBindings: Map<string, string>;
  signal: AbortSignal;
}): Promise<void> {
  const {
    conversationId,
    plan,
    results,
    triggerMessage,
    conductorRunId,
    planId,
    outputBindings,
    signal
  } = input;
  const attempted = new Set<string>();

  while (!signal.aborted) {
    const ready = plan.filter((task) => {
      if (attempted.has(task.id) || results.get(task.id)?.status !== "skipped") return false;
      return task.dependsOn.every((dependencyId) => results.get(dependencyId)?.status === "complete");
    });
    if (ready.length === 0) return;

    await Promise.all(ready.map(async (task) => {
      attempted.add(task.id);
      createSystemMessage(conversationId, `▶️ [恢复后继续] ${task.title}`);
      const result = await runChildTask(
        conversationId,
        task,
        triggerMessage,
        conductorRunId,
        planId,
        outputBindings,
        signal
      );
      results.set(task.id, result);
      persistConductorTask({
        id: `${conductorRunId}_${task.id}`,
        conductorRunId,
        conversationId,
        taskId: task.id,
        agentId: task.agentId,
        title: task.title,
        status: result.status,
        summary: result.summary,
        childRunId: result.childRunId ?? null,
        verificationStatus: result.verificationStatus,
        attempt: 1,
        now: Date.now()
      });
      createSystemMessage(
        conversationId,
        `${result.status === "complete" ? "✅" : "❌"} [恢复后继续] ${task.title}: ${result.summary}`
      );
    }));
  }
}

async function runChildTask(
  conversationId: string,
  task: ParsedTask,
  triggerMessage: Message,
  parentRunId: string,
  planId: string,
  outputBindings: Map<string, string>,
  signal: AbortSignal
): Promise<TaskResult> {
  let result = await executeChildTaskAttempts(conversationId, task, triggerMessage, parentRunId, planId, outputBindings, signal);
  for (let hop = 0; hop < 4; hop++) {
    const source = result.childRunId ? getTaskAttemptByChildRun(result.childRunId) : undefined;
    const handoff = source ? acceptedHandoffForAttempt(source.id) : null;
    if (!handoff) return result;
    result = await executeTaskHandoff(handoff.id, parentRunId, triggerMessage, signal, outputBindings);
  }
  return result;
}

/** An accepted handoff changes assignment, not the logical task or its evidence contract. */
export async function executeTaskHandoff(id: string, coordinatorRunId: string, triggerMessage: Message, signal: AbortSignal,
  outputBindings = new Map<string, string>()): Promise<TaskResult> {
  const handoff = getHandoff(id);
  if (!handoff || handoff.coordinatorRunId !== coordinatorRunId || !claimHandoff(id, coordinatorRunId)) throw new Error("Handoff has already been claimed or is not authorized.");
  try {
    const { waitForRunTreeStop } = await import("@/server/agent-runner");
    await waitForRunTreeStop(handoff.sourceRunId, signal);
    const packet = validateHandoffPackage(id);
    signal.throwIfAborted();
    const parent = getRun(coordinatorRunId);
    if (!parent || parent.status !== "running" || parent.conversationId !== handoff.conversationId) throw new Error("The handoff coordinator is not active.");
    // Prior evidence remains inspectable, but is not current-attempt proof.
    getDatabase().prepare("UPDATE task_evidence SET status='stale',invalidated_at=? WHERE attempt_id=? AND invalidated_at IS NULL").run(Date.now(), handoff.sourceAttemptId);
    updateTaskAttemptVerification(handoff.sourceAttemptId, "rejected", JSON.stringify({ handoffId: id, reason: "Superseded by an explicitly accepted handoff." }), Date.now());
    const task = { ...packet.task, agentId: handoff.targetAgentId };
    let planId = packet.sourcePlanId;
    if (coordinatorRunId !== packet.sourceConductorRunId) {
      planId = `plan_${coordinatorRunId}_handoff`;
      persistConductorPlan({ id: planId, conductorRunId: coordinatorRunId, conversationId: handoff.conversationId,
        planJson: JSON.stringify([task]), status: "active", stageAtCreation: "handoff", resumedFromRunId: packet.sourceConductorRunId, now: Date.now() });
      for (const input of packet.inputs) outputBindings.set(input.key, input.artifactId);
      publishDispatchPlan(handoff.conversationId, coordinatorRunId, [task]);
    }
    setConductorStage(handoff.conversationId, coordinatorRunId, "handoff");
    const result = await executeChildTaskAttempts(handoff.conversationId, task, triggerMessage, coordinatorRunId, planId, outputBindings, signal,
      { id, sourceAttemptId: handoff.sourceAttemptId, sourceRunId: handoff.sourceRunId, sourceAttempt: packet.sourceAttempt,
        failure: packet.failure ?? "The human requested another Agent to continue this exact task; inspect prior evidence, do not treat it as current success." });
    finishHandoff(id, result.status === "complete", result.status !== "complete" ? result.summary : undefined);
    if (coordinatorRunId !== packet.sourceConductorRunId) persistConductorTask({ id: `${coordinatorRunId}_${task.id}`, conductorRunId: coordinatorRunId,
      conversationId: handoff.conversationId, taskId: task.id, agentId: handoff.targetAgentId, title: task.title, status: result.status,
      summary: result.summary, childRunId: result.childRunId ?? null, verificationStatus: result.verificationStatus,
      attempt: packet.sourceAttempt + 1, now: Date.now() });
    return result;
  } catch (error) {
    finishHandoff(id, false, error instanceof Error ? error.message : "Handoff failed.");
    throw error;
  }
}

async function executeChildTaskAttempts(
  conversationId: string, task: ParsedTask, triggerMessage: Message, parentRunId: string, planId: string,
  outputBindings: Map<string, string>, signal: AbortSignal,
  handoff?: { id: string; sourceAttemptId: string; sourceRunId: string; sourceAttempt: number; failure: string }
): Promise<TaskResult> {
  const effectiveOutputBindings = hydrateOutputBindings(outputBindings, planId);
  // Resolve inputs — check if required inputs are available
  const resolvedInputs = resolveTaskInputs(task, effectiveOutputBindings);
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

  // The attempt row currently in flight, so the catch below can finish it. Stale by
  // design after an iteration completes — `failOpenTaskAttempt` re-reads the row and
  // refuses to touch one that already reached a terminal state.
  let currentAttemptId: string | null = null;

  try {
    // Build child prompt with full context

    // P6: Resolve verified inputs — the PRIMARY path for upstream artifact
    // metadata. Unlike resolveTaskInputs (which only checks binding existence),
    // this carries full provenance: artifact version, type, and title.
    // P4 output-binding gates ensure only verified outputs enter outputBindings,
    // so every resolved input here is implicitly verified.
    const verifiedInputs = resolveVerifiedTaskInputs(task, effectiveOutputBindings);
    const upstreamArtifacts: UpstreamArtifact[] = verifiedInputs.map((vi) => ({
      id: vi.artifactId,
      type: vi.artifactType,
      title: vi.title,
      version: vi.artifactVersion,
    }));
    // Build recent conversation snippet
    const recentConversation: Array<{ from: string; content: string }> = [];
    const userText = extractTextFromMessage(triggerMessage);
    if (userText) {
      recentConversation.push({ from: "user", content: userText });
    }

    // P2: Load active facts for this agent's context
    const taskAgent = listAgents().find(a => a.id === task.agentId);
    const workspace = getWorkspaceForConversation(conversationId);
    const workspacePath = workspace
      ? (workspace.mode === "local" && workspace.boundPath ? workspace.boundPath : workspace.rootPath)
      : undefined;
    let activeFacts: ActiveFactEntry[] = [];
    try {
      // P2: Derive agent role from capabilities, not agentId
      const agentRole = taskAgent?.capabilities?.find(c =>
        ["pm", "ui", "frontend", "react", "design", "review"].includes(c)
      ) ?? null;
      const defs = getFilteredDefinitionsForAgent({
        conversationId,
        agentRole: agentRole ?? undefined,
        userMessageText: extractTextFromMessage(triggerMessage),
      });
      activeFacts = defs
        .filter((d) => d.currentValue !== null)
        .map((d) => ({
          canonicalKey: d.canonicalKey,
          value: d.currentValue,
          valueType: d.valueType,
          description: d.description,
          trustLevel: d.trustLevel,
        }));
    } catch {
      // Fact loading failure must not block task dispatch
    }

    eventBus.publish({
      type: "dispatch.start", conversationId, timestamp: Date.now(),
      parentRunId, childRunId: "", taskId: task.id, agentId: task.agentId
    });

    // Retry loop — up to maxAttempts
    const maxAttempts = task.maxAttempts || 1;
    const now = Date.now();
    // P5: Track previous attempt identity for retry context.
    // On the first attempt these are empty — there is no previous run.
    // After each failed attempt, they are updated so the next iteration can
    // pass them into compileTaskContext → buildFailureContext.
    let previousRunId = handoff?.sourceRunId ?? "";
    let previousAttemptId = handoff?.sourceAttemptId ?? "";
    let previousError: string | undefined = handoff?.failure;
    // Post-loop references: finalRunId for dispatch events, finalAttemptId for
    // verification-status updates.
    let finalRunId = "";
    let finalAttemptId = "";
    // P4: Verified output bindings from verification engine (replaces trust-the-agent)
    let finalVerifiedBindings: Array<{ outputKey: string; artifactId: string; evidenceIds: string[] }> = [];
    let finalReport: ReturnType<typeof getTaskReport>;
    let finalEvaluation: ReturnType<typeof evaluateChildTaskResult> = { status: "failed", error: "not started" };

    const lastAttempt = (handoff?.sourceAttempt ?? 0) + maxAttempts;
    for (let attempt = (handoff?.sourceAttempt ?? 0) + 1; attempt <= lastAttempt; attempt++) {
      if (signal.aborted) return { taskId: task.id, status: "aborted", summary: "Parent run cancelled before retry." };
      // P0: Generate task execution identity for this attempt
      const attemptId = newTaskAttemptId();
      const contextSnapshotId = newContextSnapshotId();

      const taskExecution: TaskExecutionIdentity = {
        conductorRunId: parentRunId,
        planId,
        planRevision: (() => { const m = planId.match(/_rev(\d+)$|_recovery(\d+)?$/); return m ? parseInt(m[1] || m[2] || "1") : 0; })(),
        taskId: task.id,
        attemptId,
        attempt,
        contextSnapshotId
      };

      // P1: Persist task attempt record (queued → will be updated to running)
      createTaskAttempt({
        id: attemptId,
        conductorRunId: parentRunId,
        conversationId,
        planId,
        planRevision: (() => { const m = planId.match(/_rev(\d+)$|_recovery(\d+)?$/); return m ? parseInt(m[1] || m[2] || "1") : 0; })(),
        taskId: task.id,
        agentId: task.agentId,
        childRunId: null,
        attempt,
        contextSnapshotId,
        executionStatus: "queued",
        verificationStatus: "not_started",
        failureContextJson: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      currentAttemptId = attemptId;

      // P3+P5: Build compiled context snapshot via full compiler pipeline.
      // On retry (attempt > 1), pass the previous attempt's identity and error
      // so context-compiler can build a targeted FailureContext instead of
      // repeating the full original prompt.
      const envelope = await compileTaskContext({
        conversationId, conductorRunId: parentRunId, planId, planRevision: taskExecution.planRevision,
        task, attemptId, attempt, contextSnapshotId, assignedAgent: taskAgent ?? { id: task.agentId } as Agent,
        triggerMessage, resolvedInputs, upstreamArtifacts, activeFacts,
        workspacePath,
        previousAttemptId: attempt > 1 ? previousAttemptId : undefined,
        previousChildRunId: attempt > 1 ? previousRunId : undefined,
        previousError: attempt > 1 ? previousError : undefined,
        modelProvider: taskAgent?.modelProvider ?? null,
      });

      // P1: Persist context snapshot to SQLite
      try {
        insertContextSnapshot({
          id: contextSnapshotId,
          conversationId,
          conductorRunId: parentRunId,
          planId,
          taskId: task.id,
          attemptId,
          policyVersion: envelope.policyVersion,
          schemaVersion: envelope.schemaVersion,
          envelopeJson: JSON.stringify(envelope),
          manifestJson: JSON.stringify(envelope.manifest),
          tokenEstimate: envelope.budget.requiredTokens,
          requiredTokenEstimate: envelope.budget.requiredTokens,
          omittedTokenEstimate: envelope.budget.omittedTokens,
          createdAt: now,
        });
      } catch (err) {
        console.error(`[conductor] failed to persist context snapshot ${contextSnapshotId}:`, err);
      }

      // P7: Emit context.compiled event for frontend observability
      eventBus.publish({
        type: "dispatch.context.compiled",
        conversationId,
        timestamp: Date.now(),
        parentRunId,
        taskId: task.id,
        attemptId,
        contextSnapshotId,
        includedCount: envelope.manifest.filter(m => m.included).length,
        omittedCount: envelope.manifest.filter(m => !m.included).length,
        tokenEstimate: envelope.budget.requiredTokens,
        agentId: task.agentId,
      });

      // P3: Use compiled envelope prompt for first attempt, continuation for retries
      const attemptPrompt = attempt > 1
        ? buildContinuationPrompt(renderTaskContextPrompt(envelope), attempt, lastAttempt, previousError ?? "unknown")
        : renderTaskContextPrompt(envelope);

      const attemptMsg: Message = {
        id: newMessageId(), conversationId, origin: "internal", role: "user", agentId: null, runId: null,
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

      // P3: Block child run if mandatory context exceeded budget
      if (envelope.blocked) {
        console.error(`[conductor] task ${task.id} attempt ${attempt}: context overflow — mandatory ${envelope.budget.requiredTokens} > available ${envelope.budget.maxInputTokens}`);
        finalEvaluation = { status: "blocked", error: `task_context_overflow: mandatory ${envelope.budget.requiredTokens} tokens exceeds ${envelope.budget.maxInputTokens} budget` };
        finishTaskAttempt(attemptId, "blocked", Date.now());
        updateTaskAttemptVerification(attemptId, "rejected", JSON.stringify({ error: finalEvaluation.error }), Date.now());
        // Don't call startAgentRun — skip this task entirely
        break;
      }

      // Trusted delegation (#24): this child run is work one agent is handing
      // to another, so it starts with a one-time grant naming this exact
      // source run, target agent, task and attempt. Nothing else can start
      // delegated work — not a message that mentions an agent, not a replay.
      const parentRun = getRun(parentRunId);
      const delegation = issueDelegation({
        sourceRunId: parentRunId,
        sourceAgentId: parentRun?.agentId ?? "",
        targetAgentId: task.agentId,
        taskId: task.id,
        attempt
      });
      if (!delegation.ok) {
        console.error(`[conductor] delegation refused for task ${task.id} attempt ${attempt}: ${delegation.error}`);
        finalEvaluation = { status: "blocked", error: `delegation_refused: ${delegation.error}` };
        finishTaskAttempt(attemptId, "blocked", Date.now());
        updateTaskAttemptVerification(attemptId, "rejected", JSON.stringify({ error: finalEvaluation.error }), Date.now());
        break;
      }

      // P0: Pass taskExecution identity into the child run
      const { runId: attemptRunId, promise } = startAgentRun({
        conversationId,
        agentId: task.agentId,
        triggerMessage: attemptMsg,
        parentRunId,
        delegationCorrelationId: delegation.correlationId,
        taskExecution,
        taskContract: {
          acceptanceCriteria: task.acceptanceCriteria ?? [],
          expectedOutputs: (task.expectedOutputs ?? []).map((output) => ({
            outputKey: output.id,
            type: output.type,
            required: output.required ?? true
          }))
        }
      });

      // P1: Mark attempt as running now that we have the childRunId
      startTaskAttempt(attemptId, attemptRunId, Date.now());
      if (handoff) bindHandoffAttempt(handoff.id, attemptId, attemptRunId);

      try {
        await promise;
      } catch {
        // Run failed — continue to evaluation
      }

      if (acceptedHandoffForAttempt(attemptId)) {
        finishTaskAttempt(attemptId, "aborted", Date.now());
        updateTaskAttemptVerification(attemptId, "rejected", JSON.stringify({ reason: "Human accepted task handoff; old results are ineligible." }), Date.now());
        clearRunToolEvidence(attemptRunId);
        clearTaskResultsForRun(attemptRunId);
        return { taskId: task.id, status: "aborted", summary: "Task is being handed to another Agent.", childRunId: attemptRunId, verificationStatus: "rejected" };
      }

      // The delegation gate refuses BEFORE a run row exists, so the reason
      // cannot come from the database — the runner hands it back explicitly.
      // Without this the attempt was reported as "the agent never called
      // report_task_result", blaming the agent for a wiring refusal.
      const refusal = takeRunRefusalReason(attemptRunId);
      if (refusal) {
        console.error(`[conductor] task ${task.id} attempt ${attempt}: ${refusal}`);
        finalEvaluation = { status: "blocked", error: `delegation_refused: ${refusal}` };
        // The attempt row was opened with a child run id before the child
        // existed; the runner refused, so that id names nothing. Clear it
        // rather than leave an investigator chasing a run that was never made.
        clearTaskAttemptChildRun(attemptId, Date.now());
        finishTaskAttempt(attemptId, "blocked", Date.now());
        updateTaskAttemptVerification(
          attemptId,
          "rejected",
          JSON.stringify({ error: finalEvaluation.error }),
          Date.now()
        );
        // Do not let the post-loop verification rewrite an EARLIER attempt's
        // failure context with this refusal: finalAttemptId still points at the
        // previous attempt, and this break means there is no new one.
        finalAttemptId = "";
        finalRunId = "";
        break;
      }

      const report = getTaskReport(attemptRunId);
      const currentRunEvidence = getRunToolEvidence(attemptRunId);
      const replacedTaskId = getReplacedTaskId(task);
      const evidence = getTaskToolEvidence({
        conductorRunId: parentRunId,
        planId,
        taskIds: replacedTaskId ? [replacedTaskId, task.id] : [task.id],
        currentRunId: attemptRunId,
      });
      finalEvaluation = evaluateChildTaskResult(task, report, evidence);
      // P5: Capture this attempt's identity for the NEXT retry iteration.
      // These become previousAttemptId / previousChildRunId / previousError
      // in compileTaskContext → buildFailureContext on the next loop.
      previousRunId = attemptRunId;
      previousAttemptId = attemptId;
      previousError = finalEvaluation.error;
      // Also keep finalRunId/finalAttemptId for post-loop dispatch events
      // and verification-status updates.
      finalRunId = attemptRunId;
      finalAttemptId = attemptId;
      finalReport = report;

      // P7: Emit evidence.summary for frontend observability
      // P7: Emit evidence.summary — query SQLite ledger for full count,
      // not just the in-memory fileWrites + commands snapshot.
      let evidenceCount = currentRunEvidence.fileWrites.length + currentRunEvidence.commands.length;
      try {
        const ledgerRecords = listEvidenceForAttempt(attemptId);
        if (ledgerRecords.length > 0) {
          evidenceCount = ledgerRecords.length;
        }
      } catch {
        // Fall back to in-memory count if SQLite unavailable
      }
      eventBus.publish({
        type: "dispatch.evidence.summary",
        conversationId,
        timestamp: Date.now(),
        parentRunId,
        taskId: task.id,
        attemptId,
        childRunId: attemptRunId,
        evidenceCount,
      });

      // P4: Run verification engine against evidence ledger — always, not just on "complete"
      // This produces criterion verdicts even for failed tasks (explaining WHY it failed)
      try {
        const verification = await verifyTaskAttempt(task, attemptId, report);
        let persistedCount = 0;
        for (const v of verification.verdicts) {
          try {
            upsertCriterionVerdict({
              id: v.id,
              attemptId,
              criterionId: v.criterionId,
              validatorType: v.validatorType,
              status: v.status,
              evidenceIdsJson: JSON.stringify(v.evidenceIds),
              reason: v.reason,
              checkedAt: v.checkedAt,
            });
            persistedCount++;
          } catch (err) {
            // P4: Surface persistence failures — evidence-aware gate shouldn't silently drop verdicts
            console.error(`[conductor] failed to persist verdict ${v.criterionId} for attempt ${attemptId}:`, err);
          }
        }
        if (persistedCount === 0 && verification.verdicts.length > 0) {
          console.error(`[conductor] ALL verdict persistence failed for attempt ${attemptId} — evidence gate compromised`);
        }
        // P4: Verification can override the self-reported evaluation
        // P4: Capture verified output bindings from the verification result
        finalVerifiedBindings = verification.verifiedOutputBindings;

        if (verification.status === "rejected") {
          finalEvaluation = { status: "failed", error: `Verification rejected: ${verification.verdicts.filter(v => v.status === "failed").map(v => v.reason).join("; ")}` };
        } else if (verification.status === "needs_review" && finalEvaluation.status === "complete") {
          // needs_review on a self-reported-complete task → block it
          finalEvaluation = { status: "failed", error: `Verification incomplete: ${verification.verdicts.filter(v => v.status === "needs_review").map(v => v.reason).join("; ")}` };
        }

        // P7: Emit verification.updated with ACTUAL verdict counts, not binding count
        eventBus.publish({
          type: "dispatch.verification.updated",
          conversationId,
          timestamp: Date.now(),
          parentRunId,
          taskId: task.id,
          attemptId,
          status: verification.status === "verified" ? "verified"
            : verification.status === "needs_review" ? "needs_review"
            : "rejected",
          passedCount: verification.verdicts.filter(v => v.status === "passed").length,
          failedCount: verification.verdicts.filter(v => v.status === "failed").length,
        });
      } catch (err) {
        // P4: Verification engine crash → evidence gate compromised, reject the attempt
        console.error(`[conductor] verification engine CRASHED for task ${task.id} attempt ${attemptId}:`, err);
        finalEvaluation = { status: "failed", error: `Verification engine failure: ${err instanceof Error ? err.message : "unknown error"}` };

        // P7: Emit verification.updated on crash — no verdicts available
        eventBus.publish({
          type: "dispatch.verification.updated",
          conversationId,
          timestamp: Date.now(),
          parentRunId,
          taskId: task.id,
          attemptId,
          status: "rejected",
          passedCount: 0,
          failedCount: 1,
        });
      }

      clearRunToolEvidence(attemptRunId);
      clearTaskResultsForRun(attemptRunId);

      // P1: Both statuses belong to THIS attempt, not only to the last one.
      // Writing execution_status alone left every retried attempt reporting
      // `failed / not_started`, which reads as "verification never ran" when in
      // fact it ran and rejected — and hid the real reason, including
      // "没有调用 report_task_result". The blocked path above already writes both.
      // The post-loop update below still runs, because the missing-required-outputs
      // gate can re-judge the final attempt after the loop.
      const executionStatus = finalEvaluation.status === "complete" ? "reported_complete" : "failed";
      finishTaskAttempt(attemptId, executionStatus, Date.now());
      updateTaskAttemptVerification(
        attemptId,
        finalEvaluation.status === "complete" ? "verified" : "rejected",
        finalEvaluation.status !== "complete" ? JSON.stringify({ error: finalEvaluation.error }) : null,
        Date.now()
      );

      // P8: Incremental FTS rebuild — evidence + verdicts are now persisted,
      // so the FTS index should include this attempt's data for future searches.
      // NOTE: This does a full rebuild of both FTS tables per attempt.
      // For long conversations, consider debouncing or switching to
      // incremental upserts (INSERT into FTS directly from evidence collector).
      // For single-user MVP this is acceptable — rebuilds are fast on local SQLite.
      rebuildFtsForConversation(conversationId);

      if (finalEvaluation.status === "complete") break;
    }

    const report = finalReport;
    if (finalAttemptId && acceptedHandoffForAttempt(finalAttemptId)) {
      return { taskId: task.id, status: "aborted", summary: "Task is being handed to another Agent.", childRunId: finalRunId, verificationStatus: "rejected" };
    }

    // P0: Check for missing required outputs — fail before binding anything
    const verifiedOutputKeys = new Set(finalVerifiedBindings.map((binding) => binding.outputKey));
    const missingRequiredOutputs = (task.expectedOutputs ?? [])
      .filter((eo) => eo.required)
      .filter((eo) => !verifiedOutputKeys.has(eo.id));
    if (missingRequiredOutputs.length > 0 && finalEvaluation.status === "complete") {
      const missingKeys = missingRequiredOutputs.map((eo) => eo.id).join(", ");
      console.warn(
        `[output-binding] task ${task.id}: required outputs missing: ${missingKeys} — marking as failed`
      );
      finalEvaluation = { status: "failed", error: `Missing required outputs: ${missingKeys}` };
    }

    // P1: Update verification status on the final attempt
    const verificationStatus = finalEvaluation.status === "complete" ? "verified" : "rejected";
    if (finalAttemptId) {
      updateTaskAttemptVerification(
        finalAttemptId,
        verificationStatus,
        finalEvaluation.status !== "complete" ? JSON.stringify({ error: finalEvaluation.error }) : null,
        Date.now()
      );
    }

    // ── P4: Output binding — verifiedOutputBindings is the SOLE authority ──
    // The verification engine already validated each binding against:
    //   - artifact_created evidence matching outputKey + artifactId
    //   - artifact conversation ownership
    //   - expected output type alignment
    // Only bindings that passed verification may propagate downstream.
    // There is NO fallback path that trusts agent self-report (report.artifacts).

    if (finalEvaluation.status === "complete" && finalVerifiedBindings.length > 0) {
      for (const binding of finalVerifiedBindings) {
        const { outputKey, artifactId, evidenceIds } = binding;

        // Safety check: artifact must still exist and belong to this conversation
        const art = getArtifact(artifactId);
        if (!art || art.conversationId !== conversationId) {
          console.warn(
            `[output-binding] task ${task.id}: verified artifact "${artifactId}" missing or wrong conversation — rejected`
          );
          continue;
        }

        // Validate against expectedOutputs declaration
        const expectedOutput = task.expectedOutputs?.find((o) => o.id === outputKey);
        if (!expectedOutput) {
          console.warn(
            `[output-binding] task ${task.id}: verified outputKey "${outputKey}" not declared in expectedOutputs — rejected`
          );
          continue;
        }

        if (expectedOutput.type && art.type !== expectedOutput.type) {
          console.warn(
            `[output-binding] task ${task.id}: artifact type "${art.type}" ≠ expected "${expectedOutput.type}" for "${outputKey}" — rejected`
          );
          continue;
        }

        console.log(
          `[output-binding] task ${task.id}: binding "${outputKey}" → ${artifactId} (evidence: ${evidenceIds.join(", ") || "none"})`
        );
        const logicalProducerTaskId = task.replacesTaskId ?? task.id;
        outputBindings.set(`${task.id}.${outputKey}`, artifactId);
        outputBindings.set(`${logicalProducerTaskId}.${outputKey}`, artifactId);
        if (task.replacesTaskId) {
          supersedeOutputBinding({
            conductorRunId: parentRunId,
            producerTaskId: task.replacesTaskId,
            outputKey,
            replacedByTaskId: task.id,
            now: Date.now(),
          });
        }
        persistOutputBinding({
          conductorRunId: parentRunId, planId,
          producerTaskId: logicalProducerTaskId,
          actualProducerTaskId: task.replacesTaskId ? task.id : undefined,
          outputKey,
          artifactId,
          now: Date.now()
        });
      }
    } else if (finalEvaluation.status === "complete" && finalVerifiedBindings.length === 0) {
      // P4: No verified bindings produced — verification engine may have no
      // artifact-typed criteria, or the task had no expectedOutputs. This is
      // NOT an error: some tasks (e.g. code review) legitimately produce no
      // artifact outputs. Log at info level, not warn.
      console.log(
        `[output-binding] task ${task.id}: evaluation complete but zero verified bindings — nothing to propagate`
      );
    }

    // P1.4: Map "blocked" → "failed" for dispatch.end event
    const dispatchStatus: "complete" | "failed" | "aborted" | "skipped" =
      finalEvaluation.status === "blocked" ? "failed" : finalEvaluation.status;

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
      error: finalEvaluation.error
    });

    // Legacy dispatch.end — keep for backward compatibility
    eventBus.publish({
      type: "dispatch.end", conversationId, timestamp: Date.now(),
      parentRunId, childRunId: finalRunId, taskId: task.id,
      status: dispatchStatus,
      error: finalEvaluation.error
    });

    return {
      taskId: task.id,
      status: finalEvaluation.status === "complete" ? "complete" : "failed",
      summary: finalEvaluation.status === "complete"
        ? report?.summary ?? `Task "${task.title}" completed.`
        : finalEvaluation.error ?? report?.summary ?? `Task "${task.title}" failed.`,
      childRunId: finalRunId,
      verificationStatus
    };
  } catch (err) {
    // The attempt row is created before the child run and only finished at the end of
    // the iteration, so a throw in between leaves it non-terminal forever. The same
    // throw also kills the whole plan: executeConductorPlan awaits runChildTask through
    // Promise.all with no catch of its own. Finish the in-flight row, then let the
    // error propagate so the failure is still visible and the run is not silently
    // declared healthy.
    if (currentAttemptId) {
      // Best-effort: never let the repair replace the real failure. If this write
      // throws, the original error is what the run must record, so it is logged and
      // swallowed rather than substituted for `err` below.
      try {
        failOpenTaskAttempt(
          currentAttemptId,
          err instanceof Error ? err.message : String(err),
          Date.now()
        );
      } catch (repairError) {
        console.error(
          `[conductor] failed to finish in-flight attempt ${currentAttemptId} after an error:`,
          repairError
        );
      }
    }
    throw err;
  } finally {
    release?.();
  }
}

function hydrateOutputBindings(outputBindings: Map<string, string>, planId: string): Map<string, string> {
  const hydrated = new Map(outputBindings);
  try {
    for (const row of listOutputBindings(planId)) {
      const producerTaskId = typeof row.producer_task_id === "string" ? row.producer_task_id : "";
      const outputKey = typeof row.output_key === "string" ? row.output_key : "";
      const artifactId = typeof row.artifact_id === "string" ? row.artifact_id : "";
      if (!producerTaskId || !outputKey || !artifactId) continue;

      const bindingKey = `${producerTaskId}.${outputKey}`;
      if (!hydrated.has(bindingKey)) {
        hydrated.set(bindingKey, artifactId);
      }
    }
  } catch {
    // Persistence is a fallback; in-memory bindings remain authoritative.
  }
  return hydrated;
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
  messageId: string,
  signal: AbortSignal,
  piConfiguration?: PiProviderSnapshot
): Promise<void> {
  const agents = listAgents();
  const agent = agents.find((a) => a.id === conductorAgentId);
  const harness = agent ? getHarness(agent.adapterName) : null;
  if (!agent || !harness) {
    // Fallback to template summary
    await generateAggregateFallback(conversationId, messageId, conductorRunId, results, plan, outputBindings);
    return;
  }

  const conversation = getConversation(conversationId);
  const workspace = getWorkspaceForConversation(conversationId);
  if (!conversation || !workspace) {
    await generateAggregateFallback(conversationId, messageId, conductorRunId, results, plan, outputBindings);
    return;
  }

  const settings = getSettings();
  const apiKey = piConfiguration ? piConfiguration.apiKey : resolveApiKey(agent.modelProvider ?? "deepseek", agent.apiKey, settings);
  if (!apiKey) {
    await generateAggregateFallback(conversationId, messageId, conductorRunId, results, plan, outputBindings);
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
  const aggregateTools = provisionedPlatformToolNames().filter((t) => t !== "ask_user");

  const invocationInput: PiInvocationInput = {
    conversationId,
    runId: conductorRunId,
    agent: { ...agent, toolNames: aggregateTools, systemPrompt: aggregateSystemPrompt },
    conversation,
    workspace,
    triggerMessage: { ...triggerMessage, parts: [{ type: "text", content: aggregateUserPrompt }] },
    recentMessages: [],
    toolNames: aggregateTools,
    systemPrompt: aggregateSystemPrompt,
    ...piConfiguration,
    workspacePath: workspace.mode === "local" && workspace.boundPath ? workspace.boundPath : workspace.rootPath,
    apiKey
  };

  // Route the aggregate stream through consumeStream so every event carries the
  // conductor's messageId, its parts are persisted, and the summary survives a refresh.
  // (Previously events were published straight from the adapter with messageId: "",
  // and the client reducer dropped them because state.messages[""] is undefined.)
  await consumeStream({
    stream: harness.run(invocationInput, signal),
    messageId,
    runId: conductorRunId,
    signal,
    // Preserve parts streamed by earlier stages (the assess/plan turn) in the same message.
    initialParts: getMessage(messageId)?.parts ?? []
  });
}

export async function generateAggregateFallback(
  conversationId: string,
  messageId: string,
  conductorRunId: string,
  results: Map<string, TaskResult>,
  plan: ParsedTask[],
  outputBindings?: Map<string, string>
): Promise<void> {
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

  // Persist the fallback onto the conductor's own message so it is visible live and after refresh.
  await consumeStream({
    stream: singleTextPartStream(conversationId, lines.join("\n")),
    messageId,
    runId: conductorRunId,
    initialParts: getMessage(messageId)?.parts ?? []
  });
}

/** Synthesize a one-part stream so non-streamed fallback text flows through consumeStream. */
async function* singleTextPartStream(conversationId: string, content: string): AsyncIterable<StreamEvent> {
  const timestamp = Date.now();
  const part: MessagePart = { type: "text", content };
  yield { type: "part.start", conversationId, timestamp, messageId: "", partIndex: 0, part };
  yield { type: "part.end", conversationId, timestamp, messageId: "", partIndex: 0 };
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

// ── P8: FTS rebuild helper ──────────────────────────────────────────────────

/** Fire-and-forget FTS rebuild after task attempt completion. */
function rebuildFtsForConversation(conversationId: string): void {
  try {
    rebuildAllFts(conversationId);
  } catch (err) {
    // FTS rebuild must never block the conductor or fail a task
    console.error(`[conductor] FTS rebuild failed for ${conversationId}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Conductor assess — flexible LLM call that can produce direct response OR plan
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompt builders — independent, testable pure functions
// ---------------------------------------------------------------------------

/** Tools available to the Conductor during the PLAN (assess) stage only */
export const CONDUCTOR_PLAN_TOOLS = [
  // The roster tool is permitted here and nowhere else: a planner needs the
  // member list, and the roster is conversation-scoped (see tool-surface.ts).
  CONVERSATION_ROSTER_TOOL,
  "update_context_facts",
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

// ── P0: Minimal Context Envelope ──────────────────────────────────────────

interface MinimalEnvelopeFailureHint {
  previousAttemptId: string;
  error: string;
}

export function buildMinimalContextEnvelope(
  identity: TaskExecutionIdentity,
  task: ParsedTask,
  resolvedInputs: ReturnType<typeof resolveTaskInputs>,
  upstreamArtifacts: UpstreamArtifact[],
  failureHint?: MinimalEnvelopeFailureHint
): TaskContextEnvelope {
  const manifestItems: ContextManifestItem[] = [];
  const now = Date.now();
  manifestItems.push({
    id: `ctx_obj_${identity.attemptId}`, category: "task", sourceType: "plan",
    sourceId: identity.planId, reason: "task objective", required: true,
    trustLevel: "authoritative", tokenEstimate: Math.ceil(task.prompt.length / 4),
    included: true, omittedReason: null
  });
  if (failureHint) {
    manifestItems.push({
      id: `ctx_fail_${identity.attemptId}`, category: "failure", sourceType: "evaluation",
      sourceId: failureHint.previousAttemptId,
      reason: `previous attempt failed: ${failureHint.error}`,
      required: true, trustLevel: "verified", tokenEstimate: 0, included: true, omittedReason: null
    });
  }
  return {
    schemaVersion: 1, policyVersion: "evidence-context-p0-v1",
    identity: {
      conductorRunId: identity.conductorRunId, planId: identity.planId,
      planRevision: identity.planRevision, taskId: identity.taskId,
      attemptId: identity.attemptId, attempt: identity.attempt,
      contextSnapshotId: identity.contextSnapshotId
    },
    task: { title: task.title, objective: task.prompt, assignedAgentId: task.agentId, dependsOn: task.dependsOn },
    requirements: buildRequirements(task, []),
    upstreamInputs: resolvedInputs.filter(ri => ri.artifactId).map(ri => ({ fromTaskId: ri.fromTaskId, outputKey: ri.outputId, artifactId: ri.artifactId!, artifactVersion: 0, artifactType: "unknown", title: ri.outputId, verificationId: "", evidenceIds: [] })),
    failureContext: failureHint ? { previousAttemptId: failureHint.previousAttemptId, previousChildRunId: "", failedCriteria: [], failedEvidenceIds: [], failedCommands: [], missingOutputs: [], changedFiles: [], retryInstructions: [`Previous attempt failed: ${failureHint.error}`] } : null,
    blocked: false,
    includedContextItems: [],
    manifest: manifestItems,
    budget: { maxInputTokens: 0, requiredTokens: 0, optionalTokens: 0, omittedTokens: 0 },
    createdAt: now
  };
}

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
  // The tools the PLAN stage actually gets (CONDUCTOR_PLAN_TOOLS), not the
  // agent record's list: a conductor configured with bash still cannot run a
  // command while planning, and telling it it can would contradict the stage
  // instructions two blocks down.
  blocks.push(workspaceInfoBlock([...CONDUCTOR_PLAN_TOOLS, "consult_agent"], workspacePath));

  // Block 2: Conductor persona
  blocks.push(agent.systemPrompt);

  // Block 3: PLAN dynamic instructions
  blocks.push(`## 你的工作流
1. 阅读用户最新请求与上下文。
2. 在调用任何工具前，先基于语义判断当前请求属于：
   - DISCUSSION：用户在讨论方案、征求意见、询问进度或解释，尚未授权实际交付。
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
5. DISCUSSION 时直接对话；需要专业意见且工具可用时调用 consult_agent，不调用 plan_tasks，不强制创建 PRD、风格指南或其他产物。
   用户说“先别改”“先讨论”时，即使点名多位 Agent 也只进行咨询；不能把咨询结果当作用户已经批准执行。
   如果判断为 READY_TO_PLAN，直接调用 plan_tasks，不要为了形式感提问。
   例如用户已明确“React+TS、25+5、极简、不需要后端”，或明确说“细节你决定”。
6. 系统会自动执行 plan 并把子任务结果回传给你，由你做最终总结。
7. 用户明确指定两个或以上角色执行实际交付、明确要求“先由 A 再由 B”执行、或明确要求 Agent 间正式产物交接时，
   信息充分后你必须调用 plan_tasks；单个专业 Agent 足够时，计划只需一个任务，不额外插入需求、设计或审查步骤。
   上述规则不适用于只读咨询或讨论。这些平台规则优先于角色模板里固定的多角色工作流。

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
- 只有存在实际输入依赖的角色才用 dependsOn 串起来；不要因为角色不同或带有“审查/测试”字样就强制串行。
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
- 计划阶段只能调用 ask_user、plan_tasks、已授权的 consult_agent 和只读侦察工具
  （fs_list / fs_read / read_artifact / read_attachment）；不要写文件或执行命令。
- DISCUSSION 时直接回复或受控咨询；NEEDS_CLARIFICATION 时先 ask_user；READY_TO_PLAN 时直接 plan_tasks。
- 给工程类 Agent 写任务时，不要把“必须先 npm install / npm run dev”作为硬流程；如果确实需要安装依赖，只写“需要时通过 bash 发起依赖安装审批”。验证优先写 build/test/lint/typecheck/check。

## 依赖关系（执行顺序的唯一来源，务必读完）
- 系统【只】按每个任务的 dependsOn 决定顺序：
  dependsOn 为空的任务会【同时并发】启动。
- 若任务 B 需要任务 A 的产物 / 结论 / 输出，
  你【必须】在 B 的 dependsOn 里写上 A 的 id。
- 在 task 文本里写「先做 A」「基于上一步」之类【没有任何效果】
  ——执行顺序只认 dependsOn 字段。
- 彼此独立的任务留空 dependsOn；不确定实际输入时先澄清，不用无关依赖掩盖不确定性。
- Only declare expectedOutputs when the assigned agent must create a real artifact
  via write_artifact for downstream handoff or user inspection.
- Reviewer tasks use the standard review_report document output so the review can
  be verified and handed off. Only ad-hoc validation, diagnosis, status checks,
  explanations, or summaries that need no persisted handoff may omit expectedOutputs.
- If a task needs an upstream artifact, declare inputs with fromTaskId and outputId.
- For tasks with quality requirements, add concise acceptanceCriteria.

示例（只演示字段和依赖关系，agentId 均来自本次 <allowed_agent_ids>）：
${exampleTasks}`);

  // P2: Fact extraction guidance
  blocks.push(buildFactExtractionGuidance());

  // P5: Standard role output contracts
  const contractGuidance = buildContractGuidance(otherAgents);
  if (contractGuidance) blocks.push(contractGuidance);

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
    // Every member is provisioned with the whole Pi toolset (issue #79); the
    // stored grants are a record only, so reporting them would tell the planner
    // a capable member cannot do the work.
    tools: provisionedPlatformToolNames(),
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
    return r && (r.status === "failed" || r.status === "blocked");
  });

  // P5: Include verification-level detail — which criteria failed and why
  const parts: string[] = [];
  for (const t of failedTasks) {
    const r = results.get(t.id);
    const summary = r?.summary ?? "unknown error";
    parts.push(`- ${t.id} (${t.title}): ${summary}`);

    // P5: Query verdicts for this task to give precise failure reasons.
    // Scope by conductor_run_id (derived from childRunId) + task_id.
    try {
      const db = getDatabase();
      // Use childRunId → task_attempts to get the authoritative conductor_run_id
      let conductorRunId = "";
      if (r?.childRunId) {
        const runRow = db
          .prepare("SELECT conductor_run_id FROM task_attempts WHERE child_run_id = ? LIMIT 1")
          .get(r!.childRunId) as { conductor_run_id: string } | undefined;
        conductorRunId = runRow?.conductor_run_id ?? "";
      }
      if (conductorRunId) {
        const vRows = db
          .prepare(`SELECT cv.criterion_id, cv.status, cv.reason
            FROM criterion_verdicts cv
            JOIN task_attempts ta ON cv.attempt_id = ta.id
            WHERE ta.conductor_run_id = ? AND ta.task_id = ?
            ORDER BY ta.attempt DESC LIMIT 20`)
          .all(conductorRunId, t.id) as Array<{ criterion_id: string; status: string; reason: string }>;
        for (const v of vRows) {
          if (v.status !== "passed") {
            parts.push(`    ❌ ${v.criterion_id} (${v.status}): ${v.reason}`);
          }
        }
      }
    } catch { /* best-effort */ }
  }

  const passedTasks = plan.filter((t) => {
    const r = results.get(t.id);
    return r && r.status === "complete";
  });
  const passedList = passedTasks.map((t) => `- ${t.id} (${t.title}): ✅ 已完成，无需重新执行`).join("\n");

  return [
    `上一轮执行结果：${failedTasks.length} 失败, ${passedTasks.length} 成功`,
    "",
    failedTasks.length > 0 ? `失败任务（含验收详情）：\n${parts.join("\n")}` : "",
    passedTasks.length > 0 ? `已完成任务：\n${passedList}` : "",
    "",
    "补救指示：只修复失败任务。已完成任务可作为上游依赖直接引用。修复任务必须通过所有验收标准。",
  ].filter(Boolean).join("\n");
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

/** Forward a planning failure to the sole terminal-state owner. */
export function failConductor(error: string, category = "conductor_contract"): never {
  // Only agent-runner owns terminal publication, message settlement and cleanup.
  throw new PiRuntimeError(error, category);
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
  const harness = agent ? getHarness(agent.adapterName) : null;
  if (!agent || !harness) {
    createSystemMessage(input.conversationId, "⚠️ Conductor 需要配置 Pi 执行引擎。");
    failConductor("Conductor requires the Pi execution engine.", "migration_required");
    return { mode: "direct" };
  }

  const conversation = getConversation(input.conversationId);
  const workspace = getWorkspaceForConversation(input.conversationId);
  if (!conversation || !workspace) {
    createSystemMessage(input.conversationId, "⚠️ 会话或工作区未找到。");
    failConductor("Conversation or workspace not found.", "configuration");
    return { mode: "direct" };
  }

  const settings = getSettings();
  const provider = agent.modelProvider ?? "deepseek";
  const apiKey = input.piConfiguration ? input.piConfiguration.apiKey : resolveApiKey(provider, agent.apiKey, settings);
  if (!apiKey) {
    // Name the provider the agent is actually configured with: the Conductor is
    // not necessarily on DeepSeek, and a message that says otherwise sends the
    // user to the wrong settings field. `openai-compatible` is per-agent only —
    // resolveApiKey deliberately never falls back to settings or the environment
    // for it — so pointing at the settings panel would be wrong outright.
    createSystemMessage(
      input.conversationId,
      provider === "openai-compatible"
        ? `⚠️ 该 Conductor 使用 provider "openai-compatible"，其 API Key 只能配置在 Agent 上（不会读取全局设置或环境变量）。请编辑该 Agent 填入 Key。`
        : `⚠️ 缺少 provider "${provider}" 的 API Key，请在设置中为该 provider 配置后再试。`
    );
    failConductor("No API key configured.", "authentication");
    return { mode: "direct" };
  }

  const otherAgents = agents.filter((a) => !a.isConductor && input.availableAgentIds.includes(a.id));
  const workspacePath = workspace.mode === "local" && workspace.boundPath
    ? workspace.boundPath : workspace.rootPath;

  // Build the PLAN stage system prompt from the extracted pure function
  const assessSystemPrompt = buildConductorPlanPrompt(agent, otherAgents, workspacePath);
  const assessToolNames: string[] = [...CONDUCTOR_PLAN_TOOLS];
  assessToolNames.push("consult_agent");
  const { history, recentMessages } = await buildCollaborationHistory({
    agent, triggerMessage: input.triggerMessage, systemPrompt: assessSystemPrompt, currentText: userText,
  });
  const invocationInput: PiInvocationInput = {
    conversationId: input.conversationId,
    runId: input.conductorRunId,
    agent: { ...agent, toolNames: assessToolNames, systemPrompt: assessSystemPrompt },
    conversation,
    workspace,
    triggerMessage: { ...input.triggerMessage, parts: [{ type: "text", content: userText }, ...input.triggerMessage.parts.filter(part => part.type !== "text")] },
    recentMessages,
    history,
    toolNames: assessToolNames,
    systemPrompt: assessSystemPrompt,
    ...input.piConfiguration,
    workspacePath,
    apiKey,
    onTaskAccepted: input.onTaskAccepted,
    onContextCaptured: input.onContextCaptured,
  };

  // Pi owns model deadlines; approval waits must not inherit a one-minute HTTP timeout.
  const signal = input.signal ?? new AbortController().signal;

  // Stream events AND watch for plan_tasks via onEvent callback
  // We capture on tool.result (success) rather than tool.call, because the tool handler
  // may auto-correct agent IDs before returning success.
  let capturedPlan: { reasoning: string; tasks: Array<Record<string, unknown>> } | null = null;
  let planCallId: string | null = null;
  let planWasAttempted = false;

  try {
    await consumeStream({
      stream: harness.run(invocationInput, signal),
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
    input.signal?.throwIfAborted();
    // A plan receipt does not excuse protocol, provider or teardown failure.
    // The run owner records the one terminal event with the Pi error category.
    throw err;
  }

  // If plan_tasks was captured, validate and return plan mode
  if (capturedPlan) {
    const planResult = parsePlanArgs(capturedPlan);
    if (typeof planResult === "string") {
      createSystemMessage(input.conversationId, `⚠️ Plan 校验失败：${planResult}`);
      failConductor(`invalid_plan: ${planResult}`);
      return { mode: "direct" };
    }
    return { mode: "plan", plan: planResult };
  }

  // Plan was attempted but failed — fail the run
  if (planWasAttempted) {
    createSystemMessage(input.conversationId, "⚠️ Conductor 未能生成有效计划，请重试或简化需求。");
    failConductor("conductor_contract: plan_tasks failed");
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
  signal: AbortSignal,
  piConfiguration?: PiProviderSnapshot
): Promise<{ reasoning: string; tasks: RecoveryTask[] } | null> {
  const agents = listAgents();
  const agent = agents.find((a) => a.id === conductorAgentId);
  const harness = agent ? getHarness(agent.adapterName) : null;
  if (!agent || !harness) return null;

  const conversation = getConversation(conversationId);
  const workspace = getWorkspaceForConversation(conversationId);
  if (!conversation || !workspace) return null;

  const settings = getSettings();
  const apiKey = piConfiguration ? piConfiguration.apiKey : resolveApiKey(agent.modelProvider ?? "deepseek", agent.apiKey, settings);
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
- 每个恢复任务必须填写 replacesTaskId，且只能填写下面失败任务中的一个原任务 id。
- 一个失败原任务最多生成一个恢复任务；不要为 skipped 任务生成恢复任务，平台会在上游恢复后自动继续它。
- 恢复任务应继续交给原任务的专业 Agent；平台会强制继承原任务的 inputs、expectedOutputs、acceptanceCriteria、targetPaths、requiredCommands 和 requiredEvidence。
- 不要自行填写或修改上述契约字段，它们不会被采信。
- dependsOn 可以引用已经成功的原始任务 id。

## 可替换的失败任务
${originalPlan
  .filter((task) => {
    const status = results.get(task.id)?.status;
    return status === "failed" || status === "blocked";
  })
  .map((task) => `- id: "${task.id}", agentId: "${task.agentId}", title: "${task.title}"`)
  .join("\n")}`;

  const invocationInput: PiInvocationInput = {
    conversationId,
    runId: conductorRunId,
    agent: { ...agent, toolNames: ["plan_tasks"], systemPrompt },
    conversation,
    workspace,
    triggerMessage: { id: "", conversationId, origin: "internal", role: "user", agentId: null, runId: null,
      parts: [{ type: "text", content: recoveryPrompt }], status: "complete",
      mentionedAgentIds: [], parentMessageId: null, createdAt: Date.now(), updatedAt: Date.now() },
    recentMessages: [],
    toolNames: ["plan_tasks"],
    systemPrompt,
    workspacePath,
    apiKey,
    ...piConfiguration
  };

  let capturedPlan: { reasoning: string; tasks: Array<Record<string, unknown>> } | null = null;
  let planCallId: string | null = null;

  try {
    for await (const event of harness.run(invocationInput, signal)) {
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

  const replacementIds = new Map(
    planResult.tasks.map((task) => [task.id, task.replacesTaskId])
  );
  const proposedTasks: ParsedTask[] = compiled.map((task) => ({
    id: task.id,
    replacesTaskId: replacementIds.get(task.id),
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
    taskIntent: task.taskIntent,
    contractProfile: task.contractProfile,
    contractSelectionReason: task.contractSelectionReason,
    contractSelectionVersion: task.contractSelectionVersion,
    targetPaths: task.targetPaths ?? [],
    requiredCommands: task.requiredCommands ?? [],
    requiredEvidence: task.requiredEvidence ?? []
  }));

  return {
    reasoning: planResult.reasoning,
    tasks: bindRecoveryTasksToOriginalPlan(proposedTasks, originalPlan, results)
  };
}

function getReplacedTaskId(task: ParsedTask): string | null {
  const candidate = (task as Partial<RecoveryTask>).replacesTaskId;
  return typeof candidate === "string" && candidate.length > 0 && candidate !== task.id
    ? candidate
    : null;
}

export function enforceExplicitFrameworkContracts(
  plan: ParsedTask[],
  userText: string
): ParsedTask[] {
  const frameworks = detectExplicitFrameworks(userText);
  if (frameworks.length === 0) return plan;

  const frameworkLabel = frameworks.join(" / ");
  const policyMarker = "## 平台显式框架契约";

  return plan.map((task) => {
    const producesWebApp = task.expectedOutputs.some((output) => output.type === "web_app");
    if (!producesWebApp) return task;

    const targetPaths = [...new Set([...(task.targetPaths ?? []), "package.json"])];
    const requiredCommands = [...(task.requiredCommands ?? [])];
    if (!requiredCommands.some((entry) => /\bbuild\b/i.test(entry.command))) {
      requiredCommands.push({ command: "npm run build", timeoutMs: 120_000 });
    }

    const frameworkPolicy = [
      policyMarker,
      `原始用户请求明确指定 ${frameworkLabel}。该技术栈是硬性验收条件，不得降级成单文件静态 HTML、CDN UMD 或浏览器 Babel。`,
      "必须在 workspace 中创建 package.json 和对应源码，使用 npm install / npm ci 安装依赖，运行 npm run build 并取得 exitCode 0。",
      "build 成功后部署真实构建目录，并在 deploy_workspace 成功后调用 report_task_result。",
    ].join("\n");

    return {
      ...task,
      prompt: task.prompt.includes(policyMarker)
        ? task.prompt
        : `${task.prompt}\n\n${frameworkPolicy}`,
      targetPaths,
      requiredCommands,
    };
  });
}

function detectExplicitFrameworks(userText: string): string[] {
  const candidates: Array<[string, RegExp]> = [
    ["React", /\breact(?:\.js)?\b/i],
    ["Vite", /\bvite\b/i],
    ["Next.js", /\bnext(?:\.js)?\b/i],
    ["Vue", /\bvue(?:\.js)?\b/i],
    ["Nuxt", /\bnuxt(?:\.js)?\b/i],
    ["Svelte", /\bsvelte(?:kit)?\b/i],
  ];
  return candidates
    .filter(([, pattern]) => pattern.test(userText))
    .map(([name]) => name);
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
