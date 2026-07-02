// ---------------------------------------------------------------------------
// P2: Fact Value Validator — type + constraint validation
// ---------------------------------------------------------------------------

import type { FactValueType } from "@/shared/builtin-fact-definitions";

export interface ValidationResult {
  valid: boolean;
  normalized?: unknown;
  error?: string;
}

const HEX_PATTERN = /^#[0-9a-fA-F]{3,8}$/;
const COLOR_NAME_PATTERN = /^(red|blue|green|yellow|purple|orange|pink|brown|black|white|gray|grey|cyan|magenta|teal|indigo|violet|slate|amber|emerald|rose|lime|fuchsia)$/i;
const MAX_STRING_LENGTH = 10000;
const MAX_ARRAY_LENGTH = 100;
const MAX_JSON_DEPTH = 5;
const MAX_JSON_SIZE = 32768;

export function validateFactValue(value: unknown, valueType: FactValueType): ValidationResult {
  switch (valueType) {
    case "string":
      return validateString(value);
    case "number":
      return validateNumber(value);
    case "boolean":
      return validateBoolean(value);
    case "color":
      return validateColor(value);
    case "string_array":
      return validateStringArray(value);
    case "json":
      return validateJson(value);
    default:
      return { valid: false, error: `Unknown value type: ${valueType}` };
  }
}

function validateString(value: unknown): ValidationResult {
  if (typeof value !== "string") {
    return { valid: false, error: `Expected string, got ${typeof value}` };
  }
  if (value.length === 0) {
    return { valid: false, error: "String value must not be empty" };
  }
  if (value.length > MAX_STRING_LENGTH) {
    return { valid: false, error: `String too long (${value.length} > ${MAX_STRING_LENGTH})` };
  }
  return { valid: true, normalized: value };
}

function validateNumber(value: unknown): ValidationResult {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return { valid: false, error: `Expected number, got ${typeof value}` };
  }
  if (!Number.isFinite(value)) {
    return { valid: false, error: "Number must be finite" };
  }
  return { valid: true, normalized: value };
}

function validateBoolean(value: unknown): ValidationResult {
  if (typeof value !== "boolean") {
    return { valid: false, error: `Expected boolean, got ${typeof value}` };
  }
  return { valid: true, normalized: value };
}

function validateColor(value: unknown): ValidationResult {
  if (typeof value !== "string") {
    return { valid: false, error: `Expected color string, got ${typeof value}` };
  }

  // HEX color
  if (HEX_PATTERN.test(value)) {
    return { valid: true, normalized: value.toLowerCase() };
  }

  // Named color — keep as-is (semantic), don't resolve to HEX
  if (COLOR_NAME_PATTERN.test(value)) {
    return { valid: true, normalized: value.toLowerCase() };
  }

  return { valid: false, error: `Invalid color: "${value}". Must be #hex or a recognized color name.` };
}

function validateStringArray(value: unknown): ValidationResult {
  if (!Array.isArray(value)) {
    return { valid: false, error: `Expected array, got ${typeof value}` };
  }
  if (value.length > MAX_ARRAY_LENGTH) {
    return { valid: false, error: `Array too long (${value.length} > ${MAX_ARRAY_LENGTH})` };
  }
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return { valid: false, error: `Array item must be string, got ${typeof item}` };
    }
    normalized.push(item);
  }
  // Deduplicate
  return { valid: true, normalized: [...new Set(normalized)] };
}

function validateJson(value: unknown): ValidationResult {
  try {
    const json = JSON.stringify(value);
    if (json.length > MAX_JSON_SIZE) {
      return { valid: false, error: `JSON payload too large (${json.length} > ${MAX_JSON_SIZE})` };
    }
    checkDepth(value, 0, MAX_JSON_DEPTH);
    return { valid: true, normalized: value };
  } catch (e) {
    return { valid: false, error: `Invalid JSON: ${e instanceof Error ? e.message : "unknown error"}` };
  }
}

function checkDepth(value: unknown, depth: number, maxDepth: number): void {
  if (depth > maxDepth) {
    throw new Error(`JSON nesting too deep (max ${maxDepth})`);
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      checkDepth(v, depth + 1, maxDepth);
    }
  }
}
