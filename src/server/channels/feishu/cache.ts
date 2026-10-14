import type { LarkChannelOptions } from "@larksuite/channel";
import { getDatabase } from "@/db/client";

/**
 * A persistent `Cache` for the platform SDK.
 *
 * The SDK's own cache is in memory, which is fine for tokens but not for
 * deduplication: `internalCache` loses everything on restart, and the SDK's
 * dedup is what marks *every* message id in a batch as seen. Without it, a
 * redelivery that happens to be batched differently is claimed under a
 * different representative id and routed a second time.
 *
 * Two details of the SDK's contract are load-bearing and easy to get wrong:
 *
 * - The third argument to `set` is an **absolute epoch-millisecond deadline**,
 *   not a duration. The SDK passes `Date.now() + ttl` and `Infinity`. Treating
 *   it as a duration would expire entries in 1970 or never.
 * - A namespace is composed as `${namespace}/${key}`, so the same id under two
 *   namespaces is two entries. Flattening them would make a message id and an
 *   event id collide.
 */
/**
 * The SDK's own cache shape, derived rather than restated.
 *
 * Restating it means naming `Symbol` — the boxed type the SDK uses — which the
 * linter rejects and which is easy to get subtly wrong. Deriving it from the
 * option that consumes it keeps the two in step by construction.
 */
export type SdkCache = NonNullable<LarkChannelOptions["cache"]>;

function cacheKey(key: unknown, namespace?: string): string {
  // `String` handles both members of the union, including a boxed Symbol.
  const raw = String(key);
  return namespace ? `${namespace}/${raw}` : raw;
}

export function createPersistentCache(now: () => number = Date.now): SdkCache {
  return {
    async get(key, options) {
      const row = getDatabase()
        .prepare("SELECT value, expired_at FROM channel_cache WHERE cache_key = ?")
        .get(cacheKey(key, options?.namespace)) as
        | { value: string; expired_at: number | null }
        | undefined;

      // An expired row is ignored rather than deleted: reading is the common
      // path and a write on every miss would be worse than a stale row that is
      // never returned.
      if (!row) return undefined;
      if (row.expired_at !== null && row.expired_at <= now()) return undefined;

      try {
        return JSON.parse(row.value);
      } catch {
        // Written by something that did not JSON-encode. Returning the raw
        // string is better than pretending the entry is absent.
        return row.value;
      }
    },

    async set(key, value, expiredTime, options) {
      // `Infinity` and `undefined` both mean "no deadline". Storing Infinity
      // would not survive JSON, and in SQLite it becomes null anyway.
      const expiredAt =
        typeof expiredTime === "number" && Number.isFinite(expiredTime) ? expiredTime : null;

      getDatabase()
        .prepare(`
          INSERT INTO channel_cache (cache_key, value, expired_at)
          VALUES (?, ?, ?)
          ON CONFLICT(cache_key) DO UPDATE SET
            value = excluded.value,
            expired_at = excluded.expired_at
        `)
        .run(cacheKey(key, options?.namespace), JSON.stringify(value ?? null), expiredAt);

      return true;
    }
  };
}

/** Remove entries that can no longer be returned. */
export function pruneChannelCache(now: number = Date.now()): number {
  const result = getDatabase()
    .prepare("DELETE FROM channel_cache WHERE expired_at IS NOT NULL AND expired_at <= ?")
    .run(now) as { changes?: number };
  return result.changes ?? 0;
}
