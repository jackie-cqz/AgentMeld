import { describe, expect, it } from "vitest";
import { diffFileName, renderUnifiedDiff } from "@/server/channels/feishu/diff-file";

/**
 * A diff artifact has no file to send: it is a change. The unified form is what
 * every review tool reads, so it goes out as `<title>.diff`. Nothing here reads
 * the workspace, and nothing may throw — the delivery layer's contract is
 * "bytes or a reason", and a throw is swallowed upstream.
 */
describe("rendering a change as a unified diff", () => {
  const hunks = [
    {
      oldStart: 12,
      oldLines: 3,
      newStart: 12,
      newLines: 4,
      header: "function login()",
      lines: [" const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;", " return a;"]
    }
  ];

  it("writes a header and one hunk line per input line", () => {
    const result = renderUnifiedDiff(hunks, { applied: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.text.split("\n");
    expect(lines[0]).toBe("# 待审阅的改动");
    expect(result.text).toContain("--- before");
    expect(result.text).toContain("+++ after");
    expect(result.text).toContain("@@ -12,3 +12,4 @@ function login()");
    expect(result.text).toContain("-const b = 2;");
    expect(result.text).toContain("+const b = 3;");
    // A file, not a fragment: it ends with exactly one newline.
    expect(result.text.endsWith("\n")).toBe(true);
    expect(result.text.endsWith("\n\n")).toBe(false);
  });

  it("says whether the change was applied", () => {
    const result = renderUnifiedDiff(hunks, { applied: true });
    if (!result.ok) throw new Error("expected a rendered diff");
    expect(result.text).toContain("已应用");
  });

  it("counts the lines itself when the producer did not say", () => {
    const result = renderUnifiedDiff([{ lines: [" kept", "-gone", "+added"] }]);
    if (!result.ok) throw new Error("expected a rendered diff");
    // One context line counts on both sides; the deletion only on the old, the
    // addition only on the new.
    expect(result.text).toContain("@@ -1,2 +1,2 @@");
  });

  it("makes a bare line into context rather than emitting it unmarked", () => {
    // A line with no marker is not a malformed diff line; leaving it as it is
    // would produce output that a diff reader silently misreads.
    const result = renderUnifiedDiff([{ lines: ["no marker here"] }]);
    if (!result.ok) throw new Error("expected a rendered diff");
    expect(result.text).toContain("\n no marker here");
  });

  it("strips a carriage return and keeps the hunk header on one line", () => {
    const result = renderUnifiedDiff([{ header: "two\nlines", lines: ["+x\r"] }]);
    if (!result.ok) throw new Error("expected a rendered diff");
    expect(result.text).toContain("@@ -1,0 +1,1 @@ two lines");
    expect(result.text).not.toContain("\r");
  });

  it("refuses an empty or shapeless change with a reason", () => {
    for (const hunks of [[], null, undefined, "nope", [{ lines: [] }, { lines: "x" }]]) {
      const result = renderUnifiedDiff(hunks as never);
      expect(result.ok, JSON.stringify(hunks)).toBe(false);
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("reproduces a real diff -u faithfully, including -- and ++ content", () => {
    // The regression a review caught: a deletion of a line whose content starts
    // with "-- " renders as "--- old comment", and demoting that to context
    // silently turns a deletion into "it was already there".
    const hunks = [
      {
        oldStart: 1,
        newStart: 1,
        header: "sql",
        lines: [" keep", "--- old comment", "+-- new comment", " tail"]
      },
      {
        oldStart: 40,
        newStart: 40,
        lines: [" ctx", "+++ extra", " ctx2"]
      }
    ];
    const result = renderUnifiedDiff(hunks);
    if (!result.ok) throw new Error("expected a rendered diff");

    // First hunk: one deletion, one addition, two context lines.
    expect(result.text).toContain("@@ -1,3 +1,3 @@ sql");
    // Second: one addition, two context lines.
    expect(result.text).toContain("@@ -40,2 +40,3 @@");
    // The marker is preserved exactly: it is a deletion of that text.
    expect(result.text.split("\n")).toContain("--- old comment");
    expect(result.text.split("\n")).toContain("+++ extra");
  });

  it("strips a line terminator instead of turning it into trailing space", () => {
    // A CRLF patch split on "\n" leaves a CR on every line; folding it to a
    // space would append a trailing space to every line of the delivered file.
    const result = renderUnifiedDiff([{ lines: ["+x\r", "+y\r", " z\r"] }]);
    if (!result.ok) throw new Error("expected a rendered diff");
    for (const line of result.text.split("\n")) {
      expect(line.endsWith(" ")).toBe(false);
    }
    expect(result.text).toContain("+x");
    expect(result.text).toContain("+y");
  });

  it("never throws, whatever it is given", () => {
    for (const hunks of [42, {}, [null], [undefined], [{ lines: [1, 2, null] }], [""]]) {
      expect(() => renderUnifiedDiff(hunks as never)).not.toThrow();
    }
  });

  it("cannot be escaped into a second file header", () => {
    // A newline inside a "line" used to render a real `--- a/victim.txt` block,
    // and `git apply` then wrote to that path. The content is model-supplied.
    const result = renderUnifiedDiff([
      {
        lines: [
          " const a = 1;",
          "+x\n--- a/victim.txt\n+++ b/victim.txt\n@@ -1,1 +1,1 @@\n-innocent\n+pwned"
        ]
      }
    ]);
    if (!result.ok) throw new Error("expected a rendered diff");
    // The text survives, flattened onto one line: what must not survive is a
    // LINE that opens a file header.
    expect(result.text).not.toMatch(/^--- a\//m);
    // Exactly one `--- `/`+++ ` pair: ours.
    expect(result.text.match(/^--- /gm)?.length).toBe(1);
    expect(result.text.match(/^\+\+\+ /gm)?.length).toBe(1);
    // And exactly one hunk header.
    expect(result.text.match(/^@@ /gm)?.length).toBe(1);
  });

  it("keeps a header-looking line inside the hunk, where the counts hold it", () => {
    // `--- a/victim.txt` as a line means "delete a line whose content is
    // `-- a/victim.txt`" — a SQL/Lua/Haskell comment — so it must stay a
    // deletion, not be demoted to context. It is safe because the hunk's counts
    // are exact: a reader finishes the hunk there and never looks for a file
    // header inside it.
    const result = renderUnifiedDiff([{ lines: ["--- a/victim.txt", "+++ b/victim.txt"] }]);
    if (!result.ok) throw new Error("expected a rendered diff");
    expect(result.text.match(/^@@ /gm)?.length).toBe(1);
    // One deletion, one addition — exactly the two lines given.
    expect(result.text).toContain("@@ -1,1 +1,1 @@");
    const body = result.text.split("\n").filter((line) => /^[+-]/.test(line));
    expect(body).toContain("--- a/victim.txt");
  });

  it("renders a hundred thousand lines without throwing", () => {
    // `push(...lines)` becomes an argument spread, and V8 throws a RangeError
    // past ~110k — with the row already stored, the room would see nothing and
    // no not-delivering line would be written.
    const lines = Array.from({ length: 150_000 }, () => "+x");
    const result = renderUnifiedDiff([{ lines }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.split("\n").length).toBeGreaterThan(150_000);
  });

  it("counts the lines itself when the declared counts disagree", () => {
    // A wrong declared count makes the reader finish the hunk early and re-read
    // the surplus as a new file header — the structural escape, not just a
    // corrupt patch.
    const result = renderUnifiedDiff([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [" ctx", "-a", "+b", " ctx2"] }
    ]);
    if (!result.ok) throw new Error("expected a rendered diff");
    // Two context lines and one deletion/addition each side: the declared
    // "1,1" is ignored because it does not match the lines.
    expect(result.text).toContain("@@ -1,3 +1,3 @@");
  });

  it("does not count the no-newline marker as a line", () => {
    const result = renderUnifiedDiff([
      { lines: [" kept", "-gone", "+added", "\\ No newline at end of file"] }
    ]);
    if (!result.ok) throw new Error("expected a rendered diff");
    expect(result.text).toContain("@@ -1,2 +1,2 @@");
    // The marker itself is preserved: it tells the reader something true.
    expect(result.text).toContain("\\ No newline at end of file");
  });

  it("refuses to interpolate a start or count that is not a whole number", () => {
    const result = renderUnifiedDiff([
      { oldStart: Number.NaN, oldLines: -1, newStart: 1.5, newLines: Number.POSITIVE_INFINITY, lines: [" ctx", "+x"] }
    ]);
    if (!result.ok) throw new Error("expected a rendered diff");
    expect(result.text).toContain("@@ -1,1 +1,2 @@");
    expect(result.text).not.toContain("NaN");
    expect(result.text).not.toContain("Infinity");
  });

  it("carries non-string lines past without inventing them", () => {
    const result = renderUnifiedDiff([{ lines: ["+ok", 42, null, "+also"] }]);
    if (!result.ok) throw new Error("expected a rendered diff");
    expect(result.text).toContain("+ok");
    expect(result.text).toContain("+also");
    expect(result.text).not.toContain("42");
  });
});

describe("the delivered name of a change", () => {
  it("forces the .diff extension", () => {
    for (const title of ["登录页改动", "patch.diff", "fix v2.0.1", "...", "a.b.c"]) {
      expect(diffFileName(title), title).toMatch(/\.diff$/);
    }
  });
});
