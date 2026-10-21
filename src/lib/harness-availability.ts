"use client";

import { useEffect, useState } from "react";
import type { HarnessAvailability } from "@/shared/harness-catalog";
import { requestJson } from "@/lib/request-json";

/**
 * Client-side reader for `/api/harnesses`.
 *
 * That endpoint is deliberately not in the bootstrap snapshot (it probes the
 * installed engine, it is not persisted state), so components that must not
 * claim an engine runs share this one read. The result is cached for the page
 * load; a failed read is never cached, so a later component can retry.
 */
let cached: HarnessAvailability[] | null = null;
let pending: Promise<HarnessAvailability[]> | null = null;

export function loadHarnessAvailability(): Promise<HarnessAvailability[]> {
  if (cached) return Promise.resolve(cached);
  pending ??= requestJson<{ harnesses?: HarnessAvailability[] }>("/api/harnesses")
    .then((payload) => {
      if (!Array.isArray(payload.harnesses)) throw new Error("执行引擎安装状态读取失败。");
      cached = payload.harnesses;
      return payload.harnesses;
    })
    .finally(() => { pending = null; });
  return pending;
}

/**
 * The runtime report, or `null` while it is still being read.
 *
 * `failed` is separate from "no report yet": a caller must render nothing (or a
 * refusal) rather than assume an engine is available when the read failed.
 */
export function useHarnessAvailability(): { availability: HarnessAvailability[] | null; failed: boolean } {
  const [value, setValue] = useState<{ availability: HarnessAvailability[] | null; failed: boolean }>(() =>
    cached ? { availability: cached, failed: false } : { availability: null, failed: false });
  useEffect(() => {
    let live = true;
    loadHarnessAvailability()
      .then((availability) => { if (live) setValue({ availability, failed: false }); })
      .catch(() => { if (live) setValue({ availability: [], failed: true }); });
    return () => { live = false; };
  }, []);
  return value;
}
