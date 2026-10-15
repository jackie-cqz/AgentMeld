"use client";

import { Check, ImagePlus } from "lucide-react";
import { useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Modal } from "@/components/ui/modal";
import { AGENT_AVATAR_AUTO, AGENT_AVATAR_PRESETS, getAgentAvatarPreset } from "@/shared/agent-avatar-presets";
import type { AgentAvatarSource } from "@/shared/agent-avatar";

export function AgentAvatarPicker({ agent, value, onChange }: {
  agent: AgentAvatarSource; value: string; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = getAgentAvatarPreset(value);
  return <>
    <div className="agent-identity-preview">
      <AgentAvatar agent={{ ...agent, avatar: value }} size="lg" />
      <div><strong>{agent.name.trim() || "新 Agent"}</strong><span>{selected?.label ?? "自动匹配头像"}</span></div>
      <button type="button" className="ui-button" onClick={() => setOpen(true)}><ImagePlus size={14} />选择头像</button>
    </div>
    <Modal open={open} onClose={() => setOpen(false)} title="选择头像" className="agent-avatar-picker"
      footer={<button className="ui-button ui-button--primary" onClick={() => setOpen(false)}>完成</button>}>
      <fieldset><legend className="sr-only">Agent 头像预设</legend>
        <label className="agent-avatar-auto"><input type="radio" name="agent-avatar-preset" aria-label="自动匹配头像" checked={!selected} onChange={() => onChange(AGENT_AVATAR_AUTO)} />
          <AgentAvatar agent={{ ...agent, avatar: AGENT_AVATAR_AUTO }} size="sm" /><span>自动匹配</span>{!selected ? <Check size={15} aria-hidden="true" /> : null}
        </label>
        <div className="agent-avatar-preset-grid">{AGENT_AVATAR_PRESETS.map(preset => <label key={preset.id} title={preset.label}>
          <input type="radio" name="agent-avatar-preset" aria-label={preset.label} checked={value === preset.id} onChange={() => onChange(preset.id)} />
          <AgentAvatar agent={{ ...agent, avatar: preset.id }} /><span>{preset.label}</span>
          {value === preset.id ? <Check size={12} className="agent-avatar-selected" aria-hidden="true" /> : null}
        </label>)}</div>
      </fieldset>
    </Modal>
  </>;
}
