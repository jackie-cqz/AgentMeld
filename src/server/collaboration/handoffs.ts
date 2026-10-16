import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDatabase } from "@/db/bootstrap";
import { getDatabase } from "@/db/client";
import { describePrincipal, type AuthPrincipal } from "@/server/auth";
import { eventBus } from "@/server/event-bus";
import { createMessage, getAgent, getArtifact, getConversation, getMessage, getRun, getWorkspaceForConversation, listOutputBindings } from "@/server/repositories";
import { getContextSnapshot, getTaskAttempt, listEvidenceForAttempt } from "@/server/repositories/evidence-repository";
import { loadActiveFacts } from "@/server/context-facts/fact-service";
import { resolveToolPath } from "@/server/tools/workspace-access";
import { newMessageId, newRunId } from "@/shared/ids";
import type { TaskHandoff } from "@/shared/collaboration-types";
import type { ParsedTask } from "@/server/tools/conductor-tools";
import type { TaskContextEnvelope, VerifiedTaskInput } from "@/shared/task-context-types";

export interface HandoffPackage {
  version: 1;
  sourceConductorRunId: string;
  sourcePlanId: string;
  task: ParsedTask;
  sourceAttempt: number;
  sourceContextSnapshotId: string | null;
  failure: string | null;
  evidence: Array<{ id: string; type: string; status: string; contentHash: string | null }>;
  inputs: Array<{ key: string; artifactId: string; version: number }>;
  factsHash: string;
  files: Array<{ path: string; hash: string | null }>;
}

