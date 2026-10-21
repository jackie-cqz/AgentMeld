import type { AdapterName } from "./types";

/**
 * How a harness name stands in this build (issue #25 P2 selection surface).
 *
 * - `available`: a driver is registered for the name AND its `doctor()` says it
 *   can run here. Only then may the UI or a run treat it as runnable.
 * - `not-installed`: a real, selectable name whose driver is not registered in
 *   this build (or whose driver reports it cannot run here). Saving an Agent
 *   with it is honest; running it fails as `harness_unavailable`.
 * - `retired`: a legacy name whose rows must be migrated. It keeps the exact
 *   `migration_required` guidance and is never offered as a new choice.
 */
export type HarnessState = "available" | "not-installed" | "retired";

/**
 * Where an engine's stored Agent rows read their credential from.
 *
 * Legacy engines (`claude-code`, `codex`) never chose a provider per row: their
 * key came from one global settings field and a fixed environment fallback.
 * That mapping belongs to the engine, so it lives next to the engine's catalog
 * entry instead of a `switch (adapterName)` in the settings service.
 */
export interface HarnessCredentialPolicy {
  /** The `AppSettings` field holding this engine's key. */
  settingKey: "anthropicApiKey" | "openaiApiKey";
  /** Environment variables checked in order when the setting is empty. */
  envKeys: readonly string[];
  /** The `AppSettings` field holding this engine's base URL, when it has one. */
  baseUrlSettingKey?: "anthropicBaseUrl";
}

/**
 * The declared half of the truth: what this build ships, before any runtime
 * probe. The server refines it with registration + `doctor()`; nothing in the UI
 * may turn `not-installed`/`retired` into `available` on its own.
 */
export interface HarnessDescriptor {
  id: AdapterName;
  /** Product name shown in the editor and agent lists. */
  label: string;
  /**
   * Baseline state this build ships with, before any runtime probe. A selectable
   * name with a registered driver still only becomes `available` when that
   * driver's `doctor()` passes, so the baseline never promises execution.
   */
  declaredState: HarnessState;
  /** Whether a new Agent may select it. Retired names are historical only. */
  selectable: boolean;
  /**
   * Exact user-visible migration guidance for a retired name, or `null`.
   * The run-time error reads this so the editor and the run cannot disagree.
   */
  retiredMessage: string | null;
  /**
   * The fixed global-credential mapping for engines that have no per-Agent
   * provider choice, or `null` for engines whose key is resolved from the
   * Agent's `modelProvider` like every current engine.
   */
  credential: HarnessCredentialPolicy | null;
}

/**
 * The one user-visible migration sentence retired Agent rows have always shown.
 * It is a contract (tests and old rows depend on it), not a translatable string.
 */
export const RETIRED_HARNESS_MESSAGE =
  "This Agent uses a retired execution engine. Edit its model configuration to migrate to Pi.";

/**
 * The single source of truth for harness names.
 *
 * Adding or retiring an engine is one edit to this table: the registry's error
 * mapping, the availability payload, the agent-editor options and the roster all
 * derive from it. `AdapterName` is still the closed set of stored values; this
 * table gives each value a product meaning.
 */
const DESCRIPTORS: Readonly<Record<AdapterName, HarnessDescriptor>> = {
  pi: {
    id: "pi",
    label: "Pi",
    declaredState: "available",
    selectable: true,
    retiredMessage: null,
    credential: null,
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    // A real driver is registered in this build, but the declared baseline stays
    // not-installed: `deriveHarnessState` only reports `available` when that
    // driver's `doctor()` also passes (pinned SDK + CLI installed). This is what
    // keeps the UI honest on a machine where the engine is missing.
    declaredState: "not-installed",
    selectable: true,
    retiredMessage: null,
    credential: null,
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    declaredState: "retired",
    selectable: false,
    retiredMessage: RETIRED_HARNESS_MESSAGE,
    // The historical mapping: one Anthropic key, no per-Agent provider.
    credential: {
      settingKey: "anthropicApiKey",
      envKeys: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
      baseUrlSettingKey: "anthropicBaseUrl",
    },
  },
  codex: {
    id: "codex",
    label: "Codex",
    declaredState: "retired",
    selectable: false,
    retiredMessage: RETIRED_HARNESS_MESSAGE,
    credential: {
      settingKey: "openaiApiKey",
      envKeys: ["CODEX_API_KEY", "OPENAI_API_KEY"],
    },
  },
  custom: {
    id: "custom",
    label: "Custom",
    declaredState: "retired",
    selectable: false,
    retiredMessage: RETIRED_HARNESS_MESSAGE,
    credential: null,
  },
  mock: {
    id: "mock",
    label: "Mock",
    declaredState: "retired",
    selectable: false,
    retiredMessage: RETIRED_HARNESS_MESSAGE,
    credential: null,
  },
};

