import type { LarkChannel } from "@larksuite/channel";
import type { ChannelBinding, ChannelConnectionInfo, ChannelConnectionStatus } from "@/shared/types";

/**
 * The live connections, and how to ask about them.
 *
 * Split out from the module that ESTABLISHES connections so that the things
 * which merely need to know "which channel belongs to this agent" — the message
 * projection, the run progress cards, the card handlers — do not have to import
 * the connection lifecycle, which in turn imports the card handler. That was a
 * genuine import cycle: harmless while every use sat inside a function, and a
 * trap for the first one that did not.
 */

export interface ConnectionEntry {
  binding: ChannelBinding;
  /** `null` on a failed attempt: the entry exists to REPORT the failure. */
  channel: LarkChannel | null;
  status: ChannelConnectionStatus;
  botOpenId: string | null;
  botName: string | null;
  lastError: string | null;
  connectedAt: number | null;
  /** When this app was last attempted, so a failure is not retried in a loop. */
  lastAttemptAt: number;
}

declare global {
  var __agentMeldFeishuConnections: Map<string, ConnectionEntry> | undefined;
  var __agentMeldFeishuStarting: Promise<ChannelConnectionInfo[]> | undefined;
  /**
   * Bumped by every `stop`. A start that began before a stop must not register
   * its connection afterwards — otherwise stopping during a connect would leave
   * a live connection nothing holds a reference to, which is worse than either
   * outcome on its own.
   */
  var __agentMeldFeishuStopEpoch: number | undefined;
}

/**
 * Keyed by **appId**, not agentId: the platform splits an app's events across
 * two live connections, so a second connection for the same app silently halves
 * what each one receives (R6). Keying by app makes that structurally impossible
 * rather than a rule someone has to remember.
 */
export function getRegistry(): Map<string, ConnectionEntry> {
  globalThis.__agentMeldFeishuConnections ??= new Map<string, ConnectionEntry>();
  return globalThis.__agentMeldFeishuConnections;
}

export function getStopEpoch(): number {
  globalThis.__agentMeldFeishuStopEpoch ??= 0;
  return globalThis.__agentMeldFeishuStopEpoch;
}

/**
 * The live channel for an agent, for outbound projection. `null` when that
 * agent has no binding, or its connection failed — callers must treat that as
 * "this agent has no Feishu presence", never as "use someone else's".
 */
export function getFeishuChannelForAgent(agentId: string): LarkChannel | null {
  for (const entry of getRegistry().values()) {
    if (entry.binding.agentId === agentId && entry.channel) return entry.channel;
  }
  return null;
}

export function listFeishuConnections(): ChannelConnectionInfo[] {
  return [...getRegistry().values()].map((entry) => ({
    agentId: entry.binding.agentId,
    appId: entry.binding.appId,
    status: entry.status,
    botOpenId: entry.botOpenId,
    botName: entry.botName,
    lastError: entry.lastError,
    connectedAt: entry.connectedAt
  }));
}

export function resetFeishuConnectionsForTests(): void {
  globalThis.__agentMeldFeishuConnections = undefined;
  globalThis.__agentMeldFeishuStarting = undefined;
  globalThis.__agentMeldFeishuStopEpoch = undefined;
}
