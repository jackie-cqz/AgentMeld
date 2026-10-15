import { artifactFileName } from "@/server/channels/feishu/file-name";
import type { DiffHunk } from "@/shared/types";

/**
 * A diff artifact as one reviewable file.
 *
 * `code_file` already delivers the file itself; a `diff` had nothing to send
 * because it is not a file, it is a change. A unified diff is the form every
 * review tool reads, it is plain text, and it needs nothing from the workspace
 * — so it goes out as `<title>.diff`.
 *
 * The renderer is total: malformed input comes back as a reason, never as a
 * throw. A throw here is swallowed by the delivery subscriber, so the group
 * would see nothing at all and the not-delivering log line would never appear.
 */

/** The delivered name: the artifact's title, with `.diff` forced. */
export function diffFileName(title: string): string {
  return artifactFileName(title, "change", ".diff");
}

function asLines(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((line): line is string => typeof line === "string") : [];
}

/**
 * Count the lines a hunk touches on each side, the way a diff does.
 *
 * Used only when the producer did not say: context and deletions count as old,
 * context and additions as new.
 */
function impliedCounts(lines: string[]): { oldLines: number; newLines: number } {
  let oldLines = 0;
  let newLines = 0;
  for (const line of lines) {
    const marker = line[0];
    // `\ No newline at end of file` is a marker about the previous line, not a
    // line; counting it made every hunk that carried one corrupt.
    if (marker === "\\") continue;
    if (marker === "+") newLines += 1;
    else if (marker === "-") oldLines += 1;
    else {
      oldLines += 1;
      newLines += 1;
    }
  }
  return { oldLines, newLines };
}

/**
 * One line, in a shape a diff reader accepts AND cannot be escaped from.
 *
 * A newline inside a "line" was the dangerous one: `"+x\n--- a/victim.txt\n…"`
 * rendered a second file header, and `git apply` then wrote to `victim.txt` —
 * the content comes from a model or a `POST /api/artifacts` body, so this is
 * untrusted input reaching a patch format. Every newline is folded to a space,
 * and a line that would start a hunk or a file header is demoted to context.
 */
function normalizeLine(line: string): string {
  const flattened = line.replace(/[\r\n]+/g, " ");
  // Markers that carry structure. `\\` (no newline at end of file) is kept as
  // it is only when it is the whole line; anything else becomes context.
  if (/^\\/.test(flattened)) return flattened;
  // Looks like structure rather than content: defuse it. The counts already
  // stop a reader from being tricked into re-reading one of these as a header,
  // and this stops a reader that does not use the counts (a grep, a person).
  if (/^(?:--- |\+\+\+ |diff |@@ )/.test(flattened)) return ` ${flattened}`;
  if (/^[+\- ]/.test(flattened)) return flattened;
  return ` ${flattened}`;
}

/** The declared count is used only when it agrees with the lines. */
function agreedCount(declared: unknown, implied: number): number {
  return typeof declared === "number" && Number.isInteger(declared) && declared >= 0
    ? declared
    : implied;
}

/** A start line the reader can use; anything else falls back to 1. */
function safeStart(declared: unknown): number {
  return typeof declared === "number" && Number.isInteger(declared) && declared >= 0 ? declared : 1;
}

export function renderUnifiedDiff(
  hunks: unknown,
  options: { applied?: boolean } = {}
): { ok: true; text: string } | { ok: false; reason: string } {
  const list = Array.isArray(hunks) ? hunks : null;
  if (!list || list.length === 0) return { ok: false, reason: "the change has no hunks" };

  const rendered: string[] = [];
  // A header that says what this is when it lands in a chat, without quoting
  // anything the model supplied.
  rendered.push(options.applied ? "# 已应用的改动" : "# 待审阅的改动");
  rendered.push("--- before");
  rendered.push("+++ after");

  for (const raw of list) {
    const hunk = (raw ?? {}) as Partial<DiffHunk>;
    const lines = asLines(hunk.lines).map(normalizeLine);
    if (lines.length === 0) continue;

    const implied = impliedCounts(lines);
    // The lines are the authority: a declared count that disagrees with them
    // either produces a corrupt patch or — worse — makes the reader finish the
    // hunk early and re-read the surplus as a new file header.
    const declaredOld = typeof hunk.oldLines === "number" ? hunk.oldLines : undefined;
    const declaredNew = typeof hunk.newLines === "number" ? hunk.newLines : undefined;
    const oldStart = safeStart(hunk.oldStart);
    const newStart = safeStart(hunk.newStart);
    const oldLines = declaredOld === implied.oldLines ? agreedCount(declaredOld, implied.oldLines) : implied.oldLines;
    const newLines = declaredNew === implied.newLines ? agreedCount(declaredNew, implied.newLines) : implied.newLines;
    const header = typeof hunk.header === "string" && hunk.header.trim().length > 0
      ? ` ${hunk.header.replace(/[\r\n]+/g, " ").trim()}`
      : "";

    rendered.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${header}`);
    // One at a time: `push(...lines)` becomes an argument spread, and V8 throws
    // a RangeError past ~110k lines — with the row already stored, the group
    // would see nothing and the not-delivering line would never be written.
    for (const line of lines) rendered.push(line);
  }

  // Only the header lines made it: every hunk was empty or shapeless.
  if (rendered.length === 3) {
    return { ok: false, reason: "the change has no lines" };
  }

  return { ok: true, text: `${rendered.join("\n")}\n` };
}
