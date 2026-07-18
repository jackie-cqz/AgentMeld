import { describe, expect, it } from "vitest";

import { extractArtifactIds } from "@/server/evidence/artifact-reference";

describe("extractArtifactIds", () => {
  it("keeps legal trailing hyphen and underscore characters", () => {
    expect(extractArtifactIds(
      'ids: "art_alpha_123-", "art_beta_456_".',
    )).toEqual(["art_alpha_123-", "art_beta_456_"]);
  });

  it("does not extract an artifact id embedded in a larger identifier", () => {
    expect(extractArtifactIds("prefixart_alpha_123-suffix")).toEqual([]);
  });

  it("deduplicates repeated references", () => {
    expect(extractArtifactIds("art_same_123- art_same_123-")).toEqual(["art_same_123-"]);
  });
});
