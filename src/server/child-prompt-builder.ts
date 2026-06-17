import type { ParsedTask } from "@/server/tools/orchestrator-tools";

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

export function buildChildTaskPrompt(
  task: ParsedTask,
  resolvedInputs: ResolvedInput[],
  outputBindings: Map<string, string>
): string {
  const parts: string[] = [];

  // Task header
  parts.push("<task>");
  parts.push(`  <id>${task.id}</id>`);
  parts.push(`  <title>${task.title}</title>`);
  parts.push(`  <instructions>${task.prompt}</instructions>`);
  parts.push("</task>");

  // Required inputs
  if (resolvedInputs.length > 0) {
    parts.push("");
    parts.push("<required_inputs>");
    for (const input of resolvedInputs) {
      const status = input.missing
        ? "missing"
        : `artifactId="${input.artifactId}"`;
      parts.push(
        `  <input fromTaskId="${input.fromTaskId}" outputId="${input.outputId}" ` +
        `required="${input.required}" ${status}>${input.description ?? ""}</input>`
      );
    }
    parts.push("</required_inputs>");
  }

  // Expected outputs
  if (task.expectedOutputs && task.expectedOutputs.length > 0) {
    parts.push("");
    parts.push("<expected_outputs>");
    for (const output of task.expectedOutputs) {
      parts.push(
        `  <output id="${output.id}" type="${output.type}" ` +
        `required="${output.required}">${output.description ?? ""}</output>`
      );
    }
    parts.push("</expected_outputs>");
  }

  // Acceptance criteria
  if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
    parts.push("");
    parts.push("<acceptance_criteria>");
    for (const criterion of task.acceptanceCriteria) {
      parts.push(`  <item>${criterion}</item>`);
    }
    parts.push("</acceptance_criteria>");
  }

  // Reporting instruction
  parts.push("");
  parts.push("<reporting>");
  parts.push("  When you finish, call report_task_result exactly once with your status.");
  if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
    parts.push("  You must address each acceptance criterion in your report.");
  }
  if (task.expectedOutputs && task.expectedOutputs.length > 0) {
    parts.push("  Use write_artifact to produce the expected outputs. Include the outputKey when calling write_artifact.");
  }
  parts.push("</reporting>");

  return parts.join("\n");
}

export function hasMissingRequiredInputs(resolvedInputs: ResolvedInput[]): boolean {
  return resolvedInputs.some((i) => i.required && i.missing);
}