type Row = Record<string, unknown>;
function map(row: Row): TaskHandoff {
  return { id: row.id as string, conversationId: row.conversation_id as string, sourceAttemptId: row.source_attempt_id as string,
    sourceRunId: row.source_run_id as string, sourceAgentId: row.source_agent_id as string, targetAgentId: row.target_agent_id as string,
    taskId: row.task_id as string, title: row.title as string, status: row.status as TaskHandoff["status"], executionStatus: row.execution_status as TaskHandoff["executionStatus"],
    coordinatorRunId: row.coordinator_run_id as string | null, targetRunId: row.target_run_id as string | null, targetAttemptId: row.target_attempt_id as string | null,
    decidedBy: row.decided_by as string | null, error: row.error as string | null, expiresAt: row.expires_at as number,
    createdAt: row.created_at as number, updatedAt: row.updated_at as number };
}
export function getHandoff(id: string): TaskHandoff | null {
  const row = getDatabase().prepare("SELECT * FROM task_handoffs WHERE id=?").get(id) as Row | undefined;
  return row ? map(row) : null;
}
export function getHandoffPackage(id: string): HandoffPackage {
  const row = getDatabase().prepare("SELECT package_json FROM task_handoffs WHERE id=?").get(id) as { package_json: string } | undefined;
  if (!row) throw new Error("Handoff not found.");
  return JSON.parse(row.package_json) as HandoffPackage;
}
export function listHandoffs(conversationId: string): TaskHandoff[] {
  expireProposals();
  return (getDatabase().prepare("SELECT * FROM task_handoffs WHERE conversation_id=? ORDER BY created_at,id").all(conversationId) as Row[]).map(map);
}
export function acceptedHandoffForAttempt(attemptId: string): TaskHandoff | null {
  const row = getDatabase().prepare("SELECT * FROM task_handoffs WHERE source_attempt_id=? AND status='accepted' AND execution_status='stopping'").get(attemptId) as Row | undefined;
  return row ? map(row) : null;
}
function publish(id: string): TaskHandoff {
  const handoff = getHandoff(id)!;
  eventBus.publish({ type: "collaboration.handoff", conversationId: handoff.conversationId, timestamp: handoff.updatedAt, handoff });
  return handoff;
}
function expireProposals(): void {
  getDatabase().prepare("UPDATE task_handoffs SET status='expired',updated_at=MAX(updated_at+1,?) WHERE status='proposed' AND expires_at<=?").run(Date.now(), Date.now());
}
function actor(principal: AuthPrincipal): string {
  const value = describePrincipal(principal);
  if (!value) throw new Error("Authenticated human authority is required for a task handoff.");
  return value;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function latestAttemptId(conductorRunId: string, taskId: string): string | undefined {
  // Attempt numbering restarts across plan revisions. A retry from an older
  // plan must not win just because its numeric attempt is larger.
  return (getDatabase().prepare(`SELECT attempt.id FROM task_attempts attempt
    JOIN conductor_plans plan ON plan.id=attempt.plan_id
    WHERE attempt.conductor_run_id=? AND attempt.task_id=?
    ORDER BY plan.created_at DESC,plan.rowid DESC,attempt.attempt DESC,attempt.rowid DESC LIMIT 1`)
    .get(conductorRunId, taskId) as { id: string } | undefined)?.id;
}
function factsHash(conversationId: string): string {
  return hash(JSON.stringify(loadActiveFacts(conversationId).map(fact => ({ id: fact.id, key: fact.canonicalKey, value: fact.value, updatedAt: fact.updatedAt })).sort((a, b) => a.id.localeCompare(b.id))));
}
function fileHashes(conversationId: string, paths: string[]): HandoffPackage["files"] {
  if (paths.length > 20) throw new Error("Handoff file scope exceeds its bounded package budget.");
  const workspace = getWorkspaceForConversation(conversationId);
  if (!workspace) throw new Error("Workspace is unavailable.");
  const root = workspace.mode === "local" && workspace.boundPath ? workspace.boundPath : workspace.rootPath;
  const files = new Map<string, string | null>();
  let bytes = 0, visited = 0;
  const visit = (relative: string) => {
    if (++visited > 1000 || files.size > 100) throw new Error("Handoff file manifest exceeds its bounded scope.");
    if (/[?*]/.test(relative)) throw new Error("Handoff requires explicit file or directory paths, not wildcard scopes.");
    try {
      const resolved = resolveToolPath(root, relative);
      if (resolved.split(/[\\/]/).some(part => /^\.env(?!\.example$)|\.(?:pem|key)$|^\.(?:ssh|aws|npmrc|netrc|pypirc|git-credentials|git)$/i.test(part))) {
        throw new Error("Private files are not included in a handoff manifest.");
      }
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || /^(?:node_modules|\.git|\.next|dist|build|coverage|\.ssh|\.aws|\.env.*|\.npmrc|\.netrc|\.pypirc|\.git-credentials)$|\.(?:pem|key)$/i.test(entry.name)) continue;
          visit(path.posix.join(relative.replaceAll("\\", "/"), entry.name));
        }
        return;
      }
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("Handoff file is not a bounded regular file.");
      bytes += stat.size;
      if (bytes > 10 * 1024 * 1024) throw new Error("Handoff files exceed their snapshot budget.");
      files.set(relative.replaceAll("\\", "/"), createHash("sha256").update(fs.readFileSync(resolved)).digest("hex"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { files.set(relative.replaceAll("\\", "/"), null); return; }
      throw error;
    }
  };
  paths.forEach(visit);
  return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, hash]) => ({ path, hash }));
}
function assertTarget(handoff: Pick<TaskHandoff, "conversationId" | "sourceAgentId" | "targetAgentId">): void {
  const conversation = getConversation(handoff.conversationId);
  const target = getAgent(handoff.targetAgentId);
  if (!conversation?.agentIds.includes(handoff.targetAgentId) || !conversation.agentIds.includes(handoff.sourceAgentId) || !target || target.adapterName !== "pi" || target.isConductor || target.id === handoff.sourceAgentId) {
    throw new Error("Choose a different current Pi team member to take over this task.");
  }
}
export async function proposeHandoff(sourceAttemptId: string, targetAgentId: string, principal: AuthPrincipal): Promise<TaskHandoff> {
  ensureDatabase(); actor(principal); expireProposals();
  const source = getTaskAttempt(sourceAttemptId);
  if (!source?.childRunId) throw new Error("Only an existing delegated task attempt can be handed off.");
  const shape = { conversationId: source.conversationId, sourceAgentId: source.agentId, targetAgentId };
  assertTarget(shape);
  let predecessor = source.id;
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(predecessor) || visited.size >= 4) throw new Error("Task handoff chain reached its bounded hop limit.");
    visited.add(predecessor);
    const previous = getDatabase().prepare("SELECT source_attempt_id FROM task_handoffs WHERE target_attempt_id=? AND status='accepted'").get(predecessor) as { source_attempt_id: string } | undefined;
    if (!previous) break;
    predecessor = previous.source_attempt_id;
  }
  const existing = getDatabase().prepare("SELECT * FROM task_handoffs WHERE source_attempt_id=? AND (status='proposed' OR (status='accepted' AND execution_status IN ('stopping','running')))").get(source.id) as Row | undefined;
  if (existing) {
    if (existing.target_agent_id !== targetAgentId) throw new Error("This attempt already has a different handoff decision.");
    return map(existing);
  }
  if (getDatabase().prepare("SELECT id FROM task_handoffs WHERE source_attempt_id=? AND status='accepted' AND (target_attempt_id IS NOT NULL OR execution_status='complete') LIMIT 1").get(source.id)) {
    throw new Error("This source attempt has been superseded by a handoff; select the latest receiving attempt instead.");
  }
  if (latestAttemptId(source.conductorRunId, source.taskId) !== source.id || source.verificationStatus === "verified") throw new Error("Only the latest unfinished or failed attempt can be handed off.");
  const plan = getDatabase().prepare("SELECT plan_json FROM conductor_plans WHERE id=? AND conductor_run_id=? AND conversation_id=?").get(source.planId, source.conductorRunId, source.conversationId) as { plan_json: string } | undefined;
  const tasks = plan ? JSON.parse(plan.plan_json) as ParsedTask[] : [];
  const originalTask = tasks.find(task => task.id === source.taskId);
  const snapshot = source.contextSnapshotId ? getContextSnapshot(source.contextSnapshotId) : undefined;
  if (!originalTask || !snapshot || snapshot.attemptId !== source.id || snapshot.conversationId !== source.conversationId) throw new Error("The approved task contract snapshot is unavailable.");
  const envelope = JSON.parse(snapshot.envelopeJson) as TaskContextEnvelope;
  // The executed immutable snapshot is authoritative, not the pre-approval plan
  // draft (which can differ after a human edits the approval card).
  const task: ParsedTask = { ...originalTask, id: source.taskId, agentId: source.agentId, title: envelope.task.title, prompt: envelope.task.objective,
    dependsOn: [...envelope.task.dependsOn],
    inputs: (envelope.upstreamInputs as VerifiedTaskInput[]).map(input => ({ fromTaskId: input.fromTaskId, outputId: input.outputKey, required: true })),
    expectedOutputs: envelope.requirements.expectedOutputs.map(output => ({ id: output.outputKey, type: output.type as ParsedTask["expectedOutputs"][number]["type"], required: output.required })),
    acceptanceCriteria: [...envelope.requirements.acceptanceCriteria], targetPaths: [...envelope.requirements.targetPaths],
    requiredCommands: envelope.requirements.requiredCommands.map(command => ({ ...command })), requiredEvidence: [...envelope.requirements.requiredEvidence],
    maxAttempts: Math.max(1, Math.min(3, originalTask.maxAttempts ?? 1)) };
  const sourceRun = getRun(source.childRunId), parent = getRun(source.conductorRunId);
  if (!sourceRun || !parent || sourceRun.conversationId !== source.conversationId || sourceRun.parentRunId !== parent.id) throw new Error("Invalid task lineage.");
  const { isRunActive } = await import("@/server/agent-runner");
  if (isRunActive(parent.id) && (!isRunActive(sourceRun.id) || source.executionStatus !== "running")) throw new Error("Wait for the current plan to settle before taking over a finished attempt.");
  const inputs = listOutputBindings(source.planId).filter(row => task.dependsOn.includes(row.producer_task_id as string) || task.inputs.some(input => input.fromTaskId === row.producer_task_id && input.outputId === row.output_key)).map(row => {
    const artifact = getArtifact(row.artifact_id as string);
    if (!artifact || artifact.conversationId !== source.conversationId) throw new Error("An upstream artifact is unavailable.");
    return { key: `${row.producer_task_id}.${row.output_key}`, artifactId: artifact.id, version: artifact.version };
  });
  const packet: HandoffPackage = { version: 1, sourceConductorRunId: source.conductorRunId, sourcePlanId: source.planId,
    task, sourceAttempt: source.attempt, sourceContextSnapshotId: source.contextSnapshotId ?? null, failure: source.failureContextJson ?? sourceRun.error ?? null,
    evidence: listEvidenceForAttempt(source.id).slice(-200).map(record => ({ id: record.id, type: record.type, status: record.status, contentHash: record.contentHash ?? null })),
    inputs, factsHash: factsHash(source.conversationId), files: fileHashes(source.conversationId, task.targetPaths ?? []) };
  const json = JSON.stringify(packet);
  if (json.length > 100_000) throw new Error("Handoff package exceeds its context budget.");
  const id = `handoff_${randomUUID()}`, now = Date.now();
  getDatabase().prepare(`INSERT INTO task_handoffs (id,conversation_id,source_attempt_id,source_run_id,source_agent_id,target_agent_id,task_id,title,status,execution_status,package_json,expires_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,'proposed','not_started',?,?,?,?)`).run(id, source.conversationId, source.id, sourceRun.id, source.agentId, targetAgentId, source.taskId, task.title, json, now + 10 * 60_000, now, now);
  return publish(id);
}

