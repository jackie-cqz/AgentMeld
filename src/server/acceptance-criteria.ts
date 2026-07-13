export interface AcceptanceResultLike {
  criterion: string;
  passed: boolean;
  evidence?: string;
}

export function extractCriterionDescription(criterion: string): string {
  try {
    const parsed = JSON.parse(criterion) as Record<string, unknown>;
    if (typeof parsed.description === "string") return parsed.description;
  } catch {
    // Plain text criterion.
  }
  return criterion;
}

export function isAutoVerifiedCriterion(criterion: string): boolean {
  try {
    const parsed = JSON.parse(criterion) as { validator?: { type?: string } };
    const type = parsed?.validator?.type;
    return typeof type === "string" && type !== "reviewer_verdict";
  } catch {
    return false;
  }
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function humanReviewedCriteria(criteria: string[]): string[] {
  return uniqueStrings(
    criteria
      .filter((criterion) => !isAutoVerifiedCriterion(criterion))
      .map((criterion) => extractCriterionDescription(criterion).trim())
      .filter(Boolean)
  );
}

export function findMissingCriteria(
  expectedCriteria: string[],
  acceptanceResults: AcceptanceResultLike[]
): string[] {
  return expectedCriteria.filter((criterion, index) => {
    if (isCriterionCovered(criterion, acceptanceResults)) return false;

    // LLMs often preserve acceptance result order but rewrite the criterion
    // wording. If the corresponding positional result passed, treat it as a
    // covered human-reviewed criterion while evidence validators handle hard
    // checks separately.
    return acceptanceResults[index]?.passed !== true;
  });
}

export function isCriterionCovered(
  expectedCriterion: string,
  acceptanceResults: AcceptanceResultLike[]
): boolean {
  const expected = normalizeCriterionText(expectedCriterion);
  if (!expected) return true;

  return acceptanceResults.some((result) => {
    if (!result.passed) return false;

    const criterion = normalizeCriterionText(result.criterion);
    const combined = normalizeCriterionText(`${result.criterion}\n${result.evidence ?? ""}`);
    return (
      criterion === expected ||
      criterion.includes(expected) ||
      expected.includes(criterion) ||
      combined.includes(expected) ||
      diceCoefficient(expected, criterion) >= 0.58 ||
      diceCoefficient(expected, combined) >= 0.62
    );
  });
}

function normalizeCriterionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const aPairs = bigramCounts(a);
  const bPairs = bigramCounts(b);
  let overlap = 0;
  for (const [pair, count] of aPairs) {
    overlap += Math.min(count, bPairs.get(pair) ?? 0);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

function bigramCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < value.length - 1; i++) {
    const pair = value.slice(i, i + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}
