"use client";

import { CheckCircle2, Loader2, QrCode, Unlink, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useAppStore } from "@/stores/app-store";
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
      return { tone: "ok", text: info.botName ? `已连接 · ${info.botName}` : "已连接" };
    case "reconnected":
      return { tone: "ok", text: "已重连" };
    case "reconnecting":
      return { tone: "warn", text: "连接中断，重连中" };
    case "disconnected":
      return { tone: "muted", text: "已断开" };
    case "error":
      return { tone: "warn", text: info.lastError ? `连接失败：${info.lastError}` : "连接失败" };
  }
}

export function ChannelBindingsPanel() {
  const agents = useAppStore((state) => state.agents);
  const agentIds = useAppStore((state) => state.agentIds);
  const bindings = useAppStore((state) => state.channelBindings);
  const sessions = useAppStore((state) => state.channelBindingSessions);
  const connections = useAppStore((state) => state.channelConnections);
  const error = useAppStore((state) => state.channelBindingError);
  const loaded = useAppStore((state) => state.channelBindingsLoaded);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

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
    setBusyAgentId(agentId);
    try {
      await action();
    } catch {
      // The store records the message; the banner below renders it.
    } finally {
      setBusyAgentId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-stone-950">飞书渠道</h3>
        <p className="mt-1 text-xs leading-5 text-stone-500">
          每个 Agent 绑定一个独立的飞书应用，保留自己的名称与发言身份。点击绑定后扫码确认即可。
          <br />
          解绑只删除本地记录，<strong>不会删除飞书侧的应用</strong>，需要时请到开发者后台处理。
        </p>
      </div>

      {error ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      ) : null}

      {!loaded ? (
        <div className="flex items-center gap-2 text-xs text-stone-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在读取绑定状态…
        </div>
      ) : null}

      <ul className="divide-y divide-stone-100 rounded-md border border-stone-200">
        {states.map(({ agentId, agent, state }) => (
          <li key={agentId} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm text-stone-900">
                {agent?.name ?? agentId}
                <span className="ml-2 text-xs text-stone-400">{agentId}</span>
              </div>
              <BindingStatusLine state={state} now={now} connection={connections[agentId]} />
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {state.kind === "bound" ? (
                <button
                  type="button"
                  aria-label={`解绑 ${agent?.name ?? agentId} 的飞书应用`}
                  disabled={busyAgentId !== null}
                  onClick={() => void run(agentId, () => useAppStore.getState().unbindFeishu(agentId))}
                  className="flex items-center gap-1 rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50"
                >
                  <Unlink className="h-3.5 w-3.5" /> 解绑
                </button>
              ) : state.kind === "binding" ? (
                <button
                  type="button"
                  aria-label={`取消 ${agent?.name ?? agentId} 的绑定`}
                  disabled={busyAgentId !== null}
                  onClick={() =>
                    void run(agentId, () =>
                      useAppStore.getState().cancelChannelBindingSession(state.session.id)
                    )
                  }
                  className="rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50"
                >
                  取消
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={`绑定 ${agent?.name ?? agentId} 到飞书`}
                  disabled={busyAgentId !== null}
                  onClick={() => void run(agentId, () => useAppStore.getState().startFeishuBinding(agentId))}
                  className="flex items-center gap-1 rounded-md bg-stone-900 px-2 py-1 text-xs text-white hover:bg-stone-700 disabled:opacity-50"
                >
                  {busyAgentId === agentId ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <QrCode className="h-3.5 w-3.5" />
                  )}
                  绑定飞书
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {activeSession ? (
        <LauncherDialog
          agentName={activeAgentName}
          session={activeSession}
          now={now}
          onCancel={() => void useAppStore.getState().cancelChannelBindingSession(activeSession.id)}
        />
      ) : null}
    </div>
  );
}

function BindingStatusLine({
  state,
  now,
  connection
}: {
  state: AgentBindingState;
  now: number;
  connection: ChannelConnectionInfo | undefined;
}) {
  if (state.kind === "bound") {
    const described = describeConnection(connection);
    const tone =
      described?.tone === "warn"
        ? "text-amber-700"
        : described?.tone === "muted"
          ? "text-stone-400"
          : "text-emerald-700";
    return (
      <div className="space-y-0.5">
        <div className="flex items-center gap-1 text-xs text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" />
          已绑定 · {state.appId}
        </div>
        {described ? (
          <div className={`text-xs ${tone}`}>{described.text}</div>
        ) : (
          // Deliberately not "未连接": the client may simply not have read the
          // health endpoint yet, and claiming a fault would be wrong.
          <div className="text-xs text-stone-400">连接状态未知</div>
        )}
      </div>
    );
  }
  if (state.kind === "binding") {
    return (
      <div className="text-xs text-stone-500">
        等待扫码 · {describeLauncherWindow(state.session.expiresAt, now)}
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <div className="flex items-center gap-1 text-xs text-amber-700">
        <XCircle className="h-3.5 w-3.5" />
        {state.session.error ?? "绑定未完成"}
      </div>
    );
  }
  return <div className="text-xs text-stone-400">未绑定</div>;
}

function LauncherDialog({
  agentName,
  session,
  now,
  onCancel
}: {
  agentName: string;
  session: ChannelBindingSession;
  now: number;
  onCancel: () => void;
}) {
  const url = session.qrUrl;
  const safe = isSafeLauncherUrl(url);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feishu-launcher-title"
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
      >
        <h3 id="feishu-launcher-title" className="text-sm font-semibold text-stone-950">
          用飞书扫码绑定「{agentName}」
        </h3>
        <p className="mt-1 text-xs leading-5 text-stone-500">
          扫码后在确认页完成创建。{describeLauncherWindow(session.expiresAt, now)}。
        </p>

        <div className="mt-4 grid place-items-center rounded-md border border-stone-200 p-4">
          {safe ? <QRCodeSVG value={url!} size={180} /> : null}
        </div>

        {safe ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-3 block break-all text-xs text-blue-600 hover:underline"
          >
            {url}
          </a>
        ) : url ? (
          // Present but not https: refuse to navigate or render it.
          <p className="mt-3 break-all text-xs text-amber-700">
            服务端返回的绑定链接不是 https，已拒绝跳转与渲染：{url}
          </p>
        ) : (
          // Absent is a different situation from unsafe, and saying "not https"
          // about a missing URL was simply false. It happens while the list is
          // still loading or if the server dropped the URL on settle.
          <p className="mt-3 text-xs text-stone-500">正在获取二维码…</p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 rounded-md border border-stone-200 px-3 text-xs text-stone-600 hover:bg-stone-50"
          >
            取消绑定
          </button>
        </div>
      </div>
    </div>
  );
}
