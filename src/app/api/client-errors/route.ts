import { z } from "zod";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

const reportSchema = z.object({
  kind: z.enum(["error", "unhandledrejection", "react", "stuck"]),
  message: z.string().max(4000),
  stack: z.string().max(8000).optional(),
  detail: z.string().max(4000).optional(),
  url: z.string().max(2000).optional()
});

/**
 * A place for the browser to say what broke.
 *
 * The failures this exists for are invisible from the server: a render crash
 * shows a blank page, and the console that would explain it is on somebody
 * else's screen. Reported here, they land in the dev log — the same place the
 * server's own failures do — so "it went white again" becomes a stack trace
 * instead of a conversation.
 *
 * Authenticated like every other route (the reporter runs inside the app), but
 * it never fails the caller: a diagnostic must not become a second problem.
 */
export async function POST(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const body = await request.json().catch(() => ({}));
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) return Response.json({ ok: false }, { status: 400 });
  const { kind, message, stack, url, detail } = parsed.data;
  console.error(
    `[client-error] ${kind}: ${message}` + (detail ? `\n  detail: ${detail}` : "") + (url ? `\n  at ${url}` : "") + (stack ? `\n${stack}` : "")
  );
  return Response.json({ ok: true });
}
