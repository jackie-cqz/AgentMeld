import type { Agent } from "@/shared/types";

type AgentAvatarSource = Pick<Agent, "id" | "name" | "capabilities" | "isConductor">;

export interface AgentAvatarStyle {
  solid: string;
  soft: string;
}

const ROLE_STYLES = {
  conductor: {
    solid: "bg-violet-600 text-white",
    soft: "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200"
  },
  product: {
    solid: "bg-blue-600 text-white",
    soft: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200"
  },
  design: {
    solid: "bg-fuchsia-600 text-white",
    soft: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-200"
  },
  frontend: {
    solid: "bg-cyan-600 text-white",
    soft: "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-200"
  },
  reviewer: {
    solid: "bg-amber-500 text-white",
    soft: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200"
  },
  research: {
    solid: "bg-indigo-600 text-white",
    soft: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200"
  },
  engineering: {
    solid: "bg-orange-600 text-white",
    soft: "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-200"
  },
  general: {
    solid: "bg-emerald-600 text-white",
    soft: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200"
  }
} satisfies Record<string, AgentAvatarStyle>;

const FALLBACK_STYLES = [
  ROLE_STYLES.general,
  ROLE_STYLES.research,
  ROLE_STYLES.engineering,
  ROLE_STYLES.design
] as const;

export function getAgentAvatarStyle(agent: AgentAvatarSource): AgentAvatarStyle {
  if (agent.isConductor) return ROLE_STYLES.conductor;

  const identity = [agent.name, ...agent.capabilities].join(" ").toLowerCase();

  if (matches(identity, ["pm", "product", "prd", "requirements", "产品", "需求"])) {
    return ROLE_STYLES.product;
  }
  if (matches(identity, ["ui", "ux", "design", "visual", "style-guide", "设计", "视觉"])) {
    return ROLE_STYLES.design;
  }
  if (matches(identity, ["frontend", "react", "vue", "web_app", "html", "css", "前端"])) {
    return ROLE_STYLES.frontend;
  }
  if (matches(identity, ["reviewer", "review", "code-review", "qa", "审查", "评审", "测试"])) {
    return ROLE_STYLES.reviewer;
  }
  if (matches(identity, ["research", "analysis", "analyst", "研究", "调研", "分析"])) {
    return ROLE_STYLES.research;
  }
  if (matches(identity, ["backend", "server", "database", "devops", "engineering", "后端", "运维"])) {
    return ROLE_STYLES.engineering;
  }
  if (matches(identity, ["general", "custom", "assistant", "通用", "自定义"])) {
    return ROLE_STYLES.general;
  }

  return FALLBACK_STYLES[stableIndex(agent.id || agent.name, FALLBACK_STYLES.length)];
}

export function getAgentAvatarLabel(agent: AgentAvatarSource) {
  if (agent.isConductor) return "CO";

  const identity = [agent.name, ...agent.capabilities].join(" ").toLowerCase();
  if (matches(identity, ["pm", "product", "prd", "requirements", "产品", "需求"])) return "PM";
  if (matches(identity, ["ui", "ux", "design", "visual", "style-guide", "设计", "视觉"])) return "UI";
  if (matches(identity, ["frontend", "react", "vue", "web_app", "html", "css", "前端"])) return "FE";
  if (matches(identity, ["reviewer", "review", "code-review", "qa", "审查", "评审", "测试"])) return "RE";
  if (matches(identity, ["research", "analysis", "analyst", "研究", "调研", "分析"])) return "RA";
  if (matches(identity, ["backend", "server", "database", "devops", "engineering", "后端", "运维"])) return "BE";

  const asciiWords = agent.name.match(/[A-Za-z0-9]+/g);
  if (asciiWords?.length) {
    return asciiWords.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("");
  }
  return agent.name.trim().slice(0, 2) || "AG";
}

function matches(identity: string, terms: string[]) {
  return terms.some((term) => identity.includes(term));
}

function stableIndex(value: string, length: number) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash % length;
}
