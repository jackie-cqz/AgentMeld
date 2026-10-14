import { ok } from "@/server/api-utils";
import {
  listFeishuConnections,
  startFeishuChannels
} from "@/server/channels/feishu/connection";

export const dynamic = "force-dynamic";

/**
 * Connection health for every bound agent.
 *
 * A GET also (re)starts anything missing, so a binding created while the server
 * was already running does not need a restart to come up. `startFeishuChannels`
 * is idempotent and keyed by app id, so this cannot open a duplicate
 * connection — the platform splits an app's events across two live connections.
 */
export async function GET() {
  await startFeishuChannels().catch(() => {
    // Per-app failures are reported through `channel.connection` events and in
    // the list below; a total failure still answers with what we know.
  });
  return ok({ connections: listFeishuConnections() });
}
