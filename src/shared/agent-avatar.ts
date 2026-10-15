import type { Agent } from "@/shared/types";

export type AgentAvatarSource = Pick<Agent, "id" | "name" | "capabilities" | "isConductor"> & Partial<Pick<Agent, "avatar">>;
export type AgentAvatarRole = "conductor" | "product" | "design" | "frontend" | "reviewer" | "research" | "engineering" | "general" | "custom";

export interface AgentAvatarStyle { solid: string; soft: string }

const ROLE_TONES = {
  conductor: "violet", product: "blue", design: "fuchsia", frontend: "cyan",
  reviewer: "amber", research: "indigo", engineering: "orange", general: "emerald"
} as const;
const ROLE_TERMS = [
  ["product", ["pm", "product", "prd", "requirements", "产品", "需求"]],
  ["design", ["ui", "ux", "design", "visual", "style-guide", "设计", "视觉"]],
  ["frontend", ["frontend", "react", "vue", "web_app", "html", "css", "前端"]],
  ["reviewer", ["reviewer", "review", "code-review", "qa", "审查", "评审", "测试"]],
  ["research", ["research", "analysis", "analyst", "研究", "调研", "分析"]],
  ["engineering", ["backend", "server", "database", "devops", "engineering", "后端", "运维"]],
  ["general", ["general", "custom", "assistant", "通用", "自定义"]]
] as const;

export function getAgentAvatarRole(agent: AgentAvatarSource): AgentAvatarRole {
  if (agent.isConductor) return "conductor";
  // Named roles take precedence over broad skills such as React or research.
  for (const identity of [agent.name.toLowerCase(), agent.capabilities.join(" ").toLowerCase()]) {
    for (const [role, terms] of ROLE_TERMS) {
      if (terms.some(term => term.length <= 2 && /^[a-z]+$/.test(term)
        ? new RegExp(`(?:^|[^a-z0-9])${term}(?:$|[^a-z0-9])`).test(identity)
        : identity.includes(term))) return role;
    }
  }
  return "custom";
}

export function getAgentAvatarStyle(agent: AgentAvatarSource): AgentAvatarStyle {
  const role = getAgentAvatarRole(agent);
  const fallback = ["emerald", "indigo", "orange", "fuchsia"] as const;
  const tone = role === "custom" ? fallback[stableIndex(agent.id || agent.name, fallback.length)] : ROLE_TONES[role];
  return { solid: `agent-avatar-tone--${tone}`, soft: `agent-avatar-tone--${tone}` };
}

export function getAgentAvatarLabel(agent: AgentAvatarSource) {
  const role = getAgentAvatarRole(agent);
  const labels: Partial<Record<AgentAvatarRole, string>> = { conductor: "CO", product: "PM", design: "UI", frontend: "FE", reviewer: "RE", research: "RA", engineering: "BE" };
  if (labels[role]) return labels[role];
  const asciiWords = agent.name.match(/[A-Za-z0-9]+/g);
  if (asciiWords?.length) return asciiWords.slice(0, 2).map(word => word[0]?.toUpperCase()).join("");
  return Array.from(agent.name.trim()).slice(0, 2).join("") || "AG";
}

function stableIndex(value: string, length: number) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash % length;
}
