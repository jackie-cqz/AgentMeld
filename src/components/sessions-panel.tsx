"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, MonitorSmartphone, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { requestJson } from "@/lib/request-json";

interface OwnerSession {
  id: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * The owner-facing half of #24: which devices hold a live session, revoke
 * them, and mint a pairing code for a new device. Lives in settings because
 * session lifetime outlives any one panel.
 */

function describeWhen(timestamp: number): string {
  const delta = Date.now() - timestamp;
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export function SessionsPanel() {
  const [sessions, setSessions] = useState<OwnerSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mintedCode, setMintedCode] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);

  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    requestJson<{ sessions: OwnerSession[] }>("/api/auth/sessions", { cache: "no-store", signal: controller.signal })
      .then((payload) => {
        setSessions(payload.sessions);
        setError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "读取会话失败");
      });
    return () => controller.abort();
  }, [reloadVersion]);

  const reload = useCallback(() => setReloadVersion((value) => value + 1), []);

  const revoke = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      await requestJson(`/api/auth/sessions/${id}`, { method: "DELETE" });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "撤销失败");
    } finally {
      setBusyId(null);
    }
  }, [reload]);

  const mint = useCallback(async () => {
    setMinting(true);
    setMintedCode(null);
    try {
      const payload = await requestJson<{ code: string; expiresAt: number }>("/api/auth/pair/code", { method: "POST" });
      setMintedCode(payload.code);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成配对码失败");
    } finally {
      setMinting(false);
    }
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <div className="text-sm font-medium text-slate-800">接入的设备</div>
        <p className="mt-1 text-xs text-slate-500">
          每台配对过的设备持有独立会话；撤销后该设备需要重新输入配对码。全部撤销后，只能在本机重新配对（或
          <code className="mx-1 rounded bg-slate-100 px-1 py-0.5 text-[11px]">pnpm run auth:reset</code>）。
        </p>
      </div>

      {error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div> : null}

      {sessions === null ? (
        <p role="status" className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 size={14} className="animate-spin" /> 正在读取会话...
        </p>
      ) : sessions.length === 0 ? (
        <p className="text-xs text-slate-500">当前没有活跃会话。</p>
      ) : (
        <ul className="divide-y divide-[var(--ui-line)] rounded-md border border-[var(--ui-line)]">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                {session.label === "companion" ? <Smartphone size={15} className="shrink-0 text-slate-400" /> : <MonitorSmartphone size={15} className="shrink-0 text-slate-400" />}
                <div className="min-w-0">
                  <div className="truncate text-sm text-slate-800">{session.label ?? "浏览器会话"}</div>
                  <div className="text-xs text-slate-400">
                    配对于 {describeWhen(session.createdAt)} · 活跃于 {describeWhen(session.lastSeenAt)}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void revoke(session.id)}
                disabled={busyId === session.id}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-stone-200 px-2.5 text-xs text-stone-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                title="撤销此会话"
              >
                {busyId === session.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                撤销
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-[var(--ui-line)] pt-4">
        <div className="text-sm font-medium text-slate-800">新设备配对</div>
        <p className="mt-1 text-xs text-slate-500">
          生成的 6 位配对码 5 分钟内有效、只能使用一次，在目标设备打开 AgentMeld 首页时输入。
        </p>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void mint()}
            disabled={minting}
            className="flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60"
          >
            {minting ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
            生成配对码
          </button>
          {mintedCode ? (
            <span className="rounded-md bg-slate-100 px-3 py-1.5 font-mono text-base tracking-[0.4em] text-slate-800">
              {mintedCode}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
