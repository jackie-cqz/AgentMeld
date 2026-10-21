import { describe, expect, it } from "vitest";
import type { HarnessAvailability } from "@/shared/harness-catalog";
import type { AdapterName, Agent } from "@/shared/types";
import {
  handoffTargets,
  harnessDisplayLabel,
  harnessEditorModel,
  harnessIsRunnable,
  harnessMigrationNotice,
  harnessOptionBadge,
  harnessOptions,
  harnessSaveSuffix,
  harnessSelectionIsAllowed,
  harnessStatusText,
  selectedHarnessOption,
  type HarnessOption,
} from "./harness-selection";

function report(id: HarnessAvailability["id"], overrides: Partial<HarnessAvailability> = {}): HarnessAvailability {
  return {
    id,
    label: id === "pi" ? "Pi" : "OpenCode",
    state: "available",
    selectable: true,
    driverRegistered: true,
    doctor: { available: true },
    ...overrides,
  };
}

/** A payload for a machine where the pinned OpenCode CLI is not installed. */
const NOT_INSTALLED_OPENCODE: HarnessAvailability[] = [
  report("pi", { doctor: { available: true, version: "0.84.2" } }),
  report("opencode", { state: "not-installed", driverRegistered: true, doctor: { available: false, detail: "opencode CLI not found" } }),
];

describe("the harness picker view-model", () => {
  it("offers only selectable catalog names: Pi and OpenCode, never a retired name", () => {
    expect(harnessOptions(null).map((option) => option.value)).toEqual(["pi", "opencode"]);
    expect(harnessOptions(NOT_INSTALLED_OPENCODE).map((option) => option.value)).toEqual(["pi", "opencode"]);
    expect(harnessOptions(NOT_INSTALLED_OPENCODE).map((option) => option.label)).toEqual(["Pi", "OpenCode"]);
  });

  it("claims nothing is runnable before the availability report arrives", () => {
    const options = harnessOptions(null);

    expect(options.map((option) => option.checked)).toEqual([false, false]);
    expect(options.map((option) => option.runnable)).toEqual([false, false]);
    expect(options.map(harnessOptionBadge)).toEqual(["检查中", "检查中"]);
    expect(options.map(harnessStatusText)).toEqual([
      "正在检查执行引擎安装状态…",
      "正在检查执行引擎安装状态…",
    ]);
    expect(options.map(harnessSaveSuffix)).toEqual(["", ""]);
  });

  it("marks an installed Pi as available and runnable", () => {
    const pi = selectedHarnessOption(harnessOptions(NOT_INSTALLED_OPENCODE), "pi")!;

    expect(pi).toMatchObject({ checked: true, runnable: true, state: "available" });
    expect(harnessOptionBadge(pi)).toBe("可用");
    expect(harnessStatusText(pi)).toContain("0.84.2");
    // Availability is installation-level; the copy must not promise that every
    // task shape will run.
    expect(harnessStatusText(pi)).toContain("能力校验");
    expect(harnessSaveSuffix(pi)).toBe("");
  });

  it("reports an installed OpenCode as available without claiming every run works", () => {
    const installed = selectedHarnessOption(harnessOptions([
      report("pi", { doctor: { available: true, version: "0.84.2" } }),
      report("opencode", { doctor: { available: true, version: "1.19.3" } }),
    ]), "opencode")!;
    expect(installed).toMatchObject({ checked: true, runnable: true, state: "available" });
    expect(harnessOptionBadge(installed)).toBe("可用");
    expect(harnessStatusText(installed)).toContain("1.19.3");
    expect(harnessStatusText(installed)).toContain("能力校验");
    expect(harnessSaveSuffix(installed)).toBe("");
  });

  it("keeps an uninstalled OpenCode selectable but visibly not runnable", () => {
    const opencode = selectedHarnessOption(harnessOptions(NOT_INSTALLED_OPENCODE), "opencode")!;

    expect(opencode).toMatchObject({ checked: true, runnable: false, state: "not-installed" });
    expect(harnessOptionBadge(opencode)).toBe("不可运行");
    // A registered driver whose probe failed names the real reason, not a
    // fabricated "driver missing" error.
    expect(harnessStatusText(opencode)).toContain("驱动已包含");
    expect(harnessStatusText(opencode)).toContain("opencode CLI not found");
    expect(harnessStatusText(opencode)).toContain("不会自动改用 Pi");
    expect(harnessSaveSuffix(opencode)).toBe("（不可运行）");
    // Selectable is a different question from runnable: saving is still allowed.
    expect(harnessSelectionIsAllowed(opencode)).toBe(true);
  });

  it("names harness_unavailable only when no driver is registered at all", () => {
    const withoutDriver = selectedHarnessOption(harnessOptions([
      report("pi", { doctor: { available: true, version: "0.84.2" } }),
      report("opencode", { state: "not-installed", driverRegistered: false, doctor: null }),
    ]), "opencode")!;
    expect(harnessStatusText(withoutDriver)).toContain("harness_unavailable");
    expect(harnessStatusText(withoutDriver)).toContain("驱动未包含");
  });

  it("refuses a retired selection even though it is never offered", () => {
    const retired: HarnessOption = {
      value: "claude-code",
      label: "Claude Code",
      state: "retired",
      runnable: false,
      checked: true,
      doctor: null,
    };

    expect(harnessSelectionIsAllowed(retired)).toBe(false);
    expect(harnessSaveSuffix(retired)).toBe("（将迁移到 Pi）");
    expect(harnessOptionBadge(retired)).toBe("已退役");
  });

  it("reports the migration an edited retired row will get", () => {
    expect(harnessMigrationNotice(null)).toBeNull();
    expect(harnessMigrationNotice("pi")).toBeNull();
    expect(harnessMigrationNotice("opencode")).toBeNull();

    const retired = harnessMigrationNotice("claude-code");
    expect(retired).toContain("已退役");
    expect(retired).toContain("Pi");

    // A future name this build does not know is not called retired.
    const unknown = harnessMigrationNotice("future-engine");
    expect(unknown).toContain("不在当前构建中");
    expect(unknown).not.toContain("已退役");
  });

  it("labels rosters honestly instead of calling every non-Pi engine retired", () => {
    expect(harnessDisplayLabel("pi")).toBe("Pi");
    // OpenCode is selectable and ships a driver; its runtime availability is
    // reported by /api/harnesses, not assumed by this cached label.
    expect(harnessDisplayLabel("opencode")).toBe("OpenCode");
    expect(harnessDisplayLabel("claude-code")).toBe("Claude Code（已退役）");
    expect(harnessDisplayLabel("future-engine")).toBe("future-engine（不可运行）");
  });

  it("derives one consistent model for the picker and the save button", () => {
    const opencode = harnessEditorModel({ availability: NOT_INSTALLED_OPENCODE, selected: "opencode", stored: null });
    expect(opencode.selected?.value).toBe("opencode");
    expect(opencode.canSave).toBe(true);
    expect(opencode.saveSuffix).toBe("（不可运行）");
    expect(opencode.statusText).toContain("驱动已包含");
    expect(opencode.migrationNotice).toBeNull();

    const migrating = harnessEditorModel({ availability: NOT_INSTALLED_OPENCODE, selected: "pi", stored: "claude-code" });
    expect(migrating.selected?.value).toBe("pi");
    expect(migrating.canSave).toBe(true);
    expect(migrating.migrationNotice).toContain("Pi");

    const loading = harnessEditorModel({ availability: null, selected: "opencode", stored: null });
    expect(loading.statusText).toBe("正在检查执行引擎安装状态…");
    expect(loading.saveSuffix).toBe("");

    // Defensive: a retired name is not a saveable selection.
    const retiredSelection = harnessEditorModel({ availability: NOT_INSTALLED_OPENCODE, selected: "claude-code", stored: null });
    expect(retiredSelection.selected).toBeNull();
    expect(retiredSelection.canSave).toBe(false);
  });
});

