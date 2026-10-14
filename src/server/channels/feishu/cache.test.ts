import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase } from "@/test/test-database";
import { createPersistentCache, pruneChannelCache } from "@/server/channels/feishu/cache";
import { getDatabase } from "@/db/client";

/**
 * The SDK's dedup marks every message id in a batch as seen, and its own cache
 * is in memory — so the marks vanish on restart unless a persistent one is
 * injected. These tests pin the two parts of the SDK's cache contract that are
 * easy to get wrong, because getting either wrong makes deduplication silently
 * useless rather than obviously broken.
 */
describe("the persistent SDK cache", () => {
  let teardown: () => void;

  beforeEach(() => {
    teardown = setupTestDatabase("agentmeld-channel-cache-");
  });

  afterEach(() => {
    teardown();
  });

  it("round-trips a value", async () => {
    const cache = createPersistentCache();
    await cache.set("om_1", "1");

    expect(await cache.get("om_1")).toBe("1");
  });

  it("survives being rebuilt, which is the whole point", async () => {
    // A fresh instance stands in for a fresh process: the same cache has to
    // come back, or the dedup marks are lost exactly when a restart redelivers.
    await createPersistentCache().set("om_1", "1");

    expect(await createPersistentCache().get("om_1")).toBe("1");
  });

  it("treats the deadline as an absolute time, not a duration", async () => {
    // The SDK passes `Date.now() + ttl` and `Infinity`. Reading the argument as
    // a duration would expire everything in 1970 or never expire at all.
    let clock = 1_000_000;
    const cache = createPersistentCache(() => clock);

    await cache.set("soon", "1", clock + 5_000);
    await cache.set("later", "1", clock + 60_000);

    clock += 10_000;
    expect(await cache.get("soon")).toBeUndefined();
    expect(await cache.get("later")).toBe("1");
  });

  it("treats infinity and omission as no deadline", async () => {
    const cache = createPersistentCache(() => 5_000_000_000);
    await cache.set("forever", "1", Number.POSITIVE_INFINITY);
    await cache.set("alsoForever", "1");

    expect(await cache.get("forever")).toBe("1");
    expect(await cache.get("alsoForever")).toBe("1");
  });

  it("keeps namespaces apart", async () => {
    // The SDK composes namespace and key. Flattening them would make a message
    // id and an event id collide, which is exactly the pair dedup separates.
    const cache = createPersistentCache();
    await cache.set("id_1", "message", undefined, { namespace: "channel:seen" });
    await cache.set("id_1", "event", undefined, { namespace: "channel:event" });

    expect(await cache.get("id_1", { namespace: "channel:seen" })).toBe("message");
    expect(await cache.get("id_1", { namespace: "channel:event" })).toBe("event");
    expect(await cache.get("id_1")).toBeUndefined();
  });

  it("carries structured values, because it also caches credentials", async () => {
    const cache = createPersistentCache();
    await cache.set("token", { value: "t-1", expires: 42 });

    expect(await cache.get("token")).toEqual({ value: "t-1", expires: 42 });
  });

  it("overwrites an existing key", async () => {
    const cache = createPersistentCache();
    await cache.set("k", "first");
    await cache.set("k", "second");

    expect(await cache.get("k")).toBe("second");
  });

  it("prunes only the entries that can no longer be returned", async () => {
    const cache = createPersistentCache(() => 1_000);
    await cache.set("expired", "1", 500);
    await cache.set("live", "1", 5_000);

    expect(pruneChannelCache(1_000)).toBe(1);
    expect(await cache.get("live")).toBe("1");
  });

  it("never leaves the SDK key shape to drift", async () => {
    // Guards the composed-key format against a careless refactor: if this
    // changes, every previously-written dedup mark becomes unreachable.
    const cache = createPersistentCache();
    await cache.set("om_abc", "1", undefined, { namespace: "channel:seen" });

    const row = getDatabase()
      .prepare("SELECT cache_key FROM channel_cache")
      .get() as { cache_key: string };
    expect(row.cache_key).toBe("channel:seen/om_abc");
  });
});
