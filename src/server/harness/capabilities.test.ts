import { describe, expect, it } from "vitest";
import { assertHarnessSupports, HarnessCapabilityError } from "./capabilities";
import { piHarnessDriver } from "./pi-driver";
import type { HarnessCapabilities, HarnessDriver, HarnessRunStream } from "./types";

/** A driver that declares exactly the capabilities a test gives it and runs nothing. */
function fakeDriver(overrides: Partial<HarnessCapabilities> = {}): HarnessDriver {
  return {
    id: "mock",
    doctor: () => ({ available: true, version: "fixture" }),
    capabilities: () => ({
      nativeTools: true,
      businessTools: true,
      cancellation: { supported: true, mode: "signal" },
      evidence: true,
      contextPacket: "platform",
      followUp: true,
      streaming: true,
      ...overrides,
    }),
    run: async function* (): HarnessRunStream { /* empty */ },
    abort: () => false,
  };
}

function captureError(run: () => void): HarnessCapabilityError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessCapabilityError);
    return error as HarnessCapabilityError;
  }
  throw new Error("Expected the capability check to fail.");
}

describe("harness capability degradation", () => {
  it("passes Pi for every requirement Pi actually satisfies", () => {
    expect(() => assertHarnessSupports(piHarnessDriver, {
      nativeTools: true,
      businessTools: true,
      evidence: true,
      cancellation: true,
      contextPacket: "platform",
    })).not.toThrow();
  });

  it("fails honestly when an engine has no business tools", () => {
    const error = captureError(() => assertHarnessSupports(fakeDriver({ businessTools: false }), { businessTools: true }));

    expect(error.category).toBe("harness_capability");
    expect(error.harnessId).toBe("mock");
    expect(error.missing).toEqual([expect.stringContaining("business tools")]);
    expect(error.message).toContain('The "mock" execution engine cannot run this Agent');
    expect(error.message).toContain("write_artifact");
    expect(error.message).toContain("Nothing was executed.");
    expect(error.message).toContain("Choose an Agent configured with an execution engine");
  });

  it("fails honestly when tool outcomes cannot become evidence", () => {
    const error = captureError(() => assertHarnessSupports(fakeDriver({ evidence: false }), { evidence: true }));

    expect(error.category).toBe("harness_capability");
    expect(error.missing).toEqual([expect.stringContaining("evidence ledger")]);
    expect(error.message).toContain("mapping tool outcomes into the evidence ledger");
  });

  it("fails honestly when an engine builds its own context instead of consuming the packet", () => {
    const error = captureError(() => assertHarnessSupports(fakeDriver({ contextPacket: "harness" }), { contextPacket: "platform" }));

    expect(error.message).toContain("consuming the platform context packet");
  });

  it("reports every missing capability at once, not just the first", () => {
    const error = captureError(() => assertHarnessSupports(
      fakeDriver({ nativeTools: false, businessTools: false, evidence: false, cancellation: { supported: false, mode: null } }),
      { nativeTools: true, businessTools: true, evidence: true, cancellation: true },
    ));

    expect(error.missing).toHaveLength(4);
  });

  it("does not require anything the caller did not ask for", () => {
    // A harness with no capabilities can still classify a turn, which asks for none.
    expect(() => assertHarnessSupports(
      fakeDriver({ nativeTools: false, businessTools: false, evidence: false, cancellation: { supported: false, mode: null }, contextPacket: "harness" }),
      {},
    )).not.toThrow();
  });
});
