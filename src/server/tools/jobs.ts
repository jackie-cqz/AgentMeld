import { z } from "zod";
import { runValidatedBash } from "@/server/tools/bash";
import { controlCommandJob } from "@/server/tools/command-jobs";
import type { ToolDef } from "@/server/tools/types";
import { TOOL_CAPABILITIES } from "@/server/tools/capabilities";

export const jobStartTool: ToolDef = { name: "job_start", description: "Start a long build/test/lint/check or approved dependency-install command. Applies the same approval policy as bash. Returns a run-owned jobId, NOT a success verdict. Always collect its terminal exitCode with job_wait. Jobs do not survive server restarts.",
  capabilities: TOOL_CAPABILITIES.job_start,
  parameters: { type: "object", required: ["command"], properties: { command: { type: "string" }, timeoutMs: { type: "integer", minimum: 1000, maximum: 600000, description: "Hard runtime limit, default 300000 ms." } } },
  handler: (args, ctx) => runValidatedBash(args, ctx, true) };
const schema = z.object({ jobId: z.string().min(1), offset: z.number().int().min(0).max(200000).default(0), waitMs: z.number().int().min(0).max(30000).default(10000) });
function control(action: "read" | "wait" | "cancel"): ToolDef {
  return { name: `job_${action}`, description: `${action} a background job owned by this exact Agent run. Output uses an explicit offset; carry nextOffset to avoid repeated logs. waitMs is bounded to 30s; a running result is not completion.`,
    capabilities: TOOL_CAPABILITIES[`job_${action}`],
    parameters: { type: "object", required: ["jobId"], properties: { jobId: { type: "string" }, offset: { type: "integer", minimum: 0 }, waitMs: { type: "integer", minimum: 0, maximum: 30000 } } },
    async handler(args, ctx) { const parsed = schema.safeParse(args); if (!parsed.success) return { ok: false, error: `Invalid args: ${parsed.error.message}` };
      try { return { ok: true, value: await controlCommandJob(action, parsed.data.jobId, parsed.data.offset, parsed.data.waitMs, ctx) }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Job control failed." }; }
    } };
}
export const jobReadTool = control("read");
export const jobWaitTool = control("wait");
export const jobCancelTool = control("cancel");
