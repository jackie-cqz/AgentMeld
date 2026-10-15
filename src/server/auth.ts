import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { ensureDatabase } from "@/db/bootstrap";
import { getDatabase } from "@/db/client";

/**
 * Who is making this request.
 *
 * Issue #24: the API used to be a completely open local port. This module is
 * the thin, shared gate the issue asks for — every control and read route
 * resolves a principal through it before doing anything else.
 *
 * Three kinds of principal exist today, on purpose (single-owner model, no
 * IAM):
 *
 * - `owner-session`  — a browser session cookie issued after pairing. This is
 *   what the web UI runs on.
 * - `device-token`   — the companion device's long-lived token from settings
 *   (`mobileDeviceToken`). Rotatable, revocable.
 * - `feishu-binding` — an inbound Feishu event or card action. Identified by
 *   the binding's owner check elsewhere; here it only needs to reach the
 *   routes the channel owns. It is NOT a session: an open_id from one app
 *   means nothing in another app's namespace, so it never becomes an
 *   owner-session.
 *
 * Everything else is anonymous. What an anonymous request may do is decided by
 * `requireAuth`/`requireAnonymous` at the route, never by the caller.
 */

export type AuthPrincipal =
  | { kind: "owner-session"; sessionId: string; createdAt: number }
  | { kind: "device-token"; label: string }
  | { kind: "feishu-binding"; appId: string }
  | { kind: "anonymous" };

const SESSION_COOKIE = "agentmeld_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding.
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes, single use.
const PAIRING_MAX_ATTEMPTS = 5;
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 32;

declare global {
  var __agentMeldPairingCodes: Map<string, { hashed: string; expiresAt: number; attempts: number }> | undefined;
}

interface SessionRow {
  id: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  label: string | null;
}

