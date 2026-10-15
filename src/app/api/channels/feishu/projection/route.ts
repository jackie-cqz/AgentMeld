import { z } from "zod";
import { badRequest, ok } from "@/server/api-utils";
import {
  isChannelProjectionPaused,
  setChannelProjectionPaused
} from "@/server/channels/feishu/projection";
import { gateRequest } from "@/server/api-gate";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ paused: z.boolean() });

/**
 * Read or set whether anything is allowed to go out to a channel.
 *
 * This exists so the switch is operable. It was originally written as a
 * function with no caller, which made "there is a pause switch" untrue in the
 * only sense that matters — nobody could press it. Pausing stops outbound only:
 * recording, inbound routing and the web UI are untouched, so an incident can
 * be contained without killing the process or losing messages.
 *
 * The flag is in memory. A restart resumes projection, which is the right
 * failure direction for a switch meant to act fast, but it is not durable.
 */
export async function GET(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  return ok({ paused: isChannelProjectionPaused() });
}

export async function POST(request: Request) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const body = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return badRequest("Expected { paused: boolean }.");

  setChannelProjectionPaused(parsed.data.paused);
  return ok({ paused: isChannelProjectionPaused() });
}
