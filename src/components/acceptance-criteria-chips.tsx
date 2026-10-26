"use client";

import { formatAcceptanceCriteria } from "@/shared/acceptance-criteria";

/**
 * Human-readable acceptance criteria chips.
 *
 * A plain criterion keeps the original purple "验收: …" chip. A structured
 * contract (object or JSON string) shows its description plus compact badges for
 * the thing it validates, and a 必需/可选 marker. Raw JSON is never printed.
 *
 * Rendered as a fragment so each caller keeps its own wrapping container.
 */
export function AcceptanceCriteriaChips({ values }: { values: ReadonlyArray<unknown> | null | undefined }) {
  const criteria = formatAcceptanceCriteria(values);

  return (
    <>
      {criteria.map((criterion) =>
        criterion.kind === "text" ? (
          <span
            key={criterion.key}
            className="max-w-full break-words rounded bg-purple-50 px-1.5 py-0.5 text-[10px] leading-4 text-purple-700"
          >
            验收: {criterion.text}
          </span>
        ) : (
          <span
            key={criterion.key}
            className="inline-flex max-w-full flex-wrap items-center gap-1 rounded bg-purple-50 px-1.5 py-0.5 text-[10px] leading-4 text-purple-700"
          >
            <span className="min-w-0 break-words">验收: {criterion.description}</span>
            {criterion.badges.map((badge) => (
              <span
                key={badge}
                className="rounded bg-white/80 px-1 font-mono text-[9px] leading-4 text-purple-600"
              >
                {badge}
              </span>
            ))}
            {typeof criterion.required === "boolean" ? (
              <span
                className={`rounded px-1 text-[9px] leading-4 ${
                  criterion.required ? "bg-purple-100 text-purple-700" : "bg-white/70 text-slate-500"
                }`}
              >
                {criterion.required ? "必需" : "可选"}
              </span>
            ) : null}
          </span>
        )
      )}
    </>
  );
}
