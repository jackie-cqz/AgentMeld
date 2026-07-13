import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";
import { clearAllFileWritesForTests } from "@/server/dispatch-file-writes";
import { clearPendingPlansForTests } from "@/server/dispatch-plan-manager";
import { clearAllTaskResultsForTests } from "@/server/dispatch-task-results";
import { clearAllToolEvidenceForTests } from "@/server/dispatch-tool-evidence";
import { eventBus } from "@/server/event-bus";
import { clearPendingBashForTests } from "@/server/pending-bash";
import { clearPendingQuestionsForTests } from "@/server/pending-questions";
import { clearPendingWritesForTests } from "@/server/pending-writes";
import { DATA_DIR_ENV } from "@/shared/constants";

export interface BenchmarkEnvironment {
  id: string;
  caseId: string;
  trialIndex: number;
  rootDir: string;
  dataDir: string;
  reportDir: string;
  createdAt: number;
}

export interface CreateBenchmarkEnvironmentOptions {
  baseDir?: string;
  trialIndex?: number;
}

export class BenchmarkEnvironmentManager {
  private activeEnvironment: BenchmarkEnvironment | null = null;
  private previousDataDir: string | undefined;

  create(caseId: string, options: CreateBenchmarkEnvironmentOptions = {}): BenchmarkEnvironment {
    const baseDir = path.resolve(
      options.baseDir ?? process.env.AGENTMELD_BENCH_OUTPUT_DIR ?? path.join(process.cwd(), ".agentmeld-benchmark-data"),
    );
    const trialIndex = options.trialIndex ?? 1;
    const safeCaseId = sanitizeSegment(caseId);
    const id = `${safeCaseId}-trial-${trialIndex}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const rootDir = path.join(baseDir, "runs", id);
    const environment: BenchmarkEnvironment = {
      id,
      caseId,
      trialIndex,
      rootDir,
      dataDir: path.join(rootDir, "data"),
      reportDir: path.join(rootDir, "reports"),
      createdAt: Date.now(),
    };

    fs.mkdirSync(environment.dataDir, { recursive: true });
    fs.mkdirSync(environment.reportDir, { recursive: true });
    return environment;
  }

  activate(environment: BenchmarkEnvironment): void {
    if (this.activeEnvironment) {
      throw new Error(`Benchmark environment ${this.activeEnvironment.id} is already active.`);
    }

    resetBenchmarkRuntimeState();
    this.previousDataDir = process.env[DATA_DIR_ENV];
    process.env[DATA_DIR_ENV] = environment.dataDir;
    ensureDatabase();
    this.activeEnvironment = environment;
  }

  deactivate(): void {
    if (!this.activeEnvironment) return;

    resetBenchmarkRuntimeState();
    if (this.previousDataDir === undefined) {
      delete process.env[DATA_DIR_ENV];
    } else {
      process.env[DATA_DIR_ENV] = this.previousDataDir;
    }
    this.previousDataDir = undefined;
    this.activeEnvironment = null;
  }

  current(): BenchmarkEnvironment | null {
    return this.activeEnvironment;
  }
}

export function resetBenchmarkRuntimeState(): void {
  clearPendingQuestionsForTests();
  clearPendingPlansForTests();
  clearPendingWritesForTests();
  clearPendingBashForTests();
  clearAllTaskResultsForTests();
  clearAllFileWritesForTests();
  clearAllToolEvidenceForTests();
  eventBus.clearForTests();
  resetDatabaseForTests();
  resetBootstrapForTests();
}

function sanitizeSegment(value: string): string {
  const safe = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "case";
}
