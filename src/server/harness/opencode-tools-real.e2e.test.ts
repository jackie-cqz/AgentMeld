import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgent } from "@/server/agent-service";
import { buildMinimalContextEnvelope } from "@/server/conductor-service";
import { createConversation } from "@/server/conversation-service";
import { getTaskArtifacts } from "@/server/dispatch-task-results";
import {
  createMessage,
  createRun,
  getWorkspaceForConversation,
  listArtifacts,
  updateRunStatus,
} from "@/server/repositories";
import {
  createTaskAttempt,
  finishTaskAttempt,
  getContextSnapshot,
  insertContextSnapshot,
  listEvidenceForChildRun,
  listEvidenceForTask,
} from "@/server/repositories/evidence-repository";
import { resolveProviderBaseUrl } from "@/server/provider-endpoints";
import type { ParsedTask } from "@/server/tools/conductor-tools";
import {
  newContextSnapshotId,
  newMessageId,
  newRunId,
  newTaskAttemptId,
} from "@/shared/ids";
import { getOpenCodeDoctor, runOpenCodeHarness } from "./opencode-driver";
import type { HarnessEvent, HarnessInvocationInput } from "./types";
import type { TaskExecutionContract, TaskExecutionIdentity } from "@/shared/evidence-types";
import type { Agent, Artifact, Conversation, Message, Workspace } from "@/shared/types";

/**
 * The real-model half of the OpenCode business-tool proof.
 *
 * `opencode-tools.e2e.test.ts` scripts the provider and mocks the evidence
 * repository: it proves the transport, not that a real model chooses to call a
 * platform tool. This suite replaces both stand-ins with the real provider and
 * the real SQLite ledger, so a passing run means:
 *
 *   model -> OpenCode -> MCP server -> loopback bridge -> tool registry
 *         -> artifacts table + task_evidence row (with real foreign keys)
 *
 * The rows a delegated task normally owns are created here through the app's
 * own services/repositories (`createAgent`, `createConversation`, `createRun`,
 * `createTaskAttempt`, `insertContextSnapshot`). The previous throwaway probe
 * skipped that and wrote synthetic run/attempt ids, which is why its evidence
 * insert failed with `FOREIGN KEY constraint failed`; real parent rows and a
 * real task identity are the point of this fixture.
 *
 * Opt-in on purpose: an ordinary `pnpm test` / CI run never spends money or
 * needs a credential. Set `OPENCODE_REAL_E2E=1` plus the provider env and the
 * suite runs; otherwise it skips with the reason printed below.
 *
 * The provider target is the configured DeepSeek-compatible gateway. Its base
 * URL is normalized by the app's own resolver (a bare host gets `/v1`), because
 * the OpenAI-compatible endpoint OpenCode loads must be the versioned one.
 */
// Keep OpenCode's plugin runtime cache across runs, exactly like the scripted
// e2e. The platform database stays isolated by the shared test setup.
process.env.AGENTMELD_OPENCODE_HOME = path.join(os.tmpdir(), "agentmeld-opencode-real-e2e-home");

const optedIn = process.env.OPENCODE_REAL_E2E === "1";
const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
const baseUrl = process.env.DEEPSEEK_BASE_URL?.trim();
const modelId = process.env.DEEPSEEK_MODEL_ID?.trim() || "deepseek-v4-flash";

const skipReason = !optedIn
  ? "OPENCODE_REAL_E2E is not set (this suite makes a real, paid model request)"
  : !apiKey || apiKey.includes("your_")
    ? "DEEPSEEK_API_KEY is not configured (this suite makes a real, paid model request)"
    : !baseUrl
      ? "DEEPSEEK_BASE_URL is not configured (this suite makes a real, paid model request)"
      : null;

const doctor = skipReason === null ? getOpenCodeDoctor() : null;
const unavailable = doctor && !doctor.available
  ? `OpenCode is not installed: ${doctor.detail}`
  : null;
const realSkipReason = skipReason ?? unavailable;
if (realSkipReason) console.info(`[opencode real e2e] skipped: ${realSkipReason}`);

const trace = process.env.OPENCODE_REAL_E2E_TRACE === "1";

let agent: Agent;
let conversation: Conversation;
let workspace: Workspace;
let workspaceRoot: string;
let triggerMessage: Message;
let conductorRunId: string;
let childRunId: string;
let taskExecution: TaskExecutionIdentity;
let planId: string;
let taskId: string;

const taskContract: TaskExecutionContract = {
  acceptanceCriteria: ["The requested document artifact exists."],
  expectedOutputs: [{ outputKey: "note", type: "document", required: true }],
};

const prompt = [
  "Call the agentmeld_write_artifact tool now. Do not answer before the tool has returned.",
  'Use type "document", title "Real-model E2E artifact", outputKey "note",',
  'and content exactly: "# Real-model E2E\\n\\nThis document was written by a real model through the AgentMeld business-tool bridge."',
  'After the tool succeeds, reply with exactly the word: done',
].join("\n");