function member(id: string, adapterName: AdapterName, isConductor = false): Agent {
  return {
    id, name: id, avatar: "A", description: "", capabilities: [], adapterName,
    modelProvider: "deepseek", modelId: "fixture", apiKey: null, apiBaseUrl: null,
    contextWindow: null, reasoningEffort: null, systemPrompt: "", toolNames: [],
    isBuiltin: false, isConductor, supportsVision: true, createdAt: 1, updatedAt: 1,
  };
}

describe("handoff target eligibility", () => {
  const agents = {
    ag_worker: member("ag_worker", "pi"),
    ag_peer: member("ag_peer", "pi"),
    ag_opencode: member("ag_opencode", "opencode"),
    ag_conductor: member("ag_conductor", "pi", true),
  };

  it("answers runnability only for a confirmed available report", () => {
    expect(harnessIsRunnable(NOT_INSTALLED_OPENCODE, "pi")).toBe(true);
    expect(harnessIsRunnable(NOT_INSTALLED_OPENCODE, "opencode")).toBe(false);
    expect(harnessIsRunnable(null, "pi")).toBe(false);
    expect(harnessIsRunnable(NOT_INSTALLED_OPENCODE, "future-engine")).toBe(false);
  });

  it("offers only current non-Conductor members whose engine the runtime reports available", () => {
    const input = { agentIds: Object.keys(agents), agents, sourceAgentId: "ag_worker", availability: NOT_INSTALLED_OPENCODE };

    // Pi peers are still offered: the Pi-equivalent outcome is unchanged.
    expect(handoffTargets(input).map((agent) => agent.id)).toEqual(["ag_peer"]);

    // Before the report arrives (or when the read failed) nothing is offered,
    // instead of guessing that Pi runs.
    expect(handoffTargets({ ...input, availability: null })).toEqual([]);
    expect(handoffTargets({ ...input, availability: [] })).toEqual([]);

    // A second engine becomes a real target only when its own report says so.
    expect(handoffTargets({ ...input, availability: [report("pi"), report("opencode")] })
      .map((agent) => agent.id)).toEqual(["ag_peer", "ag_opencode"]);
  });
});
