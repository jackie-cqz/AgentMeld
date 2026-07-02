"use client";

import { File, Loader2, Paperclip, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { requestJson } from "@/lib/request-json";
import { useAppStore } from "@/stores/app-store";
import type { Attachment } from "@/shared/types";

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
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (!files?.length) return;
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
    try {
      await requestJson(`/api/attachments?id=${encodeURIComponent(attachment.id)}`, {
        method: "DELETE"
      });
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
      removePendingAttachment(conversationId, attachment.id);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "附件删除失败。");
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/30 px-4">
      <section className="flex max-h-[78vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
        <header className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-950">会话文件</h2>
            <p className="text-xs text-slate-500">上传后可插入下一条消息</p>
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-md hover:bg-slate-100" title="关闭">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <input ref={inputRef} type="file" multiple hidden onChange={(event) => void upload(event.target.files)} />
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="flex h-9 items-center gap-2 rounded-md bg-blue-600 px-3 text-sm font-medium text-white disabled:opacity-60"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            上传文件
          </button>
          <span className="text-xs text-slate-500">{attachments.length} 个文件</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />加载中</div> : null}
          {!loading && attachments.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">还没有上传文件</p> : null}
          <div className="space-y-2">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="flex items-center gap-3 rounded-md border border-slate-200 px-3 py-2">
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
                  className="grid h-8 w-8 place-items-center rounded-md text-blue-600 hover:bg-blue-50"
                  title="插入消息"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => void remove(attachment)} className="grid h-8 w-8 place-items-center rounded-md text-red-500 hover:bg-red-50" title="删除">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          {error ? <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        </div>
      </section>
    </div>
  );
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
