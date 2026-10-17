import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import {
  BENCHMARK_CASE_SCHEMA_VERSION,
  type AgentBenchmarkCase,
  type BenchmarkAssertion,
  type BenchmarkRole,
} from "@/server/context-metrics/benchmark-types";
import { benchmarkAssertionSchema, benchmarkRoleSchema } from "./assertion";

const benchmarkCaseCategorySchema = z.enum([
  "collaboration",
  "context_handoff",
  "fact_update",
  "recovery",
  "safety",
  "false_completion",
]);

const benchmarkWorkspacePathSchema = z.string()
  .trim()
  .min(1)
  .refine((value) => {
    const portable = value.replaceAll("\\", "/");
    return !portable.startsWith("/")
      && !/^[a-zA-Z]:\//.test(portable)
      && !portable.split("/").some((segment) => segment === "..");
  }, "Workspace file path must be relative and may not traverse outside the workspace.");

const benchmarkRuntimeSchema = z.object({
  fsWriteApprovalMode: z.enum(["auto", "review"]).optional(),
  contextMode: z.enum(["raw", "evidence"]).optional(),
  // The window belongs to the Agent model config; the fixture sets it for the
  // participating Agents so raw and evidence runs are measured on equal terms.
  contextWindow: z.number().int().min(1000).max(10_000_000).optional(),
  workspaceFiles: z.array(z.object({
    path: benchmarkWorkspacePathSchema,
    content: z.string(),
  }).strict()).min(1).optional(),
  assetBundle: z.object({
    root: benchmarkWorkspacePathSchema.refine(
      (value) => value.replaceAll("\\", "/").startsWith("tests/e2e-assets/"),
      "Asset bundle root must be under tests/e2e-assets.",
    ),
    publicDir: benchmarkWorkspacePathSchema.optional(),
    hiddenDir: benchmarkWorkspacePathSchema.optional(),
    setupCommands: z.array(z.object({
      id: z.string().trim().min(1),
      command: z.string().trim().min(1),
      timeoutMs: z.number().int().positive().optional(),
    }).strict()).optional(),
    generatedPublicDir: benchmarkWorkspacePathSchema.optional(),
    generatedHiddenDir: benchmarkWorkspacePathSchema.optional(),
  }).strict().optional(),
  verifiers: z.array(z.object({
    id: z.string().trim().min(1),
    command: z.string().trim().min(1),
    timeoutMs: z.number().int().positive().optional(),
    expectedExitCode: z.number().int().optional(),
  }).strict()).optional(),
  userScript: z.object({
    questions: z.array(z.object({
      match: z.string().trim().min(1).optional(),
      answers: z.record(z.string(), z.string()),
    }).strict()).optional(),
    approvals: z.array(z.object({
      type: z.enum(["dispatch_plan", "fs_write", "bash"]),
      match: z.string().trim().min(1).optional(),
      decision: z.enum(["approve", "reject"]),
      maxMatches: z.number().int().positive().optional(),
    }).strict()).optional(),
    onUnmatchedQuestion: z.enum(["first_option", "fail"]).optional(),
    onUnmatchedApproval: z.enum(["approve", "reject", "fail"]).optional(),
  }).strict().optional(),
  browserScripts: z.array(z.object({
    id: z.string().trim().min(1),
    outputKey: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    initialTimeMs: z.number().int().nonnegative().optional(),
    steps: z.array(z.discriminatedUnion("action", [
      z.object({ action: z.literal("fill"), selector: z.string().min(1), value: z.string() }).strict(),
      z.object({ action: z.literal("click"), selector: z.string().min(1) }).strict(),
      z.object({ action: z.literal("press"), selector: z.string().min(1), key: z.string().min(1) }).strict(),
      z.object({ action: z.literal("check"), selector: z.string().min(1) }).strict(),
      z.object({ action: z.literal("select_option"), selector: z.string().min(1), index: z.number().int().nonnegative() }).strict(),
      z.object({ action: z.literal("wait"), timeoutMs: z.number().int().nonnegative() }).strict(),
      z.object({ action: z.literal("reload") }).strict(),
      z.object({ action: z.literal("navigate"), path: z.string().min(1) }).strict(),
      z.object({ action: z.literal("advance_clock"), timeoutMs: z.number().int().nonnegative() }).strict(),
      z.object({
        action: z.literal("assert_storage"),
        key: z.string().min(1).optional(),
        valuePattern: z.string().min(1).optional(),
        minEntries: z.number().int().nonnegative().optional(),
        timeoutMs: z.number().int().positive().optional(),
      }).strict(),
      z.object({ action: z.literal("assert_text"), text: z.string().min(1) }).strict(),
      z.object({ action: z.literal("assert_visible"), selector: z.string().min(1) }).strict(),
      z.object({ action: z.literal("assert_hidden"), selector: z.string().min(1) }).strict(),
      z.object({ action: z.literal("assert_dom_changed") }).strict(),
    ])).min(1),
  }).strict()).optional(),
  faults: z.array(z.object({
    id: z.string().trim().min(1),
    type: z.enum([
      "tool_arguments_json",
      "tool_failure",
      "command_nonzero",
      "deployment_missing",
      "task_report_fake_deployment",
      "sse_disconnect",
      "child_run_abort",
    ]),
    toolName: z.string().trim().min(1),
    occurrence: z.number().int().positive().optional(),
    commandPattern: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1).optional(),
  }).strict()).optional(),
}).strict();

