import type {
  ToolContext,
  ToolDef,
  ToolExecutionMeta,
  ToolFailureCategory,
  ToolResult,
} from "@/server/tools/types";
import { captureEvidence } from "@/server/evidence/evidence-collector";
import { classifyToolError } from "@/server/logger";

function normalizeToolError(error: unknown, toolName?: string): ToolResult {
  const message = error instanceof Error ? error.message : "Tool handler threw an unexpected error.";
  const category = classifyToolError(error instanceof Error ? error : message, toolName);
  return {
    ok: false,
    error: `[${category}] ${message}`,
  };
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private executionInterceptor: ((name: string, args: unknown, ctx: ToolContext) => ToolResult | null) | null = null;

  register(tool: ToolDef): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  resolve(names: string[]): ToolDef[] {
    return names.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return tool;
    });
  }

  async execute(
    name: string,
    args: unknown,
    ctx: ToolContext,
    meta?: ToolExecutionMeta,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${name}` };
    }
    if (ctx.allowedToolNames && !ctx.allowedToolNames.includes(name)) {
      return this.recordPreflightFailure(name, args, "Tool not authorized for this Agent run.", ctx,
        meta ?? { callId: `denied_${ctx.runId}_${Date.now()}` }, { code: "TOOL_PERMISSION_DENIED", category: "security_policy" });
    }

    const startedAt = Date.now();
    let result: ToolResult;
    try {
      const injected = this.executionInterceptor?.(name, args, ctx) ?? null;
      result = injected ?? await tool.handler(args, ctx);
    } catch (error) {
      result = normalizeToolError(error, name);
    }

    // Persist the terminal result before returning so verification cannot race
    // against an unfinished evidence write.
    await captureEvidence({
      toolName: name,
      args,
      result,
      context: ctx,
      durationMs: Date.now() - startedAt,
      callId: meta?.callId,
    }).catch((error) => {
      // Tool behavior remains available even if observability storage fails, but
      // the failure is explicit instead of becoming an unhandled background task.
      console.error(`[tool-registry] failed to capture terminal evidence for ${name}:`, error);
    });

    return result;
  }

  async recordPreflightFailure(
    name: string,
    args: unknown,
    error: string,
    ctx: ToolContext,
    meta: ToolExecutionMeta,
    options?: { code?: string; category?: ToolFailureCategory },
  ): Promise<ToolResult> {
    const result: ToolResult = {
      ok: false,
      error,
      code: options?.code ?? "TOOL_ARGUMENTS_INVALID",
      category: options?.category ?? "validation_error",
    };
    await captureEvidence({
      toolName: name,
      args,
      result,
      context: ctx,
      durationMs: 0,
      callId: meta.callId,
    });
    return result;
  }

  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  clearForTests(): void {
    this.tools.clear();
  }

  setExecutionInterceptorForTests(
    interceptor: ((name: string, args: unknown, ctx: ToolContext) => ToolResult | null) | null,
  ): void {
    if (interceptor && process.env.AGENTMELD_BENCH_FAULT_INJECTION !== "1") {
      throw new Error("Tool fault injection is only available inside an explicit benchmark environment.");
    }
    this.executionInterceptor = interceptor;
  }
}

import { bashTool } from "@/server/tools/bash";
import { fsListTool } from "@/server/tools/fs-list";
import { fsMkdirTool } from "@/server/tools/fs-mkdir";
import { fsPatchTool } from "@/server/tools/fs-patch";
import { fsReadTool } from "@/server/tools/fs-read";
import { fsWriteTool } from "@/server/tools/fs-write";
import { readArtifactTool } from "@/server/tools/read-artifact";
import { writeArtifactTool } from "@/server/tools/write-artifact";
import { askUserTool } from "@/server/tools/ask-user";
import { deployArtifactTool } from "@/server/tools/deploy-artifact";
import { deployWorkspaceTool } from "@/server/tools/deploy-workspace";
import { readAttachmentTool } from "@/server/tools/read-attachment";
import { planTasksTool, reportTaskResultTool } from "@/server/tools/conductor-tools";
import { readEvidenceTool } from "@/server/tools/read-evidence";
import { updateContextFactsTool } from "@/server/tools/update-context-facts";
import { fsGlobTool, fsSearchTool } from "@/server/tools/fs-search";
import { jobStartTool, jobReadTool, jobWaitTool, jobCancelTool } from "@/server/tools/jobs";
import { webFetchTool, webSearchTool } from "@/server/tools/web";
import { gitInspectTool } from "@/server/tools/git-inspect";
import { browserCheckTool } from "@/server/tools/browser-check";
import { listTeamMembersTool } from "@/server/tools/list-team-members";

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(bashTool);
  registry.register(fsListTool);
  registry.register(fsReadTool);
  registry.register(fsMkdirTool);
  registry.register(fsWriteTool);
  registry.register(fsPatchTool);
  registry.register(readArtifactTool);
  registry.register(writeArtifactTool);
  registry.register(askUserTool);
  registry.register(deployArtifactTool);
  registry.register(deployWorkspaceTool);
  registry.register(readAttachmentTool);
  registry.register(planTasksTool);
  registry.register(listTeamMembersTool);
  registry.register(reportTaskResultTool);
  registry.register(readEvidenceTool);
  registry.register(updateContextFactsTool);
  for (const tool of [fsGlobTool, fsSearchTool, jobStartTool, jobReadTool, jobWaitTool, jobCancelTool, webFetchTool, webSearchTool, gitInspectTool, browserCheckTool]) registry.register(tool);
  return registry;
}

export const toolRegistry = buildRegistry();
