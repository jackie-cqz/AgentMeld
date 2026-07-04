// ---------------------------------------------------------------------------
// P3: Context Renderer — renders TaskContextEnvelope as a model prompt
// Replaces child-prompt-builder's buildChildTaskPrompt for compiled contexts.
// ---------------------------------------------------------------------------

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
  const inputItems = includedContextItems.filter(c => c.category === "upstream_input");
  const wsItems = includedContextItems.filter(c => c.category === "workspace");
  const msgItems = includedContextItems.filter(c => c.category === "recent_message");

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
        const val = typeof fact.value === "object" ? JSON.stringify(fact.value) : String(fact.value ?? "");
        parts.push(`    <constraint key="${escapeXml(fact.canonicalKey)}">${escapeXml(val)}</constraint>`);
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
        parts.push(`    <input from="${escapeXml(inp.fromTaskId ?? "")}" outputKey="${escapeXml(inp.outputKey ?? "")}" artifactId="${escapeXml(inp.artifactId)}" version="${inp.artifactVersion ?? 1}" />`);
      }
    }
    parts.push(`  </verified_inputs>`);
  }

  // P3: Workspace state from packed wsItems
  if (wsItems.length > 0) {
    parts.push(`  <workspace_state>`);
    for (const ws of wsItems) {
      const wp = ws.content as { path?: string };
      if (wp.path) parts.push(`    <target_path>${escapeXml(wp.path)}</target_path>`);
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

  // Evidence contract
  parts.push(`  <evidence_contract>`);
  parts.push(`    <!-- All tool calls during this task will be automatically recorded. -->`);
  parts.push(`    <!-- You MUST call report_task_result when finished. -->`);
  parts.push(`    <!-- The Runtime independently verifies evidence — your report is a claim, not a verdict. -->`);
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
  parts.push(`- Reported/unverified content should only be used for diagnosis.`);
  parts.push(`- You MUST call report_task_result when your task is complete.`);
  parts.push(`- The Runtime independently verifies evidence — your report is a claim, not a verdict.`);
  parts.push(`</instruction>`);
  parts.push(``);
  parts.push(`<your_task>${escapeXml(task.objective)}</your_task>`);

  return parts.join("\n");
}
