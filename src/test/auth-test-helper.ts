import { randomBytes } from "node:crypto";
import { ensureDatabase } from "@/db/bootstrap";
import { getDatabase } from "@/db/client";
import { hashToken } from "@/server/auth";

/**
 * Route tests call handlers directly, and since the #24 gate every handler
 * refuses anonymous callers once an owner has paired. These helpers put a
 * test-run owner session into the (fresh, temp) database and produce requests
 * that carry it, so a test exercises its route's real logic, not the gate.
 *
 * The gate itself has its own tests (api-gate.test.ts) where none of this is
 * used — there it is exercised exactly as production sees it.
 */

let currentCookie: string | null = null;

export function pairTestOwner(): string {
  ensureDatabase();
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  getDatabase().exec(`
    CREATE TABLE IF NOT EXISTS owner_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER NULL,
      label TEXT
    );
  `);
  getDatabase()
    .prepare("INSERT INTO owner_sessions (id, token_hash, created_at, last_seen_at, label) VALUES (?, ?, ?, ?, ?)")
    .run(`os_${randomBytes(8).toString("hex")}`, hashToken(token), now, now, "test");
  currentCookie = `agentmeld_session=${token}`;
  return currentCookie;
}

export function resetTestAuth(): void {
  currentCookie = null;
}

/** A request the gate accepts, for routes under test. */
export function authedRequest(url: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  if (currentCookie) headers.set("cookie", currentCookie);
  return new Request(url, { ...init, headers });
}