/** Every known descriptor, in display order (Pi first, retired names last). */
export const HARNESS_DESCRIPTORS: readonly HarnessDescriptor[] = Object.values(DESCRIPTORS);

/** The names a new Agent may select today, derived from the table above. */
export const SELECTABLE_HARNESS_IDS: readonly AdapterName[] = HARNESS_DESCRIPTORS
  .filter((descriptor) => descriptor.selectable)
  .map((descriptor) => descriptor.id);

/**
 * Look a name up without trusting the caller's type.
 *
 * Stored Agent rows and a future build can carry a value outside today's union;
 * such a name is a real `not-installed` engine, never retired, so it fails as
 * `harness_unavailable` rather than sending the user to a migration that would
 * not help.
 */
export function harnessDescriptor(name: AdapterName | string): HarnessDescriptor {
  if (Object.prototype.hasOwnProperty.call(DESCRIPTORS, name)) {
    return DESCRIPTORS[name as AdapterName];
  }
  return {
    id: name as AdapterName,
    label: name,
    declaredState: "not-installed",
    selectable: false,
    retiredMessage: null,
    credential: null,
  };
}

export function isRetiredAdapter(name: AdapterName | string): boolean {
  return harnessDescriptor(name).declaredState === "retired";
}

/** Type guard used by API schemas: only a known, currently selectable name passes. */
export function isSelectableAdapter(name: unknown): name is AdapterName {
  return (
    typeof name === "string" &&
    Object.prototype.hasOwnProperty.call(DESCRIPTORS, name) &&
    DESCRIPTORS[name as AdapterName].selectable
  );
}

/** What a driver's `doctor()` reports, as the client receives it. */
export interface HarnessDoctorReport {
  available: boolean;
  version?: string;
  detail?: string;
}

/**
 * One row of the `/api/harnesses` payload: the declared descriptor plus the
 * runtime facts. The client never has to guess why a name is not usable.
 */
export interface HarnessAvailability {
  id: AdapterName;
  label: string;
  state: HarnessState;
  selectable: boolean;
  /** Whether this build registered a driver for the name. */
  driverRegistered: boolean;
  /** The driver's own report, or `null` when no driver is registered. */
  doctor: HarnessDoctorReport | null;
}

/**
 * The one derivation of runtime state from registration + doctor.
 *
 * A driver that says it is unavailable never becomes `available`; a retired name
 * stays retired while it has no driver, and would only read as available if a
 * driver were actually registered for it (which production does not do).
 */
export function deriveHarnessState(
  descriptor: HarnessDescriptor,
  runtime: { driverRegistered: boolean; doctor: HarnessDoctorReport | null },
): HarnessState {
  if (runtime.driverRegistered && runtime.doctor?.available === true) return "available";
  if (descriptor.declaredState === "retired") return "retired";
  return "not-installed";
}

/**
 * The failure contract for an Agent whose adapter has no registered driver.
 *
 * Retired names keep the exact historical `migration_required` message; every
 * other unregistered name reports what actually happened, as
 * `harness_unavailable`. Shared so the registry, the agent service and the UI
 * cannot drift into three slightly different explanations.
 */
export type UnavailableHarnessCategory = "harness_unavailable" | "migration_required";

export interface UnavailableHarnessFailure {
  message: string;
  category: UnavailableHarnessCategory;
}

export function unregisteredHarnessFailure(name: AdapterName | string): UnavailableHarnessFailure {
  const descriptor = harnessDescriptor(name);
  if (descriptor.declaredState === "retired") {
    return {
      message: descriptor.retiredMessage ?? RETIRED_HARNESS_MESSAGE,
      category: "migration_required",
    };
  }
  return {
    message: `No execution engine is registered for "${name}". Install or enable its harness before running this Agent.`,
    category: "harness_unavailable",
  };
}
