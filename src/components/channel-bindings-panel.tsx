"use client";

import { Clock3, ExternalLink, Loader2, MessageSquare, QrCode, RefreshCw, Search, Unlink } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useAppStore } from "@/stores/app-store";
import { Modal } from "@/components/ui/modal";
import { Feedback } from "@/components/ui/controls";
import { AgentAvatar } from "@/components/agent-avatar";
import type {
  ChannelBinding,
  ChannelBindingSession,
  ChannelConnectionInfo
} from "@/shared/types";

/**
 * What the UI should show for one agent. Extracted as a pure function so the
 * state machine is testable without a DOM — the repository's component tests
 * follow this pattern.
 */
export type AgentBindingState =
  | { kind: "unbound" }
  | { kind: "binding"; session: ChannelBindingSession }
  | { kind: "bound"; appId: string; bindingId: string | null }
  | { kind: "failed"; session: ChannelBindingSession };

export function deriveAgentBindingState(
  agentId: string,
  binding: ChannelBinding | undefined,
  sessions: Record<string, ChannelBindingSession>
): AgentBindingState {
  // A stored binding wins: the server refuses a new attempt while one exists, so
  // a live session here would be a stale leftover rather than a real attempt.
  if (binding) return { kind: "bound", appId: binding.appId, bindingId: binding.id };

  const mine = Object.values(sessions).filter((session) => session.agentId === agentId);

  const waiting = mine.find((session) => session.status === "awaiting_scan");
  if (waiting) return { kind: "binding", session: waiting };

  // A success event names the app it created, so the row can say "bound"
  // straight away. Falling through to "unbound" here used to make a completed
  // scan look like it had failed, because nothing else populated the binding
  // map until a refetch happened.
  const succeeded = mine.find((session) => session.status === "succeeded");
  if (succeeded) {
    return { kind: "bound", appId: succeeded.appId ?? "未知应用", bindingId: succeeded.bindingId ?? null };
  }

  // Sessions carry no creation timestamp, so when several failed attempts are
  // around the choice between them is arbitrary. Any of them conveys the same
  // thing: the last attempt did not succeed.
  const failed = mine.find((session) => session.status === "failed");
  if (failed) return { kind: "failed", session: failed };

  return { kind: "unbound" };
}