/** Pairing/session tokens are stored one-way. Shared with the test helper. */
export function hashToken(token: string): string {
  // A pairing code is short and human-typed, so it gets the same one-way
  // treatment as a session token: what sits in the database cannot be read
  // back out, and what appears in a log cannot be replayed.
  const salt = createHash("sha256").update("agentmeld-session-salt").digest();
  return scryptSync(token, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

function ensureSessionsTable(): void {
  getDatabase().exec(`
    CREATE TABLE IF NOT EXISTS owner_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER NULL,
      label TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_owner_sessions_hash ON owner_sessions(token_hash);
  `);
}

/**
 * Has this install EVER been paired — does at least one owner session row
 * exist, live or not?
 *
 * Deliberately "ever", not "currently": the bootstrap window (anonymous code
 * minting) may open exactly once, on a fresh install. If it reopened whenever
 * the last session expired or was revoked, anyone on the network could wait
 * for that moment and pair themselves as owner — revocation would be
 * self-defeating. An owner who loses every session recovers with shell
 * access to the machine (`pnpm run auth:reset`), which is the real trust
 * boundary of a local-first app.
 */
export function hasPairedOwner(): boolean {
  ensureDatabase();
  ensureSessionsTable();
  const row = getDatabase()
    .prepare("SELECT 1 FROM owner_sessions LIMIT 1")
    .get() as unknown;
  return Boolean(row);
}

/** The QR-string a user reads off the screen and types into the other device. */
export function createPairingCode(): { code: string; expiresAt: number } {
  ensureDatabase();
  ensureSessionsTable();
  // 6 digits from 3 bytes: enough space that PAIRING_MAX_ATTEMPTS guesses
  // against a 5-minute window is not a practical attack on a LAN.
  const code = String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(6, "0");
  const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
  globalThis.__agentMeldPairingCodes ??= new Map();
  const codes = globalThis.__agentMeldPairingCodes;
  // One live code at a time: a second request replaces the first rather than
  // doubling the guessing surface.
  codes.clear();
  for (const [key, entry] of codes) if (entry.expiresAt < Date.now()) codes.delete(key);
  codes.set("current", { hashed: hashToken(code), expiresAt, attempts: 0 });
  return { code, expiresAt };
}

export interface PairingResult {
  ok: boolean;
  error?: string;
  status: number;
  setCookie?: string;
}

/** Redeem a pairing code into a session cookie. Single use, attempt-capped. */
export function redeemPairingCode(code: string): PairingResult {
  ensureDatabase();
  ensureSessionsTable();
  const codes = globalThis.__agentMeldPairingCodes;
  const entry = codes?.get("current");
  if (!codes || !entry) {
    return { ok: false, error: "No pairing code has been issued. Request one first.", status: 400 };
  }
  if (entry.expiresAt < Date.now()) {
    codes.delete("current");
    return { ok: false, error: "The pairing code expired. Request a new one.", status: 410 };
  }
  if (!constantTimeEquals(hashToken(code), entry.hashed)) {
    entry.attempts += 1;
    if (entry.attempts >= PAIRING_MAX_ATTEMPTS) {
      codes.delete("current");
      return { ok: false, error: "Too many wrong codes. Request a new one.", status: 429 };
    }
    return { ok: false, error: "That code is not right.", status: 401 };
  }
  codes.delete("current");

  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const id = `os_${randomBytes(8).toString("hex")}`;
  getDatabase()
    .prepare("INSERT INTO owner_sessions (id, token_hash, created_at, last_seen_at, label) VALUES (?, ?, ?, ?, ?)")
    .run(id, hashToken(token), now, now, null);
  return { ok: true, status: 200, setCookie: sessionCookie(token) };
}

function sessionCookie(token: string, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)): string {
  // HttpOnly: the companion SPA never needs to read it. SameSite=Strict keeps
  // a logged-in browser from being ridden cross-site. Path covers the whole
  // app because the API lives under the same origin.
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/** Resolve who is calling. Never throws; unknown means anonymous. */
export async function resolvePrincipal(request: Request): Promise<AuthPrincipal> {
  // 1. Session cookie.
  const cookie = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (cookie) {
    const principal = sessionFromCookie(cookie);
    if (principal) return principal;
  }
  // 2. Device token (Authorization: Bearer, companion device). Imported
  // dynamically: settings-service will import this module's `hasPairedOwner`
  // for its gate, and a static cycle would break both at load time.
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    const { getSettings } = await import("@/server/settings-service");
    const expected = getSettings().mobileDeviceToken ?? null;
    if (token && expected && constantTimeEquals(hashToken(token), hashToken(expected))) {
      return { kind: "device-token", label: "companion" };
    }
  }
  return { kind: "anonymous" };
}

function sessionFromCookie(token: string): AuthPrincipal | null {
  ensureDatabase();
  ensureSessionsTable();
  const now = Date.now();
  const rows = getDatabase()
    .prepare("SELECT id, token_hash, created_at, last_seen_at, revoked_at FROM owner_sessions WHERE token_hash = ?")
    .all(hashToken(token)) as SessionRow[];
  const row = rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;
  if (now - row.last_seen_at > SESSION_TTL_MS) return null;
  // Sliding expiry: activity keeps the session alive. Bounded writes, no await.
  getDatabase().prepare("UPDATE owner_sessions SET last_seen_at = ? WHERE id = ?").run(now, row.id);
  return { kind: "owner-session", sessionId: row.id, createdAt: row.created_at };
}

/** List live sessions so the owner can revoke them. */
export function listSessions(): Array<{ id: string; label: string | null; createdAt: number; lastSeenAt: number }> {
  ensureDatabase();
  ensureSessionsTable();
  const now = Date.now();
  return (getDatabase()
    .prepare("SELECT id, created_at, last_seen_at, revoked_at, label FROM owner_sessions")
    .all() as SessionRow[])
    .filter((row) => !row.revoked_at && now - row.last_seen_at < SESSION_TTL_MS)
    .map((row) => ({ id: row.id, label: row.label, createdAt: row.created_at, lastSeenAt: row.last_seen_at }));
}

export function revokeSession(id: string): boolean {
  ensureDatabase();
  ensureSessionsTable();
  const result = getDatabase()
    .prepare("UPDATE owner_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(Date.now(), id) as { changes: number | bigint };
  return Number(result.changes) > 0;
}

/** Rotate the device token: returns the new one. Callers show it once. */
export async function rotateDeviceToken(): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const { updateSettings } = await import("@/server/settings-service");
  updateSettings({ mobileDeviceToken: token });
  return token;
}

export async function clearDeviceToken(): Promise<void> {
  const { updateSettings } = await import("@/server/settings-service");
  updateSettings({ mobileDeviceToken: null });
}

export function sessionCookieHeader(token: string): string {
  return sessionCookie(token);
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export const AUTH_SESSION_COOKIE_NAME = SESSION_COOKIE;
