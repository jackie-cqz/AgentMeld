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
    tags: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((benchmarkCase, ctx) => {
    const ids = new Set<string>();
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

      for (const role of referencedRoles(assertion)) {
        if (!benchmarkCase.expectedRoles.includes(role)) {
          ctx.addIssue({
            code: "custom",
            path: ["assertions", index],
            message: `Assertion ${assertion.id} references role ${role}, but it is absent from expectedRoles.`,
          });
        }
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
    case "deployment_ready":
    case "retry_bound":
      return assertion.role ? [assertion.role] : [];
  }
}
