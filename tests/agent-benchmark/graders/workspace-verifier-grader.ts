import type {
  CommandVerifierAssertion,
  NoForbiddenMutationAssertion,
  StructuredOutputAssertion,
  WorkspaceFileAssertion,
} from "@/server/context-metrics/benchmark-types";

import { assertionResult, type BenchmarkGrader } from "./grader-types";


export const commandVerifierGrader: BenchmarkGrader = {
  type: "command_verifier",
  grade(rawAssertion, context) {
    const assertion = rawAssertion as CommandVerifierAssertion;
    const validation = context.runtimeValidation?.verifiers?.find(
      (candidate) => candidate.verifierId === assertion.verifierId,
    );
    if (!validation) {
      return assertionResult(assertion, false, `Verifier result is missing: ${assertion.verifierId}.`);
    }
    const passed = validation.status === "passed";
    const detail = passed
      ? `Verifier ${assertion.verifierId} passed with exit code ${validation.exitCode}.`
      : `Verifier ${assertion.verifierId} ${validation.status}: exit=${validation.exitCode}, expected=${validation.expectedExitCode}, ${validation.error ?? (validation.stderr || "no error output")}`;
    return assertionResult(assertion, passed, detail);
  },
};

export const workspaceFileGrader: BenchmarkGrader = {
  type: "workspace_file",
  grade(rawAssertion, context) {
    const assertion = rawAssertion as WorkspaceFileAssertion;
    const validation = context.runtimeValidation?.workspaceFiles?.find(
      (candidate) => candidate.path === assertion.path,
    );
    if (!validation) return assertionResult(assertion, false, `Workspace validation is missing: ${assertion.path}.`);
    const errors: string[] = [];
    if (!validation.exists || !validation.isFile) errors.push(validation.error ?? "Path is not a file.");
    if (assertion.minBytes != null && validation.bytes < assertion.minBytes) {
      errors.push(`File has ${validation.bytes} bytes; expected at least ${assertion.minBytes}.`);
    }
    for (const pattern of assertion.contentPatterns ?? []) {
      if (validation.contentText == null) {
        errors.push(`Cannot apply text pattern to binary file: ${pattern}.`);
        continue;
      }
      try {
        if (!new RegExp(pattern, "m").test(validation.contentText)) errors.push(`Content does not match: ${pattern}.`);
      } catch (error) {
        errors.push(`Invalid content pattern ${pattern}: ${error instanceof Error ? error.message : String(error)}.`);
      }
    }
    return assertionResult(
      assertion,
      errors.length === 0,
      errors.length === 0 ? `Workspace file is valid: ${assertion.path} (${validation.bytes} bytes).` : errors.join(" "),
      [{ filePath: assertion.path }],
    );
  },
};

export const structuredOutputGrader: BenchmarkGrader = {
  type: "structured_output",
  grade(rawAssertion, context) {
    const assertion = rawAssertion as StructuredOutputAssertion;
    const validation = context.runtimeValidation?.structuredOutputs?.find(
      (candidate) => candidate.path === assertion.path && candidate.format === assertion.format,
    );
    if (!validation) return assertionResult(assertion, false, `Structured output validation is missing: ${assertion.path}.`);
    return assertionResult(
      assertion,
      validation.valid,
      validation.valid
        ? `Structured ${assertion.format} output is valid with ${validation.recordCount} record(s).`
        : validation.errors.join(" "),
      [{ filePath: assertion.path }],
    );
  },
};

export const noForbiddenMutationGrader: BenchmarkGrader = {
  type: "no_forbidden_mutation",
  grade(rawAssertion, context) {
    const assertion = rawAssertion as NoForbiddenMutationAssertion;
    const validations = assertion.paths.map((protectedPath) =>
      context.runtimeValidation?.mutations?.find((candidate) => candidate.path === protectedPath));
    const missing = assertion.paths.filter((_, index) => !validations[index]);
    const changed = validations.filter((validation) => validation && !validation.unchanged);
    const passed = missing.length === 0 && changed.length === 0;
    const reason = passed
      ? `Protected files remained unchanged: ${assertion.paths.join(", ")}.`
      : [
          missing.length ? `Missing mutation validation: ${missing.join(", ")}.` : "",
          changed.length ? `Protected files changed: ${changed.map((item) => item!.path).join(", ")}.` : "",
        ].filter(Boolean).join(" ");
    return assertionResult(assertion, passed, reason, assertion.paths.map((filePath) => ({ filePath })));
  },
};
