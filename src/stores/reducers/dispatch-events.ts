import type { StreamEvent } from "@/shared/types";
import {
  createDispatchState,
  ensureDispatchState,
  findLatestMessageIdForRun,
  removeIdFromBucket,
  type StoreDraft,
  upsertPendingDispatchPlan
} from "@/stores/store-helpers";

export function applyDispatchEvent(state: StoreDraft, event: StreamEvent) {
  if (event.type === "dispatch.plan") {
    state.dispatchesByRunId[event.runId] = createDispatchState(
      event.conversationId,
      event.runId,
      event.plan,
      findLatestMessageIdForRun(state, event.conversationId, event.runId)
    );
    return true;
  }

  if (event.type === "dispatch.plan.pending") {
    upsertPendingDispatchPlan(state, event.pendingPlan);
    state.dispatchesByRunId[event.pendingPlan.runId] = {
      ...createDispatchState(
        event.conversationId,
        event.pendingPlan.runId,
        event.pendingPlan.plan,
        findLatestMessageIdForRun(state, event.conversationId, event.pendingPlan.runId)
      ),
      reviewStatus: "pending",
      pendingPlanId: event.pendingPlan.id
    };
    return true;
  }

  if (event.type === "dispatch.plan.resolved") {
    removeIdFromBucket(state.pendingDispatchPlanIdsByConversation, event.conversationId, event.pendingId);
    delete state.pendingDispatchPlans[event.pendingId];
    const dispatch = state.dispatchesByRunId[event.runId];
    if (dispatch) {
      dispatch.reviewStatus = event.approved ? "approved" : "rejected";
      dispatch.pendingPlanId = undefined;
    }
    return true;
  }

  if (event.type === "dispatch.start") {
    const dispatch = ensureDispatchState(state, event.conversationId, event.parentRunId);
    dispatch.taskStatus[event.taskId] = "running";
    if (event.childRunId) dispatch.childRunIds[event.taskId] = event.childRunId;
    return true;
  }

  if (event.type === "dispatch.task.start") {
    const dispatch = ensureDispatchState(state, event.conversationId, event.parentRunId);
    dispatch.taskStatus[event.taskId] = "running";
    dispatch.childRunIds[event.taskId] = event.childRunId;
    dispatch.attempts[event.taskId] = event.attempt;
    return true;
  }

  if (event.type === "dispatch.task.end") {
    const dispatch = ensureDispatchState(state, event.conversationId, event.parentRunId);
    dispatch.taskStatus[event.taskId] = event.status;
    dispatch.childRunIds[event.taskId] = event.childRunId;
    if (event.error) dispatch.errors[event.taskId] = event.error;
    return true;
  }

  if (event.type === "dispatch.end") {
    const dispatch = ensureDispatchState(state, event.conversationId, event.parentRunId);
    dispatch.taskStatus[event.taskId] = event.status;
    if (event.childRunId) dispatch.childRunIds[event.taskId] = event.childRunId;
    if (event.error) dispatch.errors[event.taskId] = event.error;
    return true;
  }

  return false;
}
