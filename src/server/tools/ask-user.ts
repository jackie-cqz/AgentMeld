import { z } from "zod";
import { registerPendingQuestion } from "@/server/pending-questions";
import type { ToolDef } from "@/server/tools/types";

const questionSchema = z.object({
  question: z.string().min(1).max(300),
  header: z.string().min(1).max(20),
  options: z
    .array(z.object({ label: z.string().min(1), description: z.string().optional() }))
    .min(2)
    .max(6),
  multiSelect: z.boolean().optional()
});

const ArgsSchema = z.object({
  questions: z.array(questionSchema).min(1).max(5)
});

export const askUserTool: ToolDef = {
  name: "ask_user",
  description:
    "Ask the user structured multiple-choice questions to clarify requirements. " +
    "Use this before planning when the model judges that unresolved high-impact choices would " +
    "materially change scope, behavior, visuals, technical delivery, task decomposition, or acceptance. " +
    "Do not use it when the request is already specific or the user delegated those choices. " +
    "Each question has 2-4 options. 1-4 questions per call. " +
    "The agent run will pause until the user answers.",
  parameters: {
    type: "object",
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          required: ["question", "header", "options"],
          properties: {
            question: { type: "string", description: "Full question text." },
            header: { type: "string", maxLength: 20, description: "Short label." },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 6,
              items: {
                type: "object",
                required: ["label"],
                properties: {
                  label: { type: "string" },
                  description: { type: "string" }
                }
              }
            },
            multiSelect: { type: "boolean" }
          }
        }
      }
    }
  },
  async handler(args, ctx) {
    const parsed = ArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid questions: ${parsed.error.message}` };
    }

    const answers = await registerPendingQuestion(
      ctx.conversationId,
      ctx.agentId,
      ctx.runId,
      parsed.data.questions
    );

    return {
      ok: true,
      value: { answers }
    };
  }
};
