// ---------------------------------------------------------------------------
// P1: Evidence extractors — one per tool, producing typed evidence payloads
// ---------------------------------------------------------------------------

import type { ToolContext } from "@/server/tools/types";
import { sanitizeCommand, sanitizeOutput } from "@/server/evidence/evidence-sanitizer";
import { hashContent, hashCommandOutput } from "@/server/evidence/evidence-hash";

export interface ExtractedEvidence {
  type: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  contentHash: string | null;
}

export type EvidenceExtractor = (
  ctx: ToolContext,
  args: unknown,
  result: unknown,
  durationMs: number
) => ExtractedEvidence | ExtractedEvidence[] | null;

function getStr(v: unknown, key: string): string {
  if (v && typeof v === "object" && key in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)[key]);
  }
  return "";
}

// ── fs_read ────────────────────────────────────────────────────────────────

export const extractFileRead: EvidenceExtractor = (ctx, args) => {
  const path = getStr(args, "path") || getStr(args, "file_path");
  if (!path) return null;
  return {
    type: "file_read",
    subjectType: "file",
    subjectId: path,
    payload: { path, agentId: ctx.agentId },
    contentHash: null,
  };
};

// ── fs_write ───────────────────────────────────────────────────────────────

export const extractFileWrite: EvidenceExtractor = (ctx, args) => {
  const path = getStr(args, "path") || getStr(args, "file_path");
  const action = getStr(args, "action") || "modified";
  if (!path) return null;
  return {
    type: "file_written",
    subjectType: "file",
    subjectId: path,
    payload: { path, action, agentId: ctx.agentId },
    contentHash: null,
  };
};

// ── bash ──────────────────────────────────────────────────────────────────

export const extractCommand: EvidenceExtractor = (ctx, args, _result, durationMs) => {
  const command = getStr(args, "command");
  if (!command) return null;

  const normalizedCmd = sanitizeCommand(command);
  const resultObj = _result as { ok?: boolean; value?: { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean } } | undefined;
  const value = resultObj?.value;
  const exitCode = value?.exitCode ?? (resultObj?.ok ? 0 : 1);
  const timedOut = value?.timedOut ?? false;
  const stdout = value?.stdout ?? "";
  const stderr = value?.stderr ?? "";
  const { excerpt, truncated } = sanitizeOutput(stdout + (stderr ? "\n[stderr]\n" + stderr : ""));
  const outputHash = hashCommandOutput(stdout, stderr);
  const isTest = normalizedCmd.includes("test") || normalizedCmd.includes("pnpm test") || normalizedCmd.includes("npm test");

  return {
    type: isTest ? "test_executed" : "command_executed",
    subjectType: "command",
    subjectId: normalizedCmd.slice(0, 120),
    payload: {
      command: normalizedCmd.slice(0, 500),
      exitCode,
      timedOut,
      outputExcerpt: excerpt,
      outputTruncated: truncated,
      durationMs,
    },
    contentHash: outputHash,
  };
};

// ── read_artifact ─────────────────────────────────────────────────────────

export const extractArtifactRead: EvidenceExtractor = (ctx, args) => {
  const artifactId = getStr(args, "artifactId") || getStr(args, "id");
  if (!artifactId) return null;
  const version = getStr(args, "version") || "latest";
  return {
    type: "artifact_read",
    subjectType: "artifact",
    subjectId: artifactId,
    payload: { artifactId, version, agentId: ctx.agentId },
    contentHash: null,
  };
};

// ── write_artifact ────────────────────────────────────────────────────────

export const extractArtifactCreated: EvidenceExtractor = (ctx, args, result) => {
  const artifactType = getStr(args, "type");
  const outputKey = getStr(args, "outputKey");
  // Extract artifactId from the result if the tool returned one
  const resultObj = result as { ok?: boolean; value?: { artifactId?: string; id?: string } } | undefined;
  const artifactId = resultObj?.value?.artifactId ?? resultObj?.value?.id ?? "";
  return {
    type: "artifact_created",
    subjectType: "artifact",
    subjectId: outputKey || "unknown",
    payload: { artifactType, outputKey, artifactId, agentId: ctx.agentId },
    contentHash: null,
  };
};

// ── deploy_artifact / deploy_workspace ─────────────────────────────────────

export const extractDeployment: EvidenceExtractor = (ctx, args) => {
  const outputKey = getStr(args, "outputKey");
  return {
    type: "deployment_created",
    subjectType: "deployment",
    subjectId: outputKey || "unknown",
    payload: { outputKey, agentId: ctx.agentId },
    contentHash: null,
  };
};

// ── ask_user ──────────────────────────────────────────────────────────────

export const extractUserAnswer: EvidenceExtractor = (ctx, args) => {
  const question = getStr(args, "question");
  return {
    type: "user_answered",
    subjectType: "answer",
    subjectId: `ask_${Date.now()}`,
    payload: { question: question.slice(0, 200), agentId: ctx.agentId },
    contentHash: null,
  };
};

// ── report_task_result ────────────────────────────────────────────────────

export const extractTaskReport: EvidenceExtractor = (ctx, args) => {
  const status = getStr(args, "status");
  const summary = getStr(args, "summary").slice(0, 500);
  return {
    type: "task_reported",
    subjectType: "task",
    subjectId: ctx.taskExecution?.taskId ?? "unknown",
    payload: { status, summary, agentId: ctx.agentId },
    contentHash: hashContent(summary),
  };
};

// ── Tool → extractor map ──────────────────────────────────────────────────

export const EXTRACTOR_MAP: Record<string, EvidenceExtractor> = {
  fs_read: extractFileRead,
  fs_write: extractFileWrite,
  fs_patch: extractFileWrite,
  bash: extractCommand,
  read_artifact: extractArtifactRead,
  write_artifact: extractArtifactCreated,
  deploy_artifact: extractDeployment,
  deploy_workspace: extractDeployment,
  ask_user: extractUserAnswer,
  report_task_result: extractTaskReport,
};
