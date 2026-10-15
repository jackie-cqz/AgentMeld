import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authedRequest, pairTestOwner, resetTestAuth } from "@/test/auth-test-helper";
import { ensureDatabase } from "@/db/bootstrap";
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
  resolvedAt?: number | null;
  status?: string | null;
  error?: unknown;
};

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
    expect(body.resolvedBy).toBe("ou_alice");
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
    expect(body.resolvedBy).toBe(winnerOperator);
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

  it("accepts an explicit null operator, matching the server-side contract", async () => {
    registerPendingBash("conv_null", "ag_1", "run_null", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    const res = await resolveBash(jsonRequest({ approved: true, resolvedBy: null }), ctx(id));
    expect(res.status).toBe(200);
    expect(getApprovalRecord(id)?.resolvedBy).toBeNull();
  });

  it("resolves and records the caller-declared operator", async () => {
    registerPendingBash("conv_r2", "ag_1", "run_r2", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    const res = await resolveBash(jsonRequest({ approved: true, resolvedBy: "ou_alice" }), ctx(id));
    expect(res.status).toBe(200);
    expect(getApprovalRecord(id)?.resolvedBy).toBe("ou_alice");
  });

  it("leaves the operator unattributed when the caller does not declare one", async () => {
    registerPendingBash("conv_r3", "ag_1", "run_r3", "npm install", "/ws", "Reason");
    const id = getAllPendingBashCommands()[0].id;

    const res = await resolveBash(jsonRequest({ approved: true }), ctx(id));
    expect(res.status).toBe(200);

    const record = getApprovalRecord(id);
    expect(record?.resolvedBy).toBeNull();
    expect(record?.status).toBe("approved");
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
    expect(body.resolvedBy).toBe("ou_carol");
    expect(body.status).toBe("rejected");
  });

  it("resolves and records the caller-declared operator", async () => {
    registerPendingWrite("conv_r5", "ag_1", "run_r5", "a.txt", "/ws/a.txt", null, "x");
    const id = getAllPendingWrites()[0].id;

    const res = await resolveWrite(jsonRequest({ approved: true, resolvedBy: "ou_carol" }), ctx(id));
    expect(res.status).toBe(200);
    expect(getApprovalRecord(id)?.resolvedBy).toBe("ou_carol");
  });

  it("accepts an explicit null operator on this route too", async () => {
    registerPendingWrite("conv_r10", "ag_1", "run_r10", "a.txt", "/ws/a.txt", null, "x");
    const id = getAllPendingWrites()[0].id;

    const res = await resolveWrite(jsonRequest({ approved: true, resolvedBy: null }), ctx(id));
    expect(res.status).toBe(200);
    expect(getApprovalRecord(id)?.resolvedBy).toBeNull();
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
    expect(body.resolvedBy).toBe("ou_erin");
    expect(body.status).toBe("approved");
  });

  it("records the answering operator on success", async () => {
    registerPendingQuestion("conv_r7", "ag_1", "run_r7", [{ question: "Which stack?", header: "Stack", options: [{ label: "React" }, { label: "Vue" }] }]);
    const id = getAllPendingQuestions()[0].id;

    const res = await answerQuestionRoute(
      jsonRequest({ answers: { "Which stack?": "React" }, resolvedBy: "ou_erin" }),
      ctx(id)
    );
    expect(res.status).toBe(200);
    expect(getApprovalRecord(id)?.resolvedBy).toBe("ou_erin");
  });

  it("accepts an explicit null operator on this route too", async () => {
    registerPendingQuestion("conv_r11", "ag_1", "run_r11", [{ question: "Which stack?", header: "Stack", options: [{ label: "React" }] }]);
    const id = getAllPendingQuestions()[0].id;

    const res = await answerQuestionRoute(
      jsonRequest({ answers: { "Which stack?": "React" }, resolvedBy: null }),
      ctx(id)
    );
    expect(res.status).toBe(200);
    expect(getApprovalRecord(id)?.resolvedBy).toBeNull();
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
    expect(body.resolvedBy).toBe("ou_frank");
    expect(body.status).toBe("rejected");
  });

  it("records the caller-declared operator when rejecting", async () => {
    registerPendingPlan("conv_r9", "run_r9", [
      { id: "t1", agentId: "ag_1", task: "Do the thing", dependsOn: [] }
    ]);
    const id = getAllPendingPlans()[0].id;

    const res = await resolvePlan(jsonRequest({ action: "reject", resolvedBy: "ou_frank" }), ctx(id));
    expect(res.status).toBe(200);

    const record = getApprovalRecord(id);
    expect(record?.status).toBe("rejected");
    expect(record?.resolvedBy).toBe("ou_frank");
  });

  it("accepts an explicit null operator on this route too", async () => {
    registerPendingPlan("conv_r12", "run_r12", [
      { id: "t1", agentId: "ag_1", task: "Do the thing", dependsOn: [] }
    ]);
    const id = getAllPendingPlans()[0].id;

    const res = await resolvePlan(jsonRequest({ action: "reject", resolvedBy: null }), ctx(id));
    expect(res.status).toBe(200);
    expect(getApprovalRecord(id)?.resolvedBy).toBeNull();
  });
});
