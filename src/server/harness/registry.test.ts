import { describe, expect, it } from "vitest";
import type { AdapterName } from "@/shared/types";
import { piHarnessDriver } from "./pi-driver";
import {
  getHarness,
  listHarnesses,
  registerHarness,
  unregisterHarness,
  unregisteredHarnessError,
} from "./registry";
import type { HarnessDriver, HarnessRunStream } from "./types";

const RETIRED_MESSAGE = "This Agent uses a retired execution engine. Edit its model configuration to migrate to Pi.";

/** The smallest driver that satisfies the contract; it never runs anything. */
function fakeHarness(id: AdapterName): HarnessDriver {
  return {
    id,
    doctor: () => ({ available: true, version: "fixture" }),
    capabilities: () => ({
      nativeTools: true,
      businessTools: true,
      cancellation: { supported: true, mode: "signal" },
      evidence: true,
      contextPacket: "platform",
      followUp: false,
      streaming: true,
    }),
    run: async function* (): HarnessRunStream { /* empty */ },
    abort: () => false,
  };
}

describe("the harness registry", () => {
  it("registers Pi as the only production driver", () => {
    expect(listHarnesses().map((driver) => driver.id)).toEqual(["pi"]);
    expect(getHarness("pi")).toBe(piHarnessDriver);
    // No non-Pi adapter is dispatched in P0, however old the Agent row is.
    for (const retired of ["claude-code", "codex", "custom", "mock"] as const) {
      expect(getHarness(retired)).toBeNull();
    }
  });

  it("dispatches a newly registered driver and restores the production set on unregister", () => {
    const fake = fakeHarness("mock");
    const previous = registerHarness(fake);
    try {
      expect(previous).toBeNull();
      expect(getHarness("mock")).toBe(fake);
      expect(listHarnesses().map((driver) => driver.id)).toEqual(["pi", "mock"]);
    } finally {
      expect(unregisterHarness("mock")).toBe(true);
    }
    expect(getHarness("mock")).toBeNull();
    expect(listHarnesses().map((driver) => driver.id)).toEqual(["pi"]);
  });

  it("returns the replaced driver from the registration point", () => {
    const first = fakeHarness("mock");
    const second = fakeHarness("mock");
    registerHarness(first);
    try {
      expect(registerHarness(second)).toBe(first);
      expect(getHarness("mock")).toBe(second);
    } finally {
      unregisterHarness("mock");
    }
  });

  it("keeps migration guidance and migration_required for every retired adapter", () => {
    for (const retired of ["claude-code", "codex", "custom", "mock"] as const) {
      expect(unregisteredHarnessError(retired)).toEqual({
        message: RETIRED_MESSAGE,
        category: "migration_required",
      });
    }
  });

  it("names an unknown engine honestly instead of calling it retired", () => {
    // AdapterName is a closed union today; a P1 name reaches this branch.
    const failure = unregisteredHarnessError("future-engine" as AdapterName);

    expect(failure.category).toBe("harness_unavailable");
    expect(failure.message).toContain('"future-engine"');
    expect(failure.message).not.toContain("retired");
  });
});
