import Link from "next/link";
import { ArrowLeft, FlaskConical } from "lucide-react";

import { BenchmarkDashboard } from "@/components/benchmark-dashboard";

export const dynamic = "force-dynamic";

export default function BenchmarkPage() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-[1600px] items-center gap-4 px-6 py-4">
          <Link href="/" className="grid h-9 w-9 place-items-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" title="返回工作区">
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="grid h-9 w-9 place-items-center rounded-md bg-blue-600 text-white">
            <FlaskConical className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-base font-semibold">Collaboration Benchmark</h1>
            <p className="text-xs text-slate-500">确定性 Hard Gate、语义 Judge 与上下文策略回归</p>
          </div>
        </div>
      </header>
      <BenchmarkDashboard />
    </main>
  );
}
