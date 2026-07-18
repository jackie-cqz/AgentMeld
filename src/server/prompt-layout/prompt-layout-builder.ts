// ---------------------------------------------------------------------------
// P0: Prompt Layout Builder — assemble stable prefix and dynamic suffix
// ---------------------------------------------------------------------------

import type { PromptLayout, PromptLayoutInput, PromptLayoutSection } from "@/server/prompt-layout/prompt-layout-types";
import { generateCacheKey } from "@/server/prompt-layout/prompt-cache-key";

const PLATFORM_PROMPT_VERSION = "agentmeld-p0-v1";
export const ROLE_CONTRACT_VERSION = "role-contracts-v1";
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

export function buildPromptLayout(input: PromptLayoutInput): PromptLayout {
  const sections: PromptLayoutSection[] = [];

  // ── Stable prefix sections ──────────────────────────────────────────────

  // Agent identity
  const identityContent = `<agent_identity>
  <agent_id>${input.agentId}</agent_id>
  <agent_name>${input.agentName}</agent_name>
  <capabilities>${input.agentCapabilities.join(", ")}</capabilities>
</agent_identity>`;
  sections.push({
    id: "agent_identity", placement: "stable_prefix", title: "Agent Identity",
    content: identityContent, tokenEstimate: estimateTokens(identityContent), stable: true,
  });

  // Agent system prompt (static part)
  if (input.agentSystemPrompt.trim()) {
    sections.push({
      id: "agent_system_prompt", placement: "stable_prefix", title: "System Prompt",
      content: input.agentSystemPrompt, tokenEstimate: estimateTokens(input.agentSystemPrompt), stable: true,
    });
  }

  // Platform stable sections from adapter
  for (const sec of input.stableSections) {
    sections.push({
      id: sec.id, placement: "stable_prefix", title: sec.title,
      content: sec.content, tokenEstimate: sec.tokenEstimate, stable: true,
    });
  }

  // ── Dynamic suffix sections ─────────────────────────────────────────────

  // User message
  const userContent = `<user_request>\n${input.userMessage.slice(0, 4000)}\n</user_request>`;
  sections.push({
    id: "user_request", placement: "dynamic_suffix", title: "User Request",
    content: userContent, tokenEstimate: estimateTokens(userContent), stable: false,
  });

  // Task prompt
  if (input.taskPrompt.trim()) {
    sections.push({
      id: "task_prompt", placement: "dynamic_suffix", title: "Task Prompt",
      content: `<your_task>\n${input.taskPrompt}\n</your_task>`, tokenEstimate: estimateTokens(input.taskPrompt), stable: false,
    });
  }

  // Task context XML (from TaskContextEnvelope)
  if (input.taskContextXml.trim()) {
    sections.push({
      id: "task_context", placement: "dynamic_suffix", title: "Task Context",
      content: input.taskContextXml, tokenEstimate: estimateTokens(input.taskContextXml), stable: false,
    });
  }

  // Failure context
  if (input.failureContextXml.trim()) {
    sections.push({
      id: "failure_context", placement: "dynamic_suffix", title: "Failure Context",
      content: input.failureContextXml, tokenEstimate: estimateTokens(input.failureContextXml), stable: false,
    });
  }

  const stableSections = sections.filter((s) => s.placement === "stable_prefix");
  const dynamicSections = sections.filter((s) => s.placement === "dynamic_suffix");

  const stablePrefix = stableSections.map((s) => s.content).join("\n\n");
  const dynamicSuffix = dynamicSections.map((s) => s.content).join("\n\n");

  const cacheKey = generateCacheKey({
    agentId: input.agentId,
    agentSystemPrompt: input.agentSystemPrompt,
    toolNames: input.toolNames,
    platformPromptVersion: PLATFORM_PROMPT_VERSION,
    roleContractVersion: ROLE_CONTRACT_VERSION,
  });

  return { stablePrefix, dynamicSuffix, cacheKey, sections };
}
