# P0 - 工程基座

## 目标

建立一个稳定、可安装、可运行、可验证的 Next.js 16.2.6 工程基础。P0 不实现业务功能，只确保后续代码有正确的框架、工具链和目录约束。

## 参考文件

- `AGENTS.md`
- `CLAUDE.md` 第 2、3、4、6 节
- `README.zh-CN.md` 的“技术栈”“快速开始”“常用命令”
- `openspec/project.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/02-project-structure.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`
- `node_modules/next/dist/docs/01-app/01-getting-started/11-css.md`
- `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`
- `node_modules/next/dist/docs/02-pages/04-api-reference/04-config/01-next-config-js/serverExternalPackages.md`

## 范围

必须创建：

- `package.json`
- `pnpm-workspace.yaml`
- `tsconfig.json`
- `next.config.ts`
- `eslint.config.mjs`
- `postcss.config.mjs`
- `next-env.d.ts`
- `src/app/layout.tsx`
- `src/app/page.tsx`
- `src/app/globals.css`

## 关键决策

1. 使用 App Router，不创建 Pages Router。
2. 使用 `src/app`，为后续 `src/server`、`src/db`、`src/shared` 留出空间。
3. `next.config.ts` 里保留 `serverExternalPackages`，避免 native/SDK 包被错误打包。
4. Next 16 默认 Turbopack，不在脚本里额外加 `--turbopack`。
5. 使用 ESLint CLI，而不是已废弃的 `next lint`。
6. TypeScript 保持 strict。

## 任务拆分

1. 创建项目依赖清单。
2. 安装 Next 16.2.6、React 19、Tailwind 4、Drizzle、SQLite、Zustand、OpenAI/Anthropic/Codex SDK 依赖。
3. 创建最小 App Router 页面。
4. 读取 Next 本地文档，记录影响实现的约定。
5. 运行类型检查、lint、build。
6. 记录 pnpm install 中出现的 native build script 提醒。

## 验收标准

- `pnpm install` 成功。
- `node_modules/next/dist/docs/` 存在并已读取关键文档。
- `tsc --noEmit` 通过。
- `eslint .` 通过。
- `next build` 通过。
- `next dev` 能启动基础页面。

## 风险

- `latest` 依赖可能拉到不兼容的 ESLint/TypeScript 版本，所以开发工具应锁在兼容版本。
- `better-sqlite3` 的 build script 可能被 pnpm 阻止，P1 真正使用 SQLite 时必须处理。
