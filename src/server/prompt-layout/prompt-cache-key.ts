// ---------------------------------------------------------------------------
// P0: Prompt cache key — deterministic fingerprint of stable prefix content
// ---------------------------------------------------------------------------

import * as crypto from "node:crypto";

export function generateCacheKey(params: {
  agentId: string;
  agentSystemPrompt: string;
  toolNames: string[];
  platformPromptVersion: string;
  roleContractVersion: string;
}): string {
  const input = [
    params.agentId,
    params.agentSystemPrompt,
    params.toolNames.slice().sort().join(","),
    params.platformPromptVersion,
    params.roleContractVersion,
  ].join("\n");

  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}
