// ---------------------------------------------------------------------------
// P2: Fact API — GET active facts, POST approve/reject definitions
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import { loadActiveFacts, loadDynamicDefinitions, listPendingDefinitions, approveDefinition, rejectDefinition } from "@/server/context-facts/fact-service";
import { BUILTIN_FACT_DEFINITIONS } from "@/shared/builtin-fact-definitions";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId");
  const pending = searchParams.get("pending") === "1";

  if (!conversationId) {
    return NextResponse.json({ ok: false, error: "conversationId is required" }, { status: 400 });
  }

  if (pending) {
    const defs = listPendingDefinitions(conversationId);
    return NextResponse.json({ ok: true, data: defs });
  }

  const facts = loadActiveFacts(conversationId);
  const definitions = [...BUILTIN_FACT_DEFINITIONS, ...loadDynamicDefinitions(conversationId)];

  // Merge active values into definition list
  const merged = definitions
    .filter((d) => d.origin === "builtin" || (d as { status?: string }).status === "active")
    .map((d) => {
      const fact = facts.find((f) => f.canonicalKey === d.canonicalKey && f.status === "active");
      return {
        definitionId: d.id,
        canonicalKey: d.canonicalKey,
        namespace: d.namespace,
        valueType: d.valueType,
        description: d.description,
        currentValue: fact?.value ?? null,
        updatedAt: fact?.updatedAt ?? null,
      };
    });

  return NextResponse.json({ ok: true, data: merged });
}

export async function POST(request: Request) {
  const body = await request.json() as {
    conversationId?: string;
    action?: string;
    definitionId?: string;
    value?: unknown;
  };

  const { conversationId, action, definitionId, value } = body;

  if (!conversationId) {
    return NextResponse.json({ ok: false, error: "conversationId is required" }, { status: 400 });
  }

  if (action === "approve" && definitionId) {
    const result = approveDefinition(conversationId, definitionId, value ?? null);
    if ("error" in result) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, data: result });
  }

  if (action === "reject" && definitionId) {
    const ok = rejectDefinition(conversationId, definitionId);
    if (!ok) {
      return NextResponse.json({ ok: false, error: "Definition not found or not pending." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, data: { rejected: definitionId } });
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}. Use "approve" or "reject".` }, { status: 400 });
}
