import fs from "node:fs";
import { z } from "zod";
import { getConversation } from "@/server/repositories";
import { registerPendingWrite } from "@/server/pending-writes";
import {
  assertPathWithinWorkspace,
  ensureDir,
  MAX_FILE_WRITE_BYTES,
  SANDBOX_MAX_BYTES,
  SANDBOX_MAX_FILES,
  scanWorkspaceUsage
} from "@/server/workspace-utils";
import type { ToolDef } from "@/server/tools/types";

const ArgsSchema = z.object({
  path: z.string().min(1),
  content: z.string()
});

export const fsWriteTool: ToolDef = {
  name: "fs_write",
  description:
    "Write a text file inside the workspace. Creates parent directories automatically. " +
    "Max 100 KB per file. In sandbox mode, the total workspace cannot exceed 100 MB / 1000 files.",
  parameters: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: {
        type: "string",
        description: "File path relative to workspace root."
      },
      content: {
        type: "string",
        description: "Text content to write."
      }
    }
  },
  async handler(args, ctx) {
    const parsed = ArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` };
    }

    // Check content size
    const contentBytes = Buffer.byteLength(parsed.data.content, "utf-8");
    if (contentBytes > MAX_FILE_WRITE_BYTES) {
      return { ok: false, error: `Content too large (${contentBytes} bytes, max ${MAX_FILE_WRITE_BYTES}).` };
    }

    // Validate path
    let absolutePath: string;
    try {
      absolutePath = assertPathWithinWorkspace(ctx.workspacePath, parsed.data.path);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Path validation failed." };
    }

    // Sandbox quota check
    try {
      const usage = scanWorkspaceUsage(ctx.workspacePath);
      if (usage.totalBytes + contentBytes > SANDBOX_MAX_BYTES) {
        return {
          ok: false,
          error: `Workspace quota exceeded: ${usage.totalBytes} bytes used, max ${SANDBOX_MAX_BYTES}.`
        };
      }
      if (usage.totalFiles >= SANDBOX_MAX_FILES) {
        return {
          ok: false,
          error: `Workspace file limit exceeded: ${usage.totalFiles} files, max ${SANDBOX_MAX_FILES}.`
        };
      }
    } catch {
      // If scan fails, proceed (e.g. workspace dir doesn't exist yet).
    }

    // Read old content if file exists
    let oldContent: string | null = null;
    try {
      oldContent = fs.readFileSync(absolutePath, "utf-8");
    } catch {
      // File doesn't exist yet — fine.
    }

    // Determine approval mode from conversation
    const conversation = getConversation(ctx.conversationId);
    const approvalMode = conversation?.fsWriteApprovalMode ?? "review";

    if (approvalMode === "auto") {
      // Write directly
      ensureDir(absolutePath);
      fs.writeFileSync(absolutePath, parsed.data.content, "utf-8");
      return {
        ok: true,
        value: {
          path: parsed.data.path,
          absolutePath,
          cwd: ctx.workspacePath,
          bytes: contentBytes,
          applied: "auto"
        }
      };
    }

    // Review mode: register pending write and wait for approval
    const approved = await registerPendingWrite(
      ctx.conversationId,
      ctx.agentId,
      ctx.runId,
      parsed.data.path,
      absolutePath,
      oldContent,
      parsed.data.content
    );

    if (!approved) {
      return { ok: false, error: "User rejected the file change." };
    }

    // Approved — write to disk
    ensureDir(absolutePath);
    fs.writeFileSync(absolutePath, parsed.data.content, "utf-8");
    return {
      ok: true,
      value: {
        path: parsed.data.path,
        absolutePath,
        cwd: ctx.workspacePath,
        bytes: contentBytes,
        applied: "review"
      }
    };
  }
};
