import { z } from "zod";
import { deployWorkspace } from "@/server/deployment-service";
import type { ToolDef } from "@/server/tools/types";

export const deployWorkspaceTool: ToolDef = {
  name: "deploy_workspace",
  description:
    "Deploy a static directory from the workspace. The directory must contain an index.html. Use after running build commands.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Path relative to workspace root." },
      title: { type: "string", description: "Optional deployment title." }
    }
  },
  async handler(args, ctx) {
    const parsed = z.object({
      path: z.string().min(1),
      title: z.string().optional()
    }).safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` };
    }

    const result = deployWorkspace(ctx.workspacePath, parsed.data.path, parsed.data.title);
    if (result.status !== "ready") {
      return { ok: false, error: result.error ?? "Deployment failed." };
    }
    return { ok: true, value: result };
  }
};
