import type { ParsedTask } from "@/server/tools/conductor-tools";

export interface ResolvedInput {
  fromTaskId: string;
  outputId: string;
  required: boolean;
  artifactId?: string;
  description?: string;
  missing: boolean;
}

export interface ResolvedOutput {
  id: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface UpstreamArtifact {
  id: string;
  type: string;
  title: string;
  version: number;
}

export interface BuildChildPromptInput {
  task: ParsedTask;
  resolvedInputs: ResolvedInput[];
  /** Artifacts from completed upstream tasks (id, type, title, version) */
  upstreamArtifacts: UpstreamArtifact[];
  /** Recent conversation messages for context (user request + conductor messages) */
  recentConversation: Array<{ from: string; content: string }>;
}

export function resolveTaskInputs(
  task: ParsedTask,
  outputBindings: Map<string, string> // "taskId.outputKey" → artifactId
): ResolvedInput[] {
  return (task.inputs || []).map((input) => {
    const bindingKey = `${input.fromTaskId}.${input.outputId}`;
    const artifactId = outputBindings.get(bindingKey);
    return {
      fromTaskId: input.fromTaskId,
      outputId: input.outputId,
      required: input.required,
      artifactId,
      description: input.description,
      missing: !artifactId
    };
  });
}

/**
 * Build the complete user prompt for a dispatched child agent.
 *
 * Produces XML matching message-flow-with-prompts-new.md §LLM 调用 #2-#5:
 *   <context>
 *     <recent_conversation>...</recent_conversation>
 *     <required_inputs>...</required_inputs>
 *     <expected_outputs>...</expected_outputs>
 *     <upstream_artifacts>...</upstream_artifacts>
 *     <acceptance_criteria>...</acceptance_criteria>
 *     <task_evidence_contract>...</task_evidence_contract>
 *   </context>
 *   <your_task>...</your_task>
 *   (ending paragraph: "You are continuing...")
 */
export function buildChildTaskPrompt(input: BuildChildPromptInput): string {
  const { task, resolvedInputs, upstreamArtifacts, recentConversation } = input;
  const parts: string[] = [];

  parts.push("<context>");

  // Recent conversation — gives the sub-agent minimal context about the original request
  if (recentConversation.length > 0) {
    parts.push("  <recent_conversation>");
    for (const msg of recentConversation) {
      const from = normalizeConversationSource(msg.from);
      const escapedContent = escapeXml(msg.content).slice(0, 500);
      parts.push(`    <message from="${escapeXml(from)}">${escapedContent}</message>`);
    }
    parts.push("  </recent_conversation>");
    parts.push("");
  }

  // Required inputs — artifacts that MUST be read before starting
  if (resolvedInputs.length > 0) {
    parts.push("  <required_inputs>");
    for (const ri of resolvedInputs) {
      const attrs = [
        `fromTaskId="${ri.fromTaskId}"`,
        `outputId="${ri.outputId}"`,
        `required="${ri.required}"`,
      ];
      if (ri.artifactId) attrs.push(`artifactId="${ri.artifactId}"`);
      parts.push(`    <input ${attrs.join(" ")}>${escapeXml(ri.description ?? "")}</input>`);
    }
    parts.push("  </required_inputs>");
    parts.push("");
  }

  // Expected outputs — what artifacts the agent should produce
  if (task.expectedOutputs && task.expectedOutputs.length > 0) {
    parts.push("  <expected_outputs>");
    for (const output of task.expectedOutputs) {
      parts.push(
        `    <output id="${output.id}" type="${output.type}" required="${output.required}">${escapeXml(output.description ?? "")}</output>`
      );
    }
    parts.push("  </expected_outputs>");
    parts.push("");
  }

  // Upstream artifacts — artifacts from completed tasks (for read_artifact reference)
  if (upstreamArtifacts.length > 0) {
    parts.push("  <upstream_artifacts>");
    for (const art of upstreamArtifacts) {
      parts.push(
        `    <artifact id="${art.id}" type="${art.type}" title="${escapeXml(art.title)}" version="${art.version}" />`
      );
    }
    parts.push("  </upstream_artifacts>");
    parts.push("");
  }

  // Acceptance criteria
  if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
    parts.push("  <acceptance_criteria>");
    for (const criterion of task.acceptanceCriteria) {
      parts.push(`    <criterion>${escapeXml(criterion)}</criterion>`);
    }
    parts.push("  </acceptance_criteria>");
    parts.push("");
  }

  // Task evidence contract — what files/commands/evidence the system will check
  if (
    (task.targetPaths && task.targetPaths.length > 0) ||
    (task.requiredCommands && task.requiredCommands.length > 0) ||
    (task.requiredEvidence && task.requiredEvidence.length > 0)
  ) {
    parts.push("  <task_evidence_contract>");
    if (task.targetPaths && task.targetPaths.length > 0) {
      parts.push("    <target_paths>");
      for (const p of task.targetPaths) {
        parts.push(`      <path>${escapeXml(p)}</path>`);
      }
      parts.push("    </target_paths>");
    }
    if (task.requiredCommands && task.requiredCommands.length > 0) {
      parts.push("    <required_commands>");
      for (const cmd of task.requiredCommands) {
        const timeoutAttr = cmd.timeoutMs ? ` timeoutMs="${cmd.timeoutMs}"` : "";
        parts.push(`      <command${timeoutAttr} text="${escapeXml(cmd.command)}" />`);
      }
      parts.push("    </required_commands>");
    }
    if (task.requiredEvidence && task.requiredEvidence.length > 0) {
      parts.push("    <required_evidence>");
      for (const item of task.requiredEvidence) {
        parts.push(`      <item>${escapeXml(item)}</item>`);
      }
      parts.push("    </required_evidence>");
    }
    parts.push("  </task_evidence_contract>");
    parts.push("");
  }

  parts.push("</context>");
  parts.push("");

  // Task instructions
  parts.push(`<your_task>${task.prompt}</your_task>`);

  // Ending paragraph — tells the agent it's a dispatched sub-task, must call report_task_result
  parts.push("");
  parts.push(
    "You are continuing the same dispatched sub-task. The system expects you to " +
    "complete it, not to ask whether you should do it. Use read_artifact when you " +
    "need full artifact content. When you are done, call report_task_result with " +
    'minimal JSON only, for example {"status":"complete","summary":"what you completed"}. ' +
    "Never omit report_task_result."
  );
  if (task.expectedOutputs && task.expectedOutputs.length > 0) {
    parts.push(
      "If expected_outputs are declared and your completed work creates an artifact, " +
      "use write_artifact and pass outputKey equal to that output id. Do not repeat " +
      "artifact ids inside report_task_result; the system records them automatically."
    );
  }

  return parts.join("\n");
}

export function hasMissingRequiredInputs(resolvedInputs: ResolvedInput[]): boolean {
  return resolvedInputs.some((i) => i.required && i.missing);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function normalizeConversationSource(source: string): string {
  return source === "conductor" ? "conductor" : source;
}
