import { describe, expect, it } from "vitest";
import { safeFileName } from "@/server/channels/feishu/file-name";

/**
 * The bug these pin was found by CI, not locally: a filename is capped by its
 * BYTE length on Linux (255 on ext4) and by UTF-16 units on macOS, so a cap
 * expressed in characters passes on a Mac and fails on the runner. The same
 * class of bug the previous sanitiser had, caught the same way.
 */
describe("safeFileName", () => {
  it("keeps an ordinary name", () => {
    expect(safeFileName("report.md", "fallback")).toBe("report.md");
  });

  it("strips what a filesystem must not be told", () => {
    expect(safeFileName("a/b\\c:d.txt", "fallback")).toBe("a-b-cd.txt");
    expect(safeFileName("../../etc/passwd", "fallback")).toBe("..-..-etc-passwd");
  });

  it("refuses a name that is only a traversal", () => {
    expect(safeFileName("..", "fallback")).toBe("fallback");
    expect(safeFileName(".", "fallback")).toBe("fallback");
    expect(safeFileName("", "fallback")).toBe("fallback");
    expect(safeFileName(null, "fallback")).toBe("fallback");
  });

  it("stays inside the filesystem's BYTE limit, not its character count", () => {
    // 130 CJK characters is 390 bytes: fine by character count, fatal on Linux.
    const name = safeFileName(`${"图".repeat(130)}.png`, "fallback");

    expect(Buffer.byteLength(name, "utf-8")).toBeLessThanOrEqual(255);
    // Room for the id prefix the caller adds in front of it.
    expect(Buffer.byteLength(`att_abcdefghijkl-${name}`, "utf-8")).toBeLessThanOrEqual(255);
  });

  it("keeps the extension even when the stem must be cut", () => {
    // The extension decides whether the file opens as a document or as a blob,
    // so losing it because the stem was long makes a valid name look broken.
    const name = safeFileName(`${"图".repeat(130)}.md`, "fallback");
    expect(name.endsWith(".md")).toBe(true);
  });

  it("applies a supplied extension only when the name has none", () => {
    expect(safeFileName("attachment-1", "fallback", ".png")).toBe("attachment-1.png");
    expect(safeFileName("shot.jpg", "fallback", ".png")).toBe("shot.jpg");
  });

  it("cuts by code point, leaving no lone surrogate", () => {
    const name = safeFileName(`${"a".repeat(200)}😀😀.txt`, "fallback");
    expect(/[\uD800-\uDFFF]/.test(name)).toBe(false);
  });
});