beforeAll(() => {
  if (realSkipReason) return;
  const endpoint = resolveProviderBaseUrl("deepseek");
  if (!endpoint) throw new Error("No DeepSeek endpoint could be resolved for the real OpenCode e2e.");
  agent = createAgent({
    name: "OpenCode real-model e2e",
    description: "Real provider, real OpenCode process, real evidence ledger",
    adapterName: "opencode",
    modelProvider: "deepseek",
    modelId,
    apiKey,
    apiBaseUrl: endpoint,
    toolNames: ["write_artifact"],
    systemPrompt: "You are a terse end-to-end test assistant. Use the requested tool before answering.",
  });
  conversation = createConversation({ mode: "single", agentIds: [agent.id], fsWriteApprovalMode: "auto" });
  const storedWorkspace = getWorkspaceForConversation(conversation.id);
  if (!storedWorkspace) throw new Error("The real OpenCode e2e conversation has no workspace.");
  // OpenCode/lease compare physical roots; the workspace service stores the
  // path it created, which on macOS may still be the `/var` spelling of a
  // `/private/var` directory.
  workspaceRoot = fs.realpathSync.native(storedWorkspace.rootPath);
  workspace = { ...storedWorkspace, rootPath: workspaceRoot };
  triggerMessage = createMessage({
    id: newMessageId(),
    conversationId: conversation.id,
    role: "user",
    origin: "human",
    parts: [{ type: "text", content: prompt }],
    status: "complete",
    now: Date.now(),
  });

  const now = Date.now();
  planId = `plan_real_e2e_${conversation.id}`;
  taskId = "task_real_e2e";
  conductorRunId = newRunId();
  // The conductor run is the parent every task_evidence row references.
  createRun({
    id: conductorRunId,
    conversationId: conversation.id,
    agentId: agent.id,
    triggerMessageId: triggerMessage.id,
    parentRunId: null,
    status: "running",
    now,
  });

  childRunId = newRunId();
  // The child run is the evidence row's child_run_id (also the run id the
  // harness reports its events/artifacts under).
  createRun({
    id: childRunId,
    conversationId: conversation.id,
    agentId: agent.id,
    triggerMessageId: triggerMessage.id,
    parentRunId: conductorRunId,
    status: "running",
    now,
  });

  const attemptId = newTaskAttemptId();
  const contextSnapshotId = newContextSnapshotId();
  createTaskAttempt({
    id: attemptId,
    conductorRunId,
    conversationId: conversation.id,
    planId,
    planRevision: 0,
    taskId,
    agentId: agent.id,
    childRunId,
    attempt: 1,
    contextSnapshotId,
    executionStatus: "running",
    verificationStatus: "not_started",
    failureContextJson: null,
    startedAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  taskExecution = {
    conductorRunId,
    planId,
    planRevision: 0,
    taskId,
    attemptId,
    attempt: 1,
    contextSnapshotId,
  };

  // The evidence row carries this snapshot id. It has no foreign key, but a
  // real task identity should still resolve to the row the app would have
  // written, so persist it with the same compiler the conductor uses.
  const parsedTask: ParsedTask = {
    id: taskId,
    agentId: agent.id,
    title: "Real-model OpenCode business tool",
    prompt,
    dependsOn: [],
    inputs: [],
    expectedOutputs: [{ id: "note", type: "document", required: true }],
    acceptanceCriteria: taskContract.acceptanceCriteria,
    maxAttempts: 1,
    taskIntent: "delivery",
    contractProfile: "minimal",
  };
  const envelope = buildMinimalContextEnvelope(taskExecution, parsedTask, [], []);
  insertContextSnapshot({
    id: contextSnapshotId,
    conversationId: conversation.id,
    conductorRunId,
    planId,
    taskId,
    attemptId,
    policyVersion: envelope.policyVersion,
    schemaVersion: envelope.schemaVersion,
    envelopeJson: JSON.stringify(envelope),
    manifestJson: JSON.stringify(envelope.manifest),
    tokenEstimate: 0,
    requiredTokenEstimate: 0,
    omittedTokenEstimate: 0,
    createdAt: now,
  });
});

afterAll(() => {
  if (realSkipReason || !taskExecution) return;
  // Close the fixture's run rows as the task runner would. The database itself
  // is owned and removed by the shared per-file test setup.
  finishTaskAttempt(taskExecution.attemptId, "reported_complete", Date.now());
  updateRunStatus(childRunId, "complete", null, Date.now());
  updateRunStatus(conductorRunId, "complete", null, Date.now());
});

function invocation(): HarnessInvocationInput {
  const endpoint = resolveProviderBaseUrl("deepseek");
  if (!endpoint || !apiKey) throw new Error("The real OpenCode e2e lost its provider configuration.");
  return {
    conversationId: conversation.id,
    runId: childRunId,
    parentRunId: conductorRunId,
    taskExecution,
    taskContract,
    agent,
    conversation,
    workspace,
    triggerMessage,
    context: {
      systemPrompt:
        "You are a terse end-to-end test assistant. You have one business tool; call it when asked, then answer exactly as instructed.",
      packet: { task: prompt, priorHistory: [], attachments: [] },
      recentMessages: [],
    },
    tools: { names: ["write_artifact"], required: ["write_artifact"] },
    requirements: {
      businessTools: true,
      nativeTools: false,
      evidence: true,
      cancellation: true,
      contextPacket: "platform",
    },
    provider: {
      providerId: "deepseek",
      catalogProvider: "deepseek",
      modelId,
      endpoint,
      credential: apiKey,
      revision: `deepseek:real-e2e:${modelId}`,
      reasoningEffort: null,
      vision: false,
      contextWindow: null,
    },
    workspaceRoot,
    // Generous: a cold engine home also installs OpenCode's plugin runtime.
    // Later runs reuse the cache and settle in seconds.
    timeoutMs: 600_000,
    access: "workspace",
  };
}

async function run(input: HarnessInvocationInput): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const event of runOpenCodeHarness(input, new AbortController().signal)) events.push(event);
  return events;
}

