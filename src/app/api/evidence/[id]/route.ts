import { NextResponse } from "next/server";

import { getEvidence } from "@/server/repositories/evidence-repository";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const evidence = getEvidence(id);
  if (!evidence) return NextResponse.json({ error: "Evidence not found." }, { status: 404 });
  return NextResponse.json({ evidence });
}
