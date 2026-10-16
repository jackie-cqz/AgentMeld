import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { PiInvocationInput } from "@/server/pi/types";

const fixture = vi.hoisted(() => ({ inputs: [] as PiInvocationInput[], report: true, plan: null as ParsedTask[] | null, holdSource: false, stopped: [] as string[] }));
vi.mock("@/server/pi/runtime", () => ({ runPiInvocation: async function* (input: PiInvocationInput, signal: AbortSignal) {
  fixture.inputs.push(input);
  if (fixture.plan && input.agent.isConductor && input.toolNames.includes("plan_tasks")) {
    const base = { conversationId: input.conversationId, timestamp: Date.now(), messageId: "", callId: `plan_${input.runId}` };
    yield { ...base, type: "tool.call" as const, toolName: "plan_tasks", args: { reasoning: "Fixture plan", tasks: fixture.plan } };
    yield { ...base, type: "tool.result" as const, result: { reasoning: "Fixture plan", tasks: fixture.plan } };
    return;
  }
  if (fixture.holdSource && input.agent.id === "ag_mock_builder") {
    try { await new Promise<void>((_resolve, reject) => {
      const stop = () => reject(signal.reason);
      if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
    }); } finally { fixture.stopped.push(input.runId); }
  }
  if (fixture.report && input.taskExecution) {
    const { recordTaskReport } = await import("@/server/dispatch-task-results");
    recordTaskReport(input.runId, { taskId: input.taskExecution.taskId, runId: input.runId, status: "complete", summary: "Verified scoped fixture task", acceptanceResults: [], blockers: [], artifacts: {} });
  }
  input.onTaskAccepted?.();
  yield { type: "part.start" as const, conversationId: input.conversationId, timestamp: Date.now(), messageId: "", partIndex: 0, part: { type: "text" as const, content: "Scoped handoff fixture" } };
} }));

import { createConversation, getBootstrapPayload } from "@/server/conversation-service";
import { updateAgent } from "@/server/agent-service";
import { createMessage, createRun, getRun, getWorkspaceForConversation, persistConductorPlan } from "@/server/repositories";
import { createTaskAttempt, getContextSnapshot, getTaskAttempt, insertContextSnapshot, listTaskAttempts } from "@/server/repositories/evidence-repository";
import { buildMinimalContextEnvelope } from "@/server/conductor-service";
import { abortRun, isRunActive, startAgentRun } from "@/server/agent-runner";
import { eventBus } from "@/server/event-bus";
import { approvePlan } from "@/server/dispatch-plan-manager";
import { decideHandoff, getHandoff, getHandoffPackage, listHandoffs, proposeHandoff, validateHandoffPackage } from "./handoffs";
import { getDatabase } from "@/db/client";
import type { ParsedTask } from "@/server/tools/conductor-tools";
import type { AuthPrincipal } from "@/server/auth";
import { recoverOrphanedRuns } from "@/server/run-recovery";
import { persistedDispatches } from "./dispatch-projection";

const owner: AuthPrincipal = { kind: "owner-session", sessionId: "fixture-owner", createdAt: 1 };
beforeEach(() => { fixture.inputs.length = 0; fixture.stopped.length = 0; fixture.report = true; fixture.plan = null; fixture.holdSource = false; });
afterEach(async () => {
  const all = getDatabase().prepare("SELECT id FROM agent_runs").all() as Array<{ id: string }>;
  all.forEach(row => abortRun(row.id));
  await vi.waitFor(() => expect(all.some(row => isRunActive(row.id))).toBe(false));
});

