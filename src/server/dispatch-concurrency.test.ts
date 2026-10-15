import { afterEach, describe, expect, it } from "vitest";
import { acquireConcurrencySlot, getActiveConcurrencyCount, resetConcurrencyForTests } from "./dispatch-concurrency";

afterEach(resetConcurrencyForTests);

describe("dispatch concurrency cancellation", () => {
  it("removes cancelled waiters without consuming phantom slots", async () => {
    const signal = new AbortController().signal;
    const releases = [];
    for (let i = 0; i < 3; i++) releases.push(await acquireConcurrencySlot(signal));
    const waitingController = new AbortController();
    const cancelled = acquireConcurrencySlot(waitingController.signal);
    waitingController.abort();
    await expect(cancelled).rejects.toThrow("Aborted");
    for (const release of releases) { release(); release(); }
    expect(getActiveConcurrencyCount()).toBe(0);
  });
});