export const benchmarkCaseSchema = z
  .object({
    schemaVersion: z.literal(BENCHMARK_CASE_SCHEMA_VERSION),
    id: z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    category: benchmarkCaseCategorySchema,
    prompt: z.string().trim().min(1),
    expectedRoles: z.array(benchmarkRoleSchema).min(1),
    assertions: z.array(benchmarkAssertionSchema).min(1),
    limits: z.object({
      maxDurationMs: z.number().int().positive(),
      maxModelCalls: z.number().int().positive().optional(),
      maxToolCalls: z.number().int().positive().optional(),
      maxInputTokens: z.number().int().positive().optional(),
      maxAttemptsPerTask: z.number().int().positive().optional(),
    }).strict(),
    runtime: benchmarkRuntimeSchema.optional(),
    judge: z.object({
      enabled: z.boolean(),
      requiredForPass: z.boolean().optional(),
      rubricVersion: z.string().trim().min(1).optional(),
      dimensions: z.array(z.string().trim().min(1)).min(1).optional(),
    }).strict().optional(),
    tags: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((benchmarkCase, ctx) => {
    const ids = new Set<string>();
    const declaredBindings = new Set<string>();
    const verifierIds = new Set<string>();
    for (let index = 0; index < (benchmarkCase.runtime?.verifiers?.length ?? 0); index++) {
      const verifier = benchmarkCase.runtime!.verifiers![index];
      if (verifierIds.has(verifier.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["runtime", "verifiers", index, "id"],
          message: `Duplicate verifier id: ${verifier.id}`,
        });
      }
      verifierIds.add(verifier.id);
    }
    for (const rawAssertion of benchmarkCase.assertions) {
      const assertion = rawAssertion as BenchmarkAssertion;
      if (assertion.type !== "output_binding" || assertion.requiredAbsent) continue;
      for (const key of [assertion.outputKey, ...(assertion.aliases ?? [])]) {
        declaredBindings.add(`${assertion.role}:${key}`);
      }
    }
    for (let index = 0; index < benchmarkCase.assertions.length; index++) {
      const assertion = benchmarkCase.assertions[index] as BenchmarkAssertion;
      if (ids.has(assertion.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["assertions", index, "id"],
          message: `Duplicate assertion id: ${assertion.id}`,
        });
      }
      ids.add(assertion.id);

      if (assertion.type === "command_verifier" && !verifierIds.has(assertion.verifierId)) {
        ctx.addIssue({
          code: "custom",
          path: ["assertions", index, "verifierId"],
          message: `Assertion ${assertion.id} references undeclared verifier ${assertion.verifierId}.`,
        });
      }

      for (const role of referencedRoles(assertion)) {
        if (!benchmarkCase.expectedRoles.includes(role)) {
          ctx.addIssue({
            code: "custom",
            path: ["assertions", index],
            message: `Assertion ${assertion.id} references role ${role}, but it is absent from expectedRoles.`,
          });
        }
      }

      const outputReference = assertion.type === "dag_edge" && assertion.outputKey
        ? { role: assertion.fromRole, outputKey: assertion.outputKey }
        : assertion.type === "artifact_read"
          ? { role: assertion.producerRole, outputKey: assertion.outputKey }
          : null;
      if (
        outputReference
        && !declaredBindings.has(`${outputReference.role}:${outputReference.outputKey}`)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["assertions", index],
          message:
            `Assertion ${assertion.id} references ${outputReference.role}.${outputReference.outputKey}, `
            + "but no required output_binding assertion declares that producer output.",
        });
      }
    }
  });

export function parseBenchmarkCase(value: unknown, source = "benchmark case"): AgentBenchmarkCase {
  const result = benchmarkCaseSchema.safeParse(value);
  if (result.success) return result.data as AgentBenchmarkCase;

  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid ${source}: ${detail}`);
}

export function readBenchmarkCaseFile(filePath: string): AgentBenchmarkCase {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    throw new Error(`Unable to read benchmark case ${filePath}: ${String(error)}`);
  }
  return parseBenchmarkCase(parsed, filePath);
}

export function loadBenchmarkCases(directory: string): AgentBenchmarkCase[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => readBenchmarkCaseFile(path.join(directory, file)));
}

function referencedRoles(assertion: BenchmarkAssertion): BenchmarkRole[] {
  switch (assertion.type) {
    case "role_executed":
    case "output_binding":
      return [assertion.role];
    case "dag_edge":
      return [assertion.fromRole, assertion.toRole];
    case "artifact_read":
      return [assertion.producerRole, assertion.consumerRole];
    case "tool_succeeded":
    case "tool_rejected":
    case "warning_present":
    case "approval_resolved":
    case "deployment_ready":
    case "build_succeeded":
    case "preview_http":
    case "retry_bound":
    case "tool_retry_bound":
    case "verification_status":
      return assertion.role ? [assertion.role] : [];
    case "command_verifier":
    case "workspace_file":
    case "structured_output":
    case "no_forbidden_mutation":
      return [];
    case "artifact_valid":
      return [assertion.role];
    case "consultation_reflected":
    case "consultation_lifecycle":
      return [assertion.role];
    case "browser_interaction":
    case "fault_injected":
      return [];
  }
}
