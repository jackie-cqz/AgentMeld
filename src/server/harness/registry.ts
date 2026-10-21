import type { AdapterName } from "@/shared/types";
import { unregisteredHarnessFailure } from "@/shared/harness-catalog";
import type { HarnessErrorCategory } from "./errors";
import { piHarnessDriver } from "./pi-driver";
import type { HarnessDriver } from "./types";

/**
 * The only list of execution engines the platform will dispatch to.
 *
 * Registration is explicit and happens at module load: Pi is the one production
 * driver, and adding a second engine in P1 must be a visible edit here rather
 * than a name-based branch inside the run loop. There is deliberately no
 * fallback driver — an Agent whose adapter has no driver fails honestly.
 *
 * Which adapter names exist, which are selectable and which are retired is NOT
 * decided here: `src/shared/harness-catalog.ts` is the single source of truth,
 * and this module only answers "is a driver registered for this name?".
 */
const drivers = new Map<AdapterName, HarnessDriver>();

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
 * turn it into a neutral `HarnessError`.
 *
 * The mapping is derived from the shared descriptor table, not a second list:
 * retired names keep the exact migration message and `migration_required`
 * category (old Agent rows must still send the user to edit and migrate rather
 * than to a dead end), while every other unregistered name — including the
 * selectable-but-not-installed `opencode` — reports `harness_unavailable`.
 */
export function unregisteredHarnessError(name: AdapterName): { message: string; category: HarnessErrorCategory } {
  return unregisteredHarnessFailure(name);
}

// Pi is the single production driver. P1 registers more here, one at a time.
registerHarness(piHarnessDriver);
