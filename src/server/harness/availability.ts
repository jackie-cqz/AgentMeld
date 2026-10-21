import type { AdapterName } from "@/shared/types";
import {
  HARNESS_DESCRIPTORS,
  deriveHarnessState,
  harnessDescriptor,
  type HarnessAvailability,
  type HarnessDoctorReport,
} from "@/shared/harness-catalog";
import { getHarness } from "./registry";
import type { HarnessDoctor, HarnessDriver } from "./types";

/**
 * Turn one registered driver's `doctor()` into the client-facing report.
 *
 * The driver contract says `doctor()` must not throw for a missing/broken
 * installation, but availability is a read endpoint: one misbehaving driver must
 * not turn the whole answer into a 500. A thrown probe is reported as honestly
 * unavailable, with the reason, never as "available" and never silently dropped.
 */
function readDoctor(descriptor: HarnessDriver["id"], driver: HarnessDriver): HarnessDoctorReport {
  let report: HarnessDoctor;
  try {
    report = driver.doctor();
  } catch (error) {
    return {
      available: false,
      detail: `The "${descriptor}" harness could not report its installation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return {
    available: report.available === true,
    ...(report.version ? { version: report.version } : {}),
    ...(report.detail ? { detail: report.detail } : {}),
  };
}

/** Runtime availability for one name, derived from registration plus doctor(). */
export function getHarnessAvailability(name: AdapterName | string): HarnessAvailability {
  const descriptor = harnessDescriptor(name);
  const driver = getHarness(descriptor.id);
  const doctor = driver ? readDoctor(descriptor.id, driver) : null;
  return {
    id: descriptor.id,
    label: descriptor.label,
    state: deriveHarnessState(descriptor, { driverRegistered: driver !== null, doctor }),
    selectable: descriptor.selectable,
    driverRegistered: driver !== null,
    doctor,
  };
}

/**
 * Whether an Agent's engine can run on this machine right now.
 *
 * This is the single predicate collaboration and maintenance paths use instead
 * of comparing an adapter name to a literal: a driver must be registered for the
 * name *and* its own `doctor()` must pass. Any other state is honestly "not
 * runnable", including a retired row with no driver.
 */
export function isHarnessAvailable(name: AdapterName | string): boolean {
  return getHarnessAvailability(name).state === "available";
}

/**
 * The `/api/harnesses` payload: every known name, with the runtime truth.
 *
 * It lists retired names too (so the UI can explain an old Agent row) but never
 * invents a driver for them; a retired name with no driver is `retired`, a
 * selectable name with no driver is `not-installed`.
 */
export function listHarnessAvailability(): HarnessAvailability[] {
  return HARNESS_DESCRIPTORS.map((descriptor) => getHarnessAvailability(descriptor.id));
}
