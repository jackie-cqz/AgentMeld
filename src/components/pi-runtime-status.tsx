"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, RefreshCw, Terminal, TriangleAlert } from "lucide-react";
import { requestJson } from "@/lib/request-json";

interface PiStatus { available: boolean; expectedVersion: string; installedVersion: string | null; nodeVersion: string; error: string | null }

export function PiRuntimeStatus({ open }: { open: boolean }) {
  const [status, setStatus] = useState<PiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    requestJson<PiStatus>("/api/runtime/pi", { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setStatus(value); setError(null); } })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Pi 状态读取失败。"); });
    return () => controller.abort();
  }, [open, revision]);
  return <div className="mb-4 border-b border-[var(--ui-border)] pb-3">
    <div className="flex items-center gap-2 text-sm"><Terminal size={16} /><strong>Pi</strong>
      {status?.available ? <><CheckCircle2 size={14} className="text-emerald-600" /><span className="ui-muted">{status.installedVersion} · 安装就绪</span></>
        : status || error ? <TriangleAlert size={15} className="text-amber-600" /> : <span className="ui-muted">正在检查安装</span>}
      <button type="button" className="ui-icon-button ml-auto" title="重新检查 Pi" aria-label="重新检查 Pi" onClick={() => { setStatus(null); setError(null); setRevision(value => value + 1); }}><RefreshCw size={14} /></button>
    </div>
    {error || status?.error ? <p role="alert" className="mt-2 text-xs text-red-700">{error || status?.error}</p> : null}
  </div>;
}
