import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterName } from "@/shared/types";
import { HARNESS_DESCRIPTORS } from "@/shared/harness-catalog";
import { authedRequest, pairTestOwner, resetTestAuth } from "@/test/auth-test-helper";
import { GET as getHarnesses } from "@/app/api/harnesses/route";
import { getHarnessAvailability, isHarnessAvailable, listHarnessAvailability } from "./availability";
import { registerHarness, unregisterHarness } from "./registry";
import type { HarnessDoctor, HarnessDriver, HarnessRunStream } from "./types";

// The mapping under test is "registration + doctor", not the real installation,
// so pin Pi's probe instead of depending on which packages this machine has.
vi.mock("@/server/pi/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/pi/config")>();
  return {
    ...actual,
    getPiDoctor: () => ({
      available: true,
      expectedVersion: "fixture",
      installedVersion: "fixture",
      nodeVersion: process.versions.node,
      error: null,
    }),
  };
});

/** The smallest driver that satisfies the contract; only `doctor()` matters here. */
function fakeDriver(id: AdapterName, doctor: () => HarnessDoctor): HarnessDriver {
  return {
    id,
    doctor,
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

afterEach(() => {
  unregisterHarness("opencode");
  resetTestAuth();
});

describe("harness availability", () => {
  it("reports Pi as available from a registered driver whose doctor passes", () => {
    const pi = getHarnessAvailability("pi");
    expect(pi).toMatchObject({
      id: "pi",
      label: "Pi",
      state: "available",
      selectable: true,
      driverRegistered: true,
      doctor: { available: true, version: "fixture" },
    });
    expect(pi.doctor?.detail).toContain("Node.js");
  });

  it("reports OpenCode as a selectable but not-installed engine in this build", () => {
    expect(getHarnessAvailability("opencode")).toEqual({
      id: "opencode",
      label: "OpenCode",
      state: "not-installed",
      selectable: true,
      driverRegistered: false,
      doctor: null,
    });
  });

  it("keeps every retired name retired and invents no driver for it", () => {
    for (const descriptor of HARNESS_DESCRIPTORS.filter((entry) => entry.declaredState === "retired")) {
      expect(getHarnessAvailability(descriptor.id)).toEqual({
        id: descriptor.id,
        label: descriptor.label,
        state: "retired",
        selectable: false,
        driverRegistered: false,
        doctor: null,
      });
    }
  });

  it("never upgrades OpenCode from a registered driver whose doctor fails", () => {
    registerHarness(fakeDriver("opencode", () => ({ available: false, detail: "opencode CLI not found" })));
    expect(getHarnessAvailability("opencode")).toMatchObject({
      state: "not-installed",
      selectable: true,
      driverRegistered: true,
      doctor: { available: false, detail: "opencode CLI not found" },
    });
  });

  it("reads OpenCode as available only once its driver is registered and the doctor passes", () => {
    registerHarness(fakeDriver("opencode", () => ({ available: true, version: "9.9.9" })));
    expect(getHarnessAvailability("opencode")).toMatchObject({
      state: "available",
      driverRegistered: true,
      doctor: { available: true, version: "9.9.9" },
    });

    unregisterHarness("opencode");
    expect(getHarnessAvailability("opencode").state).toBe("not-installed");
  });

  it("reports a throwing doctor as unavailable instead of failing the read", () => {
    registerHarness(fakeDriver("opencode", () => { throw new Error("probe exploded"); }));
    expect(getHarnessAvailability("opencode")).toMatchObject({
      state: "not-installed",
      driverRegistered: true,
      doctor: { available: false, detail: expect.stringContaining("probe exploded") },
    });
  });

  it("lists every catalog name in display order", () => {
    expect(listHarnessAvailability().map((entry) => entry.id))
      .toEqual(HARNESS_DESCRIPTORS.map((descriptor) => descriptor.id));
    expect(listHarnessAvailability().map((entry) => entry.state)).toEqual([
      "available",
      "not-installed",
      "retired",
      "retired",
      "retired",
      "retired",
    ]);
  });

  it("answers runnability with the same registration + doctor evidence", () => {
    // Pi: a registered driver whose doctor passes.
    expect(isHarnessAvailable("pi")).toBe(true);
    // OpenCode: selectable but no driver, so not runnable.
    expect(isHarnessAvailable("opencode")).toBe(false);
    // A retired name is never runnable without a real driver.
    expect(isHarnessAvailable("claude-code")).toBe(false);
    // An unknown name is not runnable, never retired.
    expect(isHarnessAvailable("future-engine")).toBe(false);

    registerHarness(fakeDriver("opencode", () => ({ available: true, version: "9.9.9" })));
    expect(isHarnessAvailable("opencode")).toBe(true);
  });

  it("serves the no-store payload the Agent editor reads", async () => {
    pairTestOwner();
    const response = await getHarnesses(authedRequest("http://localhost/api/harnesses"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as { harnesses: Array<{ id: string; state: string; selectable: boolean }> };
    expect(body.harnesses.map((entry) => entry.id))
      .toEqual(HARNESS_DESCRIPTORS.map((descriptor) => descriptor.id));
    expect(body.harnesses.find((entry) => entry.id === "opencode")).toMatchObject({
      state: "not-installed",
      selectable: true,
    });
    expect(body.harnesses.find((entry) => entry.id === "pi")).toMatchObject({ state: "available", selectable: true });
  });
});
