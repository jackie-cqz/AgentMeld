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
      const inp = candidate.content as { artifactId?: string; title?: string; version?: number };
      return {
        candidate,
        compressedContent: inp.artifactId
          ? { artifactId: inp.artifactId, title: inp.title, version: inp.version }
          : candidate.content,
        compressionSummary: "artifact ref",
      };
    }
    case "workspace": {
      const ws = candidate.content as { path?: string };
      return { candidate, compressedContent: { path: ws.path }, compressionSummary: "path ref" };
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
