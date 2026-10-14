import { describe, expect, it } from "vitest";
import { validateCriterion } from "@/server/verification/validator-registry";
import type { AcceptanceCriterionSpec } from "@/shared/types";
import type { CriterionValidator } from "@/shared/evidence-types";

interface EvidenceFixture {
  id: string;
  type: string;
  subjectId: string;
  payloadJson: string;
  status: string;
}

function criterion(validator: CriterionValidator): AcceptanceCriterionSpec {
  return { id: "c1", description: "criterion", required: true, validator };
}

function evidence(overrides: Partial<EvidenceFixture> & Pick<EvidenceFixture, "type" | "subjectId">): EvidenceFixture {
  return {
    id: "ev_1",
    payloadJson: "{}",
    status: "valid",
    ...overrides
  };
}

describe("validator-registry invalid-evidence gate", () => {
  it("does not satisfy file_exists with invalid evidence", () => {
    const invalid = [evidence({ type: "file_written", subjectId: "src/App.tsx", status: "invalid" })];
    const valid = [evidence({ type: "file_written", subjectId: "src/App.tsx", status: "valid" })];

    expect(validateCriterion(criterion({ type: "file_exists", path: "src/App.tsx" }), { type: "file_exists", path: "src/App.tsx" }, invalid, undefined).passed).toBe(false);
    expect(validateCriterion(criterion({ type: "file_exists", path: "src/App.tsx" }), { type: "file_exists", path: "src/App.tsx" }, valid, undefined).passed).toBe(true);
  });

  it("does not satisfy file_changed with invalid evidence", () => {
    const invalid = [evidence({ type: "file_written", subjectId: "src/App.tsx", status: "invalid" })];
    const valid = [evidence({ type: "file_written", subjectId: "src/App.tsx", status: "valid" })];

    expect(validateCriterion(criterion({ type: "file_changed", path: "src/App.tsx" }), { type: "file_changed", path: "src/App.tsx" }, invalid, undefined).passed).toBe(false);
    expect(validateCriterion(criterion({ type: "file_changed", path: "src/App.tsx" }), { type: "file_changed", path: "src/App.tsx" }, valid, undefined).passed).toBe(true);
  });

  it("does not satisfy command_exit with invalid (blocked/never-run) evidence", () => {
    const validator: CriterionValidator = { type: "command_exit", command: "pnpm build", expectedExitCode: 0 };
    const invalid = [evidence({
      type: "command_executed",
      subjectId: "pnpm build",
      payloadJson: JSON.stringify({ command: "pnpm build", exitCode: 0 }),
      status: "invalid"
    })];
    const valid = [evidence({
      type: "command_executed",
      subjectId: "pnpm build",
      payloadJson: JSON.stringify({ command: "pnpm build", exitCode: 0 }),
      status: "valid"
    })];

    expect(validateCriterion(criterion(validator), validator, invalid, undefined).passed).toBe(false);
    expect(validateCriterion(criterion(validator), validator, valid, undefined).passed).toBe(true);
  });

  it("does not satisfy deployment_created with invalid or failed evidence", () => {
    const validator: CriterionValidator = { type: "deployment_created", outputKey: "app" };
    const invalid = [evidence({
      type: "deployment_created",
      subjectId: "app",
      payloadJson: JSON.stringify({ outputKey: "app", deploymentStatus: "ready", deploymentId: "dep_1" }),
      status: "invalid"
    })];
    const failed = [evidence({
      type: "deployment_created",
      subjectId: "app",
      payloadJson: JSON.stringify({ outputKey: "app", deploymentStatus: "failed" }),
      status: "valid"
    })];
    const valid = [evidence({
      type: "deployment_created",
      subjectId: "app",
      payloadJson: JSON.stringify({ outputKey: "app", deploymentStatus: "ready", deploymentId: "dep_1" }),
      status: "valid"
    })];

    expect(validateCriterion(criterion(validator), validator, invalid, undefined).passed).toBe(false);
    expect(validateCriterion(criterion(validator), validator, failed, undefined).passed).toBe(false);
    expect(validateCriterion(criterion(validator), validator, valid, undefined).passed).toBe(true);
  });

  it("does not satisfy user_confirmation with invalid evidence", () => {
    const validator: CriterionValidator = { type: "user_confirmation" };
    const invalid = [evidence({ type: "user_answered", subjectId: "ask_1", status: "invalid" })];
    const valid = [evidence({ type: "user_answered", subjectId: "ask_1", status: "valid" })];

    expect(validateCriterion(criterion(validator), validator, invalid, undefined).passed).toBe(false);
    expect(validateCriterion(criterion(validator), validator, valid, undefined).passed).toBe(true);
  });
});
