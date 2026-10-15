import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authedRequest, pairTestOwner, resetTestAuth } from "@/test/auth-test-helper";
import { ensureDatabase } from "@/db/bootstrap";
import { createConversation } from "@/server/conversation-service";
import { eventBus } from "@/server/event-bus";
import { setupTestDatabase } from "@/test/test-database";
import { getApprovalRecord } from "@/server/repositories";
import {
  cancelPendingBashForRun,
  clearPendingBashForTests,
  getAllPendingBashCommands,
  registerPendingBash
} from "@/server/pending-bash";
import {
  clearPendingWritesForTests,
  getAllPendingWrites,
  registerPendingWrite
} from "@/server/pending-writes";
import {
  clearPendingQuestionsForTests,
  getAllPendingQuestions,
  registerPendingQuestion
} from "@/server/pending-questions";
import {
  clearPendingPlansForTests,
  getAllPendingPlans,
  registerPendingPlan
} from "@/server/dispatch-plan-manager";

// Route handlers
import { POST as resolveBash } from "@/app/api/pending-bash/[id]/resolve/route";
import { POST as resolveWrite } from "@/app/api/pending-writes/[id]/resolve/route";
import { POST as answerQuestionRoute } from "@/app/api/pending-questions/[id]/answer/route";
import { POST as resolvePlan } from "@/app/api/dispatch-plans/[id]/resolve/route";

let cleanupDatabase: (() => void) | undefined;

beforeAll(() => {
  cleanupDatabase = setupTestDatabase("agentmeld-approval-routes-");
});

afterAll(() => {
  cleanupDatabase?.();
});

beforeEach(() => {
  eventBus.clearForTests();
  clearPendingBashForTests();
  clearPendingWritesForTests();
  clearPendingQuestionsForTests();
  clearPendingPlansForTests();
  ensureDatabase();
  pairTestOwner();
});

afterEach(() => {
  resetTestAuth();
  clearPendingBashForTests();
  clearPendingWritesForTests();
  clearPendingQuestionsForTests();
  clearPendingPlansForTests();
  eventBus.clearForTests();
});

