import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TESTS_ROOT = path.join(REPO_ROOT, "tests");
const DRAFTS_DIR = path.join(TESTS_ROOT, "e2e-fixtures", "drafts");
const ASSETS_DIR = path.join(TESTS_ROOT, "e2e-assets");

const EXPECTED_CASE_IDS = [
  "tb2d-build-cython-extension",
  "tb2d-cancel-async-tasks",
  "tb2d-count-dataset-tokens-offline",
  "tb2d-db-wal-recovery",
  "tb2d-filter-js-from-html",
  "tb2d-financial-document-processor",
  "tb2d-fix-code-vulnerability",
  "tb2d-multi-source-data-merger",
  "tb2d-regex-log",
  "tb2d-video-jump-analyzer",
].sort();
const PROMOTED_CASE_IDS = [
  "tb2d-build-cython-extension",
  "tb2d-cancel-async-tasks",
  "tb2d-count-dataset-tokens-offline",
  "tb2d-db-wal-recovery",
  "tb2d-filter-js-from-html",
  "tb2d-financial-document-processor",
  "tb2d-fix-code-vulnerability",
  "tb2d-multi-source-data-merger",
  "tb2d-regex-log",
  "tb2d-video-jump-analyzer",
].sort();

interface DraftFixture {
  draftSchemaVersion: number;
  status: string;
  id: string;
  source: { dataset: string; taskId: string; url: string; adaptation: string };
  expectedRoles: string[];
  plannedDag: Array<{ from: string; to: string; outputKey: string }>;
  plannedOutputs: Array<{ role: string; outputKey: string; type: string }>;
  plannedAssertions: string[];
  assets: { manifest: string };
  runtimeDraft: {
    environment: { kind: string; network: string };
    verifiers: Array<{ id: string; command: string; expectedExitCode: number; exposeToAgent: boolean }>;
  };
}

interface AssetManifest {
  assetSchemaVersion: number;
  caseId: string;
  sourceTask: string;
  sourceUrl: string;
  licenseNote: string;
  public: string[];
  setup: string[];
  hidden: string[];
  generated: string[];
  requirements: string[];
  notes: string;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function resolveInside(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  expect(relative).not.toBe("");
  expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(false);
  return resolved;
}

describe("Terminal-Bench 2 derived fixture drafts", () => {
  const draftFiles = fs
    .readdirSync(DRAFTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const drafts = draftFiles.map((name) => readJson<DraftFixture>(path.join(DRAFTS_DIR, name)));

  it("defines exactly the planned ten cases", () => {
    expect(drafts.map((draft) => draft.id).sort()).toEqual(EXPECTED_CASE_IDS);
  });

  it.each(drafts)("declares a complete role contract for $id", (draft) => {
    expect(draft.draftSchemaVersion).toBe(1);
    expect(["planned", "promoted"]).toContain(draft.status);
    expect(draft.source.dataset).toBe("terminal-bench-2");
    expect(draft.source.taskId.length).toBeGreaterThan(2);
    expect(draft.source.url).toMatch(/^https:\/\//);
    expect(draft.source.adaptation.length).toBeGreaterThan(20);
    expect(draft.expectedRoles).toEqual(["pm", "frontend", "reviewer"]);
    expect(draft.plannedDag).toHaveLength(2);
    expect(draft.plannedOutputs).toHaveLength(3);
    expect(draft.plannedAssertions.length).toBeGreaterThanOrEqual(4);
    expect(draft.runtimeDraft.environment.kind).toMatch(/^(workspace|container)$/);
    expect(draft.runtimeDraft.environment.network).toMatch(/^(disabled|approval-required)$/);
    expect(draft.runtimeDraft.verifiers.length).toBeGreaterThan(0);
    for (const verifier of draft.runtimeDraft.verifiers) {
      expect(verifier.id.length).toBeGreaterThan(3);
      expect(verifier.command.length).toBeGreaterThan(5);
      expect(verifier.expectedExitCode).toBe(0);
      expect(verifier.exposeToAgent).toBe(false);
    }
  });

  it.each(drafts)("has a visibility-safe asset manifest for $id", (draft) => {
    const declaredManifest = path.resolve(REPO_ROOT, draft.assets.manifest);
    const expectedManifest = path.join(ASSETS_DIR, draft.id, "manifest.json");
    expect(declaredManifest).toBe(expectedManifest);
    expect(fs.existsSync(expectedManifest)).toBe(true);

    const manifest = readJson<AssetManifest>(expectedManifest);
    expect(manifest.assetSchemaVersion).toBe(1);
    expect(manifest.caseId).toBe(draft.id);
    expect(manifest.sourceTask).toBe(draft.source.taskId);
    expect(manifest.sourceUrl).toBe(draft.source.url);
    expect(manifest.licenseNote.length).toBeGreaterThan(20);
    expect(manifest.public.length).toBeGreaterThan(0);
    expect(manifest.hidden.length).toBeGreaterThan(0);
    expect(manifest.requirements.length).toBeGreaterThan(0);
    expect(manifest.notes.length).toBeGreaterThan(20);

    const assetRoot = path.dirname(expectedManifest);
    const declared = new Set<string>();
    for (const [visibility, files] of [
      ["public", manifest.public],
      ["setup", manifest.setup],
      ["hidden", manifest.hidden],
    ] as const) {
      for (const relativePath of files) {
        expect(declared.has(relativePath), `${draft.id}: duplicate path ${relativePath}`).toBe(false);
        declared.add(relativePath);
        const absolutePath = resolveInside(assetRoot, relativePath);
        expect(fs.existsSync(absolutePath), `${draft.id}: missing ${visibility} asset ${relativePath}`).toBe(true);
        expect(fs.statSync(absolutePath).isFile()).toBe(true);
      }
    }

    for (const generatedPath of manifest.generated) {
      expect(generatedPath.startsWith("generated/") || generatedPath.startsWith("public/")).toBe(true);
      resolveInside(assetRoot, generatedPath.replace(/[\\/]$/, "/placeholder"));
    }
  });

  it("promotes only cases backed by the runnable hidden verifier harness", () => {
    const productionRoot = path.join(TESTS_ROOT, "e2e-fixtures");
    const productionIds = fs.readdirSync(productionRoot)
      .filter((name) => name.startsWith("tb2d-") && name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .sort();
    expect(productionIds).toEqual(PROMOTED_CASE_IDS);
    expect(drafts.filter((draft) => draft.status === "promoted").map((draft) => draft.id).sort())
      .toEqual(PROMOTED_CASE_IDS);
  });
});
