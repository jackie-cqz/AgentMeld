import { z } from "zod";

import type { BenchmarkAssertion } from "@/server/context-metrics/benchmark-types";

export const benchmarkRoleSchema = z.enum(["conductor", "pm", "ui", "frontend", "reviewer"]);
export const benchmarkArtifactTypeSchema = z.enum(["web_app", "document", "image", "ppt"]);

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
      type: z.literal("deployment_ready"),
      role: benchmarkRoleSchema.optional(),
      outputKey: z.string().trim().min(1).optional(),
    }).strict(),
    z.object({
      ...assertionBase,
      type: z.literal("retry_bound"),
      role: benchmarkRoleSchema.optional(),
      minAttempts: z.number().int().nonnegative().optional(),
      maxAttempts: z.number().int().positive().optional(),
    }).strict(),
  ])
  .superRefine((assertion, ctx) => {
    if (assertion.type !== "retry_bound") return;
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
  });

export function parseBenchmarkAssertion(value: unknown): BenchmarkAssertion {
  return benchmarkAssertionSchema.parse(value) as BenchmarkAssertion;
}
