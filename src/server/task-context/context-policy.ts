// ---------------------------------------------------------------------------
// P3: Context Policy — strictly defined injection tiers
// ---------------------------------------------------------------------------

export type InjectionTier = "mandatory" | "high" | "optional" | "forbidden";

export interface TierClassification {
  tier: InjectionTier;
  reason: string;
}

/**
 * Classify a candidate into one of four injection tiers per §9.4.
 */
export function classifyCandidate(category: string, sourceType: string, required: boolean, trustLevel: string): TierClassification {
  // Mandatory — cannot be trimmed, cannot be excluded
  if (required) {
    return { tier: "mandatory", reason: "explicitly required by task contract" };
  }
  if (category === "task") {
    return { tier: "mandatory", reason: "task identity and objective" };
  }
  if (trustLevel === "authoritative") {
    return { tier: "mandatory", reason: "authoritative source (user confirmation, system config)" };
  }
  if (category === "failure") {
    return { tier: "mandatory", reason: "failure context for retry" };
  }

  // High priority
  if (category === "fact") {
    return { tier: "high", reason: "active fact in task namespace" };
  }
  if (category === "upstream_input") {
    return { tier: "high", reason: "verified upstream artifact" };
  }
  if (category === "workspace") {
    return { tier: "high", reason: "workspace state (targetPaths)" };
  }

  // Optional
  if (category === "recent_message" || category === "retrieved_history") {
    return { tier: "optional", reason: "historical context" };
  }

  // Everything else
  return { tier: "optional", reason: "default tier for non-mandatory items" };
}

/** Items that must NEVER be injected into an agent context */
export function isForbidden(category: string, trustLevel: string, status?: string): boolean {
  // Unverified artifacts as fact
  if (category === "upstream_input" && trustLevel === "reported") return true;
  // Superseded/pending/rejected facts
  if (category === "fact" && status && status !== "active") return true;
  return false;
}
