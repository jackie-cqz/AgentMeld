import { z } from "zod";
import { isSelectableAdapter } from "./harness-catalog";
import type { AdapterName } from "./types";

/**
 * The adapter an Agent API request may carry.
 *
 * Derived from the harness catalog's allowlist rather than a second literal
 * list, so a name the registry says cannot be selected is rejected here too.
 * Retired values are refused (they are migration targets, not choices) and an
 * unregistered future name is refused until the catalog marks it selectable.
 */
export const selectableAdapterNameSchema = z.custom<AdapterName>(isSelectableAdapter, {
  message: "The selected execution engine is not available in this build.",
});
