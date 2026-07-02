import fs from "node:fs";
import path from "node:path";
import { getDatabase } from "@/db/client";
import { getWorkspaceForConversation } from "@/server/repositories";
import { newAttachmentId } from "@/shared/ids";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (!conversationId) {
    return Response.json({ error: "Missing conversationId." }, { status: 400 });
  }
  const rows = getDatabase()
    .prepare("SELECT * FROM attachments WHERE conversation_id = ? ORDER BY created_at DESC")
    .all(conversationId) as Array<Record<string, unknown>>;
  return Response.json({
    attachments: rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      kind: row.kind,
      fileName: row.file_name,
      filePath: row.file_path,
      size: row.size,
      mimeType: row.mime_type,
      createdAt: row.created_at
    }))
  });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing attachment id." }, { status: 400 });
  const row = getDatabase()
    .prepare("SELECT file_path FROM attachments WHERE id = ?")
    .get(id) as { file_path: string } | undefined;
  if (!row) return Response.json({ error: "Attachment not found." }, { status: 404 });
  getDatabase().prepare("DELETE FROM attachments WHERE id = ?").run(id);
  try {
    fs.rmSync(row.file_path, { force: true });
  } catch {
    // The database record is authoritative; a missing stale file should not block cleanup.
  }
  return Response.json({ deleted: true });
}

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
