import fs from "node:fs";
import { z } from "zod";
import { MAX_TEXT_CHARS, MAX_FILE_READ_BYTES } from "@/server/workspace-utils";
import { TOOL_CAPABILITIES } from "@/server/tools/capabilities";
import type { ToolDef } from "@/server/tools/types";
import { createHash } from "node:crypto";
import { safeWorkspacePath } from "@/server/tools/workspace-access";

const ArgsSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().min(1).optional(),
  startColumn: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  includeLineNumbers: z.boolean().optional()
});

export const fsReadTool: ToolDef = {
  name: "fs_read",
  capabilities: TOOL_CAPABILITIES.fs_read,
  description:
    "Read workspace text (max 1 MB). Optional startLine/startColumn (1-based) and limit (max 5000) page through files. Continue using nextStartLine AND nextStartColumn, including very long lines. Returns a content hash. Raw content unless includeLineNumbers=true; do not use displayed line prefixes in patches. Max 50k characters per page.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      startLine: { type: "integer", minimum: 1, description: "First line to read, 1-based." },
      startColumn: { type: "integer", minimum: 1, description: "First character on startLine, 1-based; carry nextStartColumn for long lines." },
      limit: { type: "integer", minimum: 1, maximum: 5000, description: "Maximum lines to return." },
      includeLineNumbers: { type: "boolean", description: "Prefix displayed lines with their line number. Do not include these prefixes in fs_patch oldText." },
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
      absolutePath = safeWorkspacePath(ctx.workspacePath, parsed.data.path);
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

    if (raw.includes("\0")) return { ok: false, error: "Binary file cannot be read as text." };
    const lines = raw.split("\n");
    const start = (parsed.data.startLine ?? 1) - 1;
    const column = (parsed.data.startColumn ?? 1) - 1;
    if (start >= lines.length || column > lines[start].length) return { ok: false, error: "Read cursor is outside this file. Re-read after file changes." };
    const paged = parsed.data.startLine !== undefined || parsed.data.startColumn !== undefined || parsed.data.limit !== undefined || parsed.data.includeLineNumbers;
    let content = ""; let end = start; let nextLine = start; let nextColumn = column;
    const stop = Math.min(lines.length, start + (parsed.data.limit ?? (paged ? 2000 : lines.length)));
    for (let index = start; index < stop; index++) {
      const offset = index === start ? column : 0;
      const prefix = `${index > start ? "\n" : ""}${parsed.data.includeLineNumbers ? `${index + 1}: ` : ""}`;
      const available = MAX_TEXT_CHARS - content.length - prefix.length;
      if (available <= 0) break;
      const segment = lines[index].slice(offset, offset + available);
      content += prefix + segment; end = index + 1;
      if (offset + segment.length < lines[index].length) { nextLine = index; nextColumn = offset + segment.length; break; }
      nextLine = index + 1; nextColumn = 0;
    }
    const truncated = nextLine < lines.length;

    return {
      ok: true,
      value: {
        path: parsed.data.path,
        absolutePath,
        cwd: ctx.workspacePath,
        size: stat.size,
        content,
        truncated,
        startLine: start + 1, endLine: end, totalLines: lines.length,
        hasMore: truncated, nextStartLine: truncated ? nextLine + 1 : null, nextStartColumn: truncated ? nextColumn + 1 : null,
        contentHash: createHash("sha256").update(raw).digest("hex")
      }
    };
  }
};
