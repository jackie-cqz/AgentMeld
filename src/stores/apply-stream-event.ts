import type { StreamEvent } from "@/shared/types";
import { applyArtifactEvent } from "@/stores/reducers/artifact-events";
import { applyChannelEvent } from "@/stores/reducers/channel-events";
import { applyCompactionEvent } from "@/stores/reducers/compaction-events";
import { applyDispatchEvent } from "@/stores/reducers/dispatch-events";
import { applyMessageEvent } from "@/stores/reducers/message-events";
import { applyPendingEvent } from "@/stores/reducers/pending-events";
import { applyRunEvent } from "@/stores/reducers/run-events";
import { applyToolEvent } from "@/stores/reducers/tool-events";
import { ensureConversationBuckets, type StoreDraft } from "@/stores/store-helpers";

export function applyStreamEvent(state: StoreDraft, event: StreamEvent) {
  // Channel-binding events are not conversation-scoped and carry an empty id.
  // Creating buckets for "" would leave seven permanent empty arrays for a
  // conversation that can never exist, so only real ids get buckets.
  if (event.conversationId) ensureConversationBuckets(state, event.conversationId);
  if (event.type === "collaboration.consultation") {
    const previous = state.consultations[event.consultation.id];
    const isTerminal = (status: string) => status !== "requested" && status !== "running";
    if ((!previous || previous.updatedAt <= event.consultation.updatedAt) &&
      !(previous && isTerminal(previous.status) && !isTerminal(event.consultation.status))) {
      state.consultations[event.consultation.id] = event.consultation;
    }
    return;
  }
  if (applyRunEvent(state, event)) return;
  if (applyMessageEvent(state, event)) return;
  if (applyToolEvent(state, event)) return;
  if (applyArtifactEvent(state, event)) return;
  if (applyDispatchEvent(state, event)) return;
  if (applyPendingEvent(state, event)) return;
  if (applyChannelEvent(state, event)) return;
  applyCompactionEvent(state, event);
}
