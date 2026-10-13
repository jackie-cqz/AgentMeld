// ---------------------------------------------------------------------------
// P3: Context Compressor — V1: keep mandatory items full, summarize rest
// ---------------------------------------------------------------------------

import type { ContextCandidate } from "@/server/task-context/context-candidates";

export interface CompressedItem {
  candidate: ContextCandidate;
  compressedContent: unknown;
  compressionSummary: string;
}

/**
 * V1 compression: mandatory items keep their full content; optional items
 * are compressed to summary form. No LLM calls.
 */
export function compressCandidate(candidate: ContextCandidate, tier: "mandatory" | "high" | "optional"): CompressedItem {
  switch (candidate.category) {
    case "fact":
      return {
        candidate,
        compressedContent: candidate.content,
        compressionSummary: tier === "mandatory" ? "full" : "summary",
      };
    case "upstream_input": {
      return {
        candidate,
        // Upstream inputs already contain lightweight metadata, not artifact bodies.
        compressedContent: candidate.content,
        compressionSummary: "artifact ref",
      };
    }
    case "workspace": {
      const ws = candidate.content as { path?: string; entries?: unknown[]; truncated?: boolean; note?: string };
      return {
        candidate,
        compressedContent: Array.isArray(ws.entries)
          ? { entries: ws.entries, truncated: ws.truncated ?? false, note: ws.note }
          : { path: ws.path },
        compressionSummary: Array.isArray(ws.entries) ? "workspace snapshot" : "path ref",
      };
    }
    case "evidence": {
      return { candidate, compressedContent: candidate.content, compressionSummary: tier === "mandatory" ? "full evidence" : "evidence ref" };
    }
    case "failure":
      return { candidate, compressedContent: candidate.content, compressionSummary: "full" };
    default:
      return { candidate, compressedContent: candidate.content, compressionSummary: tier === "mandatory" ? "full" : "summary" };
  }
}
