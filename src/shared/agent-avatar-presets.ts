export const AGENT_AVATAR_AUTO = "av:auto";

export const AGENT_AVATAR_PRESETS = [
  { id: "av:bot", label: "机器人", icon: "general" },
  { id: "av:graph", label: "协作", icon: "conductor" },
  { id: "av:tasks", label: "规划", icon: "product" },
  { id: "av:pen", label: "设计", icon: "design" },
  { id: "av:code", label: "代码", icon: "frontend" },
  { id: "av:shield", label: "质量", icon: "reviewer" },
  { id: "av:search", label: "研究", icon: "research" },
  { id: "av:term", label: "终端", icon: "engineering" },
  { id: "av:book", label: "知识", icon: "book" },
  { id: "av:bulb", label: "灵感", icon: "bulb" },
  { id: "av:globe", label: "探索", icon: "globe" },
  { id: "av:flask", label: "实验", icon: "flask" },
  { id: "av:rocket", label: "交付", icon: "rocket" },
  { id: "av:layers", label: "架构", icon: "layers" },
  { id: "av:compass", label: "导航", icon: "compass" },
  { id: "av:data", label: "数据", icon: "database" }
] as const;

export function getAgentAvatarPreset(value?: string) {
  return AGENT_AVATAR_PRESETS.find(preset => preset.id === value);
}
