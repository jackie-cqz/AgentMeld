import fs from "node:fs";
import { z } from "zod";
import { assertPathWithinWorkspace } from "@/server/workspace-utils";
import { TOOL_CAPABILITIES } from "@/server/tools/capabilities";
import type { ToolDef } from "@/server/tools/types";

const ArgsSchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean().optional().default(true)
});

export const fsMkdirTool: ToolDef = {
  name: "fs_mkdir",
  capabilities: TOOL_CAPABILITIES.fs_mkdir,
  description:
    "Create a directory inside the workspace. Use this instead of bash/PowerShell mkdir when a directory is needed. " +
    "It cannot delete, move, rename, or overwrite files.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Directory path relative to workspace root." },
      recursive: {
        type: "boolean",
        description: "Create parent directories as needed. Defaults to true."
      }
    }
  },
  async handler(args, ctx) {
    const parsed = ArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` };
    }

    let absolutePath: string;
    try {
      absolutePath = assertPathWithinWorkspace(ctx.workspacePath, parsed.data.path);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Path validation failed." };
    }

    if (fs.existsSync(absolutePath) && !fs.statSync(absolutePath).isDirectory()) {
      return { ok: false, error: `Path "${parsed.data.path}" already exists and is not a directory.` };
    }

    fs.mkdirSync(absolutePath, { recursive: parsed.data.recursive });
    return {
      ok: true,
      value: {
        path: parsed.data.path,
        absolutePath,
        created: true
      }
    };
  }
};
