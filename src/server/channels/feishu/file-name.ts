import path from "node:path";

/**
 * Filenames for anything this channel writes to disk or uploads.
 *
 * Two limits, and the second one is not obvious: a filename is capped by its
 * BYTE length on Linux (255 bytes on ext4), not by its character count. A cap
 * expressed in characters therefore lets a CJK name through at three bytes per
 * character — 120 characters is 360 bytes — and the write fails on a platform
 * whose cap is measured the other way. macOS counts UTF-16 units, so the same
 * name is fine locally and fails in CI, which is how this was found.
 *
 * Truncation walks code points rather than slicing, because slicing can split a
 * surrogate pair and leave a lone surrogate that the filesystem replaces with
 * U+FFFD — so the name in the database stops matching the name on disk.
 */

/** Room for the id prefix callers add, and for the extension. */
const MAX_NAME_BYTES = 180;

function truncateToBytes(text: string, maxBytes: number): string {
  let out = "";
  for (const point of text) {
    if (Buffer.byteLength(out + point, "utf-8") > maxBytes) break;
    out += point;
  }
  return out;
}

/**
 * A name a filesystem will accept, with the extension preserved.
 *
 * The extension is kept deliberately: it is what decides whether a file opens
 * as a document or as a generic blob, and losing it because the stem was long
 * would make a valid name look like a broken one.
 */
export function safeFileName(fileName: string | null, fallback: string, extension = ""): string {
  const cleaned = (fileName ?? "")
    .replace(/[/\\]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .trim();

  const own = path.extname(cleaned);
  const suffix = own || extension;
  const stem = own ? cleaned.slice(0, cleaned.length - own.length) : cleaned;

  const room = Math.max(1, MAX_NAME_BYTES - Buffer.byteLength(suffix, "utf-8"));
  const base = truncateToBytes(stem, room);

  if (!base || base === "." || base === "..") return `${fallback}${suffix}`;
  return `${base}${suffix}`;
}

/**
 * A title with every trailing dot segment removed.
 *
 * safeFileName keeps whatever extension the name appears to have, so a title
 * like "Dashboard 2.0.1" or "设计稿v2.0.pptx" silently loses the extension the
 * caller asked for. Both artifact types that build a delivered file name need
 * the same two steps in this order: strip ALL trailing dot segments (a loop —
 * one pass leaves "2.0", whose ".0" then reads as the extension), then force
 * the one the content actually has. Two copies of this drifted once already.
 */
export function stripAllExtensions(title: string): string {
  let trimmed = title.trim();
  let previous = "";
  while (previous !== trimmed) {
    previous = trimmed;
    trimmed = trimmed.replace(/\.[^.]*$/, "").trim();
  }
  return trimmed.length > 0 ? trimmed : title.trim();
}

/** Append the extension if the sanitiser left something else. */
export function forceExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
}

/** The name to deliver a file under, with the content's extension forced. */
export function artifactFileName(title: string, fallback: string, extension: string): string {
  return forceExtension(safeFileName(stripAllExtensions(title), fallback, extension), extension);
}
