import { describe, expect, it } from "vitest";
import {
  applyTerminalEvidenceToToolCalls,
  isBlockingBrowserRequest,
  resolveDeploymentPreviewPath,
  selectLatestTerminalEvidence,
  selectLatestValidDeploymentEvidence,
  splitSelectorFallbacks,
  type RuntimeEvidenceRow,
} from "./runtime-validation-collector";
import type { BenchmarkToolCallValidation } from "@/server/context-metrics/benchmark-types";

describe("resolveDeploymentPreviewPath", () => {
  it("prefers the persisted artifact preview path", () => {
    expect(resolveDeploymentPreviewPath({
      artifactId: "art_1",
      artifactPreviewPath: "/deployments/dep_ws_1",
      evidencePayload: { previewPath: "/deployments/dep_art_1" }
    })).toBe("/deployments/dep_ws_1");
  });

  it("uses the deployment evidence path when artifact content has no path", () => {
    expect(resolveDeploymentPreviewPath({
      artifactId: "art_1",
      evidencePayload: { previewPath: "/deployments/dep_art_1" }
    })).toBe("/deployments/dep_art_1");
  });

  it("recovers deterministic deploy_artifact paths from legacy evidence", () => {
    expect(resolveDeploymentPreviewPath({
      artifactId: "art_legacy",
      evidenceSourceId: "deploy_artifact_123",
      evidencePayload: {}
    })).toBe("/deployments/dep_art_legacy");
  });

  it("does not invent a deploy_workspace path without persisted evidence", () => {
    expect(resolveDeploymentPreviewPath({
      artifactId: "art_workspace",
      evidenceSourceId: "deploy_workspace_123",
      evidencePayload: {}
    })).toBe("");
  });

  it("selects a later successful deployment after an earlier missing-path failure", () => {
    const failed = evidence({
      id: "ev_deploy_failed",
      source_id: "call_deploy_1",
      status: "invalid",
      payload_json: JSON.stringify({ artifactId: "art_1", deploymentStatus: "failed", previewPath: "" }),
      created_at: 10,
    });
    const recovered = evidence({
      id: "ev_deploy_recovered",
      source_id: "call_deploy_2",
      status: "valid",
      payload_json: JSON.stringify({
        artifactId: "art_1",
        deploymentStatus: "ready",
        previewPath: "/deployments/dep_ws_recovered",
      }),
      created_at: 20,
    });

    expect(selectLatestValidDeploymentEvidence([failed, recovered], "art_1")?.id)
      .toBe("ev_deploy_recovered");
  });

  it("does not reuse an earlier success after a later terminal failure for the same call", () => {
    const rows = [
      evidence({ id: "ev_build_1", type: "command_executed", source_id: "call_build", status: "valid", created_at: 10 }),
      evidence({ id: "ev_build_2", type: "command_executed", source_id: "call_build", status: "invalid", created_at: 20 }),
    ];

    expect(selectLatestTerminalEvidence(rows, new Set(["command_executed"]))[0]).toMatchObject({
      id: "ev_build_2",
      status: "invalid",
    });
  });
});

describe("splitSelectorFallbacks", () => {
  it("preserves commas inside selector functions and attributes", () => {
    expect(splitSelectorFallbacks(
      "button[type='submit'], button:has-text('保存,继续'), [data-label='a,b'], form button"
    )).toEqual([
      "button[type='submit']",
      "button:has-text('保存,继续')",
      "[data-label='a,b']",
      "form button",
    ]);
  });
});

describe("isBlockingBrowserRequest", () => {
  it("blocks same-origin deployment resource failures", () => {
    expect(isBlockingBrowserRequest(
      "http://127.0.0.1:3002/deployments/dep_1/assets/app.js",
      "http://127.0.0.1:3002/deployments/dep_1",
    )).toBe(true);
  });

  it("keeps third-party resource failures observable without failing the app", () => {
    expect(isBlockingBrowserRequest(
      "https://via.placeholder.com/400x200",
      "http://127.0.0.1:3002/deployments/dep_1",
    )).toBe(false);
  });
});

describe("applyTerminalEvidenceToToolCalls", () => {
  it("uses command exit codes as the canonical terminal status", () => {
    const calls: BenchmarkToolCallValidation[] = [
      toolCall({ callId: "call_failed", sequence: 0 }),
      toolCall({ callId: "call_passed", sequence: 1 }),
    ];
    const rows = [
      evidence({
        type: "command_executed",
        source_id: "call_failed",
        status: "valid",
        payload_json: JSON.stringify({ command: "npm run build", exitCode: 1 }),
      }),
      evidence({
        type: "command_executed",
        source_id: "call_passed",
        status: "valid",
        payload_json: JSON.stringify({ command: "npm run build", exitCode: 0 }),
      }),
    ];

    expect(applyTerminalEvidenceToToolCalls(calls, rows).map((call) => call.status))
      .toEqual(["failed", "succeeded"]);
  });

  it("marks structured tool rejection evidence as failed", () => {
    const calls = [toolCall({ callId: "call_rejected" })];
    const rows = [evidence({
      type: "tool_rejected",
      source_id: "call_rejected",
      status: "invalid",
      payload_json: JSON.stringify({ code: "WORKSPACE_PATH_ESCAPE" }),
    })];

    expect(applyTerminalEvidenceToToolCalls(calls, rows)[0]).toMatchObject({
      status: "failed",
      result: { code: "WORKSPACE_PATH_ESCAPE" },
    });
  });
});

function evidence(overrides: Partial<RuntimeEvidenceRow>): RuntimeEvidenceRow {
  return {
    id: "ev_default",
    task_id: "t1",
    attempt_id: "ta1",
    child_run_id: "run_child",
    type: "deployment_created",
    status: "valid",
    source_id: "call_1",
    subject_id: "web_app",
    payload_json: "{}",
    created_at: 1,
    ...overrides,
  };
}

function toolCall(overrides: Partial<BenchmarkToolCallValidation>): BenchmarkToolCallValidation {
  return {
    runId: "run_child",
    taskId: "t1",
    attemptId: "ta1",
    callId: "call_1",
    toolName: "bash",
    args: { command: "npm run build" },
    status: "pending",
    result: null,
    sequence: 0,
    ...overrides,
  };
}
