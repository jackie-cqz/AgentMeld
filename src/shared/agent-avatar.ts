import type { Agent } from "@/shared/types";

type AgentAvatarSource = Pick<Agent, "id" | "name" | "capabilities" | "isConductor">;

const ROLE_STYLES = {
  conductor: { solid: "bg-violet-100 text-violet-700", soft: "text-violet-600" },
  pm: { solid: "bg-blue-100 text-blue-700", soft: "text-blue-600" },
  design: { solid: "bg-fuchsia-100 text-fuchsia-700", soft: "text-fuchsia-600" },
  engineering: { solid: "bg-cyan-100 text-cyan-700", soft: "text-cyan-600" },
  research: { solid: "bg-amber-100 text-amber-700", soft: "text-amber-600" },
} as const;

const FALLBACK_STYLES = [
  { solid: "bg-slate-100 text-slate-700", soft: "text-slate-600" },
] as const;

function stableIndex(str: string, length: number): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % length;
}

function matches(identity: string, keywords: string[]): boolean {
  return keywords.some((kw) => identity.includes(kw));
}

export interface AgentAvatarStyle {
  solid: string;
  soft: string;
}

export function getAgentAvatarStyle(agent: AgentAvatarSource): AgentAvatarStyle {
  if (agent.isConductor) return ROLE_STYLES.conductor;

  const identity = [agent.name, ...agent.capabilities].join(" ").toLowerCase();

  if (matches(identity, ["pm", "product", "prd", "requirements"])) return ROLE_STYLES.pm;
  if (matches(identity, ["ui", "ux", "design", "visual", "style-guide"])) return ROLE_STYLES.design;
  if (matches(identity, ["react", "frontend", "web_app", "builder"])) return ROLE_STYLES.engineering;
  if (matches(identity, ["review", "code-review", "analysis"])) return ROLE_STYLES.research;

  return FALLBACK_STYLES[stableIndex(agent.id || agent.name, FALLBACK_STYLES.length)];
}

export function getAgentAvatarLabel(agent: AgentAvatarSource) {
  if (agent.isConductor) return "CO";

  const identity = [agent.name, ...agent.capabilities].join(" ").toLowerCase();
  if (matches(identity, ["pm", "product", "prd", "requirements"])) return "PM";
  if (matches(identity, ["ui", "ux", "design", "visual", "style-guide"])) return "UI";
  if (matches(identity, ["react", "frontend", "web_app", "builder"])) return "FE";
  if (matches(identity, ["review", "code-review", "analysis"])) return "RV";

  return (agent.name || agent.id || "?").slice(0, 2).toUpperCase();
}