function jsonRequest(body: unknown): Request {
  return authedRequest("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

type ResolveBody = {
  resolvedBy?: string | null;
  resolvedByLabel?: string | null;
  resolvedAt?: number | null;
  status?: string | null;
  error?: unknown;
};

/**
 * The identity a paired test browser records: `owner:session:<id>` where the
 * id is generated per pairing, so tests match the shape, not the value.
 */
const OWNER_PRINCIPAL = /^owner:session:os_[0-9a-f]+$/;

describe("POST /api/pending-bash/[id]/resolve", () => {
  it("reports the operator to a second caller that arrives after resolution", async () => {
    registerPendingBash("conv_r1", "ag_1", "run_r1", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    const first = await resolveBash(jsonRequest({ approved: true, resolvedBy: "ou_alice" }), ctx(id));
    expect(first.status).toBe(200);

    // A real second request. The in-memory entry is already gone, so this only
    // reaches 409 because the route consults the record; before that it was a
    // bare 404 and the second surface learned nothing.
    const second = await resolveBash(jsonRequest({ approved: false, resolvedBy: "ou_bob" }), ctx(id));
    expect(second.status).toBe(409);

    const body = (await second.json()) as ResolveBody;
    // The identity is the authenticated session, not the string "ou_alice" the
    // first caller typed; that string is preserved separately as a label.
    expect(body.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(body.resolvedByLabel).toBe("ou_alice");
    expect(body.status).toBe("approved");
    expect(typeof body.resolvedAt).toBe("number");
  });

  it("tells an unknown id apart from an already-resolved one", async () => {
    const res = await resolveBash(jsonRequest({ approved: true }), ctx("pb_never_existed"));
    expect(res.status).toBe(404);
  });

  it("settles a concurrent double submit with one 200 and one 409", async () => {
    registerPendingBash("conv_race", "ag_1", "run_race", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    const [a, b] = await Promise.all([
      resolveBash(jsonRequest({ approved: true, resolvedBy: "ou_alice" }), ctx(id)),
      resolveBash(jsonRequest({ approved: false, resolvedBy: "ou_bob" }), ctx(id))
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);

    // Derive the winner from whichever response won rather than hardcoding one:
    // the assertion is the invariant "the loser is told who won", not the
    // scheduler's ordering.
    const winnerIsA = a.status === 200;
    const winnerOperator = winnerIsA ? "ou_alice" : "ou_bob";
    const loser = winnerIsA ? b : a;
    const body = (await loser.json()) as ResolveBody;
    // Same session on both requests, so the identity is the same either way;
    // what distinguishes the responses is the label the winner sent.
    expect(body.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(body.resolvedByLabel).toBe(winnerOperator);
  });

  it("reports a cancelled approval as settled rather than missing", async () => {
    registerPendingBash("conv_cancel", "ag_1", "run_cancel", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    // Cancel behind the route, which is what a run abort does.
    cancelPendingBashForRun("run_cancel");

    const res = await resolveBash(jsonRequest({ approved: true, resolvedBy: "ou_alice" }), ctx(id));
    expect(res.status).toBe(409);

    const body = (await res.json()) as ResolveBody;
    expect(body.status).toBe("cancelled");
    // Nobody decided, so there is no operator, but there is a timestamp.
    expect(body.resolvedBy).toBeNull();
    expect(typeof body.resolvedAt).toBe("number");
  });

  it("does not report a resolved id from another queue as its own", async () => {
    registerPendingBash("conv_cross", "ag_1", "run_cross", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    const first = await resolveBash(jsonRequest({ approved: true, resolvedBy: "ou_alice" }), ctx(id));
    expect(first.status).toBe(200);

    // The same id sent to the writes route: its in-memory entry never existed
    // and the record is another type's, so this must be a plain 404 rather than
    // a 409 claiming a pending write was resolved.
    const wrongRoute = await resolveWrite(jsonRequest({ approved: true }), ctx(id));
    expect(wrongRoute.status).toBe(404);
  });

  it("attributes a rejection to the principal, not the label", async () => {
    // The reject success path was never driven with a label, so swapping the
    // two arguments here left the whole suite green.
    registerPendingBash("conv_reject", "ag_1", "run_reject", "rm -rf build", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    const res = await resolveBash(jsonRequest({ approved: false, resolvedBy: "ou_mallory" }), ctx(id));
    expect(res.status).toBe(200);

    const record = getApprovalRecord(id);
    expect(record?.status).toBe("rejected");
    expect(record?.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(record?.resolvedByLabel).toBe("ou_mallory");
  });

  it("records the principal even when the caller sends no label", async () => {
    registerPendingBash("conv_null", "ag_1", "run_null", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    const res = await resolveBash(jsonRequest({ approved: true, resolvedBy: null }), ctx(id));
    expect(res.status).toBe(200);

    // Identity comes from the session, so it is present; only the display
    // label is absent.
    const record = getApprovalRecord(id);
    expect(record?.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(record?.resolvedByLabel).toBeNull();
  });

  it("records the authenticated principal, not the string the caller typed", async () => {
    registerPendingBash("conv_r2", "ag_1", "run_r2", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    const res = await resolveBash(jsonRequest({ approved: true, resolvedBy: "ou_alice" }), ctx(id));
    expect(res.status).toBe(200);

    const record = getApprovalRecord(id);
    expect(record?.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(record?.resolvedByLabel).toBe("ou_alice");
  });

  it("does not let a caller forge the principal through the label", async () => {
    // The whole point of #24: a body string must not be able to claim an
    // identity. A forged "owner:session:..." label stays a label.
    registerPendingBash("conv_forge", "ag_1", "run_forge", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    const forged = "owner:session:os_deadbeefdeadbeef";
    const res = await resolveBash(jsonRequest({ approved: true, resolvedBy: forged }), ctx(id));
    expect(res.status).toBe(200);

    const record = getApprovalRecord(id);
    expect(record?.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(record?.resolvedBy).not.toBe(forged);
    expect(record?.resolvedByLabel).toBe(forged);
  });

  it("records the device principal for a companion-token request", async () => {
    registerPendingBash("conv_dev", "ag_1", "run_dev", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    const token = "dev_" + "d".repeat(40);
    const { getDatabase } = await import("@/db/client");
    getDatabase().prepare("UPDATE app_settings SET mobile_device_token = ? WHERE id = 'singleton'").run(token);

    const res = await resolveBash(
      new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ approved: true, resolvedBy: "手机" })
      }),
      ctx(id)
    );
    expect(res.status).toBe(200);

    const record = getApprovalRecord(id);
    expect(record?.resolvedBy).toBe("device:companion");
    expect(record?.resolvedByLabel).toBe("手机");
  });
});

describe("POST /api/pending-writes/[id]/resolve", () => {
  it("reports the operator to a second caller that arrives after resolution", async () => {
    registerPendingWrite("conv_r4", "ag_1", "run_r4", "a.txt", "/ws/a.txt", null, "x");
    const id = getAllPendingWrites()[0].id;

    const first = await resolveWrite(jsonRequest({ approved: false, resolvedBy: "ou_carol" }), ctx(id));
    expect(first.status).toBe(200);

    const second = await resolveWrite(jsonRequest({ approved: true, resolvedBy: "ou_dave" }), ctx(id));
    expect(second.status).toBe(409);

    const body = (await second.json()) as ResolveBody;
    expect(body.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(body.resolvedByLabel).toBe("ou_carol");
    expect(body.status).toBe("rejected");
  });

  it("records the authenticated principal, not the string the caller typed", async () => {
    registerPendingWrite("conv_r5", "ag_1", "run_r5", "a.txt", "/ws/a.txt", null, "x");
    const id = getAllPendingWrites()[0].id;

    const res = await resolveWrite(jsonRequest({ approved: true, resolvedBy: "ou_carol" }), ctx(id));
    expect(res.status).toBe(200);
    const record = getApprovalRecord(id);
    expect(record?.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(record?.resolvedByLabel).toBe("ou_carol");
  });

  it("records the principal with a null label when the caller omits one", async () => {
    registerPendingWrite("conv_r10", "ag_1", "run_r10", "a.txt", "/ws/a.txt", null, "x");
    const id = getAllPendingWrites()[0].id;

    const res = await resolveWrite(jsonRequest({ approved: true, resolvedBy: null }), ctx(id));
    expect(res.status).toBe(200);
    const record = getApprovalRecord(id);
    expect(record?.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(record?.resolvedByLabel).toBeNull();
  });
});

describe("POST /api/pending-questions/[id]/answer", () => {
  it("reports the answering operator to a second caller that arrives after the answer", async () => {
    registerPendingQuestion("conv_r6", "ag_1", "run_r6", [{ question: "Which stack?", header: "Stack", options: [{ label: "React" }, { label: "Vue" }] }]);
    const id = getAllPendingQuestions()[0].id;

    const first = await answerQuestionRoute(
      jsonRequest({ answers: { "Which stack?": "React" }, resolvedBy: "ou_erin" }),
      ctx(id)
    );
    expect(first.status).toBe(200);

    const second = await answerQuestionRoute(jsonRequest({ answers: { "Which stack?": "Vue" } }), ctx(id));
    expect(second.status).toBe(409);

    const body = (await second.json()) as ResolveBody;
    expect(body.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(body.resolvedByLabel).toBe("ou_erin");
    expect(body.status).toBe("approved");
  });

  it("records the authenticated principal on success", async () => {
    registerPendingQuestion("conv_r7", "ag_1", "run_r7", [{ question: "Which stack?", header: "Stack", options: [{ label: "React" }, { label: "Vue" }] }]);
    const id = getAllPendingQuestions()[0].id;

    const res = await answerQuestionRoute(
      jsonRequest({ answers: { "Which stack?": "React" }, resolvedBy: "ou_erin" }),
      ctx(id)
    );
    expect(res.status).toBe(200);
    const record = getApprovalRecord(id);
    expect(record?.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(record?.resolvedByLabel).toBe("ou_erin");
  });

  it("records the principal with a null label when the caller omits one", async () => {
    registerPendingQuestion("conv_r11", "ag_1", "run_r11", [{ question: "Which stack?", header: "Stack", options: [{ label: "React" }] }]);
    const id = getAllPendingQuestions()[0].id;

    const res = await answerQuestionRoute(
      jsonRequest({ answers: { "Which stack?": "React" }, resolvedBy: null }),
      ctx(id)
    );
    expect(res.status).toBe(200);
    const record = getApprovalRecord(id);
    expect(record?.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(record?.resolvedByLabel).toBeNull();
  });
});

describe("POST /api/dispatch-plans/[id]/resolve", () => {
  it("reports the operator to a second caller that arrives after resolution", async () => {
    registerPendingPlan("conv_r8", "run_r8", [
      { id: "t1", agentId: "ag_1", task: "Do the thing", dependsOn: [] }
    ]);
    const id = getAllPendingPlans()[0].id;

    const first = await resolvePlan(jsonRequest({ action: "reject", resolvedBy: "ou_frank" }), ctx(id));
    expect(first.status).toBe(200);

    const second = await resolvePlan(jsonRequest({ action: "reject", resolvedBy: "ou_grace" }), ctx(id));
    expect(second.status).toBe(409);

    const body = (await second.json()) as ResolveBody;
    expect(body.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(body.resolvedByLabel).toBe("ou_frank");
    expect(body.status).toBe("rejected");
  });

  it("records the authenticated principal when rejecting", async () => {
    registerPendingPlan("conv_r9", "run_r9", [
      { id: "t1", agentId: "ag_1", task: "Do the thing", dependsOn: [] }
    ]);
    const id = getAllPendingPlans()[0].id;

    const res = await resolvePlan(jsonRequest({ action: "reject", resolvedBy: "ou_frank" }), ctx(id));
    expect(res.status).toBe(200);

    const record = getApprovalRecord(id);
    expect(record?.status).toBe("rejected");
    expect(record?.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(record?.resolvedByLabel).toBe("ou_frank");
  });

  it("attributes an approval of a plan to the principal, not the label", async () => {
    // The approval gate re-validates against the real conversation members, so
    // this one needs a conversation whose agents can actually take the task.
    const conversation = createConversation({
      title: "审批群", mode: "group",
      agentIds: ["ag_mock_conductor", "ag_mock_builder"]
    });
    registerPendingPlan(conversation.id, "run_approve", [
      { id: "t1", agentId: "ag_mock_builder", task: "Do the thing", dependsOn: [] }
    ]);
    const id = getAllPendingPlans()[0].id;

    const res = await resolvePlan(jsonRequest({ action: "approve", resolvedBy: "ou_heidi" }), ctx(id));
    expect(res.status).toBe(200);
    expect((await res.clone().json()) as { approved?: boolean }).toMatchObject({ approved: true });

    const record = getApprovalRecord(id);
    expect(record?.status).toBe("approved");
    expect(record?.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(record?.resolvedByLabel).toBe("ou_heidi");
  });

  it("attributes a revision of a plan to the principal, not the label", async () => {
    registerPendingPlan("conv_revise", "run_revise", [
      { id: "t1", agentId: "ag_1", task: "Do the thing", dependsOn: [] }
    ]);
    const id = getAllPendingPlans()[0].id;

    const res = await resolvePlan(
      jsonRequest({ action: "revise", feedback: "先写测试", resolvedBy: "ou_ivan" }),
      ctx(id)
    );
    expect(res.status).toBe(200);

    const record = getApprovalRecord(id);
    expect(record?.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(record?.resolvedByLabel).toBe("ou_ivan");
  });

  it("records the principal with a null label when the caller omits one", async () => {
    registerPendingPlan("conv_r12", "run_r12", [
      { id: "t1", agentId: "ag_1", task: "Do the thing", dependsOn: [] }
    ]);
    const id = getAllPendingPlans()[0].id;

    const res = await resolvePlan(jsonRequest({ action: "reject", resolvedBy: null }), ctx(id));
    expect(res.status).toBe(200);
    const record = getApprovalRecord(id);
    expect(record?.resolvedBy).toMatch(OWNER_PRINCIPAL);
    expect(record?.resolvedByLabel).toBeNull();
  });
});
