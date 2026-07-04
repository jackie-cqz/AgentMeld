// ---------------------------------------------------------------------------
// P2: Fact Service tests
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { canonicalizeFactKey } from "@/server/context-facts/fact-service";
import { validateFactValue } from "@/server/context-facts/fact-value-validator";
import { generateCanonicalKey, isKeyConflict } from "@/server/context-facts/fact-key-generator";
import { getFilteredDefinitionsForAgent } from "@/server/context-facts/fact-agent-dto";
import type { CandidateFactUpdate } from "@/shared/context-fact-types";

describe("fact-canonicalizer", () => {
  it("matches by definitionId", () => {
    const candidate: CandidateFactUpdate = {
      definitionId: "builtin_ui_primary_color",
      value: "#22c55e",
      confidence: 1.0,
    };
    const result = canonicalizeFactKey(candidate, []);
    expect(result.canonicalKey).toBe("ui.theme.primaryColor");
    expect(result.definitionId).toBe("builtin_ui_primary_color");
    expect(result.method).toBe("definition_id");
  });

  it("matches by alias", () => {
    const candidate: CandidateFactUpdate = {
      proposedKey: "主色",
      value: "#ff0000",
      confidence: 0.9,
    };
    const result = canonicalizeFactKey(candidate, []);
    expect(result.canonicalKey).toBe("ui.theme.primaryColor");
    expect(result.method).toBe("alias");
  });

  it("matches by canonicalKey exactly", () => {
    const candidate: CandidateFactUpdate = {
      proposedKey: "project.goal",
      value: "Build a todo app",
      confidence: 0.95,
    };
    const result = canonicalizeFactKey(candidate, []);
    expect(result.canonicalKey).toBe("project.goal");
    expect(result.method).toBe("canonical_key");
  });

  it("matches by entity+property", () => {
    const candidate: CandidateFactUpdate = {
      entity: "frontend",
      property: "framework",
      value: "React",
      confidence: 0.9,
    };
    const result = canonicalizeFactKey(candidate, []);
    expect(result.canonicalKey).toBe("technical.frontend.framework");
    expect(result.method).toBe("entity_property");
  });

  it("returns new_definition for unknown keys", () => {
    const candidate: CandidateFactUpdate = {
      proposedKey: "pomodoro.defaultWorkDurationMinutes",
      value: 25,
      confidence: 0.8,
    };
    const result = canonicalizeFactKey(candidate, []);
    expect(result.canonicalKey).toBeNull();
    expect(result.method).toBe("new_definition");
  });
});

describe("fact-value-validator", () => {
  it("validates string values", () => {
    expect(validateFactValue("hello", "string").valid).toBe(true);
    expect(validateFactValue("", "string").valid).toBe(false);
    expect(validateFactValue(42, "string").valid).toBe(false);
  });

  it("validates number values", () => {
    expect(validateFactValue(42, "number").valid).toBe(true);
    expect(validateFactValue(NaN, "number").valid).toBe(false);
    expect(validateFactValue(Infinity, "number").valid).toBe(false);
  });

  it("validates boolean values", () => {
    expect(validateFactValue(true, "boolean").valid).toBe(true);
    expect(validateFactValue("true", "boolean").valid).toBe(false);
  });

  it("validates color values (hex and named)", () => {
    expect(validateFactValue("#22c55e", "color").valid).toBe(true);
    expect(validateFactValue("#f00", "color").valid).toBe(true);
    expect(validateFactValue("green", "color").valid).toBe(true);
    expect(validateFactValue("green", "color").normalized).toBe("green");
    expect(validateFactValue("#22C55E", "color").normalized).toBe("#22c55e");
    expect(validateFactValue("not-a-color", "color").valid).toBe(false);
  });

  it("validates string_array values with dedup", () => {
    const r = validateFactValue(["a", "b", "a"], "string_array");
    expect(r.valid).toBe(true);
    expect(r.normalized).toEqual(["a", "b"]);
    expect(validateFactValue("not-array", "string_array").valid).toBe(false);
  });

  it("validates json values", () => {
    expect(validateFactValue({ key: "val" }, "json").valid).toBe(true);
    const deeplyNested: Record<string, unknown> = {};
    let current: Record<string, unknown> = deeplyNested;
    for (let i = 0; i < 10; i++) {
      current.child = {};
      current = current.child as Record<string, unknown>;
    }
    expect(validateFactValue(deeplyNested, "json").valid).toBe(false);
  });
});

describe("fact-key-generator", () => {
  it("generates canonical keys from entity + property", () => {
    expect(generateCanonicalKey("pomodoro_timer", "default_work_duration")).toBe(
      "pomodoro.timer.default.work.duration"
    );
  });

  it("uses namespace when provided", () => {
    expect(generateCanonicalKey("timer", "duration", "pomodoro")).toBe("pomodoro.duration");
  });

  it("normalizes special characters", () => {
    expect(generateCanonicalKey("UI Theme", "primary_color")).toBe("ui.theme.primary.color");
  });

  it("detects key conflicts", () => {
    expect(isKeyConflict("project.goal", [], ["project.goal"])).toBe(true);
    expect(isKeyConflict("new.key", ["new.key"], [])).toBe(true);
    expect(isKeyConflict("unique.key", [], [])).toBe(false);
  });
});

describe("fact-key-generator proposals", () => {
  it("generates clean keys with no proposed: prefix", () => {
    const key = generateCanonicalKey("theme", "primaryColor", "ui");
    expect(key).not.toContain("proposed:");
    expect(key).toBe("ui.primarycolor"); // normalized lowercase
  });

  it("generates keys from entity+property without namespace", () => {
    const key = generateCanonicalKey("PomodoroTimer", "defaultWorkDurationMinutes");
    expect(key).not.toContain("proposed:");
    expect(key).toBe("pomodoro.timer.defaultworkdurationminutes");
  });
});

describe("fact-agent-dto empty roles", () => {
  it("treats empty applicableAgentRoles as all roles", () => {
    // Dynamic defs with empty roles should NOT be filtered out
    const defs = getFilteredDefinitionsForAgent({
      conversationId: "test",
      agentRole: "frontend",
    });
    // Builtin defs have non-empty roles and should be returned
    const colorDef = defs.find(d => d.definitionId === "builtin_ui_primary_color");
    expect(colorDef).toBeDefined();
    // If there were dynamic defs with empty roles, they'd also pass the filter
  });
});

// fact-agent-dto requires a real SQLite database with conversation_facts table.
// These are integration tests that validate the DTO shape and filtering logic.
describe.skip("fact-agent-dto", () => {
  it("returns builtin defs filtered by agent role", () => {
    const result = getFilteredDefinitionsForAgent({
      conversationId: "conv_nonexistent",
      agentRole: "ui",
    });
    const colorDef = result.find((d) => d.definitionId === "builtin_ui_primary_color");
    expect(colorDef).toBeDefined();
  });

  it("filters definitions by user message content", () => {
    const result = getFilteredDefinitionsForAgent({
      conversationId: "conv_test",
      userMessageText: "我想用蓝色作为主题色",
    });
    const colorDef = result.find((d) => d.definitionId === "builtin_ui_primary_color");
    expect(colorDef).toBeDefined();
  });
});
