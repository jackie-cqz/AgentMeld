"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, requestJson } from "@/lib/request-json";

/**
 * The client half of the #24 gate.
 *
 * Every API call the app makes now resolves a principal, and an unpaired or
 * unauthenticated caller is refused. Rather than teach a dozen panels to
 * handle 401/503, this component sits above the whole app and answers one
 * question before anything renders: can this browser reach the API?
 *
 * - Install not paired yet → offer one-click pairing on this machine (mint a
 *   code, redeem it immediately, the cookie lands in this browser).
 * - Install paired but this browser has no live session → ask for a code
 *   minted from any device that still has one (or `pnpm run auth:reset` on
 *   the machine itself if none do).
 *
 * A successful pairing ends with a full page reload, so the EventSource and
 * every panel reconnect with the new cookie.
 */

type Phase = "checking" | "unpaired" | "need-session" | "ready";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await requestJson<{ paired: boolean }>("/api/auth/status", { cache: "no-store" });
        if (cancelled) return;
        if (!status.paired) {
          setPhase("unpaired");
          return;
        }
        // Paired install: does this browser carry a live session?
        try {
          await requestJson("/api/auth/sessions", { cache: "no-store" });
          if (!cancelled) setPhase("ready");
        } catch (error) {
          if (cancelled) return;
          if (error instanceof ApiRequestError && (error.status === 401 || error.status === 503)) {
            setPhase("need-session");
            return;
          }
          throw error;
        }
      } catch {
        if (!cancelled) setPhase("need-session");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === "checking") {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f7f6f2]">
        <div className="rounded-md border border-stone-200 bg-white px-5 py-4 text-sm text-stone-600 shadow-sm">
          正在检查访问权限...
        </div>
      </main>
    );
  }

  if (phase === "ready") return <>{children}</>;
  return <PairingScreen mode={phase === "unpaired" ? "first" : "reentry"} />;
}

function PairingScreen({ mode }: { mode: "first" | "reentry" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const pairHere = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const minted = await requestJson<{ code: string }>("/api/auth/pair/code", { method: "POST" });
      await requestJson("/api/auth/pair", { method: "POST", body: JSON.stringify({ code: minted.code }) });
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "配对失败");
      setBusy(false);
    }
  }, []);

  const redeem = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await requestJson("/api/auth/pair", { method: "POST", body: JSON.stringify({ code }) });
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "配对码无效");
      setBusy(false);
    }
  }, [code]);

  return (
    <main className="grid min-h-screen place-items-center bg-[#f7f6f2] p-6">
      <div className="w-full max-w-sm rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <h1 className="text-base font-semibold text-stone-800">
          {mode === "first" ? "初始化 AgentMeld" : "需要验证"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          {mode === "first"
            ? "这台 AgentMeld 还没有配对过。首次使用需要建立所有者会话，之后其他设备通过配对码接入。"
            : "这个安装已配对，但当前浏览器没有有效会话。请在任一仍可使用的设备上生成配对码后输入；若所有会话都已失效，在运行 AgentMeld 的机器上执行 pnpm run auth:reset。"}
        </p>

        {mode === "first" ? (
          <button
            type="button"
            onClick={pairHere}
            disabled={busy}
            className="mt-4 w-full rounded-md bg-stone-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "正在配对..." : "在本机完成配对"}
          </button>
        ) : (
          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void redeem();
            }}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6 位配对码"
              inputMode="numeric"
              maxLength={6}
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm tracking-widest outline-none focus:border-stone-500"
            />
            <button
              type="submit"
              disabled={busy || code.length !== 6}
              className="shrink-0 rounded-md bg-stone-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "验证中..." : "接入"}
            </button>
          </form>
        )}

        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      </div>
    </main>
  );
}