describe.skipIf(realSkipReason !== null)("OpenCode real-model business-tool end-to-end", () => {
  it("settles a real run that calls write_artifact and persists bound evidence", async () => {
    const events = await run(invocation());

    expect(events[0]).toEqual({ type: "run.started" });
    const settled = events.at(-1);
    expect(settled).toEqual({ type: "run.settled", status: "completed" });

    const calls = events.filter(
      (event): event is Extract<HarnessEvent, { type: "tool.call" }> =>
        event.type === "tool.call" && event.toolName === "write_artifact",
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const successes = calls.filter(call =>
      events.some(event => event.type === "tool.result" && event.callId === call.callId && !event.isError),
    );
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // The model saw OpenCode's MCP-prefixed name; the platform recorded the
    // platform name. Both facts are part of the transport proof.
    expect(calls[0].toolName).toBe("write_artifact");

    // Binding, through the same map a dispatched task's report consumes.
    const artifacts = getTaskArtifacts(childRunId);
    expect(Object.keys(artifacts)).toContain("note");
    expect(artifacts.note).toMatch(/^art_/);

    // The artifact itself, as the conversation UI lists it.
    const visible = listArtifacts(conversation.id);
    const artifact = visible.find((entry): entry is Artifact => entry.id === artifacts.note);
    expect(artifact).toBeDefined();
    expect(artifact?.type).toBe("document");
    expect(artifact?.createdByAgentId).toBe(agent.id);

    // The evidence row is read back from SQLite, not from the in-memory mock
    // the scripted e2e uses. Its foreign keys only resolve because this file
    // created the real conductor run, child run and task attempt above.
    const evidence = listEvidenceForChildRun(childRunId);
    const created = evidence.find(record => record.type === "artifact_created" && record.status === "valid");
    expect(created).toBeDefined();
    expect(created).toMatchObject({
      conversationId: conversation.id,
      conductorRunId,
      planId,
      taskId,
      attemptId: taskExecution.attemptId,
      childRunId,
      agentId: agent.id,
      sourceKind: "tool_call",
      subjectType: "artifact",
      subjectId: "note",
    });
    expect(JSON.parse(created!.payloadJson)).toMatchObject({
      outputKey: "note",
      artifactId: artifacts.note,
      artifactType: "document",
      agentId: agent.id,
    });

    // ...and it is reachable by task identity, not only by run identity.
    const byTask = listEvidenceForTask(conductorRunId, planId, taskId);
    expect(byTask.map(record => record.id)).toContain(created!.id);
    expect(getContextSnapshot(taskExecution.contextSnapshotId)).toMatchObject({
      conversationId: conversation.id,
      conductorRunId,
      planId,
      taskId,
      attemptId: taskExecution.attemptId,
    });

    if (trace) {
      console.info(`[opencode real e2e] model=${modelId}`);
      console.info(`[opencode real e2e] settled=${JSON.stringify(settled)}`);
      console.info(`[opencode real e2e] write_artifact calls=${calls.length} successes=${successes.length}`);
      console.info(`[opencode real e2e] artifacts=${JSON.stringify(artifacts)}`);
      console.info(`[opencode real e2e] evidence=${JSON.stringify(byTask.map(record => ({
        id: record.id,
        type: record.type,
        status: record.status,
        subjectId: record.subjectId,
        payload: JSON.parse(record.payloadJson),
        childRunId: record.childRunId,
        attemptId: record.attemptId,
      })))}`);
    }
  }, 600_000);
});
