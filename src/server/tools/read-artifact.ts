import { z } from "zod";
import { getArtifact } from "@/server/repositories";
import type { ToolDef } from "@/server/tools/types";

const ArgsSchema = z.object({
  artifactId: z.string().min(1)
});

export const readArtifactTool: ToolDef = {
  name: "read_artifact",
  description:
    "Read the full content of an artifact in the current conversation. Use this when you need to reuse or reference an artifact produced earlier in this session.",
  parameters: {
    type: "object",
    required: ["artifactId"],
    properties: {
      artifactId: {
        type: "string",
        description: "The ID of the artifact to read (must belong to the current conversation)."
      }
    }
  },
  async handler(args, ctx) {
    const parsed = ArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` };
    }

    const artifact = getArtifact(parsed.data.artifactId);
    if (!artifact) {
      return { ok: false, error: `Artifact "${parsed.data.artifactId}" not found.` };
    }
    if (artifact.conversationId !== ctx.conversationId) {
      return { ok: false, error: "Artifact does not belong to the current conversation." };
    }

    return {
      ok: true,
      value: {
        id: artifact.id,
        type: artifact.type,
        title: artifact.title,
        content: artifact.content,
        version: artifact.version
      }
    };
  }
};
