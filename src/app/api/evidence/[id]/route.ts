import { NextResponse } from "next/server";

import { getEvidence } from "@/server/repositories/evidence-repository";
import { gateRequest } from "@/server/api-gate";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await gateRequest(request);
  if (!gate.allowed) return gate.response;
  const { id } = await context.params;
  const evidence = getEvidence(id);
  if (!evidence) return NextResponse.json({ error: "Evidence not found." }, { status: 404 });
  return NextResponse.json({ evidence });
}
