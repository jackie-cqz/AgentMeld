import { describe, expect, it } from "vitest";
import { AGENT_AVATAR_AUTO, AGENT_AVATAR_PRESETS, getAgentAvatarPreset } from "./agent-avatar-presets";
import { getAgentAvatarRole } from "./agent-avatar";

describe("Agent avatar presets", () => {
  it("offers 16 distinct presets that fit the existing avatar API limit", () => {
    expect(AGENT_AVATAR_PRESETS).toHaveLength(16);
    expect(new Set(AGENT_AVATAR_PRESETS.map(preset => preset.id)).size).toBe(16);
    expect(new Set(AGENT_AVATAR_PRESETS.map(preset => preset.icon)).size).toBe(16);
    for (const preset of AGENT_AVATAR_PRESETS) {
      expect(preset.id.length).toBeLessThanOrEqual(10);
      expect(getAgentAvatarPreset(preset.id)).toBe(preset);
    }
  });
  it("falls back to automatic matching for legacy and unknown strings", () => {
    for (const value of [undefined, "", "CO", "旧头像", "av:unknown", AGENT_AVATAR_AUTO]) expect(getAgentAvatarPreset(value)).toBeUndefined();
  });
  it("does not change the Agent's role when selecting a different icon", () => {
    expect(getAgentAvatarRole({ id: "pm", name: "PM", capabilities: [], isConductor: false, avatar: "av:rocket" })).toBe("product");
  });
});