/** mm:ss until the launcher URL stops working. */
export function formatRemainingMs(remainingMs: number): string {
  if (remainingMs <= 0) return "已过期";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * A whole phrase rather than a duration, because concatenating one produced
 * "链接剩余 已过期". `expiresAt <= 0` means the client never learned the
 * deadline, which is not the same as the link having expired.
 */
export function describeLauncherWindow(expiresAt: number, now: number): string {
  if (expiresAt <= 0) return "链接已就绪";
  if (expiresAt <= now) return "链接已过期";
  return `链接剩余 ${formatRemainingMs(expiresAt - now)}`;
}

/**
 * The launcher URL is rendered into an href, so its scheme matters: a value that
 * is not https could navigate the user somewhere unwanted. The URL comes from
 * the server, but nothing downstream should have to trust that.
 */
export function isSafeLauncherUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Whether a stored binding row needs re-reading. Fires when a session reported a
 * success that the local map does not reflect — including the case where the map
 * holds a *different* binding for that agent, which a plain "do we have a
 * binding?" test would never correct.
 *
 * Extracted so the condition is testable; it previously lived inline with no
 * coverage at all, and deleting it broke nothing in the suite.
 */
export function shouldRefreshBindings(
  sessions: Record<string, ChannelBindingSession>,
  bindings: Record<string, ChannelBinding>
): boolean {
  return Object.values(sessions).some(
    (session) =>
      session.status === "succeeded" &&
      session.bindingId !== undefined &&
      bindings[session.agentId]?.id !== session.bindingId
  );
}

/**
 * How to describe a connection, or `null` when there is nothing to say.
 *
 * `null` matters: a connection the client has not heard about yet must not be
 * rendered as broken. "Bound but not connected" is a real and confusing state
 * — the bot exists in the group but cannot receive anything — so it is shown
 * distinctly rather than folded into "unbound".
 */
export function describeConnection(
  info: ChannelConnectionInfo | undefined
): { tone: "ok" | "warn" | "muted"; text: string } | null {
  if (!info) return null;
  switch (info.status) {
    case "connected":
      // A reason can be present while connected: a `bot_loop` guard trip is
      // reported against the current status. Dropping it here is what made the
      // guard look silent even after it had fired.
      return info.lastError
        ? { tone: "warn", text: `已连接，但最近有事件被拒：${info.lastError}` }
        : { tone: "ok", text: info.botName ? `已连接 · ${info.botName}` : "已连接" };
    case "reconnected":
      return info.lastError ? { tone: "warn", text: `已重连，但最近有事件被拒：${info.lastError}` } : { tone: "ok", text: "已重连" };
    case "reconnecting":
      return { tone: "warn", text: "连接中断，重连中" };
    case "disconnected":
      return { tone: "muted", text: "已断开" };
    case "error":
      return { tone: "warn", text: info.lastError ? `连接失败：${info.lastError}` : "连接失败" };
  }
}

export function bindingNeedsAttention(state: AgentBindingState, connection: ChannelConnectionInfo | undefined, now: number): boolean {
  if (state.kind === "failed") return true;
  if (state.kind === "binding") return state.session.expiresAt > 0 && state.session.expiresAt <= now;
  if (state.kind !== "bound" || !connection) return false;
  return Boolean(connection.lastError) || ["error", "disconnected", "reconnecting"].includes(connection.status);
}

type BindingFilter = "all" | "bound" | "unbound" | "attention";

export function ChannelBindingsPanel({ active = true }: { active?: boolean }) {
  const agents = useAppStore((state) => state.agents);
  const agentIds = useAppStore((state) => state.agentIds);
  const bindings = useAppStore((state) => state.channelBindings);
  const sessions = useAppStore((state) => state.channelBindingSessions);
  const connections = useAppStore((state) => state.channelConnections);
  const error = useAppStore((state) => state.channelBindingError);
  const loaded = useAppStore((state) => state.channelBindingsLoaded);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [unbindAgentId, setUnbindAgentId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<BindingFilter>("all");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const actionBusy = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Passive read: it must not erase a message from an action that just failed.
    void useAppStore.getState().loadChannelBindings({ preserveError: true }).catch(() => {});
    // Connection health is a separate read. It also (re)starts anything missing,
    // so a binding created while the server was already running comes up without
    // a restart.
    void useAppStore.getState().loadChannelConnections();
  }, []);

  // A scan that finished on the server arrives as an event naming the app id but
  // not the whole binding row, so pull the row once. Also fires when the row we
  // hold is a *different* binding than the one the event named — the stale-row
  // case, where a plain "do we have a binding?" test would never correct itself.
  const needsBindingRefresh = useMemo(
    () => shouldRefreshBindings(sessions, bindings),
    [sessions, bindings]
  );
  useEffect(() => {
    if (needsBindingRefresh) {
      void useAppStore.getState().loadChannelBindings({ preserveError: true }).catch(() => {});
    }
  }, [needsBindingRefresh]);

  // Drives the countdown on the launcher URL. One interval for the panel rather
  // than one per row.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const states = useMemo(
    () =>
      agentIds.map((agentId) => ({
        agentId,
        agent: agents[agentId],
        state: deriveAgentBindingState(agentId, bindings[agentId], sessions)
      })),
    [agentIds, agents, bindings, sessions]
  );

  const activeEntry = states.find((entry) => entry.state.kind === "binding");
  const activeSession =
    activeEntry && activeEntry.state.kind === "binding" ? activeEntry.state.session : null;
  const activeAgentName = activeEntry
    ? agents[activeEntry.agentId]?.name ?? activeEntry.agentId
    : "";

  const run = async (agentId: string, action: () => Promise<void>) => {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setBusyAgentId(agentId);
    try {
      await action();
    } catch {
      // The store records the message; the banner below renders it.
    } finally {
      actionBusy.current = false;
      setBusyAgentId(null);
    }
  };

  const counts = {
    all: states.length,
    bound: states.filter(entry => entry.state.kind === "bound").length,
    unbound: states.filter(entry => entry.state.kind === "unbound").length,
    attention: states.filter(entry => bindingNeedsAttention(entry.state, connections[entry.agentId], now)).length
  };
  const connectedCount = states.filter(entry => entry.state.kind === "bound" && ["connected", "reconnected"].includes(connections[entry.agentId]?.status ?? "")).length;
  const visible = states.filter(({ agentId, agent, state }) => {
    if (filter === "bound" && state.kind !== "bound") return false;
    if (filter === "unbound" && state.kind !== "unbound") return false;
    if (filter === "attention" && !bindingNeedsAttention(state, connections[agentId], now)) return false;
    return [agent?.name, agentId, state.kind === "bound" ? state.appId : "", connections[agentId]?.botName].join(" ").toLowerCase().includes(query.trim().toLowerCase());
  });
  const disabled = !loaded || busyAgentId !== null || refreshing;
  const refresh = async () => {
    if (actionBusy.current) return;
    actionBusy.current = true; setRefreshing(true);
    try {
      await useAppStore.getState().loadChannelBindings();
      await useAppStore.getState().loadChannelConnections();
    } catch { /* The store retains the visible error. */ }
    finally { actionBusy.current = false; setRefreshing(false); }
  };

  return <section className="channel-settings" aria-label="渠道绑定">
    <header className="channel-section-heading"><h3>渠道绑定</h3><button className="ui-button" aria-label="刷新渠道状态" title="刷新渠道状态" disabled={refreshing || busyAgentId !== null} onClick={() => void refresh()}><RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />{refreshing ? "刷新中…" : "刷新状态"}</button></header>
    <div className="channel-platform"><span className="channel-platform-icon"><MessageSquare size={22} strokeWidth={1.7} /></span>
      <div><h4>飞书 <span>Feishu</span></h4><p>长连接</p></div>
      <div className="channel-platform-counts"><span><strong>{loaded ? counts.bound : "—"}</strong>已绑定</span><span><strong>{loaded ? connectedCount : "—"}</strong>已连接</span></div>
    </div>
    {error ? <div className="channel-error"><Feedback>{error}</Feedback></div> : null}
    <div className="channel-toolbar"><div className="channel-filters" role="group" aria-label="绑定状态筛选">
      {([{ id: "all", label: "全部" }, { id: "bound", label: "已绑定" }, { id: "unbound", label: "未绑定" }, { id: "attention", label: "需处理" }] as const).map(item =>
        <button key={item.id} aria-label={item.label} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}<span aria-hidden="true">{loaded ? counts[item.id] : "—"}</span></button>)}
    </div><label className="channel-search"><Search size={14} /><input ref={searchInput} aria-label="搜索渠道 Agent" placeholder="搜索 Agent 或应用…" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
    {!loaded ? <p className="channel-loading" role="status"><Loader2 size={14} className="animate-spin" />正在读取绑定状态…</p> : null}
    <div className="channel-table-heading" aria-hidden="true"><span>Agent</span><span>飞书应用</span><span>连接状态</span><span>操作</span></div>
    <ul className="channel-agent-list" aria-label="飞书 Agent 绑定列表">
      {visible.map(({ agentId, agent, state }) => {
        const connection = connections[agentId];
        const detail = state.kind === "failed" ? state.session.error ?? "绑定未完成" : state.kind === "bound" ? connection?.lastError : null;
        return <li key={agentId} className="channel-agent-row">
          <div className="channel-agent-identity">{agent ? <AgentAvatar agent={agent} /> : null}
            <div><strong title={agentId}>{agent?.name ?? agentId}</strong><small>{agent?.isConductor ? "主协调者" : agent?.capabilities[0] ?? "Agent"}</small></div>
          </div>
          <div className="channel-application">{loaded && state.kind === "bound" ? <><span>{connection?.botName || "已绑定应用"}</span><code title={state.appId}>{state.appId}</code></> : <span className="channel-muted">{!loaded ? "—" : state.kind === "binding" ? "正在绑定" : state.kind === "failed" ? "未完成绑定" : "未绑定应用"}</span>}</div>
          <div className="channel-agent-health"><BindingStatus state={state} now={now} connection={connection} loaded={loaded} /></div>
          <div className="channel-agent-actions">
            {state.kind === "bound" ? <button className="ui-icon-button channel-unbind" type="button" aria-label={`解绑 ${agent?.name ?? agentId} 的飞书应用`} title="解绑飞书应用" disabled={disabled} onClick={() => setUnbindAgentId(agentId)}><Unlink size={15} /></button>
              : state.kind === "binding" ? <button className="ui-button ui-button--quiet" aria-label={`取消 ${agent?.name ?? agentId} 的绑定`} disabled={disabled} onClick={() => void run(agentId, () => useAppStore.getState().cancelChannelBindingSession(state.session.id))}>取消</button>
                : <button className="ui-button" type="button" aria-label={`绑定 ${agent?.name ?? agentId} 到飞书`} disabled={disabled} onClick={() => void run(agentId, () => useAppStore.getState().startFeishuBinding(agentId))}>
                  {busyAgentId === agentId ? <Loader2 size={14} className="animate-spin" /> : <QrCode size={14} />}{state.kind === "failed" ? "重试绑定" : "绑定飞书"}</button>}
          </div>
          {detail ? <details className="channel-row-error"><summary>查看原因</summary><p>{detail}</p></details> : null}
        </li>;
      })}
    </ul>
    {loaded && !visible.length ? <div className="channel-empty"><Search size={24} strokeWidth={1.5} /><p>{states.length ? "没有匹配的 Agent" : "暂无 Agent"}</p>{states.length ? <button className="ui-button ui-button--quiet" onClick={() => { setQuery(""); setFilter("all"); searchInput.current?.focus(); }}>查看全部</button> : null}</div> : null}
    {unbindAgentId ? <Modal open onClose={() => setUnbindAgentId(null)} title="解绑飞书应用？" size="small" busy={busyAgentId !== null}
      footer={<>{error ? <Feedback>{error}</Feedback> : null}<button className="ui-button" disabled={busyAgentId !== null} onClick={() => setUnbindAgentId(null)}>取消</button>
        <button className="ui-button ui-button--danger" disabled={busyAgentId !== null} onClick={() => void run(unbindAgentId, async () => { await useAppStore.getState().unbindFeishu(unbindAgentId); setUnbindAgentId(null); })}>{busyAgentId ? <Loader2 size={14} className="animate-spin" /> : <Unlink size={14} />}确认解绑</button></>}>
      <div className="channel-unbind-identity"><strong>{agents[unbindAgentId]?.name ?? unbindAgentId}</strong><code>{bindings[unbindAgentId]?.appId}</code></div>
      <p className="ui-muted">仅移除本地绑定，不会删除飞书侧应用。</p>
    </Modal> : null}
    {active && activeSession ? <LauncherDialog key={activeSession.id} agentName={activeAgentName} session={activeSession} now={now}
      onCancel={() => useAppStore.getState().cancelChannelBindingSession(activeSession.id)}
      onRenew={async () => { await useAppStore.getState().cancelChannelBindingSession(activeSession.id); await useAppStore.getState().startFeishuBinding(activeSession.agentId); }} /> : null}
  </section>;
}

