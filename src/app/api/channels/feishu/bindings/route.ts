import { z } from "zod";
import { badRequest, ok } from "@/server/api-utils";
import {
  listBindingSessions,
  listFeishuBindings,
  startFeishuBinding
} from "@/server/channels/feishu/binding";

export const dynamic = "force-dynamic";

const startSchema = z.object({
  agentId: z.string().min(1)
});

/**
 * Start a scan-to-bind attempt. Resolves once the launcher URL exists, which is
 * what the caller needs to display; registration then continues in the
 * background and its outcome arrives on the event stream.
 *
 * Failures also carry `sessionId` when an attempt was created, so the caller can
 * poll or cancel the very attempt it just started instead of only learning about
 * it from the stream.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) return badRequest("agentId is required.", parsed.error.flatten());

  const result = await startFeishuBinding(parsed.data.agentId);
  if (!result.ok) {
    const payload = { error: result.error, sessionId: result.sessionId ?? null };
    if (result.status === 409) return Response.json(payload, { status: 409 });
    if (result.status === 404) return Response.json(payload, { status: 404 });
    // 502 explicitly, not via serverError(): the attempt failed because the
    // upstream flow did, and serverError() is fixed at 500.
    if (result.status === 502) return Response.json(payload, { status: 502 });
    return badRequest(result.error);
  }

  // Only a live session carries the launcher URL: it is dropped as soon as the
  // attempt settles, and it is never broadcast to every listener on the stream.
  return ok({ session: result.session });
}

/** Stored bindings (never containing an app secret) plus any in-flight sessions. */
export async function GET() {
  // Through the service, which bootstraps. Reaching the repository from here
  // used to answer 500 on a database that had not been bootstrapped yet.
  return ok({ bindings: listFeishuBindings(), sessions: listBindingSessions() });
}
