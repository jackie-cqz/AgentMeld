import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { safeWorkspacePath, SEARCH_EXCLUDES } from "@/server/tools/workspace-access";
import type { ToolDef } from "@/server/tools/types";
import { TOOL_CAPABILITIES } from "@/server/tools/capabilities";

const schema = z.object({ path: z.string().default("."), glob: z.string().min(1).max(200).default("**/*"),
  query: z.string().min(1).max(300).optional(), caseSensitive: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(50) });

function discovery(name: "fs_glob" | "fs_search"): ToolDef {
  return { name, description: name === "fs_glob" ? "Find workspace files by glob, respecting .gitignore and excluding secrets/build/dependency directories. Results are bounded; narrow the glob when truncated."
    : "Search workspace text for a literal query (not regex). Returns paths, 1-based line numbers, and bounded snippets. Respects .gitignore and excludes secrets/build/dependency directories.",
    capabilities: TOOL_CAPABILITIES[name],
    parameters: { type: "object", required: name === "fs_search" ? ["query"] : [], properties: {
      path: { type: "string", description: "Directory or file within the workspace; default ." }, glob: { type: "string", description: "File glob, default **/*" },
      query: { type: "string", description: "Literal text to find; required for fs_search." }, caseSensitive: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 200 }
    } },
    async handler(args, ctx) {
      const parsed = schema.safeParse(args);
      if (!parsed.success || (name === "fs_search" && !parsed.data.query)) return { ok: false, error: "Invalid args: query is required for search; limit must be 1–200." };
      const input = parsed.data;
      try {
        if (path.isAbsolute(input.glob) || input.glob.split(/[\\/]/).includes("..")) throw new Error("Glob must stay within the requested directory.");
        const root = safeWorkspacePath(ctx.workspacePath, input.path);
        const stat = await fs.stat(root);
        const directory = stat.isDirectory() ? root : path.dirname(root);
        const paths: string[] = [];
        // Stream discovery instead of collecting an unbounded repository listing.
        const { globbyStream } = await import("globby");
        const stream = Readable.from(globbyStream(stat.isDirectory() ? input.glob : path.basename(root), { cwd: directory, gitignore: true, globalGitignore: false, braceExpansion: false, extglob: false, onlyFiles: true, followSymbolicLinks: false, dot: false, ignore: SEARCH_EXCLUDES }));
        const cancel = () => stream.destroy(new Error("Search cancelled or timed out. Narrow the search scope."));
        const timer = setTimeout(cancel, 10000);
        ctx.abortSignal.addEventListener("abort", cancel, { once: true });
        const started = Date.now();
        const matches: Array<{ path: string; line: number; text: string }> = [];
        let scanned = 0; let bytes = 0; let truncated = false;
        try {
          for await (const entry of stream) {
            if (ctx.abortSignal.aborted) throw new Error("Search cancelled.");
            if (Date.now() - started > 10000 || scanned >= 5000 || bytes > 20 * 1024 * 1024) { truncated = true; break; }
            const absolute = safeWorkspacePath(ctx.workspacePath, path.join(directory, String(entry)));
            const relative = path.relative(ctx.workspacePath, absolute).split(path.sep).join("/");
            scanned++;
            if (name === "fs_glob") {
              paths.push(relative);
              if (paths.length >= input.limit) { truncated = true; break; }
              continue;
            }
            const info = await fs.stat(absolute);
            if (info.size > 1024 * 1024) continue;
            const content = await fs.readFile(absolute, "utf8"); bytes += info.size;
            if (content.includes("\0")) continue;
            const query = input.caseSensitive ? input.query! : input.query!.toLowerCase();
            const lines = content.split(/\r?\n/);
            for (let index = 0; index < lines.length; index++) {
              const line = input.caseSensitive ? lines[index] : lines[index].toLowerCase();
              const column = line.indexOf(query);
              if (column < 0) continue;
              matches.push({ path: relative, line: index + 1, text: lines[index].slice(Math.max(0, column - 100), column + 400) });
              if (matches.length >= input.limit) break;
            }
            if (matches.length >= input.limit) { truncated = true; break; }
          }
        } finally { clearTimeout(timer); ctx.abortSignal.removeEventListener("abort", cancel); stream.destroy(); }
        return { ok: true, value: { path: input.path, ...(name === "fs_glob" ? { paths } : { matches }), scannedFiles: scanned, truncated, ...(truncated ? { hint: "Results may be incomplete. Narrow path/glob/query." } : {}) } };
      } catch (failure) { return { ok: false, error: failure instanceof Error ? failure.message : "Search failed." }; }
    }
  };
}
export const fsGlobTool = discovery("fs_glob");
export const fsSearchTool = discovery("fs_search");
