import { z } from "zod";
import { PROVIDER_PRESETS } from "@/shared/provider-presets";
import { providerProfileIdSchema, providerProfileInputSchema } from "@/shared/model-provider-schema";
import { deleteModelProviderProfile, listModelProviderProfiles, saveModelProviderProfile } from "@/server/model-provider-service";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ providers: listModelProviderProfiles(), environmentPresets: PROVIDER_PRESETS.filter(preset => preset.envKey && process.env[preset.envKey]?.trim()).map(preset => preset.id) });
}

async function save(request: Request, updating: boolean) {
  const schema = updating ? providerProfileInputSchema.extend({ id: providerProfileIdSchema }) : providerProfileInputSchema;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "供应商配置无效，请检查名称、API 地址、模型和凭据。" }, { status: 400 });
  const { id, ...input } = parsed.data as z.infer<typeof providerProfileInputSchema> & { id?: string };
  try {
    const provider = saveModelProviderProfile(input, id);
    return Response.json({ provider }, { status: updating ? 200 : 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存供应商失败。" }, { status: 400 });
  }
}

export const POST = (request: Request) => save(request, false);
export const PATCH = (request: Request) => save(request, true);

export async function DELETE(request: Request) {
  const parsed = z.object({ id: providerProfileIdSchema }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "供应商 ID 无效。" }, { status: 400 });
  try {
    deleteModelProviderProfile(parsed.data.id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "移除供应商失败。" }, { status: 409 });
  }
}
