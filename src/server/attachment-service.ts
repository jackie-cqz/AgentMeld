import fs from "node:fs";
import path from "node:path";
import { getDatabase } from "@/db/client";

export interface AttachmentMeta {
  id: string;
  conversationId: string;
  kind: "image" | "file";
  fileName: string;
  filePath: string;
  size: number;
  mimeType: string;
  createdAt: number;
}

export function getAttachment(attachmentId: string): AttachmentMeta | null {
  const row = getDatabase()
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .get(attachmentId) as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    kind: row.kind as "image" | "file",
    fileName: row.file_name as string,
    filePath: row.file_path as string,
    size: row.size as number,
    mimeType: row.mime_type as string,
    createdAt: row.created_at as number
  };
}

export function readAttachmentContent(
  attachment: AttachmentMeta,
  maxChars = 50_000
): { content: string; truncated: boolean } | { note: string } {
  const ext = path.extname(attachment.fileName).toLowerCase();
  const textTypes = new Set([
    ".txt", ".md", ".json", ".xml", ".yaml", ".yml", ".csv",
    ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".scss",
    ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp",
    ".sh", ".bash", ".zsh", ".ps1", ".toml", ".ini", ".cfg",
    ".env", ".gitignore", ".dockerignore", ".sql"
  ]);

  if (!textTypes.has(ext) && !attachment.mimeType.startsWith("text/")) {
    return { note: `Binary file: ${attachment.fileName} (${attachment.mimeType}, ${attachment.size} bytes). Cannot extract text content.` };
  }

  try {
    const raw = fs.readFileSync(attachment.filePath, "utf-8");
    const truncated = raw.length > maxChars;
    return { content: truncated ? raw.slice(0, maxChars) : raw, truncated };
  } catch {
    return { note: `Failed to read attachment: ${attachment.fileName}` };
  }
}
