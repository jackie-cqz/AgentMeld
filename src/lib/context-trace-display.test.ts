import { expect, it } from "vitest";
import { traceLabel } from "./context-trace-display";

it("translates statuses without discarding unknown diagnostic values", () => {
  expect(traceLabel("reported_complete")).toBe("已报告完成");
  expect(traceLabel("diagnostic")).toBe("诊断记录");
  expect(traceLabel("new_evidence_kind")).toBe("new_evidence_kind");
});
