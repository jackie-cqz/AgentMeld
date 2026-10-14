// ---------------------------------------------------------------------------
// P3: Context Renderer — renders TaskContextEnvelope as a model prompt
// Replaces child-prompt-builder's buildChildTaskPrompt for compiled contexts.
// ---------------------------------------------------------------------------

import { humanReviewedCriteria } from "@/server/acceptance-criteria";
import type { TaskContextEnvelope } from "@/shared/task-context-types";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderTaskContextPrompt(envelope: TaskContextEnvelope): string {
  const { identity, task, requirements, upstreamInputs, failureContext, manifest, blocked, includedContextItems } = envelope;
  const parts: string[] = [];

  if (blocked) {
    parts.push(`[TASK CONTEXT OVERFLOW]`);
    parts.push(`Mandatory context (${envelope.budget.requiredTokens} tokens) exceeds budget (${envelope.budget.maxInputTokens} tokens).`);
    parts.push(`This task cannot be executed. Conductor must replan with fewer/smaller dependencies.`);
    return parts.join("\n");
  }

  // P3: Render from includedContextItems when available (packed results)
  const factItems = includedContextItems.filter(c => c.category === "fact");
  const wsItems = includedContextItems.filter(c => c.category === "workspace");
  const msgItems = includedContextItems.filter(c => c.category === "recent_message");

  // P1: Render Task State first — structured status before material
  if (envelope.taskState) {
    parts.push(`<task_state>`);
    const ts = envelope.taskState;
    parts.push(`  <status>taskId: ${escapeXml(ts.taskId)} | agent: ${escapeXml(ts.agentId)} | role: ${ts.role ?? "unknown"} | attempt: ${ts.attempt} | status: ${ts.executionStatus}</status>`);
    if (ts.requiredInputs.length > 0) {
      parts.push(`  <required_inputs>`);
      for (const ri of ts.requiredInputs) {
        const flags = [!ri.available && "missing", ri.available && !ri.read && "unread"].filter(Boolean).join(", ");
        parts.push(`    <input key="${escapeXml(ri.key)}" available="${ri.available}" read="${ri.read}"${flags ? ` flags="${flags}"` : ""}>${escapeXml(ri.title)}</input>`);
      }
      parts.push(`  </required_inputs>`);
    }
    if (ts.failedCriteria.length > 0) {
      parts.push(`  <failed_criteria>`);
      for (const fc of ts.failedCriteria) {
        parts.push(`    <criterion id="${escapeXml(fc.criterionId)}">${escapeXml(fc.description)}</criterion>`);
      }
      parts.push(`  </failed_criteria>`);
    }
    if (ts.failedCommands.length > 0) {
      parts.push(`  <failed_commands>`);
      for (const fc of ts.failedCommands) {
        parts.push(`    <command exit="${fc.exitCode}">${escapeXml(fc.command)}</command>`);
      }
      parts.push(`  </failed_commands>`);
    }
    parts.push(`  <next_action>${escapeXml(ts.nextActionHint)}</next_action>`);
    parts.push(`</task_state>`);
    parts.push("");
  }

  parts.push(`<task_context`);
  parts.push(`  context_id="${escapeXml(identity.contextSnapshotId)}"`);
  parts.push(`  policy_version="${escapeXml(envelope.policyVersion)}"`);
  parts.push(`  task_id="${escapeXml(identity.taskId)}"`);
  parts.push(`  attempt="${identity.attempt}"`);
  parts.push(`>`);

  // Objective
  parts.push(`  <objective>${escapeXml(task.objective)}</objective>`);

  // Constraints / active facts
  if (requirements.constraints && requirements.constraints.length > 0) {
    parts.push(`  <constraints>`);
    for (const c of requirements.constraints) {
      const fact = c as { canonicalKey?: string; value?: unknown; description?: string };
      if (fact.canonicalKey) {
        const trustLevel = factItems.find(item =>
          (item.content as { canonicalKey?: string }).canonicalKey === fact.canonicalKey
        )?.trustLevel ?? "reported";
        const val = typeof fact.value === "object" ? JSON.stringify(fact.value) : String(fact.value ?? "");
        parts.push(`    <constraint key="${escapeXml(fact.canonicalKey)}" trust="${escapeXml(trustLevel)}">${escapeXml(val)}</constraint>`);
      }
    }
    parts.push(`  </constraints>`);
  }

  // Verified inputs
  if (upstreamInputs.length > 0) {
    parts.push(`  <verified_inputs>`);
    for (const input of upstreamInputs) {
      const inp = input as { fromTaskId?: string; outputKey?: string; artifactId?: string; artifactVersion?: number; title?: string };
      if (inp.artifactId) {
        parts.push(`    <input from="${escapeXml(inp.fromTaskId ?? "")}" outputKey="${escapeXml(inp.outputKey ?? "")}" artifactId="${escapeXml(inp.artifactId)}" version="${inp.artifactVersion ?? 1}" title="${escapeXml(inp.title ?? "")}" />`);
      }
    }
    parts.push(`  </verified_inputs>`);
  }

  // P3: Workspace state from packed wsItems
  if (wsItems.length > 0) {
    parts.push(`  <workspace_state>`);
    for (const ws of wsItems) {
      const wp = ws.content as {
        path?: string;
        refType?: string;
        refId?: string;
        readTool?: string;
        entries?: Array<{ path: string; type: "file" | "directory" }>;
        truncated?: boolean;
        note?: string;
      };
      if (wp.refType === "file" && wp.refId) {
        parts.push(`    <file_reference path="${escapeXml(wp.refId)}" readTool="${escapeXml(wp.readTool ?? "fs_read")}" />`);
      }
      if (wp.path) parts.push(`    <target_path>${escapeXml(wp.path)}</target_path>`);
      if (Array.isArray(wp.entries)) {
        parts.push(`    <workspace_snapshot truncated="${wp.truncated ? "true" : "false"}">`);
        if (wp.note) parts.push(`      <note>${escapeXml(wp.note)}</note>`);
        for (const entry of wp.entries) {
          parts.push(`      <entry type="${escapeXml(entry.type)}" path="${escapeXml(entry.path)}" />`);
        }
        parts.push(`    </workspace_snapshot>`);
      }
    }
    parts.push(`  </workspace_state>`);
  }

  // Expected outputs
  if (requirements.expectedOutputs && requirements.expectedOutputs.length > 0) {
    parts.push(`  <expected_outputs>`);
    for (const eo of requirements.expectedOutputs) {
      parts.push(`    <output key="${escapeXml(eo.outputKey)}" type="${escapeXml(eo.type ?? "unknown")}" required="${eo.required}" />`);
    }
    parts.push(`  </expected_outputs>`);
  }

  // P3: Recent messages from packed msgItems
  if (msgItems.length > 0) {
    parts.push(`  <recent_messages>`);
    for (const msg of msgItems) {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      parts.push(`    <message source="${escapeXml(msg.sourceType)}">${escapeXml(content)}</message>`);
    }
    parts.push(`  </recent_messages>`);
  }

  // Evidence contract.
  //
  // Every item below is enforced by evaluateChildTaskResult, so it has to be
  // rendered: requirements the agent never sees are requirements it cannot meet.
  // This block used to hold only comments, which made group tasks fail on
  // "缺少必需证据说明" / "验收标准漏报" / "缺少成功命令证据" no matter what the
  // agent did (issue #11).
  //
  // The arrays are read defensively (`?? []`): they are required by the envelope
  // type, so every producer is checked at compile time, but an envelope parsed
  // from stored JSON is not.
  const targetPaths = requirements.targetPaths ?? [];
  const requiredCommands = requirements.requiredCommands ?? [];
  const requiredEvidence = requirements.requiredEvidence ?? [];
  // Only the criteria the report is actually judged on — the evaluator filters
  // auto-verified contract criteria out of check ⑤, and rendering those made the
  // agent report them as results, which then failed check ④.
  const reviewedCriteria = humanReviewedCriteria(requirements.acceptanceCriteria ?? []);

  parts.push(`  <evidence_contract>`);
  parts.push(`    <!-- All tool calls during this task are recorded automatically. -->`);
  parts.push(`    <!-- The Runtime independently verifies evidence — your report is a claim, not a verdict. -->`);
  if (targetPaths.length > 0) {
    parts.push(`    <target_paths>`);
    parts.push(`      <!-- Create or modify exactly these paths; the run looks for file evidence for each. -->`);
    for (const targetPath of targetPaths) {
      parts.push(`      <path>${escapeXml(targetPath)}</path>`);
    }
    parts.push(`    </target_paths>`);
  }
  if (requiredCommands.length > 0) {
    parts.push(`    <required_commands>`);
    parts.push(`      <!-- Run these commands and let them succeed — the run is checked against command evidence, and an equivalent command does not count. -->`);
    for (const required of requiredCommands) {
      parts.push(`      <command>${escapeXml(required.command)}</command>`);
    }
    parts.push(`    </required_commands>`);
  }
  if (requiredEvidence.length > 0) {
    parts.push(`    <required_evidence>`);
    parts.push(`      <!-- Address each of these in your report (summary, files, commands, tests). -->`);
    for (const item of requiredEvidence) {
      parts.push(`      <item>${escapeXml(item)}</item>`);
    }
    parts.push(`    </required_evidence>`);
  }
  if (reviewedCriteria.length > 0) {
    parts.push(`    <acceptance_criteria>`);
    parts.push(`      <!-- Return every criterion in report_task_result.acceptanceResults, with passed and evidence. -->`);
    for (const criterion of reviewedCriteria) {
      parts.push(`      <criterion>${escapeXml(criterion)}</criterion>`);
    }
    parts.push(`    </acceptance_criteria>`);
  }
  parts.push(`    <!-- You MUST call report_task_result when finished. -->`);
  parts.push(`  </evidence_contract>`);

  // Failure context
  if (failureContext) {
    parts.push(`  <failure_context previous_attempt="${escapeXml(failureContext.previousAttemptId)}">`);
    for (const instr of failureContext.retryInstructions ?? []) {
      parts.push(`    <instruction>${escapeXml(instr)}</instruction>`);
    }
    for (const cmd of failureContext.failedCommands ?? []) {
      parts.push(`    <failed_command command="${escapeXml(cmd.command)}" exitCode="${cmd.exitCode ?? "?"}" evidenceId="${escapeXml(cmd.evidenceId)}">${escapeXml(cmd.errorExcerpt)}</failed_command>`);
    }
    for (const f of failureContext.changedFiles ?? []) {
      parts.push(`    <changed_file path="${escapeXml(f.path)}" hash="${escapeXml(f.contentHash ?? "")}" />`);
    }
    parts.push(`  </failure_context>`);
  }

  // Manifest summary (compact)
  const incCount = manifest.filter(m => m.included).length;
  const omCount = manifest.filter(m => !m.included).length;
  parts.push(`  <context_manifest included="${incCount}" omitted="${omCount}" />`);

  parts.push(`</task_context>`);
  parts.push(``);
  parts.push(`<instruction>`);
  parts.push(`- Verified inputs can be used as authoritative facts.`);
  parts.push(`- When you need an upstream artifact, use the exact artifactId from <verified_inputs> with read_artifact. Never invent artifact ids from task ids like r1/r2 or output keys.`);
  parts.push(`- Reported/unverified content should only be used for diagnosis.`);
  parts.push(`- Constraint trust levels are preserved from their source. A reported or retrieved constraint is not a verified fact; do not let it override authoritative constraints.`);
  parts.push(`- You MUST call report_task_result when your task is complete.`);
  parts.push(`- The Runtime independently verifies evidence — your report is a claim, not a verdict.`);
  parts.push(`</instruction>`);
  parts.push(``);
  parts.push(`<your_task>${escapeXml(task.objective)}</your_task>`);

  return parts.join("\n");
}
