import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { ensureDatabase, resetBootstrapForTests } from "@/db/bootstrap";
import { resetDatabaseForTests } from "@/db/client";
import { createPairingCode, redeemPairingCode } from "@/server/auth";
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

/** Credentials for the owner the sandbox was paired with. */
export interface BenchmarkOwnerSession {
  /** `name=value`, suitable for a Cookie request header. */
  cookieHeader: string;
  name: string;
  value: string;
}

/**
 * Pair the fresh sandbox with an owner through the SAME path a first-run
 * install uses: mint a bootstrap pairing code, then redeem it into a session
 * row. This is required because `/deployments/*` sits behind `gateRequest`,
 * which answers 503 until an owner session exists. The benchmark's preview
 * probe and its Playwright checks reach that route as the owner would; there
 * is no test-only auth bypass here.
 */
export function pairBenchmarkOwner(): BenchmarkOwnerSession {
  const { code } = createPairingCode();
  const result = redeemPairingCode(code);
  if (!result.ok || !result.setCookie) {
    throw new Error(result.error ?? "Benchmark owner session could not be created.");
  }
  const cookie = result.setCookie.split(";")[0].trim();
  const separator = cookie.indexOf("=");
  if (separator <= 0) throw new Error("Benchmark owner session cookie was malformed.");
  return { cookieHeader: cookie, name: cookie.slice(0, separator), value: cookie.slice(separator + 1) };
}

export class BenchmarkEnvironmentManager {
  private activeEnvironment: BenchmarkEnvironment | null = null;
  private previousDataDir: string | undefined;
  private benchmarkOwnerSession: BenchmarkOwnerSession | null = null;

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
    // A fresh sandbox has zero owner_sessions rows, so every gated route would
    // answer 503. Pair it here, at bootstrap, exactly as the app does.
    this.benchmarkOwnerSession = pairBenchmarkOwner();
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
    this.benchmarkOwnerSession = null;
  }

  current(): BenchmarkEnvironment | null {
    return this.activeEnvironment;
  }

  /** The paired owner the active sandbox was provisioned with, if any. */
  ownerSession(): BenchmarkOwnerSession | null {
    return this.benchmarkOwnerSession;
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