function BindingStatus({ state, now, connection, loaded }: { state: AgentBindingState; now: number; connection: ChannelConnectionInfo | undefined; loaded: boolean }) {
  let text = "未绑定";
  let tone = "muted";
  if (!loaded) text = "读取中";
  else if (state.kind === "failed") { text = "绑定失败"; tone = "warn"; }
  else if (state.kind === "binding") {
    const expired = state.session.expiresAt > 0 && state.session.expiresAt <= now;
    text = expired ? "链接已过期" : "等待确认"; tone = expired ? "warn" : "pending";
  } else if (state.kind === "bound") {
    text = !connection ? "状态未知" : connection.status === "connected" ? "已连接" : connection.status === "reconnected" ? "已重连" : connection.status === "reconnecting" ? "重连中" : connection.status === "error" ? "连接失败" : "已断开";
    tone = describeConnection(connection)?.tone ?? "muted";
    if (connection?.lastError && ["connected", "reconnected"].includes(connection.status)) text = "连接有告警";
  }
  return <span className={`channel-status channel-status--${tone}`}><span />{text}</span>;
}

function LauncherDialog({
  agentName,
  session,
  now,
  onCancel,
  onRenew
}: {
  agentName: string;
  session: ChannelBindingSession;
  now: number;
  onCancel: () => Promise<void>;
  onRenew: () => Promise<void>;
}) {
  const url = session.qrUrl;
  const safe = isSafeLauncherUrl(url);
  const expired = session.expiresAt > 0 && session.expiresAt <= now;
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const actionBusy = useRef(false);
  const act = async (action: () => Promise<void>) => {
    if (actionBusy.current) return;
    actionBusy.current = true;
    setCancelling(true);
    setCancelError(null);
    try { await action(); } catch (error) { setCancelError(error instanceof Error ? error.message : "操作失败。"); }
    finally { actionBusy.current = false; setCancelling(false); }
  };

  return (
    <Modal open onClose={() => void act(onCancel)} title={`绑定飞书 · ${agentName}`} size="medium" className="channel-launcher-dialog" busy={cancelling}
      footer={<>{cancelError ? <Feedback>{cancelError}</Feedback> : null}<button className="ui-button" onClick={() => void act(onCancel)} disabled={cancelling}>取消绑定</button>
        {expired || !safe ? <button className="ui-button ui-button--primary" onClick={() => void act(onRenew)} disabled={cancelling}>{cancelling ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}重新获取</button> : null}</>}>
      <div className="channel-launcher-layout"><div className={`channel-qr ${safe && !expired ? "" : "is-unavailable"}`}>
        {safe && !expired ? <QRCodeSVG role="img" aria-label="飞书绑定二维码" value={url!} size={176} marginSize={2} /> : <QrCode size={76} strokeWidth={1} aria-hidden="true" />}
      </div><div className="channel-launcher-details">
        <span className="channel-launcher-platform"><MessageSquare size={15} />飞书</span>
        <h3>{expired ? "二维码已过期" : safe ? "等待扫码确认" : url ? "绑定链接不可用" : "二维码暂不可用"}</h3>
        <p className="channel-launcher-agent">{agentName}</p>
        <span className={`channel-launcher-time ${expired ? "is-expired" : ""}`}><Clock3 size={13} />{expired || safe ? describeLauncherWindow(session.expiresAt, now) : "等待重新获取"}</span>
        {safe && !expired ? <a className="ui-button" href={url} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} />打开确认页</a> : null}
        {!safe && url ? <Feedback>绑定链接不是有效的 HTTPS 地址，已阻止打开。</Feedback> : null}
      </div></div>
    </Modal>
  );
}
