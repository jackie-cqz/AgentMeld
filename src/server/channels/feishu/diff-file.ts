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
 * untrusted input reaching a patch format.
 *
 * Two rules, in this order:
 *
 * 1. A trailing line terminator is stripped and any interior one is folded to a
 *    space, so one element can never become two lines.
 * 2. A line that carries no marker and looks like structure gets a leading
 *    space. A line that DOES carry a marker is content and is never rewritten:
 *    `-` followed by `-- old comment` is `--- old comment`, a deletion of a
 *    SQL/Lua comment, and demoting it to context would silently change what the
 *    change says.
 *
 * What makes this safe is not the second rule but the counts: they are derived
 * from the lines that are actually emitted, so a reader finishes the hunk at its
 * last line and never looks for a file header inside one. That is why a
 * header-looking BODY line may be left at column 0 — verified against git apply
 * and GNU patch with a matrix of forging attempts.
 */
function normalizeLine(line: string): string {
  // A trailing CR is a line TERMINATOR the producer split off, not content:
  // turning it into a space would append one to every line of a CRLF patch.
  const flattened = line.replace(/[\r\n]+$/, "").replace(/[\r\n]+/g, " ");
  // A line that already carries a marker is CONTENT. `-` followed by
  // `-- old comment` makes `--- old comment`, which is a deletion of a
  // SQL/Lua/Haskell comment, not a file header — demoting it to context would
  // silently change what the change says.
  if (/^[+\- ]/.test(flattened)) return flattened;
  // No marker and it looks like structure: this is the only place a forged
  // header could live, so it becomes context. A `\\`-prefixed marker line is
  // let through — it tells the reader something true about the previous line.
  if (/^\\/.test(flattened)) return flattened;
  return ` ${flattened}`;
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
    const oldStart = safeStart(hunk.oldStart);
    const newStart = safeStart(hunk.newStart);
    // The lines are the authority. A declared count that disagrees with them is
    // not used: it would let a reader finish the hunk early and re-read the
    // surplus as a header.
    const oldLines = implied.oldLines;
    const newLines = implied.newLines;
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
