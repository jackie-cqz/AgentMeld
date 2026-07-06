// ---------------------------------------------------------------------------
// P2: E2E Fixture validation — ensure all fixtures are well-formed
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const FIXTURES_DIR = path.join(__dirname, "..", "..", "..", "tests", "e2e-fixtures");

interface E2EFixture {
  id: string; title: string; description: string; userPrompt: string;
  expectedTasks: string[];
  expectedOutputs: Array<{ taskRole: string; outputKey: string; type: string }>;
  requiredToolEvidence: string[];
  successCriteria: string[];
  minPassCriteria: number;
}

function loadFixtures(): E2EFixture[] {
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf-8")));
}

describe("P2 E2E fixtures", () => {
  const fixtures = loadFixtures();

  it("has at least 5 fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });

  for (const fix of fixtures) {
    describe(fix.id, () => {
      it("has required fields", () => {
        expect(fix.id.length).toBeGreaterThan(0);
        expect(fix.title.length).toBeGreaterThan(0);
        expect(fix.userPrompt.length).toBeGreaterThan(0);
        expect(fix.expectedTasks.length).toBeGreaterThanOrEqual(2);
        expect(fix.expectedOutputs.length).toBeGreaterThanOrEqual(2);
        expect(fix.successCriteria.length).toBeGreaterThanOrEqual(3);
        expect(fix.minPassCriteria).toBeGreaterThan(0);
        expect(fix.minPassCriteria).toBeLessThanOrEqual(fix.successCriteria.length);
      });

      it("expectedOutputs have valid types", () => {
        const validTypes = ["web_app", "document", "image", "ppt"];
        for (const eo of fix.expectedOutputs) {
          expect(eo.outputKey.length).toBeGreaterThan(0);
          expect(validTypes).toContain(eo.type);
          expect(fix.expectedTasks).toContain(eo.taskRole);
        }
      });

      it("expectedTasks match expectedOutputs taskRoles", () => {
        const roles = new Set(fix.expectedOutputs.map((eo) => eo.taskRole));
        for (const role of roles) {
          expect(fix.expectedTasks).toContain(role);
        }
      });

      it("requiredToolEvidence has known tool types", () => {
        const knownTools = ["write_artifact", "read_artifact", "fs_write", "fs_read", "fs_patch", "bash", "deploy_workspace", "deploy_artifact"];
        for (const tool of fix.requiredToolEvidence) {
          expect(knownTools).toContain(tool);
        }
      });

      it("successCriteria are non-empty strings", () => {
        for (const sc of fix.successCriteria) {
          expect(sc.length).toBeGreaterThan(0);
        }
      });
    });
  }

  it("fixture IDs are unique", () => {
    const ids = fixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
