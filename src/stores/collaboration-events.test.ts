import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./app-store";
import { normalizeBootstrap } from "./normalize-bootstrap";
import type { AgentConsultation } from "@/shared/collaboration-types";

const consultation: AgentConsultation = {
  id: "consult_1", conversationId: "conv_1", sourceRunId: "run_1", sourceAgentId: "frontend", targetAgentId: "designer",
  targetRunId: "run_2", requestKey: "layout", question: "Which layout?", status: "running", answer: null, error: null,
  expiresAt: 1000, createdAt: 1, updatedAt: 2,
};

beforeEach(() => useAppStore.setState({ consultations: {} }));

describe("consultation SSE and bootstrap projection", () => {
  it("upserts lifecycle events and does not regress a terminal state on replay", () => {
    const send = (item: AgentConsultation) => useAppStore.getState().applyEvent({ type: "collaboration.consultation", conversationId: item.conversationId, timestamp: item.updatedAt, consultation: item });
    send(consultation);
    send({ ...consultation, status: "replied", answer: "Compact layout", updatedAt: 3 });
    send({ ...consultation, updatedAt: 3 });
    expect(useAppStore.getState().consultations.consult_1.status).toBe("replied");
    expect(useAppStore.getState().consultations.consult_1.answer).toBe("Compact layout");
  });

  it("restores persisted consultations after refresh and accepts older bootstrap payloads", () => {
    const payload = { agents: [], conversations: [], messagesByConversation: {}, runsByConversation: {}, artifactsByConversation: {}, pendingWrites: [], pendingBashCommands: [], pendingDispatchPlans: [] };
    expect(normalizeBootstrap(payload).consultations).toEqual({});
    const state = normalizeBootstrap({ ...payload, consultationsByConversation: { conv_1: [consultation] } });
    expect(state.consultations.consult_1).toEqual(consultation);
  });
});
