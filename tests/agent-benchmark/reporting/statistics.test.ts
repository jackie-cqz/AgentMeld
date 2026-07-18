import { describe, expect, it } from "vitest";

import { mean, percentile, standardDeviation, wilsonInterval } from "./statistics";

describe("benchmark statistics", () => {
  it("computes stable aggregate statistics", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(standardDeviation([2, 2, 2])).toBe(0);
    expect(percentile([40, 10, 30, 20], 50)).toBe(20);
    expect(percentile([40, 10, 30, 20], 95)).toBe(40);
  });

  it("returns a bounded Wilson confidence interval", () => {
    const interval = wilsonInterval(8, 10);
    expect(interval.low).toBeGreaterThan(0);
    expect(interval.high).toBeLessThanOrEqual(1);
    expect(interval.low).toBeLessThan(0.8);
    expect(interval.high).toBeGreaterThan(0.8);
  });

  it("uses explicit zero-sample semantics", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 });
    expect(percentile([], 95)).toBe(0);
  });
});
