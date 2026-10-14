import type { StreamEvent } from "@/shared/types";
import type { StoreDraft } from "@/stores/store-helpers";

/**
 * Channel-binding events are not conversation-scoped, so this reducer never
 * touches conversation buckets — only the session it names.
 *
 * The event deliberately carries no launcher URL (whoever holds that URL first
 * can create the app), so a session reaching a terminal state must drop any URL
 * this client learned from the start response. Otherwise a finished attempt
 * would keep offering a spent QR code.
 */
export function applyChannelEvent(state: StoreDraft, event: StreamEvent): boolean {
  if (event.type !== "channel.binding.updated") return false;

  const existing = state.channelBindingSessions[event.sessionId];
  const next = {
    id: event.sessionId,
    agentId: event.agentId,
    status: event.status,
    // Unknown for a session this client did not start; the start response is
    // what normally supplies it.
    expiresAt: existing?.expiresAt ?? 0
  };

  state.channelBindingSessions[event.sessionId] = event.status === "awaiting_scan" && existing?.qrUrl
    ? { ...next, qrUrl: existing.qrUrl }
    : event.error
      ? { ...next, error: event.error }
      : next;

  return true;
}