/** Re-check references rather than treating a stored package as evergreen authority. */
export function validateHandoffPackage(id: string): HandoffPackage {
  const handoff = getHandoff(id);
  if (!handoff) throw new Error("Handoff not found.");
  assertTarget(handoff);
  const packet = getHandoffPackage(id);
  if (packet.factsHash !== factsHash(handoff.conversationId)) throw new Error("Active facts changed; create a fresh handoff proposal.");
  if (JSON.stringify(packet.files) !== JSON.stringify(fileHashes(handoff.conversationId, packet.task.targetPaths ?? []))) throw new Error("Workspace files changed; create a fresh handoff proposal.");
  for (const input of packet.inputs) {
    const artifact = getArtifact(input.artifactId);
    const binding = listOutputBindings(packet.sourcePlanId).find(row => `${row.producer_task_id}.${row.output_key}` === input.key);
    if (!artifact || artifact.conversationId !== handoff.conversationId || artifact.version !== input.version || binding?.artifact_id !== artifact.id) throw new Error("Upstream inputs changed; create a fresh handoff proposal.");
  }
  if (latestAttemptId(packet.sourceConductorRunId, handoff.taskId) !== handoff.sourceAttemptId) throw new Error("A newer task attempt already exists.");
  return packet;
}

export async function decideHandoff(id: string, decision: "accept" | "decline" | "cancel", principal: AuthPrincipal): Promise<TaskHandoff> {
  ensureDatabase(); const by = actor(principal); expireProposals();
  const handoff = getHandoff(id);
  if (!handoff) throw new Error("Handoff not found.");
  const status = decision === "accept" ? "accepted" : decision === "decline" ? "declined" : "cancelled";
  if (handoff.status === status) return handoff;
  if (handoff.status !== "proposed") throw new Error("This handoff decision is already settled.");
  if (decision !== "accept") {
    getDatabase().prepare("UPDATE task_handoffs SET status=?,decided_by=?,updated_at=MAX(updated_at+1,?) WHERE id=? AND status='proposed'").run(status, by, Date.now(), id);
    return publish(id);
  }
  const packet = validateHandoffPackage(id);
  const { abortRun, isRunActive, startAgentRun } = await import("@/server/agent-runner");
  validateHandoffPackage(id);
  const parent = getRun(packet.sourceConductorRunId)!;
  const live = isRunActive(parent.id);
  if (live && !isRunActive(handoff.sourceRunId)) throw new Error("The source task has already settled; wait for the plan to finish.");
  const coordinator = getAgent(parent.agentId);
  if (!live && (!coordinator || !getConversation(handoff.conversationId)?.agentIds.includes(coordinator.id) || coordinator.id === handoff.targetAgentId)) throw new Error("The original coordinator is no longer available.");
  const coordinatorRunId = live ? parent.id : newRunId();
  const changed = getDatabase().prepare("UPDATE task_handoffs SET status='accepted',execution_status='stopping',coordinator_run_id=?,decided_by=?,updated_at=MAX(updated_at+1,?) WHERE id=? AND status='proposed'").run(coordinatorRunId, by, Date.now(), id) as { changes: number };
  if (!changed.changes) return getHandoff(id)!;
  publish(id);
  if (live) { abortRun(handoff.sourceRunId); return getHandoff(id)!; }
  const original = parent.triggerMessageId ? getMessage(parent.triggerMessageId) : null;
  const message = createMessage({ id: newMessageId(), conversationId: handoff.conversationId, origin: "human", role: "user", agentId: null, runId: null,
    parentMessageId: original?.id ?? null, parts: [{ type: "text", content: "确认交接卡片中的任务，交由指定 Agent 接手。保留原任务范围与验收标准，不新增其他目标。" }], status: "complete", now: Date.now() });
  eventBus.publish({ type: "message.added", conversationId: handoff.conversationId, timestamp: Date.now(), message });
  const handle = startAgentRun({ runId: coordinatorRunId, conversationId: handoff.conversationId, agentId: coordinator!.id, triggerMessage: message, acceptedHandoffId: id });
  void handle.promise.then(() => {
    const current = getHandoff(id);
    if (current && ["stopping", "running"].includes(current.executionStatus)) finishHandoff(id, false, "Handoff coordinator ended before verified completion.");
  });
  return getHandoff(id)!;
}

export function claimHandoff(id: string, coordinatorRunId: string): boolean {
  return !!(getDatabase().prepare("UPDATE task_handoffs SET execution_status='running',updated_at=MAX(updated_at+1,?) WHERE id=? AND status='accepted' AND execution_status='stopping' AND coordinator_run_id=?").run(Date.now(), id, coordinatorRunId) as { changes: number }).changes;
}
export function bindHandoffAttempt(id: string, attemptId: string, runId: string): void {
  getDatabase().prepare("UPDATE task_handoffs SET target_attempt_id=?,target_run_id=?,updated_at=MAX(updated_at+1,?) WHERE id=? AND execution_status='running'").run(attemptId, runId, Date.now(), id);
  publish(id);
}
export function finishHandoff(id: string, complete: boolean, error?: string): void {
  getDatabase().prepare("UPDATE task_handoffs SET execution_status=?,error=?,updated_at=MAX(updated_at+1,?) WHERE id=? AND execution_status IN ('stopping','running')").run(complete ? "complete" : "failed", error ?? null, Date.now(), id);
  publish(id);
}
