const ARTIFACT_ID_PATTERN = /(?<![A-Za-z0-9_-])art_[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g;

/** Extract complete persisted artifact ids without trimming legal NanoID suffixes. */
export function extractArtifactIds(text: string): string[] {
  return [...new Set(text.match(ARTIFACT_ID_PATTERN) ?? [])];
}
