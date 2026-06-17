import fs from "node:fs";
import path from "node:path";
import { getDataDir, getDatabase } from "@/db/client";
import { getWorkspaceForConversation } from "@/server/repositories";
import { newAttachmentId } from "@/shared/ids";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const formData = await request.formData().catch(() => null);
  if (!formData) {
    return Response.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const conversationId = formData.get("conversationId") as string | null;

  if (!file || !conversationId) {
    return Response.json({ error: "Missing file or conversationId." }, { status: 400 });
  }

  const workspace = getWorkspaceForConversation(conversationId);
  if (!workspace) {
    return Response.json({ error: "Conversation workspace not found." }, { status: 404 });
  }

  // Safe file name
  const safeName = path.basename(file.name || "untitled");
  const attachDir = path.join(workspace.rootPath, "attachments");
  fs.mkdirSync(attachDir, { recursive: true });

  const id = newAttachmentId();
  const filePath = path.join(attachDir, `${id}-${safeName}`);

  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(filePath, buffer);

  const now = Date.now();
  const mimeType = file.type || "application/octet-stream";
  const kind = mimeType.startsWith("image/") ? "image" : "file";

  getDatabase().prepare(`
    INSERT INTO attachments (id, conversation_id, kind, file_name, file_path, size, mime_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, conversationId, kind, safeName, filePath, buffer.length, mimeType, now);

  return Response.json({
    attachment: {
      id,
      conversationId,
      kind,
      fileName: safeName,
      filePath,
      size: buffer.length,
      mimeType,
      createdAt: now
    }
  }, { status: 201 });
}
