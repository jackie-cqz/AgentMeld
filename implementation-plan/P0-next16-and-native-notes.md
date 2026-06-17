# P0 - Next 16 本地文档与 Native SQLite 记录

## 已读取的 Next 本地文档

- `node_modules/next/dist/docs/01-app/01-getting-started/02-project-structure.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md`
- `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`
- `node_modules/next/dist/docs/02-pages/04-api-reference/04-config/01-next-config-js/serverExternalPackages.md`

## 对实现的影响

- 使用 `src/app` App Router，不创建 Pages Router。
- Route Handler 保持在 `src/app/api/**/route.ts`。
- Next 16 默认 Turbopack，脚本里不额外传 `--turbopack`。
- ESLint 使用 `eslint .`，不使用已废弃的 `next lint`。
- `next.config.ts` 保留 `serverExternalPackages`，避免 agent SDK 与 native SQLite 包被错误打包。

## Native SQLite 记录

当前机器的 Node 24 环境在首次安装后没有生成 `better-sqlite3` 对应 ABI 的 native binding。根因是 pnpm 自动忽略了 native build script。

处理方式：

1. `package.json` 增加 `pnpm.onlyBuiltDependencies = ["better-sqlite3"]`。
2. 执行 `pnpm rebuild better-sqlite3`。
3. 用实际 `new Database(":memory:")` 验证，不能只 `require("better-sqlite3")`。
4. P1 的 `src/db/client.ts` 仍保留 fallback：优先尝试 `better-sqlite3`，如果 native binding 缺失，则在 Node 24+ 下 fallback 到 `node:sqlite` `DatabaseSync`。

验证结果：

- `pnpm ignored-builds` 输出 `None`。
- `drizzle-kit push --config drizzle.config.ts` 已用临时 SQLite 文件验证通过。
