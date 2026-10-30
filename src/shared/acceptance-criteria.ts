// ---------------------------------------------------------------------------
// Acceptance criteria are stored in three different shapes, and only one of
// them is meant to be read by a human:
//
//   1. a plain human line   "PRD 产物已创建"
//   2. a structured contract object
//      { id, description, required, validator: { type: "artifact_exists", ... } }
//   3. a JSON string holding that contract — the canonical form the role
//      contract resolver writes into `DispatchPlanItem.acceptanceCriteria`
//      (see `src/server/agent-contracts/contract-resolver.ts`), because the
//      verification engine parses it back into a `AcceptanceCriterionSpec`.
//
// Human surfaces must never print shape 3 verbatim. This module is the single
// place that knows the encoding, so the plan card, the dispatch progress card
// and any future surface agree on the same rules. It is intentionally pure and
// defensive: malformed JSON degrades to the original string instead of throwing.
// ---------------------------------------------------------------------------

export type AcceptanceCriterionDisplay =
  | {
      kind: "text";
      /** Stable React key; also used for deduplication. */
      key: string;
      text: string;
    }
  | {
      kind: "contract";
      key: string;
      /** Human-readable description, never raw JSON. */
      description: string;
      /** Compact labels for the thing the contract validates, e.g. ["prd", "document"]. */
      badges: string[];
      /** `true` → 必需, `false` → 可选, `undefined` → no marker. */
      required?: boolean;
    };

const VALIDATOR_LABELS: Record<string, string> = {
  artifact_exists: "产物",
  deployment_created: "部署",
  command_exit: "命令",
  file_exists: "文件",
  file_changed: "文件变更",
  user_confirmation: "人工确认",
  reviewer_verdict: "评审",
};

const BADGE_MAX_LENGTH = 40;

/**
 * Parse one criterion of any accepted shape into a renderable description.
 * Returns `null` for values that carry no usable text at all.
 */
export function parseAcceptanceCriterion(value: unknown): AcceptanceCriterionDisplay | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const parsed = tryParseRecord(text);
    if (parsed) {
      const contract = toContractDisplay(parsed);
      if (contract) return contract;
    }
    // Malformed JSON, a JSON scalar, or a JSON object that is not a contract:
    // show the original string rather than guessing.
    return textDisplay(text);
  }

  if (isRecord(value)) {
    return toContractDisplay(value);
  }

  if (Array.isArray(value)) return null;

  return textDisplay(String(value));
}

/**
 * Parse, flatten and deduplicate a criteria list for display.
 *
 * Deduplication rules:
 *  - identical lines (after whitespace/case normalization) render once;
 *  - when a human line and a structured contract describe the same requirement
 *    (same description text), only the richer contract form is kept.
 */
export function formatAcceptanceCriteria(
  values: ReadonlyArray<unknown> | null | undefined
): AcceptanceCriterionDisplay[] {
  if (!Array.isArray(values)) return [];

  const parsed: AcceptanceCriterionDisplay[] = [];
  for (const value of values) {
    const display = parseAcceptanceCriterion(value);
    if (display) parsed.push(display);
  }

  const contractDescriptions = new Set(
    parsed
      .filter((display): display is Extract<AcceptanceCriterionDisplay, { kind: "contract" }> => display.kind === "contract")
      .map((display) => normalizeCriterionText(display.description))
  );

  const seen = new Set<string>();
  const result: AcceptanceCriterionDisplay[] = [];
  for (const display of parsed) {
    const normalized = normalizeCriterionText(display.kind === "text" ? display.text : display.description);
    if (!normalized) continue;
    if (display.kind === "text" && contractDescriptions.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(display);
  }
  return result;
}

/**
 * Normalize a criterion of any accepted shape back to the canonical string
 * form the rest of the platform understands (verification engine, prompt
 * builder, handoff packages). Used at API boundaries so a structured contract
 * submitted by a client is stored/verified instead of becoming "[object Object]".
 */
export function serializeAcceptanceCriterion(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (isRecord(value)) {
    const contract = toContractDisplay(value);
    if (!contract) {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    const validator = isRecord(value.validator) ? value.validator : undefined;
    const description = readString(value.description) ?? readString(value.id) ?? contract.description;
    return JSON.stringify({
      id: readString(value.id) ?? deriveCriterionId(validator, description),
      description,
      required: typeof value.required === "boolean" ? value.required : true,
      validator: validator ?? { type: "reviewer_verdict" },
    });
  }
  return String(value);
}

// ── Internals ───────────────────────────────────────────────────────────────

function toContractDisplay(
  record: Record<string, unknown>
): Extract<AcceptanceCriterionDisplay, { kind: "contract" }> | null {
  const validator = isRecord(record.validator) ? record.validator : undefined;
  const description =
    readString(record.description)
    ?? readString(record.id)
    ?? readString(record.name)
    ?? validatorHeadline(validator);
  if (!description) return null;
  const display: Extract<AcceptanceCriterionDisplay, { kind: "contract" }> = {
    kind: "contract",
    key: `contract:${normalizeCriterionText(description)}`,
    description,
    badges: contractBadges(validator),
  };
  if (typeof record.required === "boolean") display.required = record.required;
  return display;
}

function textDisplay(text: string): AcceptanceCriterionDisplay {
  return { kind: "text", key: `text:${normalizeCriterionText(text)}`, text };
}

function contractBadges(validator: Record<string, unknown> | undefined): string[] {
  if (!validator) return [];
  const values: string[] = [];
  for (const key of ["outputKey", "artifactType", "path", "command"] as const) {
    const value = readString(validator[key]);
    if (value) values.push(truncate(value));
  }
  const unique = [...new Set(values)];
  if (unique.length > 0) return unique;
  const label = validatorHeadline(validator);
  return label ? [label] : [];
}

function validatorHeadline(validator: Record<string, unknown> | undefined): string | null {
  const type = readString(validator?.type);
  if (!type) return null;
  return VALIDATOR_LABELS[type] ?? null;
}

function deriveCriterionId(validator: Record<string, unknown> | undefined, description: string): string {
  const subject =
    readString(validator?.outputKey)
    ?? readString(validator?.path)
    ?? readString(validator?.command)
    ?? readString(validator?.type)
    ?? description;
  const body = `${subject}`
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 60);
  return body ? `criterion-${body}` : "criterion";
}

function normalizeCriterionText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function truncate(value: string): string {
  return value.length > BADGE_MAX_LENGTH ? `${value.slice(0, BADGE_MAX_LENGTH - 1)}…` : value;
}

function tryParseRecord(text: string): Record<string, unknown> | null {
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
