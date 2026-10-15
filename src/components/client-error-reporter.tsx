"use client";

import { useEffect } from "react";
import { useAppStore } from "@/stores/app-store";

/**
 * Report what the browser saw go wrong.
 *
 * A render crash leaves a blank page, and the console that explains it is on
 * the user's screen — not on the machine reading the logs. These listeners send
 * the message and stack to the server, where they appear as `[client-error]`
 * lines next to the server's own failures.
 *
 * Deliberately not wrapped in the app's error boundary: a boundary catches
 * render errors, this catches everything that escapes one — including the
 * unhandled promise rejections that a crashing stream tends to produce.
 */
export function ClientErrorReporter() {
  useEffect(() => {
    const report = (kind: "error" | "unhandledrejection", message: string, stack?: string) => {
      // sendBeacon survives a page that is about to go away; fetch keeps the
      // report testable. Both are best-effort.
      const payload = JSON.stringify({ kind, message: message.slice(0, 4000), stack: stack?.slice(0, 8000), url: location.href });
      try {
        void fetch("/api/client-errors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true
        }).catch(() => {});
      } catch {
        // Reporting must never be the thing that breaks the page.
      }
    };

    const onError = (event: ErrorEvent) => {
      report("error", event.message || String(event.error ?? "unknown error"), event.error?.stack);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      report(
        "unhandledrejection",
        reason instanceof Error ? reason.message : String(reason),
        reason instanceof Error ? reason.stack : undefined
      );
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}

/**
 * Self-check for the failure that leaves no trace at all: the page is alive —
 * it keeps polling — but nothing responds to a click. Nothing throws, so the
 * error listeners stay silent, and the person is left saying "it froze again"
 * with no evidence anywhere.
 *
 * Every 45 seconds this looks at what is actually on top of the page, whether
 * the live stream is still open, and how far the main thread has drifted from
 * its timer. Reported as a `stuck` event, it turns "it froze" into "an element
 * with class X covers the viewport and the stream is CLOSED".
 */
export function ClientStuckProbe() {
  useEffect(() => {
    const describe = (element: Element | null) => {
      if (!element) return "none";
      const cls = typeof element.className === "string" ? element.className.slice(0, 80) : "";
      return `${element.tagName.toLowerCase()}${cls ? "." + cls.split(/\s+/).join(".") : ""}`;
    };
    let last = Date.now();
    const timer = window.setInterval(() => {
      const drift = Date.now() - last - 45_000;
      last = Date.now();
      const center = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      const covering: string[] = [];
      for (const element of Array.from(document.querySelectorAll("body *"))) {
        const rect = element.getBoundingClientRect();
        if (rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9) {
          const style = getComputedStyle(element);
          if (style.position === "fixed" || style.position === "absolute") covering.push(describe(element));
        }
        if (covering.length >= 4) break;
      }
      // The stream is the one thing the server cannot see: its requests are the
      // long-lived ones, so a dead stream looks like silence rather than a
      // failure. The store knows its state, so the report can say so.
      const stream = useAppStore.getState().connectionStatus;
      const detail = [
        `center=${describe(center)}`,
        `covering=[${covering.join(", ")}]`,
        `stream=${stream}`,
        `driftMs=${drift}`,
        `dialogs=${document.querySelectorAll("dialog[open]").length}`,
        `hidden=${document.hidden}`,
        `title=${document.title}`
      ].join(" | ");
      // Only when something looks wrong: a healthy page should not fill the log.
      // A backgrounded tab has its timers throttled to about once a minute, so
      // drift alone proves nothing there: it reported a 41s "stall" for a page
      // that was merely behind another window. Only a VISIBLE page can be
      // judged by its own timer.
      const stalled = !document.hidden && drift > 2000;
      if (stalled || covering.length > 0 || stream === "error") {
        void fetch("/api/client-errors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "stuck", message: "page looks stuck", detail, url: location.href }),
          keepalive: true
        }).catch(() => {});
      }
    }, 45_000);
    return () => window.clearInterval(timer);
  }, []);

  return null;
}
