import { describe, expect, it } from "vitest";
import {
  HARNESS_ERROR_CATEGORIES,
  HARNESS_ERROR_FALLBACK,
  HarnessError,
  harnessErrorFromCategory,
  isHarnessErrorCategory,
} from "./errors";

/**
 * Every category the Pi runtime, the Pi driver, the registry/capability checks
 * and the platform-owned Pi-replacement errors actually produce today.
 *
 * The right-hand side is the string persisted in `agent_runs.error_category`
 * before this slice; it must not change, because the field is user/QA-visible.
 */
const PI_CATEGORY_TO_PERSISTED: ReadonlyArray<readonly [string, string]> = [
  ["aborted", "aborted"],
  ["authentication", "authentication"],
  ["classification", "classification"],
  ["cleanup_failed", "cleanup_failed"],
  ["conductor_contract", "conductor_contract"],
  ["configuration", "configuration"],
  ["context_overflow", "context_overflow"],
  ["control_receipt_failed", "control_receipt_failed"],
  ["control_unavailable", "control_unavailable"],
  ["empty_response", "empty_response"],
  ["extension_unavailable", "extension_unavailable"],
  ["harness_capability", "harness_capability"],
  ["harness_unavailable", "harness_unavailable"],
  ["migration_required", "migration_required"],
  ["missing_task_report", "missing_task_report"],
  ["output_limit", "output_limit"],
  ["process_exit", "process_exit"],
  ["protocol", "protocol"],
  ["provider", "provider"],
  ["rate_limit", "rate_limit"],
  ["runtime", "runtime"],
  ["security_policy", "security_policy"],
  ["startup", "startup"],
  ["timeout", "timeout"],
  ["transport", "transport"],
  ["turn_limit", "turn_limit"],
  ["version_mismatch", "version_mismatch"],
  ["workspace_ownership", "workspace_ownership"],
];

describe("the neutral harness error taxonomy", () => {
  it.each(PI_CATEGORY_TO_PERSISTED)("keeps Pi's %s category persisted as %s", (piCategory, persisted) => {
    const error = harnessErrorFromCategory("Fixture failure.", piCategory);

    expect(error).toBeInstanceOf(HarnessError);
    expect(error.name).toBe("HarnessError");
    expect(error.category).toBe(persisted);
    // A mapped category is not a degradation; nothing is left over.
    expect(error.sourceCategory).toBeUndefined();
    expect(error.message).toBe("Fixture failure.");
  });

  it("covers every category in the neutral taxonomy with a same-string Pi mapping", () => {
    const mapped = new Set(PI_CATEGORY_TO_PERSISTED.map(([pi]) => pi));
    for (const category of HARNESS_ERROR_CATEGORIES) expect(mapped.has(category)).toBe(true);
    expect(isHarnessErrorCategory(HARNESS_ERROR_FALLBACK)).toBe(true);
  });

  it("degrades an unmapped Pi category to the documented fallback, keeping the raw category", () => {
    const error = harnessErrorFromCategory("Teleporter offline", "teleporter_offline");

    expect(error.category).toBe(HARNESS_ERROR_FALLBACK);
    expect(error.category).toBe("runtime");
    // Honest degradation: the original category is retained for diagnostics,
    // never persisted as `error_category`.
    expect(error.sourceCategory).toBe("teleporter_offline");
    expect(error.message).toBe("Teleporter offline");
  });

  it("does not treat an unknown category as known", () => {
    expect(isHarnessErrorCategory("teleporter_offline")).toBe(false);
  });
});
