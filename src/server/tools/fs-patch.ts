import fs from "node:fs";
import { z } from "zod";
import { getConversation } from "@/server/repositories";
import { recordFileWrite } from "@/server/dispatch-file-writes";
import { recordFileWriteEvidence } from "@/server/dispatch-tool-evidence";
import { registerPendingWrite } from "@/server/pending-writes";
import {
  assertPathWithinWorkspace,
  checkSandboxQuota,
  MAX_FILE_READ_BYTES,
  scanWorkspaceUsage
} from "@/server/workspace-utils";
import type { ToolContext, ToolDef, ToolResult } from "@/server/tools/types";
import { TOOL_CAPABILITIES } from "@/server/tools/capabilities";

const ArgsSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1).max(50_000),
  newText: z.string().max(100_000),
  replaceAll: z.boolean().optional().default(false)
});

export const fsPatchTool: ToolDef = {
  name: "fs_patch",
  capabilities: TOOL_CAPABILITIES.fs_patch,
  description:
    "Modify an existing workspace text file by replacing an exact oldText snippet with newText. " +
    "oldText and newText must differ; a no-op replacement is rejected. " +
    "By default oldText must occur exactly once; set replaceAll=true only for an intentional bulk replacement. " +
    "Read the file with fs_read before patching. Uses the same approval and workspace safety policy as fs_write.",
  parameters: {
    type: "object",
    required: ["path", "oldText", "newText"],
    properties: {
      path: {
        type: "string",
        description: "Existing text file path relative to workspace root."
      },
      oldText: {
        type: "string",
        description: "Exact text currently present in the file. Include enough surrounding context to make it unique."
      },
      newText: {
        type: "string",
        description: "Replacement text. Use an empty string only when intentionally removing the matched snippet."
      },
      replaceAll: {
        type: "boolean",
        description: "Replace every exact occurrence. Defaults to false and rejects ambiguous multiple matches."
      }
    }
  },
  async handler(args, ctx) {
    const parsed = ArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` };
    }
    if (parsed.data.oldText === parsed.data.newText) {
      return {
        ok: false,
        error:
          "No-op patch rejected: oldText and newText are identical, so no source change is needed. " +
          "Treat this edit as complete and continue with the next requirement; do not retry the same patch.",
        code: "NO_OP_PATCH",
        category: "validation_error",
      };
    }

    let absolutePath: string;
    try {
      absolutePath = assertPathWithinWorkspace(ctx.workspacePath, parsed.data.path);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Path validation failed.",
        code: "WORKSPACE_PATH_ESCAPE",
        category: "security_policy",
      };
    }

    let oldContent: string;
    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile()) {
        return { ok: false, error: `Path "${parsed.data.path}" is not a file.` };
      }
      if (stat.size > MAX_FILE_READ_BYTES) {
        return {
          ok: false,
          error: `File too large to patch safely (${stat.size} bytes, max ${MAX_FILE_READ_BYTES}).`
        };
      }
      oldContent = fs.readFileSync(absolutePath, "utf-8");
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error
          ? `Unable to read "${parsed.data.path}": ${error.message}`
          : `Unable to read "${parsed.data.path}".`
      };
    }

    if (oldContent.includes("\0")) {
      return { ok: false, error: `File "${parsed.data.path}" is not a supported text file.` };
    }

    const occurrences = countOccurrences(oldContent, parsed.data.oldText);
    if (occurrences === 0) {
      return {
        ok: false,
        error:
          `oldText was not found in "${parsed.data.path}". ` +
          "Read the latest file with fs_read and retry with an exact snippet."
      };
    }
    if (!parsed.data.replaceAll && occurrences !== 1) {
      return {
        ok: false,
        error:
          `oldText matched ${occurrences} locations in "${parsed.data.path}". ` +
          "Include more surrounding context to make the match unique, or set replaceAll=true intentionally."
      };
    }

    const replacementCount = parsed.data.replaceAll ? occurrences : 1;
    const newContent = parsed.data.replaceAll
      ? oldContent.split(parsed.data.oldText).join(parsed.data.newText)
      : replaceFirst(oldContent, parsed.data.oldText, parsed.data.newText);
    const oldBytes = Buffer.byteLength(oldContent, "utf-8");
    const newBytes = Buffer.byteLength(newContent, "utf-8");

    if (newBytes > MAX_FILE_READ_BYTES) {
      return {
        ok: false,
        error: `Patched file would be too large (${newBytes} bytes, max ${MAX_FILE_READ_BYTES}).`
      };
    }

    try {
      const usage = scanWorkspaceUsage(ctx.workspacePath);
      const quotaError = checkSandboxQuota(usage, newBytes, oldBytes, false);
      if (quotaError) return { ok: false, error: quotaError };
    } catch {
      // Path validation and file-size checks still apply if usage scanning fails.
    }

    const conversation = getConversation(ctx.conversationId);
    const approvalMode = conversation?.fsWriteApprovalMode ?? "auto";

    if (approvalMode === "review") {
      const approved = await registerPendingWrite(
        ctx.conversationId,
        ctx.agentId,
        ctx.runId,
        parsed.data.path,
        absolutePath,
        oldContent,
        newContent
      );
      if (!approved) {
        return {
          ok: false,
          error: "User rejected the file change.",
          code: "APPROVAL_REJECTED",
          category: "approval_rejected",
        };
      }

      const staleError = verifyFileUnchanged(absolutePath, oldContent, parsed.data.path);
      if (staleError) return staleError;
    }

    fs.writeFileSync(absolutePath, newContent, "utf-8");
    recordPatchEvidence(ctx, parsed.data.path, absolutePath, newContent);

    return {
      ok: true,
      value: {
        path: parsed.data.path,
        absolutePath,
        cwd: ctx.workspacePath,
        replacements: replacementCount,
        beforeBytes: oldBytes,
        afterBytes: newBytes,
        applied: approvalMode
      }
    };
  }
};

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor <= content.length - search.length) {
    const index = content.indexOf(search, cursor);
    if (index === -1) break;
    count += 1;
    cursor = index + search.length;
  }
  return count;
}

function replaceFirst(content: string, oldText: string, newText: string): string {
  const index = content.indexOf(oldText);
  return content.slice(0, index) + newText + content.slice(index + oldText.length);
}

function verifyFileUnchanged(
  absolutePath: string,
  expectedContent: string,
  relativePath: string
): ToolResult | null {
  try {
    if (fs.readFileSync(absolutePath, "utf-8") === expectedContent) return null;
  } catch {
    // Treat files removed during approval as stale as well.
  }
  return {
    ok: false,
    error:
      `File "${relativePath}" changed while the patch was awaiting approval. ` +
      "Read the latest file with fs_read and submit a new fs_patch."
  };
}

function recordPatchEvidence(
  ctx: ToolContext,
  relativePath: string,
  absolutePath: string,
  content: string
): void {
  if (ctx.runId) {
    recordFileWrite(ctx.runId, absolutePath, content);
  }
  if (ctx.runId && ctx.parentRunId) {
    recordFileWriteEvidence(ctx.runId, {
      path: relativePath,
      absolutePath,
      action: "modified",
    });
  }
}
