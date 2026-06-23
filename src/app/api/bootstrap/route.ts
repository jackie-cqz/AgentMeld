import { getBootstrapPayload } from "@/server/conversation-service";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getBootstrapPayload());
}
