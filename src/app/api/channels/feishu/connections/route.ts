import { ok } from "@/server/api-utils";
import { listFeishuConnections, startFeishuChannels } from "@/server/channels/feishu/connection";

export const dynamic = "force-dynamic";

/**
 * Connection health for every bound agent, **including the ones that failed**.
 *
 * Every binding gets a row once an attempt has been made, so "this bot could
 * not connect" is readable from here rather than looking the same as "we have
 * not asked yet". A failure that lived only in an event was invisible to any
 * client that was not already subscribed when it happened.
 *
 * A GET also nudges anything missing or previously failed to (re)connect, so a
 * binding created while the server was already running does not need a restart.
 * That part is deliberately NOT awaited: an app whose host never answers must
 * not hold this response open, and the caller is asking for the current state,
 * not for a connection attempt to finish. Failed apps are retried no more often
 * than the cooldown allows, so polling this route cannot become a retry storm.
 */
export async function GET() {
  void startFeishuChannels().catch(() => {
    // Per-app outcomes are reported in the list below; a total failure still
    // answers with whatever state is known.
  });
  return ok({ connections: listFeishuConnections() });
}
