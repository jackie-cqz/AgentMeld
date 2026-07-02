import type { ToolContext, ToolDef, ToolResult } from "@/server/tools/types";

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

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

  async execute(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${name}` };
    }

    const startedAt = Date.now();
    let result: ToolResult;
    try {
      result = await tool.handler(args, ctx);
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : "Tool handler threw an unexpected error."
      };
    }

    // P1: Capture evidence for every tool execution (fire-and-forget, never blocks)
    const { captureEvidence } = await import("@/server/evidence/evidence-collector");
    captureEvidence({
      toolName: name,
      args,
      result,
      context: ctx,
      durationMs: Date.now() - startedAt,
    }).catch(() => {
      // Silently ignore — evidence capture failure must never affect task execution
    });

    return result;
  }

  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  clearForTests(): void {
    this.tools.clear();
  }
}

import { bashTool } from "@/server/tools/bash";
import { fsListTool } from "@/server/tools/fs-list";
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

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(bashTool);
  registry.register(fsListTool);
  registry.register(fsReadTool);
  registry.register(fsWriteTool);
  registry.register(readArtifactTool);
  registry.register(writeArtifactTool);
  registry.register(askUserTool);
  registry.register(deployArtifactTool);
  registry.register(deployWorkspaceTool);
  registry.register(readAttachmentTool);
  registry.register(planTasksTool);
  registry.register(reportTaskResultTool);
  registry.register(readEvidenceTool);
  return registry;
}

export const toolRegistry = buildRegistry();
