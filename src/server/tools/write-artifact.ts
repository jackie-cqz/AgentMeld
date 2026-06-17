import { z } from "zod";
import { createArtifact } from "@/server/repositories";
import { newArtifactId } from "@/shared/ids";
import type { ArtifactContent, ArtifactType } from "@/shared/types";
import type { ToolDef } from "@/server/tools/types";

const ArgsSchema = z.object({
  type: z.enum(["web_app", "document", "image", "ppt"]),
  title: z.string().min(1).max(200),
  content: z.unknown()
});

export const writeArtifactTool: ToolDef = {
  name: "write_artifact",
  description: `Create an artifact (document, web app, image, or presentation) in the current conversation.

For document type, content must be: { format: "markdown", content: "..." }
For web_app type, content must be: { files: { "index.html": "...", "style.css": "..." }, entry: "index.html" }
For image type, content must be: { url: "..." }
For ppt type, content must be: { title?: "...", theme?: {...}, slides: [...] }

IMPORTANT: Always provide type, title, and content. Never call this tool with empty arguments.`,
  parameters: {
    type: "object",
    required: ["type", "title", "content"],
    properties: {
      type: {
        type: "string",
        enum: ["web_app", "document", "image", "ppt"],
        description: "The type of artifact to create."
      },
      title: {
        type: "string",
        description: "A short human-readable title for the artifact."
      },
      content: {
        description: "The artifact content, whose shape depends on the type. See tool description for details."
      }
    }
  },
  async handler(args, ctx) {
    const parsed = ArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid args: ${parsed.error.message}` };
    }

    const { type, title } = parsed.data;
    const rawContent = parsed.data.content;

    const normalized = normalizeContent(type, rawContent);
    if (normalized instanceof Error) {
      return { ok: false, error: normalized.message };
    }

    const artifact = createArtifact({
      id: newArtifactId(),
      conversationId: ctx.conversationId,
      createdByAgentId: ctx.agentId,
      type,
      title,
      content: normalized,
      version: 1,
      parentArtifactId: null,
      now: Date.now()
    });

    return {
      ok: true,
      value: {
        artifactId: artifact.id,
        title: artifact.title,
        type: artifact.type
      }
    };
  }
};

function normalizeContent(type: ArtifactType, raw: unknown): ArtifactContent | Error {
  if (type === "document") {
    return normalizeDocument(raw);
  }
  if (type === "web_app") {
    return normalizeWebApp(raw);
  }
  if (type === "image") {
    return normalizeImage(raw);
  }
  if (type === "ppt") {
    return normalizePpt(raw);
  }
  return new Error(`Unsupported artifact type: ${type}`);
}

function normalizeDocument(raw: unknown): ArtifactContent | Error {
  if (typeof raw === "string") {
    return { type: "document", format: "markdown", content: raw };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const content =
      (typeof obj.content === "string" && obj.content) ||
      (typeof obj.markdown === "string" && obj.markdown) ||
      (typeof obj.text === "string" && obj.text) ||
      "";
    if (!content) {
      return new Error("Document content is empty. Provide { content: \"...\" } or { markdown: \"...\" }.");
    }
    return { type: "document", format: "markdown", content };
  }
  return new Error("Document content must be a string or { content/markdown: \"...\" }.");
}

function normalizeWebApp(raw: unknown): ArtifactContent | Error {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;

    if (obj.files && typeof obj.files === "object") {
      const files = obj.files as Record<string, unknown>;
      const entry = typeof obj.entry === "string" ? obj.entry : "index.html";
      return {
        type: "web_app",
        files: Object.fromEntries(
          Object.entries(files).map(([key, val]) => [key, String(val)])
        ),
        entry
      };
    }

    // Flattened form: { html, css?, js? }
    if (typeof obj.html === "string") {
      const files: Record<string, string> = { "index.html": obj.html };
      if (typeof obj.css === "string") files["style.css"] = obj.css;
      if (typeof obj.js === "string") files["script.js"] = obj.js;
      return { type: "web_app", files, entry: "index.html" };
    }

    if (typeof obj.content === "string" || typeof obj.code === "string") {
      const html = (obj.content ?? obj.code) as string;
      return { type: "web_app", files: { "index.html": html }, entry: "index.html" };
    }
  }
  if (typeof raw === "string") {
    return { type: "web_app", files: { "index.html": raw }, entry: "index.html" };
  }
  return new Error(
    "web_app content must be { files: {...}, entry: \"...\" }, { html: \"...\" }, or a raw HTML string."
  );
}

function normalizeImage(raw: unknown): ArtifactContent | Error {
  if (typeof raw === "string") {
    return { type: "image", url: raw };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const url = typeof obj.url === "string" ? obj.url : "";
    if (!url) return new Error("Image content must have a url field.");
    return {
      type: "image",
      url,
      alt: typeof obj.alt === "string" ? obj.alt : undefined,
      width: typeof obj.width === "number" ? obj.width : undefined,
      height: typeof obj.height === "number" ? obj.height : undefined
    };
  }
  return new Error("Image content must be a URL string or { url: \"...\" }.");
}

function normalizePpt(raw: unknown): ArtifactContent | Error {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (!Array.isArray(obj.slides)) {
      return new Error("PPT content must have a slides array.");
    }
    return {
      type: "ppt",
      title: typeof obj.title === "string" ? obj.title : undefined,
      theme: obj.theme as ArtifactContent & { type: "ppt" } extends { theme?: infer T } ? T : undefined,
      slides: obj.slides as ArtifactContent & { type: "ppt" } extends { slides: infer S } ? S : never
    };
  }
  return new Error("PPT content must be { title?, theme?, slides: [...] }.");
}
