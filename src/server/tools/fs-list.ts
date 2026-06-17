import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertPathWithinWorkspace } from "@/server/workspace-utils";
import type { ToolDef } from "@/server/tools/types";

const ArgsSchema = z.object({
  path: z.string().default(".")
});

export const fsListTool: ToolDef = {
  name: "fs_list",
  description:
    "List files and directories inside the workspace. Returns name, relative path, and type (file/directory) for each entry.",
  parameters: {
    type: "object",
    required: [],
    properties: {
      path: {
        type: "string",
        description: "Directory path relative to workspace root. Defaults to '.' (workspace root)."
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
      return { ok: false, error: `Path not found: ${parsed.data.path}` };
    }

    if (!stat.isDirectory()) {
      return { ok: false, error: `Path is not a directory: ${parsed.data.path}` };
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolutePath, { withFileTypes: true });
    } catch (error) {
      return { ok: false, error: `Failed to read directory: ${error instanceof Error ? error.message : "unknown error"}` };
    }

    const listing = entries.map((entry) => {
      const entryPath = path.join(absolutePath, entry.name);
      const relativePath = path.relative(ctx.workspacePath, entryPath);
      let entryType: "file" | "directory" | "other" = "other";
      try {
        if (entry.isDirectory()) {
          entryType = "directory";
        } else if (entry.isFile()) {
          entryType = "file";
        }
      } catch {
        // Use lstat results from Dirent
        if (entry.isDirectory()) entryType = "directory";
        else if (entry.isFile()) entryType = "file";
      }
      return {
        name: entry.name,
        path: relativePath || entry.name,
        type: entryType
      };
    });

    return {
      ok: true,
      value: {
        cwd: ctx.workspacePath,
        path: parsed.data.path,
        entries: listing,
        count: listing.length
      }
    };
  }
};
