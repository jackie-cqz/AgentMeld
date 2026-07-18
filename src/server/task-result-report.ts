import type { DispatchTaskReport } from "@/server/dispatch-task-results";
import type { ParsedTask } from "@/server/tools/conductor-tools";
import { findMissingCriteria, humanReviewedCriteria } from "@/server/acceptance-criteria";

export interface TaskEvidence {
  fileWrites: Array<{ path: string; action: string }>;
  observedPaths?: string[];
  commands: Array<{
    command: string;
    exitCode: number | null;
    cwd?: string;
    timedOut?: boolean;
    isError?: boolean;
  }>;
}

/**
 * 7-step code-based evaluation. Does NOT trust the LLM's self-report.
 * Evidence > declaration.
 */
export function evaluateChildTaskResult(
  task: ParsedTask,
  report: DispatchTaskReport | undefined,
  evidence?: TaskEvidence
): { status: "complete" | "failed" | "blocked"; error?: string } {
  // ① Did they call report_task_result at all?
  if (!report) {
    return { status: "failed", error: "没有调用 report_task_result" };
  }

  // ② Did the LLM report complete?
  if (report.status === "failed" || report.status === "blocked") {
    return {
      status: "failed",
      error: `LLM 自己报了 ${report.status}: ${report.summary.slice(0, 100)}`
    };
  }

  // ③ Any unrecovered verification commands in evidence?
  // Setup and dependency commands may fail before the Agent recovers through
  // workspace tools. Build/test/lint/typecheck failures remain blocking unless
  // a later command proves the same validation stage succeeded.
  if (evidence) {
    const failedCommands = evidence.commands.filter((command, index) =>
      isFailedCommand(command) &&
      getValidationCommandKind(command.command) !== null &&
      !hasLaterSuccessfulValidationCommand(evidence.commands, index)
    );
    if (failedCommands.length > 0) {
      const commands = [...new Set(failedCommands.map((command) => command.command))];
      return {
        status: "failed",
        error: `命令证据失败: ${commands.join(", ")}`
      };
    }
  }

  // ④ All acceptance criteria passed?
  const reviewTask = isReviewTask(task);
  const failedAcceptance = (report.acceptanceResults ?? []).filter((result) =>
    !result.passed && (!reviewTask || result.evidence.trim().length === 0)
  );
  if (failedAcceptance.length > 0) {
    return {
      status: "failed",
      error: `验收标准未通过: ${failedAcceptance.map((a) => a.criterion).join(", ")}`
    };
  }

  // ⑤ Any human-reviewed acceptance criteria MISSING from the report?
  // Structured JSON criteria from role contracts are verified from tool evidence
  // by verification-engine. Requiring the child agent to repeat those criteria
  // makes evidence-backed artifact tasks fail even when write_artifact succeeded.
  const criteria = task.acceptanceCriteria ?? [];
  const normalizedCriteria = humanReviewedCriteria(criteria);
  const coverageResults = reviewTask
    ? (report.acceptanceResults ?? []).map((result) => ({
        ...result,
        passed: result.passed || result.evidence.trim().length > 0,
      }))
    : (report.acceptanceResults ?? []);
  const missing = findMissingCriteria(normalizedCriteria, coverageResults);
  if (missing.length > 0) {
    return {
      status: "failed",
      error: `验收标准漏报: ${missing.join(", ")}`
    };
  }

  // ⑥ targetPaths have evidence?
  const actualPaths = [
    ...(evidence?.fileWrites.map((file) => file.path) ?? []),
    ...(evidence?.observedPaths ?? []),
  ];
  const reportedPaths = (report.files ?? [])
    .filter((file) => file.action !== "read")
    .map((file) => file.path);
  const missingTargetPaths = (task.targetPaths ?? []).filter(
    (targetPath) => ![...actualPaths, ...reportedPaths].some(
      (candidatePath) => evidencePathMatches(targetPath, candidatePath)
    )
  );
  if (missingTargetPaths.length > 0) {
    return {
      status: "failed",
      error: `缺少目标文件证据: ${missingTargetPaths.join(", ")}`
    };
  }

  // ⑦ requiredCommands completed successfully?
  const actualCommands = evidence?.commands ?? [];
  const reportedCommands = [
    ...(report.commands ?? []).map((command) => ({
      command: command.command,
      passed: command.exitCode === 0 && command.passed !== false
    })),
    ...(report.tests ?? []).map((test) => ({
      command: test.command,
      passed: test.passed
    }))
  ];
  const missingCommands = (task.requiredCommands ?? []).filter((required) => {
    const normalized = normalizeCommand(required.command);
    const actualPassed = actualCommands.some(
      (command) =>
        commandSatisfiesRequirement(command.command, normalized) &&
        !command.isError &&
        !command.timedOut &&
        command.exitCode === 0
    );
    const reportedPassed = reportedCommands.some(
      (command) => commandSatisfiesRequirement(command.command, normalized) && command.passed
    );
    return !actualPassed && !reportedPassed;
  });
  if (missingCommands.length > 0) {
    return {
      status: "failed",
      error: `缺少成功命令证据: ${missingCommands.map((command) => command.command).join(", ")}`
    };
  }

  // ⑧ requiredEvidence mentioned in the structured report?
  const reportEvidenceText = [
    report.summary,
    ...(report.acceptanceResults ?? []).flatMap((result) => [result.criterion, result.evidence]),
    ...(report.files ?? []).flatMap((file) => [file.path, file.summary ?? ""]),
    ...(report.commands ?? []).flatMap((command) => [command.command, command.summary ?? ""]),
    ...(report.tests ?? []).flatMap((test) => [test.command, test.summary ?? ""]),
    ...(report.blockers ?? [])
  ].join("\n").toLowerCase();
  const missingEvidence = (task.requiredEvidence ?? []).filter(
    (requirement) => !reportEvidenceText.includes(requirement.trim().toLowerCase())
  );
  if (missingEvidence.length > 0) {
    return {
      status: "failed",
      error: `缺少必需证据说明: ${missingEvidence.join(", ")}`
    };
  }

  return { status: "complete" };
}

