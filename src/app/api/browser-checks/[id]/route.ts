import fs from "node:fs";
import { gateRequest } from "@/server/api-gate";
import { browserScreenshotPath } from "@/server/tools/browser-check";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  try {
    const { id } = await context.params;
    const data = fs.readFileSync(browserScreenshotPath(id));
    return new Response(data, { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return Response.json({ error: "Screenshot not found." }, { status: 404 }); }
}
