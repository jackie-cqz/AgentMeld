import type { AdapterName } from "@/shared/types";
import { piHarnessDriver } from "./pi-driver";
import type { HarnessDriver } from "./types";

/**
 * The only list of execution engines the platform will dispatch to.
 *
 * Registration is explicit and happens at module load: Pi is the one production
 * driver, and adding a second engine in P1 must be a visible edit here rather
 * than a name-based branch inside the run loop. There is deliberately no
 * fallback driver — an Agent whose adapter has no driver fails honestly.
 */
const drivers = new Map<AdapterName, HarnessDriver>();

/** Adapter values produced before the Pi-only refactor, kept readable for old rows. */
const RETIRED_ADAPTERS: ReadonlySet<AdapterName> = new Set(["claude-code", "codex", "custom", "mock"]);

/** Register (or replace) the driver that claims an adapter name. Returns the previous driver. */
export function registerHarness(driver: HarnessDriver): HarnessDriver | null {
  const previous = drivers.get(driver.id) ?? null;
  drivers.set(driver.id, driver);
  return previous;
}

/** Remove a driver. Production never unregisters Pi; tests use this to isolate fakes. */
export function unregisterHarness(name: AdapterName): boolean {
  return drivers.delete(name);
}

export function getHarness(name: AdapterName): HarnessDriver | null {
  return drivers.get(name) ?? null;
}

/** Every registered driver, in registration order (Pi first in production). */
export function listHarnesses(): HarnessDriver[] {
  return [...drivers.values()];
}

/**
 * The failure a caller must raise when no driver is registered for an Agent's
 * adapter, as `{ message, category }` so the run owner keeps deciding how to
 * turn it into a `PiRuntimeError`.
 *
 * Retired names keep the exact migration message and `migration_required`
 * category, because old Agent rows must still send the user to edit and migrate
 * rather than to a dead end. Any other unregistered name reports what actually
 * happened: nothing can run it.
 */
export function unregisteredHarnessError(name: AdapterName): { message: string; category: string } {
  if (RETIRED_ADAPTERS.has(name)) {
    return {
      message: "This Agent uses a retired execution engine. Edit its model configuration to migrate to Pi.",
      category: "migration_required",
    };
  }
  return {
    message: `No execution engine is registered for "${name}". Install or enable its harness before running this Agent.`,
    category: "harness_unavailable",
  };
}

// Pi is the single production driver. P1 registers more here, one at a time.
registerHarness(piHarnessDriver);
