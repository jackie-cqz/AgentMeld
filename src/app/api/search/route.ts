import { z } from "zod";
import { searchMessages } from "@/server/search-service";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  conversationId: z.string().min(1).optional(),
  role: z.enum(["user", "agent"]).optional(),
  fallback: z.literal("like").optional()
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
  if (!parsed.success) {
    return Response.json({
      ok: false,
      error: { code: "INVALID_QUERY", message: "搜索参数无效。" }
    }, { status: 400 });
  }

  const result = searchMessages({
    query: parsed.data.q,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
    conversationId: parsed.data.conversationId,
    role: parsed.data.role,
    fallback: parsed.data.fallback
  });

  if (result.error) {
    return Response.json({
      ok: false,
      error: { code: result.error, message: "搜索词包含不支持的语法。" }
    }, { status: 400 });
  }

  return Response.json({ ok: true, data: result });
}
