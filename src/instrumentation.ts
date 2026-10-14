/**
 * Server startup hook.
 *
 * Next.js calls `register()` once when the server boots. This is where the
 * Feishu long connections are opened: they are meant to be resident, and the
 * alternative — dialing out on the first request that happens to need them —
 * would make "is the bot connected?" depend on traffic.
 *
 * It also makes `docs/schema.md`'s claim that `ensureDatabase()` runs "at
 * application startup" true. Until this file existed there was no startup hook
 * at all, so bootstrapping was lazy on the first service call, which is exactly
 * how a route that skipped it answered 500 on a fresh install.
 */
export async function register(): Promise<void> {
  // Only the Node.js runtime can hold a socket. The edge runtime cannot, and
  // the build phase has no business dialing out to a tenant.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startFeishuChannels } = await import("@/server/channels/feishu/connection");
  const { startChannelRouter } = await import("@/server/channels/feishu/router");

  // Subscribe before connecting: a message that arrives in the window between
  // the two would otherwise be published with nobody listening for it.
  startChannelRouter();

  // Deliberately not awaited. A slow or unreachable platform must never delay
  // or fail server startup; each app's outcome is reported through a
  // `channel.connection` event, which the settings panel renders.
  void startFeishuChannels().catch((error: unknown) => {
    console.error("[feishu] failed to start channel connections:", error);
  });
}
