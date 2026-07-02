import fs from "node:fs";
import { z } from "zod";
import { getConversation } from "@/server/repositories";
import { recordFileWrite } from "@/server/dispatch-file-writes";
import { recordFileWriteEvidence } from "@/server/dispatch-tool-evidence";
import { registerPendingWrite } from "@/server/pending-writes";
import {
  assertPathWithinWorkspace,
  checkSandboxQuota,
  ensureDir,
  MAX_FILE_WRITE_BYTES,
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
    "Max 100 KB per file. In sandbox mode, the total workspace cannot exceed 1 GB / 50,000 files.",
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

    let oldContent: string | null = null;
    let oldBytes = 0;
    try {
      oldContent = fs.readFileSync(absolutePath, "utf-8");
      oldBytes = Buffer.byteLength(oldContent, "utf-8");
    } catch {
      // File doesn't exist yet.
    }

    // Sandbox quota check
    try {
      const usage = scanWorkspaceUsage(ctx.workspacePath);
      const quotaError = checkSandboxQuota(usage, contentBytes, oldBytes, oldContent === null);
      if (quotaError) return { ok: false, error: quotaError };
    } catch {
      // If scan fails, proceed (e.g. workspace dir doesn't exist yet).
    }

    // Determine approval mode from conversation (sandbox default: auto)
    const conversation = getConversation(ctx.conversationId);
    const approvalMode = conversation?.fsWriteApprovalMode ?? "auto";

    if (approvalMode === "auto") {
      // Write directly
      ensureDir(absolutePath);
      fs.writeFileSync(absolutePath, parsed.data.content, "utf-8");
      if (ctx.runId) {
        recordFileWrite(ctx.runId, absolutePath, parsed.data.content);
      }
      if (ctx.runId && ctx.parentRunId) {
        recordFileWriteEvidence(ctx.runId, {
          path: parsed.data.path,
          absolutePath,
          action: oldContent === null ? "created" : "modified"
        });
      }
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
    if (ctx.runId) {
      recordFileWrite(ctx.runId, absolutePath, parsed.data.content);
    }
    if (ctx.runId && ctx.parentRunId) {
      recordFileWriteEvidence(ctx.runId, {
        path: parsed.data.path,
        absolutePath,
        action: oldContent === null ? "created" : "modified"
      });
    }
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
