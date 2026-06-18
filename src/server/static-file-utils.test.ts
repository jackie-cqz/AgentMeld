import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getStaticMimeType,
  normalizeStaticFilePath,
  resolveStaticFilePath
} from "@/server/static-file-utils";

describe("static-file-utils", () => {
  it("preserves nested relative paths", () => {
    expect(normalizeStaticFilePath("assets/app.js")).toBe("assets/app.js");
    expect(normalizeStaticFilePath("assets\\app.js")).toBe("assets/app.js");
  });

  it("rejects absolute and traversal paths", () => {
    expect(normalizeStaticFilePath("../evil.js")).toBeNull();
    expect(normalizeStaticFilePath("/absolute.js")).toBeNull();
    expect(normalizeStaticFilePath("C:\\absolute.js")).toBeNull();
    expect(normalizeStaticFilePath("assets//app.js")).toBeNull();
  });

  it("resolves files inside the provided root", () => {
    const root = path.resolve("tmp", "preview");
    expect(resolveStaticFilePath(root, "assets/app.js")).toBe(path.join(root, "assets", "app.js"));
    expect(resolveStaticFilePath(root, "../evil.js")).toBeNull();
  });

  it("returns content types for common static assets", () => {
    expect(getStaticMimeType("index.html")).toContain("text/html");
    expect(getStaticMimeType("assets/app.js")).toContain("javascript");
    expect(getStaticMimeType("asset.bin")).toBe("application/octet-stream");
  });
});
