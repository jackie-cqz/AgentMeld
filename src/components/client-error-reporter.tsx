"use client";

import { useEffect } from "react";

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
