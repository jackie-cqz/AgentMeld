import { AlertTriangle, Loader2 } from "lucide-react";

/** Full-page loading spinner. */
export function PageLoading({ message = "正在加载..." }: { message?: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f7f6f2]">
      <div className="flex flex-col items-center gap-3 rounded-md border border-stone-200 bg-white px-6 py-5 shadow-sm">
        <Loader2 className="h-5 w-5 animate-spin text-stone-500" />
        <span className="text-sm text-stone-600">{message}</span>
      </div>
    </main>
  );
}

/** Full-page error display with retry button. */
export function PageError({
  message = "加载失败，请刷新重试。",
  onRetry
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f7f6f2]">
      <div className="flex max-w-sm flex-col items-center gap-4 rounded-md border border-red-200 bg-white px-6 py-6 shadow-sm text-center">
        <AlertTriangle className="h-6 w-6 text-red-500" />
        <div>
          <p className="text-sm font-medium text-stone-900">出错了</p>
          <p className="mt-1 text-sm text-stone-600">{message}</p>
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md bg-stone-950 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 transition"
          >
            重试
          </button>
        ) : null}
      </div>
    </main>
  );
}

/** Full-page empty state. */
export function PageEmpty({
  icon,
  title,
  description
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-stone-300 bg-white px-6 py-8 shadow-sm text-center max-w-sm">
        {icon ? <div className="text-stone-400">{icon}</div> : null}
        <p className="text-sm font-medium text-stone-900">{title}</p>
        {description ? <p className="text-sm leading-6 text-stone-500">{description}</p> : null}
      </div>
    </div>
  );
}

/** Inline loading indicator. */
export function InlineLoading({ text = "加载中..." }: { text?: string }) {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-stone-500">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>{text}</span>
    </div>
  );
}

/** Inline error message. */
export function InlineError({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