function world(overrides: Partial<ParsedTask> = {}) {
  for (const id of ["ag_mock_conductor", "ag_mock_builder", "ag_designer"]) updateAgent(id, { adapterName: "pi", modelProvider: "openai-compatible", modelId: "fixture-model", apiKey: "fixture-not-secret", apiBaseUrl: "http://127.0.0.1:1", toolNames: ["report_task_result", "read_artifact"] });
  const conversation = createConversation({ mode: "group", agentIds: ["ag_mock_conductor", "ag_mock_builder", "ag_designer"] });
  const suffix = conversation.id;
  const trigger = createMessage({ id: `msg_${suffix}`, conversationId: conversation.id, role: "user", origin: "human", agentId: null, runId: null, parts: [{ type: "text", content: "Inspect the bounded task" }], status: "complete", now: Date.now() });
  const parent = createRun({ id: `parent_${suffix}`, conversationId: conversation.id, agentId: "ag_mock_conductor", triggerMessageId: trigger.id, parentRunId: null, status: "failed", now: Date.now() });
  const source = createRun({ id: `source_${suffix}`, conversationId: conversation.id, agentId: "ag_mock_builder", triggerMessageId: trigger.id, parentRunId: parent.id, status: "failed", now: Date.now() });
  const task: ParsedTask = { id: "t1", agentId: source.agentId, title: "A bounded task", prompt: "Inspect this exact task and report the result", dependsOn: [], inputs: [], expectedOutputs: [], acceptanceCriteria: [], maxAttempts: 1, taskIntent: "diagnosis", contractProfile: "minimal", ...overrides };
  const planId = `plan_${suffix}`;
  persistConductorPlan({ id: planId, conductorRunId: parent.id, conversationId: conversation.id, planJson: JSON.stringify([task]), status: "active", now: Date.now() });
  const attemptId = `attempt_${suffix}`;
  createTaskAttempt({ id: attemptId, conversationId: conversation.id, conductorRunId: parent.id, planId, planRevision: 0, taskId: task.id,
    agentId: source.agentId, childRunId: source.id, attempt: 1, contextSnapshotId: `old_ctx_${suffix}`, executionStatus: "failed", verificationStatus: "rejected",
    failureContextJson: JSON.stringify({ error: "Previous validation failed" }), createdAt: Date.now(), updatedAt: Date.now() });
  const envelope = buildMinimalContextEnvelope({ conductorRunId: parent.id, planId, planRevision: 0, taskId: task.id, attemptId, attempt: 1, contextSnapshotId: `old_ctx_${suffix}` }, task, [], []);
  insertContextSnapshot({ id: envelope.identity.contextSnapshotId, conversationId: conversation.id, conductorRunId: parent.id, planId, taskId: task.id, attemptId,
    policyVersion: envelope.policyVersion, schemaVersion: 1, envelopeJson: JSON.stringify(envelope), manifestJson: JSON.stringify(envelope.manifest), tokenEstimate: 1, requiredTokenEstimate: 1, omittedTokenEstimate: 0, createdAt: Date.now() });
  return { conversation, parent, source, task, planId, attemptId };
}

