import { BookOpen, Bot, ClipboardList, Code2, Compass, Database, FlaskConical, Globe, Layers, Lightbulb, Network, PenTool, Rocket, ScanSearch, ShieldCheck, Terminal } from "lucide-react";
import { getAgentAvatarPreset } from "@/shared/agent-avatar-presets";
import { getAgentAvatarLabel, getAgentAvatarRole, getAgentAvatarStyle, type AgentAvatarSource } from "@/shared/agent-avatar";

export type AgentAvatarSize = "xs" | "sm" | "md" | "lg";
const ROLE_ICONS = { conductor: Network, product: ClipboardList, design: PenTool, frontend: Code2,
  reviewer: ShieldCheck, research: ScanSearch, engineering: Terminal, general: Bot,
  book: BookOpen, bulb: Lightbulb, globe: Globe, flask: FlaskConical, rocket: Rocket, layers: Layers, compass: Compass, database: Database };

// The adjacent name or containing button announces the identity, not twice.
export function AgentAvatar({ agent, size = "md", className = "" }: {
  agent: AgentAvatarSource; size?: AgentAvatarSize; className?: string;
}) {
  const role = getAgentAvatarRole(agent);
  const preset = getAgentAvatarPreset(agent.avatar);
  const Icon = preset ? ROLE_ICONS[preset.icon] : role === "custom" ? null : ROLE_ICONS[role];
  return <span aria-hidden="true" data-agent-role={role} data-avatar-size={size} data-avatar-preset={preset?.id ?? "auto"}
    className={`agent-avatar agent-avatar--${size} ${getAgentAvatarStyle(agent).solid} ${className}`}>
    {Icon ? <Icon strokeWidth={1.65} /> : <span className="agent-avatar-monogram">{getAgentAvatarLabel(agent)}</span>}
  </span>;
}
