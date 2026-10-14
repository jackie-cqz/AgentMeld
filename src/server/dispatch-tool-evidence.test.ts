import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListEvidenceForTask = vi.fn();

vi.mock("@/server/repositories/evidence-repository", async (importOriginal) => {
  // Spread the real module and override only what this suite drives. A whitelist
  // factory breaks every OTHER consumer of the module: the global test setup calls
  // ensureDatabase -> recoverOrphanedRuns, so an export added for the startup path
  // (retireNonTerminalAttempts) crashed this file's collection.
  const actual = await importOriginal<typeof import("@/server/repositories/evidence-repository")>();
  return {
    ...actual,
    getTaskAttemptByChildRun: vi.fn(),
    insertEvidence: vi.fn(),
    listEvidenceForChildRun: vi.fn(() => []),
    listEvidenceForTask: (...args: unknown[]) => mockListEvidenceForTask(...args),
  };
});

import {
  clearAllToolEvidenceForTests,
  getTaskToolEvidence,
} from "@/server/dispatch-tool-evidence";
import type { EvidenceRecord } from "@/server/repositories/evidence-repository";

beforeEach(() => {
  clearAllToolEvidenceForTests();
  mockListEvidenceForTask.mockReset();
});

describe("getTaskToolEvidence", () => {
  it("combines original-task writes with recovery-task verification commands", () => {
    const records: Record<string, EvidenceRecord[]> = {
      t3: [
        evidence({
          id: "ev_write",
          taskId: "t3",
          type: "file_written",
          subjectType: "file",
          subjectId: "src/App.jsx",
          payloadJson: JSON.stringify({
            path: "src/App.jsx",
            absolutePath: "C:/workspace/src/App.jsx",
            action: "created",
          }),
          createdAt: 10,
        }),
      ],
      r3: [
        evidence({
          id: "ev_build",
          taskId: "r3",
          type: "test_executed",
          subjectType: "command",
          subjectId: "npm run build",
          payloadJson: JSON.stringify({
            command: "npm run build",
            exitCode: 0,
            timedOut: false,
          }),
          createdAt: 20,
        }),
      ],
    };
    mockListEvidenceForTask.mockImplementation(
      (_runId: string, _planId: string, taskId: string) => records[taskId] ?? []
    );

    const result = getTaskToolEvidence({
      conductorRunId: "run_parent",
      planId: "plan_initial",
      taskIds: ["t3", "r3"],
    });

    expect(result.fileWrites.map((item) => item.path)).toEqual(["src/App.jsx"]);
    expect(result.observedPaths).toEqual([]);
    expect(result.commands).toContainEqual(expect.objectContaining({
      command: "npm run build",
      exitCode: 0,
      isError: false,
    }));
  });

  it("ignores invalidated and invalid ledger evidence", () => {
    mockListEvidenceForTask.mockReturnValue([
      evidence({
        id: "ev_invalid_status",
        status: "invalid",
        type: "file_written",
        subjectType: "file",
        subjectId: "src/App.jsx",
        payloadJson: JSON.stringify({ path: "src/App.jsx", action: "created" }),
        createdAt: 10,
      }),
      evidence({
        id: "ev_invalidated",
        type: "file_written",
        subjectType: "file",
        subjectId: "src/App.css",
        payloadJson: JSON.stringify({ path: "src/App.css", action: "created" }),
        invalidatedAt: 30,
        createdAt: 20,
      }),
    ]);

    const result = getTaskToolEvidence({
      conductorRunId: "run_parent",
      planId: "plan_initial",
      taskIds: ["t3"],
    });

    expect(result).toEqual({ fileWrites: [], observedPaths: [], commands: [] });
  });

  it("uses valid fs_read and fs_list evidence as observed target paths", () => {
    mockListEvidenceForTask.mockReturnValue([
      evidence({
        id: "ev_dist",
        type: "file_read",
        subjectType: "path",
        subjectId: "dist",
        payloadJson: JSON.stringify({ path: "dist", operation: "list" }),
      }),
      evidence({
        id: "ev_index",
        type: "file_read",
        subjectType: "file",
        subjectId: "dist/index.html",
        payloadJson: JSON.stringify({ path: "dist/index.html" }),
      }),
    ]);

    const result = getTaskToolEvidence({
      conductorRunId: "run_parent",
      planId: "plan_initial",
      taskIds: ["t3"],
    });

    expect(result.observedPaths).toEqual(["dist", "dist/index.html"]);
  });
});

function evidence(overrides: Partial<EvidenceRecord>): EvidenceRecord {
  return {
    id: "ev_test",
    conversationId: "conv_test",
    conductorRunId: "run_parent",
    planId: "plan_initial",
    taskId: "t3",
    attemptId: "ta_test",
    childRunId: "run_child",
    contextSnapshotId: "ctx_test",
    agentId: "ag_frontend",
    type: "file_written",
    status: "valid",
    trustLevel: "verified",
    sourceKind: "tool_call",
    sourceId: "call_test",
    subjectType: "file",
    subjectId: "src/App.jsx",
    payloadJson: "{}",
    contentHash: null,
    invalidatedAt: null,
    createdAt: 1,
    ...overrides,
  };
}
