"use client";

import { CheckCircle2, Loader2, QrCode, Unlink, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useAppStore } from "@/stores/app-store";
import type { ChannelBinding, ChannelBindingSession } from "@/shared/types";

/**
 * What the UI should show for one agent. Extracted as a pure function so the
 * state machine is testable without a DOM — the repository's component tests
 * follow this pattern.
 */
export type AgentBindingState =
  | { kind: "unbound" }
  | { kind: "binding"; session: ChannelBindingSession }
  | { kind: "bound"; binding: ChannelBinding }
  | { kind: "failed"; session: ChannelBindingSession };

export function deriveAgentBindingState(
  agentId: string,
  binding: ChannelBinding | undefined,
  sessions: Record<string, ChannelBindingSession>
): AgentBindingState {
  // A stored binding wins: the server refuses a new attempt while one exists, so
  // a live session here would be a stale leftover rather than a real attempt.
  if (binding) return { kind: "bound", binding };

  const mine = Object.values(sessions).filter((session) => session.agentId === agentId);
  const waiting = mine.find((session) => session.status === "awaiting_scan");
  if (waiting) return { kind: "binding", session: waiting };

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

export function ChannelBindingsPanel() {
  const agents = useAppStore((state) => state.agents);
  const agentIds = useAppStore((state) => state.agentIds);
  const bindings = useAppStore((state) => state.channelBindings);
  const sessions = useAppStore((state) => state.channelBindingSessions);
  const error = useAppStore((state) => state.channelBindingError);
  const loaded = useAppStore((state) => state.channelBindingsLoaded);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void useAppStore.getState().loadChannelBindings().catch(() => {});
  }, []);

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
    activeEntry && activeEntry.state.kind === "binding" && activeEntry.state.session.qrUrl
      ? activeEntry.state.session
      : null;
  const activeAgentName = activeEntry
    ? agents[activeEntry.agentId]?.name ?? activeEntry.agentId
    : "";

  const run = async (agentId: string, action: () => Promise<void>) => {
    setBusyAgentId(agentId);
    try {
      await action();
    } catch {
      // The store records the message; nothing else to do here.
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
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
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
              <BindingStatusLine state={state} now={now} />
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {state.kind === "bound" ? (
                <button
                  type="button"
                  disabled={busyAgentId !== null}
                  onClick={() => void run(agentId, () => useAppStore.getState().unbindFeishu(agentId))}
                  className="flex items-center gap-1 rounded-md border border-stone-200 px-2 py-1 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50"
                >
                  <Unlink className="h-3.5 w-3.5" /> 解绑
                </button>
              ) : state.kind === "binding" ? (
                <button
                  type="button"
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
          onClose={() =>
            void useAppStore.getState().cancelChannelBindingSession(activeSession.id)
          }
        />
      ) : null}
    </div>
  );
}

function BindingStatusLine({ state, now }: { state: AgentBindingState; now: number }) {
  if (state.kind === "bound") {
    return (
      <div className="flex items-center gap-1 text-xs text-emerald-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        已绑定 · {state.binding.appId}
      </div>
    );
  }
  if (state.kind === "binding") {
    return (
      <div className="text-xs text-stone-500">
        等待扫码 · 链接剩余 {formatRemainingMs(state.session.expiresAt - now)}
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
  onClose
}: {
  agentName: string;
  session: ChannelBindingSession;
  now: number;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-stone-950/40 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl">
        <h3 className="text-sm font-semibold text-stone-950">用飞书扫码绑定「{agentName}」</h3>
        <p className="mt-1 text-xs leading-5 text-stone-500">
          扫码后在确认页完成创建。链接剩余 {formatRemainingMs(session.expiresAt - now)}。
        </p>

        <div className="mt-4 grid place-items-center rounded-md border border-stone-200 p-4">
          {session.qrUrl ? <QRCodeSVG value={session.qrUrl} size={180} /> : null}
        </div>

        {session.qrUrl ? (
          <a
            href={session.qrUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 block break-all text-xs text-blue-600 hover:underline"
          >
            {session.qrUrl}
          </a>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-stone-200 px-3 text-xs text-stone-600 hover:bg-stone-50"
          >
            取消绑定
          </button>
        </div>
      </div>
    </div>
  );
}
