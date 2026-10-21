import { describe, expect, it } from "vitest";
import type { AdapterName } from "./types";
import {
  HARNESS_DESCRIPTORS,
  RETIRED_HARNESS_MESSAGE,
  SELECTABLE_HARNESS_IDS,
  deriveHarnessState,
  harnessDescriptor,
  isRetiredAdapter,
  isSelectableAdapter,
  unregisteredHarnessFailure,
} from "./harness-catalog";

const RETIRED_NAMES = ["claude-code", "codex", "custom", "mock"] as const;

describe("the harness catalog", () => {
  it("declares Pi available, OpenCode selectable but not installed, and legacy names retired", () => {
    expect(harnessDescriptor("pi")).toMatchObject({
      id: "pi",
      label: "Pi",
      declaredState: "available",
      selectable: true,
      retiredMessage: null,
    });
    expect(harnessDescriptor("opencode")).toMatchObject({
      id: "opencode",
      label: "OpenCode",
      declaredState: "not-installed",
      selectable: true,
      retiredMessage: null,
    });

    for (const retired of RETIRED_NAMES) {
      expect(harnessDescriptor(retired)).toMatchObject({
        id: retired,
        declaredState: "retired",
        selectable: false,
        retiredMessage: RETIRED_HARNESS_MESSAGE,
      });
      expect(isRetiredAdapter(retired)).toBe(true);
      expect(isSelectableAdapter(retired)).toBe(false);
    }

    expect(SELECTABLE_HARNESS_IDS).toEqual(["pi", "opencode"]);
    expect(HARNESS_DESCRIPTORS.map((descriptor) => descriptor.id)).toEqual([
      "pi",
      "opencode",
      ...RETIRED_NAMES,
    ]);
  });

  it("offers exactly the selectable names as editor options, in display order", () => {
    expect(HARNESS_DESCRIPTORS.filter((descriptor) => descriptor.selectable).map((descriptor) => descriptor.id))
      .toEqual(["pi", "opencode"]);
  });

  it("treats a name outside the stored union as not-installed, never retired", () => {
    const unknown = harnessDescriptor("future-engine");
    expect(unknown).toMatchObject({
      label: "future-engine",
      declaredState: "not-installed",
      selectable: false,
      retiredMessage: null,
    });
    expect(isRetiredAdapter("future-engine")).toBe(false);
    expect(isSelectableAdapter("future-engine")).toBe(false);
    expect(isSelectableAdapter(null)).toBe(false);
    expect(isSelectableAdapter(42)).toBe(false);
  });

  describe("deriveHarnessState", () => {
    it("is available only for a registered driver whose doctor passes", () => {
      expect(deriveHarnessState(harnessDescriptor("pi"), {
        driverRegistered: true,
        doctor: { available: true, version: "fixture" },
      })).toBe("available");
    });

    it("never lets a not-installed name become available without a registered driver whose doctor passes", () => {
      const opencode = harnessDescriptor("opencode");
      // A passing probe with no registered driver is not evidence of an engine.
      expect(deriveHarnessState(opencode, {
        driverRegistered: false,
        doctor: { available: true, version: "ghost" },
      })).toBe("not-installed");
      // A registered driver that cannot report is not installed.
      expect(deriveHarnessState(opencode, {
        driverRegistered: true,
        doctor: null,
      })).toBe("not-installed");
      // A registered driver whose doctor reports unavailable stays not-installed.
      expect(deriveHarnessState(opencode, {
        driverRegistered: true,
        doctor: { available: false, detail: "CLI missing" },
      })).toBe("not-installed");
      // Only registration plus a passing doctor reads as available.
      expect(deriveHarnessState(opencode, {
        driverRegistered: true,
        doctor: { available: true },
      })).toBe("available");
    });

    it("keeps retired names retired while no driver is registered, whatever the probe says", () => {
      for (const retired of RETIRED_NAMES) {
        const descriptor = harnessDescriptor(retired);
        expect(deriveHarnessState(descriptor, {
          driverRegistered: false,
          doctor: null,
        })).toBe("retired");
        expect(deriveHarnessState(descriptor, {
          driverRegistered: false,
          doctor: { available: true },
        })).toBe("retired");
      }
    });
  });

  describe("unregisteredHarnessFailure", () => {
    it("reports OpenCode as harness_unavailable with actionable install guidance", () => {
      const failure = unregisteredHarnessFailure("opencode");
      expect(failure.category).toBe("harness_unavailable");
      expect(failure.message).toBe(
        'No execution engine is registered for "opencode". Install or enable its harness before running this Agent.',
      );
      expect(failure.message).not.toContain("retired");
    });

    it("keeps the exact historical migration message for every retired name", () => {
      for (const retired of RETIRED_NAMES) {
        expect(unregisteredHarnessFailure(retired)).toEqual({
          message: RETIRED_HARNESS_MESSAGE,
          category: "migration_required",
        });
      }
    });

    it("names an unknown engine honestly instead of calling it retired", () => {
      const failure = unregisteredHarnessFailure("future-engine" as AdapterName);
      expect(failure.category).toBe("harness_unavailable");
      expect(failure.message).toContain('"future-engine"');
      expect(failure.message).not.toContain("retired");
    });
  });
});
