import { registerApp, type QRCodeInfo, type RegisterAppResult } from "@larksuite/channel";
import { randomBytes } from "node:crypto";
import { createLarkChannel } from "@larksuite/channel";
import { ensureDatabase } from "@/db/bootstrap";
import { constantTimeEquals, hashToken } from "@/server/auth";
import { eventBus } from "@/server/event-bus";
import {
  deleteChannelBinding,
  getAgent,
  getChannelBindingForAgent,
  listChannelBindings,
  setChannelBindingOwner,
  upsertChannelBinding
} from "@/server/repositories";
import { newChannelBindingId, newChannelBindingSessionId } from "@/shared/ids";
import type { ChannelBinding, ChannelBindingSession, ChannelBindingStatus } from "@/shared/types";

const CHANNEL = "feishu" as const;

/** How long a claim code is good for, and how many wrong guesses it survives. */
const CLAIM_CODE_TTL_MS = 5 * 60_000;
const CLAIM_MAX_ATTEMPTS = 5;

/**
 * The owner's open id, established without a QR scan.
 *
 * A scan hands us three things at once: the credentials, the bot's identity and
 * the scanning human's open id — and that last one is the anchor every card
 * action is authorised against. Credentials typed into a form carry no human
 * identity at all, so the binding starts fail-closed (`boundByOpenId: null`,
 * which refuses everyone) and the owner is established by a one-time code the
 * web page shows and the person sends to the bot in the group. Only someone who
 * has the app secret AND can speak to that bot can take it.
 */
interface ClaimEntry {
  agentId: string;
  hashed: string;
  expiresAt: number;
  attempts: number;
}

declare global {
  var __agentMeldChannelClaimCodes: Map<string, ClaimEntry> | undefined;
}

function getClaimCodes(): Map<string, ClaimEntry> {
  globalThis.__agentMeldChannelClaimCodes ??= new Map();
  return globalThis.__agentMeldChannelClaimCodes;
}

/** One live claim per agent: issuing another replaces it in place. */
function issueClaimCode(agentId: string): { code: string; expiresAt: number } {
  const code = String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(6, "0");
  const expiresAt = Date.now() + CLAIM_CODE_TTL_MS;
  getClaimCodes().set(agentId, { agentId, hashed: hashToken(code), expiresAt, attempts: 0 });
  return { code, expiresAt };
}

export function hasLiveClaim(agentId: string, now = Date.now()): boolean {
  const entry = getClaimCodes().get(agentId);
  if (!entry) return false;
  if (entry.expiresAt < now) {
    getClaimCodes().delete(agentId);
    return false;
  }
  return true;
}

export function claimExpiresAt(agentId: string): number | null {
  return getClaimCodes().get(agentId)?.expiresAt ?? null;
}

/**
 * Put a KNOWN code in place, for tests that need to exercise the claim path
 * without a real credential check. Production only ever mints codes through
 * `bindFeishuWithCredentials`.
 */
export function issueClaimCodeForTests(agentId: string, code: string, ttlMs = CLAIM_CODE_TTL_MS): number {
  const expiresAt = Date.now() + ttlMs;
  getClaimCodes().set(agentId, { agentId, hashed: hashToken(code), expiresAt, attempts: 0 });
  return expiresAt;
}

export function clearClaimCodesForTests(): void {
  globalThis.__agentMeldChannelClaimCodes = undefined;
}

export type ClaimOutcome =
  | { ok: true; binding: ChannelBinding }
  | { ok: false; reason: "no-claim" | "expired" | "too-many" | "wrong-code" | "not-bound" };

/**
 * Take ownership of a binding with the code the web page showed.
 *
 * Deliberately NOT a comparison against anything the caller sends besides the
 * code: the open id comes from the platform callback, so a forwarded code
 * claims the binding for whoever actually sent it — which is the same trust the
 * scan flow has (whoever holds the phone).
 */
export function claimBindingOwner(input: {
  agentId: string;
  openId: string;
  code: string;
  now?: number;
}): ClaimOutcome {
  const now = input.now ?? Date.now();
  const claims = getClaimCodes();
  const entry = claims.get(input.agentId);
  if (!entry) return { ok: false, reason: "no-claim" };
  if (entry.expiresAt < now) {
    claims.delete(input.agentId);
    return { ok: false, reason: "expired" };
  }
  if (!constantTimeEquals(hashToken(input.code.trim()), entry.hashed)) {
    entry.attempts += 1;
    if (entry.attempts >= CLAIM_MAX_ATTEMPTS) {
      claims.delete(input.agentId);
      return { ok: false, reason: "too-many" };
    }
    return { ok: false, reason: "wrong-code" };
  }

  // Single use: the entry goes before the write, so a second message with the
  // same code cannot re-claim after a failure below.
  claims.delete(input.agentId);
  if (!setChannelBindingOwner(input.agentId, CHANNEL, input.openId)) {
    return { ok: false, reason: "not-bound" };
  }
  const binding = getChannelBindingForAgent(input.agentId, CHANNEL);
  if (!binding) return { ok: false, reason: "not-bound" };
  return { ok: true, binding };
}

