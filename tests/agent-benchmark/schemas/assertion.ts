import { z } from "zod";

import type { BenchmarkAssertion } from "@/server/context-metrics/benchmark-types";

export const benchmarkRoleSchema = z.enum(["conductor", "pm", "ui", "frontend", "reviewer"]);
export const benchmarkArtifactTypeSchema = z.enum(["web_app", "document", "image", "ppt"]);

const benchmarkWorkspacePathSchema = z.string()
  .trim()
  .min(1)
  .refine((value) => {
    const portable = value.replaceAll("\\", "/");
    return !portable.startsWith("/")
      && !/^[a-zA-Z]:\//.test(portable)
      && !portable.split("/").some((segment) => segment === "..");
  }, "Workspace path must be relative and may not traverse outside the workspace.");

const assertionBase = {
  id: z.string().trim().min(1),
  required: z.boolean(),
  weight: z.number().positive().optional(),
  description: z.string().trim().min(1).optional(),
};

export const benchmarkAssertionSchema = z
  .discriminatedUnion("type", [
    z.object({
      ...assertionBase,
      type: z.literal("role_executed"),
      role: benchmarkRoleSchema,
      mustComplete: z.boolean().optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("dag_edge"),
      fromRole: benchmarkRoleSchema,
      toRole: benchmarkRoleSchema,
      outputKey: z.string().trim().min(1).optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("output_binding"),
      role: benchmarkRoleSchema,
      outputKey: z.string().trim().min(1),
      artifactType: benchmarkArtifactTypeSchema,
      aliases: z.array(z.string().trim().min(1)).optional(),
      requiredAbsent: z.boolean().optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("artifact_read"),
      producerRole: benchmarkRoleSchema,
      consumerRole: benchmarkRoleSchema,
      outputKey: z.string().trim().min(1),
      requireVerifiedBinding: z.boolean().optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("tool_succeeded"),
      toolName: z.string().trim().min(1),
      role: benchmarkRoleSchema.optional(),
      commandPattern: z.string().trim().min(1).optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("tool_rejected"),
      toolName: z.string().trim().min(1),
      role: benchmarkRoleSchema.optional(),
      category: z.enum(["security_policy", "approval_rejected", "tool_error"]).optional(),
      reasonPattern: z.string().trim().min(1).optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("warning_present"),
      code: z.string().trim().min(1),
      role: benchmarkRoleSchema.optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("fault_injected"),
      faultId: z.string().trim().min(1),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("approval_resolved"),
      approvalType: z.enum(["dispatch_plan", "fs_write", "bash"]),
      decision: z.enum(["approved", "rejected"]),
      role: benchmarkRoleSchema.optional(),
      match: z.string().trim().min(1).optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("deployment_ready"),
      role: benchmarkRoleSchema.optional(),
      outputKey: z.string().trim().min(1).optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("artifact_valid"),
      role: benchmarkRoleSchema,
      outputKey: z.string().trim().min(1),
      artifactType: benchmarkArtifactTypeSchema,
      minContentBytes: z.number().int().nonnegative().optional(),
      requiredFiles: z.array(z.string().trim().min(1)).optional(),
      requiredContentPatterns: z.array(z.string().trim().min(1)).optional(),
      requireUniqueBinding: z.boolean().optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("build_succeeded"),
      role: benchmarkRoleSchema.optional(),
      commandPattern: z.string().trim().min(1).optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("preview_http"),
      role: benchmarkRoleSchema.optional(),
      outputKey: z.string().trim().min(1).optional(),
      expectedStatus: z.number().int().min(100).max(599).optional(),
      minBodyBytes: z.number().int().nonnegative().optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("browser_interaction"),
      scriptId: z.string().trim().min(1),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("retry_bound"),
      role: benchmarkRoleSchema.optional(),
      minAttempts: z.number().int().nonnegative().optional(),
      maxAttempts: z.number().int().positive().optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("tool_retry_bound"),
      role: benchmarkRoleSchema.optional(),
      toolName: z.string().trim().min(1),
      commandPattern: z.string().trim().min(1).optional(),
      minCalls: z.number().int().nonnegative().optional(),
      maxCalls: z.number().int().positive().optional(),
      requireFailureBeforeSuccess: z.boolean().optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("verification_status"),
      role: benchmarkRoleSchema.optional(),
      expected: z.enum(["verified", "rejected", "needs_review"]),
      warningCode: z.string().trim().min(1).optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("command_verifier"),
      verifierId: z.string().trim().min(1),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("workspace_file"),
      path: benchmarkWorkspacePathSchema,
      minBytes: z.number().int().nonnegative().optional(),
      contentPatterns: z.array(z.string().min(1)).optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("structured_output"),
      path: benchmarkWorkspacePathSchema,
      format: z.enum(["json", "jsonl", "csv"]),
      requiredKeys: z.array(z.string().trim().min(1)).optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("no_forbidden_mutation"),
      paths: z.array(benchmarkWorkspacePathSchema).min(1),
    }).strict(),
  ])
  .superRefine((assertion, ctx) => {
    if (assertion.type === "retry_bound") {
      if (assertion.minAttempts == null && assertion.maxAttempts == null) {
        ctx.addIssue({ code: "custom", message: "retry_bound requires minAttempts or maxAttempts." });
      }
      if (
        assertion.minAttempts != null &&
        assertion.maxAttempts != null &&
        assertion.minAttempts > assertion.maxAttempts
      ) {
        ctx.addIssue({ code: "custom", message: "minAttempts cannot exceed maxAttempts." });
      }
    }
    if (assertion.type === "tool_retry_bound") {
      if (assertion.minCalls == null && assertion.maxCalls == null) {
        ctx.addIssue({ code: "custom", message: "tool_retry_bound requires minCalls or maxCalls." });
      }
      if (
        assertion.minCalls != null &&
        assertion.maxCalls != null &&
        assertion.minCalls > assertion.maxCalls
      ) {
        ctx.addIssue({ code: "custom", message: "minCalls cannot exceed maxCalls." });
      }
    }
  });

export function parseBenchmarkAssertion(value: unknown): BenchmarkAssertion {
  return benchmarkAssertionSchema.parse(value) as BenchmarkAssertion;
}
