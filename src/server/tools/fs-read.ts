import fs from "node:fs";
import { z } from "zod";
import { assertPathWithinWorkspace, MAX_TEXT_CHARS, MAX_FILE_READ_BYTES } from "@/server/workspace-utils";
import type { ToolDef } from "@/server/tools/types";

const ArgsSchema = z.object({
  path: z.string().min(1)
});

export const fsReadTool: ToolDef = {
  name: "fs_read",
  description:
    "Read a text file inside the workspace. Returns file content (UTF-8), truncated to 50,000 characters. Max file size: 1 MB.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Relative or absolute path to the file within the workspace."
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

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      return { ok: false, error: `File not found: ${parsed.data.path}` };
    }

    if (!stat.isFile()) {
      return { ok: false, error: `Path is not a file: ${parsed.data.path}` };
    }

    if (stat.size > MAX_FILE_READ_BYTES) {
      return { ok: false, error: `File too large (${stat.size} bytes, max ${MAX_FILE_READ_BYTES}).` };
    }

    let raw: string;
    try {
      raw = fs.readFileSync(absolutePath, "utf-8");
    } catch (error) {
      return { ok: false, error: `Failed to read file: ${error instanceof Error ? error.message : "unknown error"}` };
    }

    const truncated = raw.length > MAX_TEXT_CHARS;
    const content = truncated ? raw.slice(0, MAX_TEXT_CHARS) : raw;

    return {
      ok: true,
      value: {
        path: parsed.data.path,
        absolutePath,
        cwd: ctx.workspacePath,
        size: stat.size,
        content,
        truncated
      }
    };
  }
};
