import { z } from "zod";
import { deployArtifact } from "@/server/deployment-service";
import type { ToolDef } from "@/server/tools/types";

export const deployArtifactTool: ToolDef = {
  name: "deploy_artifact",
  description:
    "Deploy a web_app artifact to a local static preview. Only works for web_app type artifacts that belong to the current conversation.",
  parameters: {
    type: "object",
    required: ["artifactId"],
    properties: {
      artifactId: { type: "string", description: "The artifact ID to deploy." }
    }
  },
  async handler(args, ctx) {
    const parsed = z.object({ artifactId: z.string().min(1) }).safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` };
    }

    const result = deployArtifact(parsed.data.artifactId, ctx.conversationId);
    return { ok: true, value: result };
  }
};
