import { describe, expect, it } from "vitest";
import {
  formatAcceptanceCriteria,
  parseAcceptanceCriterion,
  serializeAcceptanceCriterion,
} from "./acceptance-criteria";

const PRD_CONTRACT = {
  id: "contract-artifact-prd-document",
  description: "PRD 产物已创建",
  required: true,
  validator: { type: "artifact_exists", outputKey: "prd", artifactType: "document" },
};

describe("parseAcceptanceCriterion", () => {
  it("keeps a plain human line as text", () => {
    expect(parseAcceptanceCriterion("PRD 产物已创建")).toEqual({
      kind: "text",
      key: "text:prd 产物已创建",
      text: "PRD 产物已创建",
    });
  });

  it("renders a structured contract object with description, badges and required marker", () => {
    expect(parseAcceptanceCriterion(PRD_CONTRACT)).toEqual({
      kind: "contract",
      key: "contract:prd 产物已创建",
      description: "PRD 产物已创建",
      badges: ["prd", "document"],
      required: true,
    });
  });

  it("renders a JSON-string contract exactly like the object form", () => {
    expect(parseAcceptanceCriterion(JSON.stringify(PRD_CONTRACT))).toEqual(
      parseAcceptanceCriterion(PRD_CONTRACT)
    );
  });

  it("never prints raw JSON for a malformed or non-contract JSON string", () => {
    const malformed = '{"id":"contract-artifact-prd-document","description":';
    expect(parseAcceptanceCriterion(malformed)).toEqual({
      kind: "text",
      key: `text:${malformed.toLowerCase()}`,
      text: malformed,
    });

    const nonContract = '{"a":1}';
    expect(parseAcceptanceCriterion(nonContract)).toEqual({
      kind: "text",
      key: `text:${nonContract.toLowerCase()}`,
      text: nonContract,
    });
  });

  it("falls back to the contract id when description is missing", () => {
    expect(parseAcceptanceCriterion({
      id: "contract-artifact-prd-document",
      required: true,
      validator: { type: "artifact_exists", outputKey: "prd" },
    })).toEqual({
      kind: "contract",
      key: "contract:contract-artifact-prd-document",
      description: "contract-artifact-prd-document",
      badges: ["prd"],
      required: true,
    });
  });

  it("falls back to the validator label when description and id are both missing", () => {
    expect(parseAcceptanceCriterion({ required: false, validator: { type: "reviewer_verdict" } })).toEqual({
      kind: "contract",
      key: "contract:评审",
      description: "评审",
      badges: ["评审"],
      required: false,
    });
  });

  it("omits the required marker when the contract does not declare it", () => {
    const parsed = parseAcceptanceCriterion({
      description: "风格指南产物已创建",
      validator: { type: "artifact_exists", outputKey: "style-guide" },
    });
    expect(parsed).not.toBeNull();
    expect(parsed && "required" in parsed).toBe(false);
  });

  it("keeps badges compact for command validators", () => {
    const parsed = parseAcceptanceCriterion({
      description: "构建通过",
      validator: { type: "command_exit", command: "pnpm build --filter @agentmeld/web --mode production", expectedExitCode: 0 },
    });
    expect(parsed?.kind).toBe("contract");
    if (parsed?.kind !== "contract") return;
    expect(parsed.badges).toHaveLength(1);
    expect(parsed.badges[0].endsWith("…")).toBe(true);
    expect(parsed.badges[0].length).toBeLessThanOrEqual(40);
  });

  it("ignores empty values", () => {
    expect(parseAcceptanceCriterion("   ")).toBeNull();
    expect(parseAcceptanceCriterion(null)).toBeNull();
    expect(parseAcceptanceCriterion(undefined)).toBeNull();
  });
});

describe("formatAcceptanceCriteria", () => {
  it("returns an empty list for missing or non-array input", () => {
    expect(formatAcceptanceCriteria(undefined)).toEqual([]);
    expect(formatAcceptanceCriteria(null)).toEqual([]);
  });

  it("does not show a contract twice when it also appears as a human line", () => {
    for (const values of [
      ["PRD 产物已创建", JSON.stringify(PRD_CONTRACT)],
      [JSON.stringify(PRD_CONTRACT), "PRD 产物已创建"],
    ]) {
      const formatted = formatAcceptanceCriteria(values);
      expect(formatted).toHaveLength(1);
      expect(formatted[0].kind).toBe("contract");
    }
  });

  it("deduplicates identical plain lines", () => {
    expect(formatAcceptanceCriteria(["same", " same ", "same"]).map((criterion) => criterion.kind)).toEqual([
      "text",
    ]);
  });

  it("mixes text, object contracts and JSON-string contracts in order", () => {
    const formatted = formatAcceptanceCriteria([
      "文档明确说明交付物",
      PRD_CONTRACT,
      "风格指南产物已创建",
      JSON.stringify({
        description: "构建通过",
        required: false,
        validator: { type: "command_exit", command: "pnpm build", expectedExitCode: 0 },
      }),
    ]);
    expect(formatted.map((criterion) => criterion.kind)).toEqual([
      "text",
      "contract",
      "text",
      "contract",
    ]);
    expect(formatted.map((criterion) => criterion.kind === "contract" ? criterion.description : criterion.text)).toEqual([
      "文档明确说明交付物",
      "PRD 产物已创建",
      "风格指南产物已创建",
      "构建通过",
    ]);
  });
});

describe("serializeAcceptanceCriterion", () => {
  it("leaves a plain string untouched", () => {
    expect(serializeAcceptanceCriterion("PRD 产物已创建")).toBe("PRD 产物已创建");
  });

  it("normalizes a contract object to the canonical JSON string", () => {
    const serialized = serializeAcceptanceCriterion(PRD_CONTRACT);
    expect(typeof serialized).toBe("string");
    expect(JSON.parse(serialized)).toEqual(PRD_CONTRACT);
  });

  it("derives an id and defaults required to true for an untyped contract object", () => {
    const parsed = JSON.parse(serializeAcceptanceCriterion({
      description: "PRD 产物已创建",
      validator: { type: "artifact_exists", outputKey: "prd" },
    }));
    expect(parsed.id).toBe("criterion-prd");
    expect(parsed.description).toBe("PRD 产物已创建");
    expect(parsed.required).toBe(true);
    expect(parsed.validator).toEqual({ type: "artifact_exists", outputKey: "prd" });
  });

  it("never produces [object Object] for a non-contract object", () => {
    expect(serializeAcceptanceCriterion({ note: "x" })).toBe('{"note":"x"}');
  });

  it("returns an empty string for empty values", () => {
    expect(serializeAcceptanceCriterion(undefined)).toBe("");
    expect(serializeAcceptanceCriterion(null)).toBe("");
  });
});