export interface ManualBindingResult {
  ok: boolean;
  status: number;
  error?: string;
  binding?: ChannelBinding;
  claim?: { code: string; expiresAt: number };
}

/**
 * Bind from credentials a person typed, instead of a QR scan.
 *
 * The credentials are CHECKED before they are stored: a channel is created and
 * connected once, its identity read, and then closed. Storing unchecked
 * credentials would leave a binding that fails forever at startup, which is
 * worse than refusing the form.
 */
export async function bindFeishuWithCredentials(input: {
  agentId: string;
  appId: string;
  appSecret: string;
  tenantBrand?: string | null;
}): Promise<ManualBindingResult> {
  ensureDatabase();
  const agent = getAgent(input.agentId);
  if (!agent) return { ok: false, status: 404, error: "Unknown agent." };

  const appId = input.appId.trim();
  const appSecret = input.appSecret.trim();
  if (!appId || !appSecret) {
    return { ok: false, status: 400, error: "appId and appSecret are both required." };
  }

  // The scan flow cannot hit either of these (it creates a new app), so a manual
  // binding is the only way they can happen — and both are silent destruction:
  // overwriting a working binding (owner included) because a name was mistyped,
  // or binding one app to two agents when only one of them can ever connect.
  const existing = getChannelBindingForAgent(input.agentId, CHANNEL);
  if (existing) {
    return {
      ok: false,
      status: 409,
      error: "This agent already has a Feishu app bound. Unbind it first."
    };
  }
  const takenBy = listChannelBindings().find(
    (binding) => binding.channel === CHANNEL && binding.appId === appId && binding.agentId !== input.agentId
  );
  if (takenBy) {
    return { ok: false, status: 409, error: "That app is already bound to another agent." };
  }

  const channel = createLarkChannel({ appId, appSecret, source: "agentmeld" });
  let botOpenId: string | null = null;
  try {
    await channel.connect();
    botOpenId = channel.getBotIdentity().openId;
  } catch (error) {
    await channel.disconnect().catch(() => {});
    return {
      ok: false,
      status: 400,
      error: `That app id and secret could not connect: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
  await channel.disconnect().catch(() => {});

  const binding = upsertChannelBinding({
    id: newChannelBindingId(),
    agentId: input.agentId,
    channel: CHANNEL,
    appId,
    appSecret,
    tenantBrand: input.tenantBrand ?? null,
    botOpenId,
    // Fail-closed until the owner is established by the one-time code below.
    boundByOpenId: null,
    now: Date.now()
  });
  const claim = issueClaimCode(input.agentId);
  return { ok: true, status: 201, binding, claim };
}

/** How long the launcher URL is given to appear before we give up on it. */
const QR_READY_TIMEOUT_MS = 20_000;

/** How long a settled session stays readable, so a client can observe the outcome. */
const TERMINAL_SESSION_TTL_MS = 5 * 60_000;

interface SessionEntry {
  session: ChannelBindingSession;
  abort: AbortController;
  /** Set when the status becomes terminal, so the entry can eventually be swept. */
  settledAt?: number;
}

declare global {
  var __agentMeldChannelBindingSessions: Map<string, SessionEntry> | undefined;
}

function getSessions(): Map<string, SessionEntry> {
  if (!globalThis.__agentMeldChannelBindingSessions) {
    globalThis.__agentMeldChannelBindingSessions = new Map();
  }
  return globalThis.__agentMeldChannelBindingSessions;
}

/**
 * Retire sessions that can no longer progress.
 *
 * An attempt whose launcher URL has expired is **aborted and marked failed, not
 * deleted**: its registration may still be in flight, and dropping the entry
 * would let that registration write a result into a session nobody can read.
 * Only settled sessions are dropped, once their grace period has passed.
 */
function sweep(now: number): void {
  for (const [id, entry] of getSessions()) {
    const { session, settledAt } = entry;
    if (session.status === "awaiting_scan") {
      if (session.expiresAt <= now) {
        entry.abort.abort();
        settle(entry, "failed", "The launcher URL expired before it was used.");
        publish(entry, { error: session.error });
      }
      continue;
    }
    if (settledAt !== undefined && now - settledAt > TERMINAL_SESSION_TTL_MS) {
      getSessions().delete(id);
    }
  }
}

/**
 * `sessionId` always identifies the attempt. `bindingId` is the persisted row,
 * which only exists once the scan succeeded — do not conflate the two: an
 * earlier revision published the session id under the name `bindingId`, so no
 * consumer could have matched an event to a stored binding.
 */
function publish(
  entry: SessionEntry,
  extra: { bindingId?: string; appId?: string; error?: string } = {}
): void {
  eventBus.publish({
    type: "channel.binding.updated",
    conversationId: "",
    timestamp: Date.now(),
    sessionId: entry.session.id,
    agentId: entry.session.agentId,
    status: entry.session.status,
    ...extra
  });
}

function settle(entry: SessionEntry, status: ChannelBindingStatus, error?: string): void {
  entry.session.status = status;
  if (error) entry.session.error = error;
  // The launcher URL is useless once the attempt is over. Dropping it here is
  // what makes "only the start response carries it" true by construction rather
  // than by comment.
  delete entry.session.qrUrl;
  entry.settledAt = Date.now();
}

function describeError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  const description = (error as { description?: string } | null)?.description;
  if (code || description) return [code, description].filter(Boolean).join(": ");
  return error instanceof Error ? error.message : String(error);
}

function findActiveSessionForAgent(agentId: string): ChannelBindingSession | undefined {
  for (const entry of getSessions().values()) {
    if (entry.session.agentId === agentId && entry.session.status === "awaiting_scan") {
      return entry.session;
    }
  }
  return undefined;
}

export type StartBindingResult =
  | { ok: true; session: ChannelBindingSession }
  | { ok: false; error: string; status: number; sessionId?: string };

/**
 * Begin a "scan to bind" attempt for one agent.
 *
 * Resolves once the launcher URL is known (the SDK reports it from
 * `onQRCodeReady`), because the caller has to display it. The registration
 * itself keeps running in the background — waiting for the scan can take up to
 * the URL's whole lifetime, so it must never be awaited by a request.
 */
export async function startFeishuBinding(agentId: string): Promise<StartBindingResult> {
  ensureDatabase();
  const now = Date.now();
  sweep(now);

  const agent = getAgent(agentId);
  if (!agent) return { ok: false, error: "Agent not found.", status: 404 };

  if (getChannelBindingForAgent(agentId, CHANNEL)) {
    return { ok: false, error: "This agent is already bound to a Feishu app.", status: 409 };
  }

  // A second attempt for the same agent must be refused, not started: both
  // would call registerApp and create two Feishu apps, and there is no API to
  // delete the orphan (design risk R4). A double click, a client retry, or a
  // second tab reaches this while the first attempt is still in flight, because
  // nothing has been persisted yet for the 409 above to catch.
  const active = findActiveSessionForAgent(agentId);
  if (active) {
    return {
      ok: false,
      error: "A binding attempt for this agent is already in progress.",
      status: 409,
      sessionId: active.id
    };
  }

  const abort = new AbortController();
  const entry: SessionEntry = {
    abort,
    session: {
      id: newChannelBindingSessionId(),
      agentId,
      status: "awaiting_scan",
      // Replaced with the SDK's own `expireIn` as soon as the URL arrives.
      expiresAt: now + QR_READY_TIMEOUT_MS
    }
  };
  getSessions().set(entry.session.id, entry);

  let resolveQr: ((info: QRCodeInfo) => void) | undefined;
  let rejectQr: ((error: Error) => void) | undefined;
  const qrReady = new Promise<QRCodeInfo>((resolve, reject) => {
    resolveQr = resolve;
    rejectQr = reject;
  });

  void registerApp({
    // Never allow the confirm page to pick an existing app: that would let one
    // agent's scan overwrite another agent's configuration.
    createOnly: true,
    signal: abort.signal,
    // Name and description are inherited from the agent so the bot the user
    // confirms already looks like the agent it belongs to. The avatar is
    // deliberately omitted: `appPreset.avatar` requires an image URL and agents
    // store an emoji, so promising a matching avatar is not something this can
    // deliver yet.
    appPreset: { name: agent.name, desc: agent.description },
    onQRCodeReady(info) {
      // The SDK can report the URL after we have already given up, and a late
      // callback must not resurrect a failed or cancelled attempt.
      if (entry.session.status !== "awaiting_scan") return;
      entry.session.qrUrl = info.url;
      // `expireIn` is seconds. The SDK falls back to 600 — ten minutes — when
      // the response omits the field, which is where the figure in the public
      // docs comes from; a real response reports its own value.
      entry.session.expiresAt = Date.now() + info.expireIn * 1000;
      resolveQr?.(info);
    },
    onStatusChange(info) {
      // 'polling' | 'slow_down' | 'domain_switched' — informational; the
      // terminal outcome arrives through the resolved/rejected promise.
      void info;
    }
  })
    .then((result: RegisterAppResult) => {
      // Cancellation can land after the SDK has already resolved. Do not
      // persist an identity the user asked us to stop creating.
      if (abort.signal.aborted || entry.session.status !== "awaiting_scan") {
        if (entry.session.status === "awaiting_scan") {
          settle(entry, "cancelled");
          publish(entry);
        }
        return;
      }
      const binding: ChannelBinding = upsertChannelBinding({
        id: newChannelBindingId(),
        agentId,
        channel: CHANNEL,
        appId: result.client_id,
        appSecret: result.client_secret,
        tenantBrand: result.user_info?.tenant_brand ?? null,
        boundByOpenId: result.user_info?.open_id ?? null,
        now: Date.now()
      });
      settle(entry, "succeeded");
      publish(entry, { bindingId: binding.id, appId: binding.appId });
    })
    .catch((error: unknown) => {
      if (abort.signal.aborted) {
        settle(entry, "cancelled");
        publish(entry);
        return;
      }
      const description = describeError(error);
      settle(entry, "failed", description);
      publish(entry, { error: description });
      // Unblock the start request if the flow failed before a URL appeared.
      rejectQr?.(new Error(description));
    });

  try {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Timed out waiting for the launcher URL.")), QR_READY_TIMEOUT_MS)
        .unref?.();
    });
    await Promise.race([qrReady, timeout]);
  } catch (error) {
    if (entry.session.status === "awaiting_scan") {
      abort.abort();
      settle(entry, "failed", describeError(error));
      publish(entry, { error: entry.session.error });
    }
    // The session id comes back even on failure, so the client can watch the
    // attempt it just started rather than only hearing about it on the stream.
    return {
      ok: false,
      error: entry.session.error ?? "Binding could not be started.",
      status: 502,
      sessionId: entry.session.id
    };
  }

  return { ok: true, session: entry.session };
}

export function getBindingSession(id: string): ChannelBindingSession | undefined {
  const now = Date.now();
  sweep(now);
  return getSessions().get(id)?.session;
}

/**
 * Stored bindings, with the database guaranteed to exist.
 *
 * Bootstrapping belongs on the service side, which is where the rest of this
 * repository puts it. A route that reached `listChannelBindings` directly got
 * "no such table: channel_bindings" on a database that had not been
 * bootstrapped yet — and then appeared to fix itself once another request
 * happened to bootstrap it. Routing every read through here means a new read
 * path cannot reintroduce that; fixing only the GET left the DELETE broken.
 */
export function listFeishuBindings(): ChannelBinding[] {
  ensureDatabase();
  return listChannelBindings();
}

/**
 * Sessions for a list view, including a live attempt's launcher URL.
 *
 * An earlier revision stripped that URL here, on the theory that only the
 * response which started the attempt should carry it. That was security
 * theatre: the list still hands out the session id, and `getBindingSession`
 * serves the same URL for a live attempt, so any caller able to read the list
 * could obtain it with one more request. The only thing the strip actually did
 * was lose the QR code for good after a reload — the client has no other way to
 * get it back.
 *
 * The honest statement of the exposure: this API has no inbound
 * authentication, so anyone who can reach the port can obtain a launcher URL
 * and, by opening it first, create an app in the tenant. Restricting that needs
 * authentication, not a field omission.
 */
export function listBindingSessions(): ChannelBindingSession[] {
  const now = Date.now();
  sweep(now);
  return Array.from(getSessions().values()).map((entry) => entry.session);
}

/**
 * Cancel an in-flight attempt and report the resulting state. Cancelling an
 * already-settled attempt is a no-op that still returns its real status, so a
 * caller is never told "cancelled" about an attempt that actually succeeded.
 */
export function cancelBindingSession(id: string): ChannelBindingSession | undefined {
  const entry = getSessions().get(id);
  if (!entry) return undefined;
  if (entry.session.status === "awaiting_scan") {
    entry.abort.abort();
    settle(entry, "cancelled");
    publish(entry);
  }
  return entry.session;
}

/**
 * Remove the local binding. This does not delete the Feishu app: there is no
 * confirmed API for that (design risk R4), so the UI must say the app is left
 * behind rather than implying it is cleaned up.
 */
export function unbindAgent(agentId: string): boolean {
  ensureDatabase();
  const binding = getChannelBindingForAgent(agentId, CHANNEL);
  if (!binding) return false;
  const removed = deleteChannelBinding(binding.id);

  if (removed) {
    // Removing the row is not enough: the live connection would keep speaking
    // as this agent until the process restarted. Imported lazily because the
    // connection module reads bindings from this one.
    void import("@/server/channels/feishu/connection")
      .then((mod) => mod.disconnectFeishuApp(binding.appId))
      .catch(() => {
        // The binding is gone; failing to close the socket is not actionable
        // here, and the next start sweeps anything left behind.
      });
  }

  return removed;
}

export function clearBindingSessionsForTests(): void {
  for (const entry of getSessions().values()) {
    if (entry.session.status === "awaiting_scan") entry.abort.abort();
  }
  getSessions().clear();
}
