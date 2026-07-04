// ---------------------------------------------------------------------------
// P3: Context Externalizer — convert large objects to on-demand references
// ---------------------------------------------------------------------------

import type { ContextCandidate } from "@/server/task-context/context-candidates";

export interface ExternalContextReference {
  refType: "artifact" | "file" | "evidence";
  refId: string;
  title: string;
  summary: string;
  contentHash?: string;
  readTool: "read_artifact" | "fs_read" | "read_evidence";
}

/**
 * Convert a large content candidate into a lightweight ExternalContextReference.
 * V1: artifacts and evidence become references; facts/workspace stay inline.
 */
export function externalizeCandidate(candidate: ContextCandidate): ContextCandidate | ExternalContextReference {
  switch (candidate.category) {
    // P3: upstream_input stays inline — metadata is small and renderer needs artifactId
    case "upstream_input":
      return candidate;
    case "evidence": {
      const ev = candidate.content as { evidenceId?: string; type?: string };
      if (ev.evidenceId) {
        return {
          refType: "evidence",
          refId: ev.evidenceId,
          title: ev.type ?? "evidence",
          summary: `Evidence ${ev.evidenceId}`,
          readTool: "read_evidence",
        };
      }
      return candidate;
    }
    case "workspace": {
      const ws = candidate.content as { path?: string };
      if (ws.path && candidate.tokenEstimate > 200) {
        return {
          refType: "file",
          refId: ws.path,
          title: ws.path,
          summary: `File: ${ws.path}`,
          readTool: "fs_read",
        };
      }
      return candidate;
    }
    default:
      return candidate;
  }
}