describe("formal Pi task handoff", () => {
  it("keeps durable handoff versions increasing even when the wall clock moves backwards", async () => {
    const state = world();
    const proposal = await proposeHandoff(state.attemptId, "ag_designer", owner);
    const clock = vi.spyOn(Date, "now").mockReturnValue(proposal.updatedAt - 1000);
    try {
      const declined = await decideHandoff(proposal.id, "decline", owner);
      expect(declined.updatedAt).toBeGreaterThan(proposal.updatedAt);
      expect((await decideHandoff(proposal.id, "decline", owner)).updatedAt).toBe(declined.updatedAt);
    } finally { clock.mockRestore(); }
  });
  it("selects the latest plan revision rather than a larger retry number from an obsolete plan", async () => {
    const state = world();
    getDatabase().prepare("UPDATE task_attempts SET attempt=5 WHERE id=?").run(state.attemptId);
    const now = Date.now() + 1000, planId = `later_${state.planId}`, attemptId = `later_${state.attemptId}`, contextSnapshotId = `later_ctx_${state.attemptId}`;
    const child = createRun({ id: `later_${state.source.id}`, conversationId: state.conversation.id, agentId: "ag_designer", parentRunId: state.parent.id, triggerMessageId: state.source.triggerMessageId, status: "failed", now });
    const task = { ...state.task, agentId: child.agentId, prompt: "Updated approved task scope" };
    persistConductorPlan({ id: planId, conductorRunId: state.parent.id, conversationId: state.conversation.id, revision: 1, planJson: JSON.stringify([task]), status: "active", now });
    createTaskAttempt({ id: attemptId, conductorRunId: state.parent.id, conversationId: state.conversation.id, planId, planRevision: 1, taskId: task.id,
      agentId: child.agentId, childRunId: child.id, attempt: 1, contextSnapshotId, executionStatus: "failed", verificationStatus: "rejected", createdAt: now, updatedAt: now });
    const envelope = buildMinimalContextEnvelope({ conductorRunId: state.parent.id, planId, planRevision: 1, taskId: task.id, attemptId, attempt: 1, contextSnapshotId }, task, [], []);
    insertContextSnapshot({ id: contextSnapshotId, conversationId: state.conversation.id, conductorRunId: state.parent.id, planId, taskId: task.id, attemptId,
      policyVersion: envelope.policyVersion, schemaVersion: 1, envelopeJson: JSON.stringify(envelope), manifestJson: "[]", tokenEstimate: 1, requiredTokenEstimate: 1, omittedTokenEstimate: 0, createdAt: now });
    await expect(proposeHandoff(state.attemptId, "ag_designer", owner)).rejects.toThrow("latest unfinished");
    const proposal = await proposeHandoff(attemptId, "ag_mock_builder", owner);
    expect(getHandoffPackage(proposal.id).task.prompt).toBe("Updated approved task scope");
    expect(persistedDispatches(state.conversation.id)[state.parent.id]).toMatchObject({ activeAttemptByTask: { t1: attemptId }, attempts: { t1: 1 }, plan: [expect.objectContaining({ agentId: "ag_designer" })] });
  });
  it("hands an in-flight DAG task to a new Agent only after its original owner promise exits", async () => {
    const state = world();
    fixture.holdSource = true; fixture.plan = [state.task];
    updateAgent("ag_mock_conductor", { toolNames: ["plan_tasks", "read_artifact"] });
    const trigger = createMessage({ id: `live_${state.conversation.id}`, conversationId: state.conversation.id, origin: "human", role: "user", agentId: null, runId: null,
      parts: [{ type: "text", content: "Perform the scoped diagnosis" }], status: "complete", now: Date.now() });
    const unsubscribe = eventBus.subscribe(({ event }) => {
      if (event.type === "dispatch.plan.pending") approvePlan(event.pendingPlan.id, undefined, "owner-session:fixture-owner");
    });
    try {
      const handle = startAgentRun({ conversationId: state.conversation.id, agentId: "ag_mock_conductor", triggerMessage: trigger });
      await vi.waitFor(() => expect(listTaskAttempts(handle.runId, "t1")[0]?.executionStatus).toBe("running"), { timeout: 5000 });
      const source = listTaskAttempts(handle.runId, "t1")[0];
      const proposed = await proposeHandoff(source.id, "ag_designer", owner);
      await decideHandoff(proposed.id, "accept", owner);
      await vi.waitFor(() => expect(isRunActive(handle.runId)).toBe(false), { timeout: 5000 });
      expect(getHandoff(proposed.id)?.executionStatus).toBe("complete");
      expect(fixture.stopped).toContain(source.childRunId);
      const replacement = fixture.inputs.find(input => input.agent.id === "ag_designer")!;
      expect(replacement.taskExecution?.conductorRunId).toBe(handle.runId);
      expect(replacement.taskExecution?.taskId).toBe(source.taskId);
      expect(replacement.taskExecution?.attempt).toBe(2);
      const attempts = listTaskAttempts(handle.runId, "t1");
      expect(attempts).toHaveLength(2);
      expect(attempts[0].verificationStatus).toBe("rejected");
      expect(attempts[1].verificationStatus).toBe("verified");
      expect(getRun(handle.runId)?.status).toBe("complete");
    } finally { unsubscribe(); }
  });
  it("rejects anonymous decisions, cross-team targets and obsolete source attempts", async () => {
    const state = world();
    await expect(proposeHandoff(state.attemptId, "ag_designer", { kind: "anonymous" })).rejects.toThrow("Authenticated");
    await expect(proposeHandoff(state.attemptId, "ag_reviewer", owner)).rejects.toThrow("team member");
    getDatabase().prepare("UPDATE task_attempts SET verification_status='verified' WHERE id=?").run(state.attemptId);
    await expect(proposeHandoff(state.attemptId, "ag_designer", owner)).rejects.toThrow("latest unfinished");
    expect(listHandoffs(state.conversation.id)).toEqual([]);
  });

  it("keeps task identity and contract, creates a fresh attempt/context, and accepts only once", async () => {
    const state = world();
    const proposed = await proposeHandoff(state.attemptId, "ag_designer", owner);
    expect((await proposeHandoff(state.attemptId, "ag_designer", owner)).id).toBe(proposed.id);
    const packageBefore = getHandoffPackage(proposed.id);
    const accepted = await decideHandoff(proposed.id, "accept", owner);
    const replay = await decideHandoff(proposed.id, "accept", owner);
    expect(replay.coordinatorRunId).toBe(accepted.coordinatorRunId);
    await vi.waitFor(() => expect(getHandoff(proposed.id)?.executionStatus).toBe("complete"), { timeout: 5000 });
    expect(fixture.inputs).toHaveLength(1);
    await expect(proposeHandoff(state.attemptId, "ag_designer", owner)).rejects.toThrow("superseded");
    expect(fixture.inputs).toHaveLength(1);
    const invocation = fixture.inputs[0];
    expect(invocation.agent.id).toBe("ag_designer");
    expect(invocation.taskExecution?.taskId).toBe(state.task.id);
    expect(invocation.taskExecution?.attempt).toBe(2);
    expect(invocation.taskExecution?.attemptId).not.toBe(state.attemptId);
    expect(invocation.taskContract?.acceptanceCriteria).toEqual(state.task.acceptanceCriteria);
    expect(getHandoffPackage(proposed.id)).toEqual(packageBefore);
    const attempt = listTaskAttempts(accepted.coordinatorRunId!, state.task.id)[0];
    expect(attempt.verificationStatus).toBe("verified");
    const envelope = JSON.parse(getContextSnapshot(attempt.contextSnapshotId!)!.envelopeJson);
    expect(envelope.task.assignedAgentId).toBe("ag_designer");
    expect(envelope.failureContext.previousAttemptId).toBe(state.attemptId);
    expect(getTaskAttempt(state.attemptId)?.agentId).toBe("ag_mock_builder");
    expect(getRun(state.parent.id)?.status).toBe("failed");
    const restored = getBootstrapPayload();
    expect(restored.handoffsByConversation[state.conversation.id]).toEqual(expect.arrayContaining([expect.objectContaining({ id: proposed.id, executionStatus: "complete" })]));
    expect(restored.dispatchesByRunId[accepted.coordinatorRunId!]).toMatchObject({
      activeAttemptByTask: { t1: attempt.id }, taskStatus: { t1: "complete" },
      childRunIds: { t1: invocation.runId }, plan: [expect.objectContaining({ id: "t1", agentId: "ag_designer" })],
    });
    expect(fixture.inputs).toHaveLength(1);
  });

  it("does not turn a target's oral success into a verified completion", async () => {
    fixture.report = false;
    const state = world();
    const handoff = await proposeHandoff(state.attemptId, "ag_designer", owner);
    await decideHandoff(handoff.id, "accept", owner);
    await vi.waitFor(() => expect(getHandoff(handoff.id)?.executionStatus).toBe("failed"), { timeout: 5000 });
    expect(getHandoff(handoff.id)?.error).toContain("report_task_result");
  });

  it("refuses replacement execution when source process cleanup is unconfirmed", async () => {
    const state = world();
    getDatabase().prepare("UPDATE agent_runs SET error_category='cleanup_failed' WHERE id=?").run(state.source.id);
    const handoff = await proposeHandoff(state.attemptId, "ag_designer", owner);
    await decideHandoff(handoff.id, "accept", owner);
    await vi.waitFor(() => expect(getHandoff(handoff.id)?.executionStatus).toBe("failed"), { timeout: 5000 });
    expect(fixture.inputs).toHaveLength(0);
    expect(getHandoff(handoff.id)?.targetAttemptId).toBeNull();
  });

  it("revalidates workspace hashes and rejects stale or expired proposals", async () => {
    const state = world({ targetPaths: ["app.ts"] });
    const workspace = getWorkspaceForConversation(state.conversation.id)!;
    fs.writeFileSync(path.join(workspace.rootPath, "app.ts"), "original");
    const proposed = await proposeHandoff(state.attemptId, "ag_designer", owner);
    fs.writeFileSync(path.join(workspace.rootPath, "app.ts"), "changed");
    expect(() => validateHandoffPackage(proposed.id)).toThrow("Workspace files changed");
    await expect(decideHandoff(proposed.id, "accept", owner)).rejects.toThrow("Workspace files changed");
    await decideHandoff(proposed.id, "cancel", owner);
    const next = await proposeHandoff(state.attemptId, "ag_designer", owner);
    getDatabase().prepare("UPDATE task_handoffs SET expires_at=0 WHERE id=?").run(next.id);
    await expect(decideHandoff(next.id, "accept", owner)).rejects.toThrow("settled");
    expect(fixture.inputs).toHaveLength(0);
  });

  it("snapshots a bounded directory and notices newly added source files without reading dependencies or secrets", async () => {
    const state = world({ targetPaths: ["src"] });
    const workspace = getWorkspaceForConversation(state.conversation.id)!;
    const directory = path.join(workspace.rootPath, "src");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "app.ts"), "export const ready = true;");
    fs.writeFileSync(path.join(directory, ".env"), "SECRET=fixture-not-for-transfer");
    fs.mkdirSync(path.join(directory, "node_modules"));
    fs.writeFileSync(path.join(directory, "node_modules", "dependency.js"), "dependency");
    const handoff = await proposeHandoff(state.attemptId, "ag_designer", owner);
    expect(getHandoffPackage(handoff.id).files.map(file => file.path)).toEqual(["src/app.ts"]);
    fs.writeFileSync(path.join(directory, "new.ts"), "export const added = true;");
    expect(() => validateHandoffPackage(handoff.id)).toThrow("Workspace files changed");
  });

  it("recovers an interrupted handoff record without automatically dispatching its accepted decision again", async () => {
    const state = world();
    const proposal = await proposeHandoff(state.attemptId, "ag_designer", owner);
    getDatabase().prepare("UPDATE task_handoffs SET status='accepted',execution_status='stopping',coordinator_run_id='reserved-before-crash',decided_by='owner-session:fixture-owner' WHERE id=?").run(proposal.id);
    recoverOrphanedRuns();
    const replay = await decideHandoff(proposal.id, "accept", owner);
    expect(replay).toMatchObject({ id: proposal.id, status: "accepted", executionStatus: "interrupted", coordinatorRunId: "reserved-before-crash", targetRunId: null });
    expect(fixture.inputs).toHaveLength(0);
    expect(getBootstrapPayload().handoffsByConversation[state.conversation.id]).toEqual(expect.arrayContaining([expect.objectContaining({ id: proposal.id, executionStatus: "interrupted" })]));
  });
});