function isReviewTask(task: ParsedTask): boolean {
  return task.expectedOutputs?.some((output) => output.id === "review_report") ||
    /\breview(?:er)?\b|审查|评审/i.test(`${task.title} ${task.prompt}`);
}

function normalizeEvidencePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "").toLowerCase();
}

function evidencePathMatches(targetPath: string, candidatePath: string): boolean {
  const target = normalizeEvidencePath(targetPath);
  const candidate = normalizeEvidencePath(candidatePath);
  // A root target means the task owns the workspace root. Every workspace tool
  // path is already sandbox-relative, so any concrete path is valid evidence
  // that the task inspected or changed that target.
  if (target === "." || target === "") return candidate.length > 0;
  return candidate === target ||
    candidate.startsWith(`${target}/`) ||
    candidate.endsWith(`/${target}`) ||
    candidate.includes(`/${target}/`);
}

function normalizeCommand(command: string): string {
  return normalizeCommandIntent(command);
}

function isFailedCommand(command: TaskEvidence["commands"][number]): boolean {
  return Boolean(command.isError || command.timedOut || (command.exitCode !== null && command.exitCode !== 0));
}

function isSuccessfulCommand(command: TaskEvidence["commands"][number]): boolean {
  return !command.isError && !command.timedOut && command.exitCode === 0;
}

function hasLaterSuccessfulValidationCommand(commands: TaskEvidence["commands"], failedIndex: number): boolean {
  const failedIntent = normalizeCommandIntent(commands[failedIndex]?.command ?? "");
  const failedKind = getValidationCommandKind(failedIntent);
  if (!failedIntent || !failedKind) return false;
  return commands
    .slice(failedIndex + 1)
    .some((command) => {
      if (!isSuccessfulCommand(command)) return false;
      const successfulIntent = normalizeCommandIntent(command.command);
      return successfulIntent === failedIntent || getValidationCommandKind(successfulIntent) === failedKind;
    });
}

function getValidationCommandKind(command: string): "build" | "test" | "lint" | "typecheck" | "check" | null {
  const normalized = normalizeCommandIntent(command);
  const packageScript = normalized.match(/\b(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(build|test|lint|typecheck|check)\b/);
  if (packageScript) return packageScript[1] as "build" | "test" | "lint" | "typecheck" | "check";
  if (/\b(?:vite|next|astro|nuxt)\s+build\b/.test(normalized)) return "build";
  if (/\b(?:vitest|jest|pytest)\b/.test(normalized)) return "test";
  if (/\beslint\b/.test(normalized)) return "lint";
  if (/\b(?:tsc|mypy)\b/.test(normalized)) return "typecheck";
  return null;
}

function commandSatisfiesRequirement(command: string, normalizedRequirement: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  if (normalizedCommand === normalizedRequirement) return true;
  const requiredKind = getValidationCommandKind(normalizedRequirement);
  return requiredKind !== null && getValidationCommandKind(normalizedCommand) === requiredKind;
}

function normalizeCommandIntent(command: string): string {
  const normalized = command
    .trim()
    .toLowerCase()
    .replace(/2>\s*&1/g, "")
    .replace(/\bset-location\b/g, "cd")
    .replace(/\s*&&\s*/g, ";")
    .replace(/\s*;\s*/g, ";")
    .replace(/\s+/g, " ")
    .replace(/;$/g, "");

  const workSegments = normalized
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !segment.startsWith("cd "));

  return workSegments.join(";") || normalized;
}
