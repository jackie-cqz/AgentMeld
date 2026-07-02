// ---------------------------------------------------------------------------
// P1: read_evidence — allow agents to retrieve sanitized evidence details
//
// Evidence summaries are injected into task context, but full (sanitized)
// details remain in the SQLite Ledger. Agents call this tool to fetch
// specific evidence by ID when they need more context (e.g. error output).
// ---------------------------------------------------------------------------

import type { ToolDef, ToolContext, ToolResult } from "@/server/tools/types";
import { getEvidence } from "@/server/repositories/evidence-repository";
import { sanitizeText } from "@/server/evidence/evidence-sanitizer";

const MAX_RESPONSE_LENGTH = 8192;
const MAX_PER_PAGE = 3;

export const readEvidenceTool: ToolDef = {
  name: "read_evidence",
  description:
    "Read sanitized evidence details from the Evidence Ledger by evidence ID. " +
    "Use this to inspect command output, file hashes, or artifact metadata " +
    "that was summarized in your task context. Returns cleaned payload only — " +
    "secrets and raw binary data are never included.",
  parameters: {
    type: "object",
    required: ["evidenceId"],
    properties: {
      evidenceId: {
        type: "string",
        description: "The evidence ID from your task context (e.g. ev_xxx).",
      },
    },
  },
  handler: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
    const evidenceId = getStr(args, "evidenceId");
    if (!evidenceId) {
      return { ok: false, error: "evidenceId is required" };
    }

    // Security: only read from Ledger — no shell, no filesystem
    const record = getEvidence(evidenceId);
    if (!record) {
      return { ok: false, error: `Evidence "${evidenceId}" not found.` };
    }

    // Security: cross-conversation read prevention
    if (record.conversationId !== ctx.conversationId) {
      return { ok: false, error: `Access denied: evidence belongs to a different conversation.` };
    }

    // P1 access control: only the producer task, direct downstream, or
    // failure-context-referenced tasks may read this evidence.
    if (ctx.taskExecution) {
      // For now, allow if agent is in the same conductor run
      if (record.conductorRunId !== ctx.taskExecution.conductorRunId) {
        return {
          ok: false,
          error: `Access denied: evidence belongs to a different conductor run.`,
        };
      }
    }

    // Sanitize and truncate the payload
    let payloadText = record.payloadJson;
    payloadText = sanitizeText(payloadText);

    if (payloadText.length > MAX_RESPONSE_LENGTH) {
      payloadText =
        payloadText.slice(0, MAX_RESPONSE_LENGTH) +
        `\n... [truncated ${payloadText.length - MAX_RESPONSE_LENGTH} chars]`;
    }

    return {
      ok: true,
      value: {
        evidenceId: record.id,
        type: record.type,
        status: record.status,
        trustLevel: record.trustLevel,
        subjectType: record.subjectType,
        subjectId: record.subjectId,
        contentHash: record.contentHash,
        createdAt: record.createdAt,
        payload: safeJsonParse(payloadText) ?? { _raw: payloadText },
      },
    };
  },
};

function getStr(v: unknown, key: string): string {
  if (v && typeof v === "object" && key in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)[key]);
  }
  return "";
}

function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
