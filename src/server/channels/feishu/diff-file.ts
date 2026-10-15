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

export interface RenderedDiff {
  text: string;
}

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
    if (marker === "+") newLines += 1;
    else if (marker === "-") oldLines += 1;
    else {
      oldLines += 1;
      newLines += 1;
    }
  }
  return { oldLines, newLines };
}

/** One line, in a shape a diff reader accepts. */
function normalizeLine(line: string): string {
  const withoutCr = line.replace(/\r$/, "");
  // A bare string with no marker is context, not a malformed line: prefixing it
  // is what makes the output parseable rather than silently wrong.
  return /^[+\- @\\]/.test(withoutCr) ? withoutCr : ` ${withoutCr}`;
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

  let index = 0;
  for (const raw of list) {
    index += 1;
    const hunk = (raw ?? {}) as Partial<DiffHunk>;
    const lines = asLines(hunk.lines).map(normalizeLine);
    if (lines.length === 0) continue;

    const implied = impliedCounts(lines);
    const oldStart = typeof hunk.oldStart === "number" ? hunk.oldStart : 1;
    const newStart = typeof hunk.newStart === "number" ? hunk.newStart : 1;
    const oldLines = typeof hunk.oldLines === "number" ? hunk.oldLines : implied.oldLines;
    const newLines = typeof hunk.newLines === "number" ? hunk.newLines : implied.newLines;
    const header = typeof hunk.header === "string" && hunk.header.trim().length > 0
      ? ` ${hunk.header.replace(/[\r\n]+/g, " ").trim()}`
      : "";

    rendered.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${header}`);
    rendered.push(...lines);
  }

  if (index === 0 || rendered.length === 3) {
    return { ok: false, reason: "the change has no lines" };
  }

  return { ok: true, text: `${rendered.join("\n")}\n` };
}
