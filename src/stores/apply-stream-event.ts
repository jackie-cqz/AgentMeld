import type { StreamEvent } from "@/shared/types";
import { applyArtifactEvent } from "@/stores/reducers/artifact-events";
import { applyCompactionEvent } from "@/stores/reducers/compaction-events";
import { applyDispatchEvent } from "@/stores/reducers/dispatch-events";
import { applyMessageEvent } from "@/stores/reducers/message-events";
import { applyPendingEvent } from "@/stores/reducers/pending-events";
import { applyRunEvent } from "@/stores/reducers/run-events";
import { applyToolEvent } from "@/stores/reducers/tool-events";
import { ensureConversationBuckets, type StoreDraft } from "@/stores/store-helpers";

export function applyStreamEvent(state: StoreDraft, event: StreamEvent) {
  ensureConversationBuckets(state, event.conversationId);
  if (applyRunEvent(state, event)) return;
  if (applyMessageEvent(state, event)) return;
  if (applyToolEvent(state, event)) return;
  if (applyArtifactEvent(state, event)) return;
  if (applyDispatchEvent(state, event)) return;
  if (applyPendingEvent(state, event)) return;
  applyCompactionEvent(state, event);
}
