// ---------------------------------------------------------------------------
// P2: Fact Key Generator — deterministic canonical key generation
//
// Does NOT call LLM. Generates canonical keys from entity + property.
// ---------------------------------------------------------------------------

/**
 * Deterministically generate a canonical key from entity + property.
 *
 * Rules:
 * - Normalize: lowercase, replace spaces/special chars with dots
 * - Format: {namespace}.{propertyName}
 * - If namespace not provided, derive from entity
 */
export function generateCanonicalKey(entity: string, property: string, namespace?: string): string {
  const ns = normalizeSegment(namespace ?? entity);
  const prop = normalizeSegment(property);
  return `${ns}.${prop}`;
}

function normalizeSegment(segment: string): string {
  return segment
    // Split camelCase: lowerUpper → lower.upper
    .replace(/([a-z])([A-Z])/g, "$1.$2")
    .toLowerCase()
    .replace(/[\s_]+/g, ".")
    .replace(/[^a-z0-9.]/g, "")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");
}

/**
 * Check if a generated canonical key conflicts with any existing key.
 */
export function isKeyConflict(
  proposedKey: string,
  existingKeys: string[],
  builtinKeys: string[]
): boolean {
  const all = new Set([...existingKeys, ...builtinKeys]);
  return all.has(proposedKey);
}
