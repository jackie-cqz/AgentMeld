import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
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
    "Create a directory. A relative path resolves against the workspace root; an absolute path is used as-is. " +
    "It cannot delete, move, rename, or overwrite files.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Directory path; a relative path resolves against the workspace root." },
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

    // Issue #79: full access. Unlike fs_write/fs_patch/fs_list — which the Pi
    // bridge serves with Pi's native write/edit/ls and never routes here —
    // fs_mkdir has no native equivalent, so it stays a platform extension tool
    // and an Agent run CAN call this handler. It therefore follows the same
    // capability decision as the native file tools: the path is resolved against
    // the invocation workspace, never refused for resolving outside it.
    const absolutePath = path.resolve(ctx.workspacePath, parsed.data.path);

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
