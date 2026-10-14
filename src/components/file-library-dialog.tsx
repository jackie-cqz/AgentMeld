"use client";

import { File, Loader2, Paperclip, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { requestJson } from "@/lib/request-json";
import { useAppStore } from "@/stores/app-store";
import type { Attachment } from "@/shared/types";
import { Modal } from "@/components/ui/modal";
import { Feedback } from "@/components/ui/controls";

export function FileLibraryDialog({
  conversationId,
  open,
  onClose
}: {
  conversationId: string;
  open: boolean;
  onClose: () => void;
}) {
  const addPendingAttachment = useAppStore((state) => state.addPendingAttachment);
  const removePendingAttachment = useAppStore((state) => state.removePendingAttachment);
  const inputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<Attachment | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void requestJson<{ attachments: Attachment[] }>(
      `/api/attachments?conversationId=${encodeURIComponent(conversationId)}`
    ).then((data) => {
      if (!cancelled) setAttachments(data.attachments);
    }).catch((loadError: unknown) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : "附件加载失败。");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, conversationId]);

  if (!open) return null;

  const upload = async (files: FileList | null) => {
    if (!files?.length || uploading) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.set("file", file);
        formData.set("conversationId", conversationId);
        const data = await requestJson<{ attachment: Attachment }>("/api/attachments", {
          method: "POST",
          body: formData
        });
        setAttachments((current) => [data.attachment, ...current]);
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "附件上传失败。");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async (attachment: Attachment) => {
    if (deleting) return;
    setDeleting(true);
    try {
      await requestJson(`/api/attachments?id=${encodeURIComponent(attachment.id)}`, {
        method: "DELETE"
      });
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
      removePendingAttachment(conversationId, attachment.id);
      setDeleteCandidate(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "附件删除失败。");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <><Modal open={open} onClose={onClose} title="会话文件" description={`${attachments.length} 个文件`} busy={uploading || deleting}
      footer={<>{error ? <Feedback>{error}</Feedback> : null}<button className="ui-button" onClick={onClose} disabled={uploading}>完成</button></>}>
        <div className="flex items-center justify-between mb-4">
          <input ref={inputRef} type="file" multiple hidden onChange={(event) => void upload(event.target.files)} />
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="ui-button ui-button--primary"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            上传文件
          </button>
          <span className="text-xs text-slate-500">{attachments.length} 个文件</span>
        </div>
        <div>
          {loading ? <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />加载中</div> : null}
          {!loading && attachments.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">还没有上传文件</p> : null}
          <div className="space-y-2">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="ui-list-row">
                <File className="h-4 w-4 shrink-0 text-slate-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-800">{attachment.fileName}</div>
                  <div className="text-xs text-slate-500">{formatBytes(attachment.size)} · {attachment.mimeType}</div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    addPendingAttachment(conversationId, attachment);
                    onClose();
                  }}
                  className="ui-icon-button"
                  title="插入消息"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
                <button type="button" disabled={deleting} onClick={() => { setError(null); setDeleteCandidate(attachment); }} className="ui-icon-button" title="删除">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
    </Modal><Modal open={Boolean(deleteCandidate)} onClose={() => setDeleteCandidate(null)} title="删除文件？" size="small" busy={deleting}
      footer={<>{error ? <Feedback>{error}</Feedback> : null}<button className="ui-button" disabled={deleting} onClick={() => setDeleteCandidate(null)}>取消</button><button className="ui-button ui-button--danger" disabled={deleting} onClick={() => deleteCandidate && void remove(deleteCandidate)}>删除文件</button></>}>
      <p className="ui-muted break-words">{deleteCandidate?.fileName} 将从此会话的文件库中移除，此操作不可撤销。</p>
    </Modal></>
  );
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
