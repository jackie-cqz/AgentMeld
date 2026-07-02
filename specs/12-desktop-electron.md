# Spec 12 — 桌面版（Electron）

> AgentMeld 以 Electron 打包成 macOS `.dmg` / Windows `.exe` 安装包，单文件双击即用，不要求用户预装 Node / pnpm。本 spec 定义打包方案、进程模型、路径迁移、native 依赖处理与故意不做的事。
>
> 源文件：`electron/`（main / preload / 类型）、`scripts/electron-*.ts`（打包辅助）、`package.json`（build 字段）、`next.config.ts`（standalone 输出）。

---

## 1. 目标与范围

**做**：
- 输出可分发的 `AgentMeld-<ver>.dmg`（macOS arm64 + x64 双架构）
- 输出可分发的 `AgentMeld-<ver>-setup.exe`（Windows x64 NSIS 安装包）
- 用户安装后双击图标启动，**不需要**装 Node、pnpm、Next.js
- 应用进程内嵌完整 Next.js server（API routes + SSE + 工具执行 + Claude Code SDK 子进程）
- DB 与 workspace 文件迁到 OS 用户数据目录（`app.getPath('userData')`），不污染应用安装目录
- dev / prod 走同一份 main 代码，只换 URL 来源（dev 连 `pnpm dev` 起的 server，prod 起内嵌 server）

**不做**（Phase 1）：
- 自动更新（auto-update / Squirrel / electron-updater）
- 代码签名 / 公证（macOS notarization）—— 用户首次打开走「右键 → 打开」即可
- 应用菜单 / 系统托盘 / 全局快捷键
- 深链接（`agentmeld://` protocol handler）
- Linux 构建（用户量低，待需求）
- 多窗口 / 多实例（singleInstanceLock 限定单实例）

---

## 2. 架构概览

```
┌────────────────────────────────────────────────────────────────┐
│  Electron App (single process tree)                            │
│                                                                │
│  ┌──────────────────────┐                                      │
│  │  Main Process        │                                      │
│  │  electron/main.ts    │                                      │
│  │  - app lifecycle     │                                      │
│  │  - BrowserWindow     │                                      │
│  │  - 起内嵌 Next server │                                      │
│  │  - 路径覆写注入       │                                      │
│  └──────┬───────────────┘                                      │
│         │ in-process require()                                 │
│         ▼                                                      │
│  ┌──────────────────────┐                                      │
│  │  Next.js Standalone  │                                      │
│  │  .next/standalone/   │                                      │
│  │  - API routes (SSE)  │                                      │
│  │  - better-sqlite3    │                                      │
│  │  - claude-agent-sdk  │── spawn ──► Claude Code CLI 子进程    │
│  │  - workspace bash    │── spawn ──► sh / powershell.exe      │
│  └──────────────────────┘                                      │
│         ▲                                                      │
│         │ http://127.0.0.1:<random-port>                       │
│  ┌──────┴───────────────┐                                      │
│  │  Renderer (Chromium) │                                      │
│  │  BrowserWindow       │                                      │
│  │  - loadURL(localUrl) │                                      │
│  │  - 现有 React UI     │                                      │
│  └──────────────────────┘                                      │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**关键决策**：

| 决策 | 选择 | 备选与理由 |
|---|---|---|
| Next.js 运行模式 | **Standalone in-process**（main require 起 server） | A. `spawn('next start')`：进程多一层，启动慢、退出时要清孤儿进程；B. `next export`：API/SSE 全废 |
| 渲染端通信 | **HTTP/SSE 走 127.0.0.1:port** | 复用现有所有 API / fetch / SSE，不引入 Electron IPC，最少改动 |
| Preload bridge | **可选，仅暴露 native file dialog** | 现有 DirPicker 走 `/api/fs/listdir`；如要换原生 dialog 才需要 preload |
| 打包 | **electron-builder** | 成熟，asarUnpack 配置简单，多平台一键 |

---

## 3. 目录结构

```
electron/
├── main.ts              # 主进程入口（编译为 dist-electron/main.js）
├── server-bootstrap.ts  # 在 main 里 require Next standalone server 的 helper
├── paths.ts             # userData 路径解析 + 暴露给 Next 的环境变量
└── tsconfig.json        # 主进程独立 ts 配置（commonjs / target ES2022）

scripts/
├── electron-dev.mjs        # spawn electron 入口（注入 AGENTMELD_DEV=1）
├── electron-prebuild.mjs   # next build 后补齐 standalone 资源/依赖 + 清理 symlinks/重复 runtime
└── run-electron-node.mjs   # 跨平台用 ELECTRON_RUN_AS_NODE=1 跑 npm CLI（dev/build/db:*）

dist-electron/           # tsc 输出（gitignored）
└── main.js

release/                 # electron-builder 输出（gitignored）
├── AgentMeld-0.1.0-arm64.dmg
├── AgentMeld-0.1.0.dmg          # x64
└── AgentMeld-0.1.0-setup.exe
```

**约束**：
- `electron/` 用独立 tsconfig（`module: commonjs`，因为 Electron main 跑在 Node CJS 环境）
- `electron/` 不引用 `src/` 的运行时代码（避免把 React / Next bundle 拉进 main 包）；要共享常量（如默认端口）就单独放 `electron/shared.ts` 并在 src 侧 mirror，**不**用 `@/electron/...` import
- preload.ts Phase 1 没用上（renderer 通信全走 HTTP/SSE 经 Next API routes，不需要 IPC）；将来要做原生 file dialog 再加

---

## 4. 进程模型

### 4.1 Main process（`electron/main.ts`）

职责（按时序）：

1. `app.requestSingleInstanceLock()` —— 第二次启动直接 focus 已有窗口
2. `app.whenReady()` 之前：注入 `process.env.AGENTMELD_DATA_DIR = app.getPath('userData') + '/data'`（详见 §5）
3. 启动内嵌 Next server（§4.3）→ 拿到 `127.0.0.1:<port>`
4. 创建 `BrowserWindow`（详见 §4.2）
5. `mainWindow.loadURL('http://127.0.0.1:' + port)`
6. `app.on('window-all-closed')` → 关 server，`app.quit()`

**禁止**：
- 不直接 import `@/db/client` —— main 的 Node ABI 与 Next 子模块共享 native module，让 Next standalone 自己初始化 DB
- 不在 main 里跑业务逻辑 —— 全部走 server API

### 4.2 BrowserWindow

```ts
new BrowserWindow({
  width: 1280, height: 800,
  minWidth: 980, minHeight: 600,
  title: 'AgentMeld',
  backgroundColor: '#0a0a0a',     // 避免白屏闪烁
  webPreferences: {
    nodeIntegration: false,        // 强制：渲染端纯 web
    contextIsolation: true,        // 强制
    sandbox: true,                 // 强制（renderer 走 chromium sandbox）
    preload: path.join(__dirname, 'preload.cjs'),  // Phase 1 可不挂
  },
})
```

**安全**：渲染端完全等同浏览器，不获取 Node API；与 server 的所有通信走 fetch + SSE，跟 web 版一致。

### 4.3 内嵌 Next server（`electron/server-bootstrap.ts`）

Next.js 16 `output: 'standalone'` 在 `.next/standalone/server.js` 里生成一个独立可跑的 Node server。Bootstrap 做的事：

```ts
import { createServer } from 'node:http'
import next from '...standalone/node_modules/next'  // 走 standalone 内的副本

async function startEmbeddedServer(): Promise<number> {
  const port = await getFreePort()                  // 范围 49152-65535
  process.env.PORT = String(port)
  process.env.HOSTNAME = '127.0.0.1'

  // 直接 require standalone 入口；Next 内部会 listen
  await import(path.join(standaloneDir, 'server.js'))

  // 探活：HEAD / 直到 200 为止（最多 10s，超时直接 app.quit）
  await waitUntilReady(`http://127.0.0.1:${port}/`)
  return port
}
```

**为什么不 spawn**：`spawn('node', ['server.js'])` 会多一个子进程要管生命周期（孤儿、信号、退出码），并且 main ↔ server 间无法共享内存常量。In-process require 让 Next 进程就是 main 进程，`app.quit()` 一并退出。

**端口策略**：49152-65535 范围 + 探可用，避免与开发期 `pnpm dev` 的 3000 冲突。

---

## 5. 数据路径迁移

### 5.1 现状

- DB：`process.cwd()/.agentmeld-data/agentmeld.db` —— 运行目录 = 仓库根
- Workspace：`process.cwd()/.agentmeld-data/workspaces/<convId>/`

打包后 `process.cwd()` 是用户启动 app 的目录（macOS 通常是 `/`），写不进去也不对。

### 5.2 目标

| 环境 | DATA_DIR |
|---|---|
| dev (`pnpm dev`) | `<repo>/.agentmeld-data`（不变） |
| dev (`pnpm electron:dev`) | `<repo>/.agentmeld-data`（连 dev server，复用） |
| 打包后 prod | `app.getPath('userData') + '/data'`<br>macOS：`~/Library/Application Support/AgentMeld/data`<br>Windows：`%APPDATA%\AgentMeld\data` |

### 5.3 实现

main 在 `app.whenReady()` 之前注入 env：

```ts
process.env.AGENTMELD_DATA_DIR = app.isPackaged
  ? path.join(app.getPath('userData'), 'data')
  : path.resolve(__dirname, '../..', '.agentmeld-data')  // 回到仓库根
```

改 `src/db/client.ts`：

```ts
const DATA_DIR = process.env.AGENTMELD_DATA_DIR
  ?? path.resolve(process.cwd(), '.agentmeld-data')      // web 模式兜底
```

改 `src/server/conversation-service.ts`：

```ts
const WORKSPACES_ROOT = path.join(
  process.env.AGENTMELD_DATA_DIR ?? path.resolve(process.cwd(), '.agentmeld-data'),
  'workspaces',
)
```

**为什么走 env var 而不是改成 export const fn**：减少 src 侧改动；env var 一处设置，DB 与 workspace 自动跟随；测试期可 stub。

**迁移现有 DB**：本地用户可手动把 `.agentmeld-data/` 整个拷贝到 `~/Library/Application Support/AgentMeld/data`。Phase 1 不做自动迁移（用户量小、迁移逻辑容易出 corner case；提供文档说明即可）。

**userData 路径还要 `app.setName('AgentMeld')`**：Electron 默认用 `package.json#name`（`agentmeld`）算 userData 路径。`electron/main.ts` 在 `app.requestSingleInstanceLock()` 之前覆盖名字到 productName，让 userData 落在 `~/Library/Application Support/AgentMeld/`（更友好；不显仓库代号）。

### 5.4 自动建表 + 自动 seed 内置 Agent

**问题**：打包后桌面版第一次启动时 `userData/data/agentmeld.db` 是空文件，没有任何表。drizzle 不会自动建表（它只是 ORM 层）。原来仓库 dev 流程依赖 `pnpm db:push`（drizzle-kit 推 schema）和 `pnpm db:seed` 灌内置 agent —— 这两个命令在 packaged app 里没法跑（用户机器上没有 pnpm）。

**做法**：在 `src/db/client.ts` 初始化 drizzle 之前同步建表 + seed，源文件 `src/db/bootstrap.ts`：

```ts
// CJS 模块顶层不能 await；用 better-sqlite3 原生同步 API
export function bootstrapDatabase(sqlite: Database.Database): void {
  // 1. CREATE TABLE IF NOT EXISTS × 所有表（幂等，已有不动）
  for (const stmt of DDL) sqlite.exec(stmt)
  // 2. 仅当没有 builtin agent 行时插入种子（幂等）
  ensureBuiltinAgents(sqlite)
}
```

调用点 `src/db/client.ts`：

```ts
const sqlite = globalForDb.sqlite ?? new Database(DB_PATH, { fileMustExist: false })
if (!globalForDb.sqlite) {
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  bootstrapDatabase(sqlite)        // ← 在 drizzle 拿到 sqlite 之前
  globalForDb.sqlite = sqlite
}
export const db = drizzle(sqlite, { schema })
```

**为什么用 raw DDL 字符串而不是从 schema.ts 反推**：drizzle-orm 没有「读 schema 转 DDL」的运行时 API；drizzle-kit 才有，但 drizzle-kit 是 CLI 工具，不该 require 进 standalone bundle。改 schema.ts 字段时**必须同步改 bootstrap.ts 的 DDL** —— 这是契约，违反的话第一次 packaged 启动会撞「no such column」。

**内置 Agent 数据**：`src/db/builtin-agents.ts` 导出 `BUILTIN_AGENTS: AgentInsert[]`，被 `bootstrap.ts`（packaged 启动）与 `src/db/seed.ts`（dev 用 `pnpm db:seed`）共用。当前 5 个内置：Conductor / PM 小灰 / UI 设计师 / 前端工程师 / Reviewer。改 builtin agent 列表 = 改 builtin-agents.ts 一处。

---

## 6. Native 依赖与打包

### 6.1 better-sqlite3 与 ABI 一致性

**问题**：原生 `.node` 文件绑定到具体 Node ABI（NODE_MODULE_VERSION）：

| Runtime | NODE_MODULE_VERSION |
|---|---|
| 系统 Node 24（上游） | 137 |
| 系统 Node 22 | 127 |
| Electron 33 内嵌 Node（Electron 私有 patches） | 130 |

同一份 `better_sqlite3.node` 只能跑一个 ABI。

> **⚠️ 2026-06-04 更新:`pnpm dev` 不再走 Electron Node。**
> 在 `ELECTRON_RUN_AS_NODE=1`(Electron 内嵌 Node)下,**Next 16 dev server 的请求/渲染 worker 起不来,所有 HTTP 请求挂死(0 字节、无 compile 日志)**;纯 Node 下 Next dev 完全正常(实测全路由含 DB 路由 200)。`next build` / `next start` / db CLI 不受影响(它们不是「按需编译的长驻请求服务」)。
> 因此 ABI 策略改为**两套**:
> - **`pnpm dev` / `pnpm test` / `pnpm e2e` → 纯 Node**,用 **Node ABI**;`scripts/ensure-node-sqlite.mjs` 在命令启动前打开 `better-sqlite3` 内存库,ABI 不符就 `pnpm rebuild better-sqlite3` 钉到当前 Node。
> - **`build` / `start` / `db:*` / packaged app → Electron ABI 130**,经 `scripts/ensure-electron-sqlite.mjs` 在 `ELECTRON_RUN_AS_NODE=1` 下打开内存库,ABI 不符就 `pnpm electron:rebuild`。
> 一份 `.node` 只能一种 ABI,所以在 web 开发/测试与 Electron build/db 之间仍会 flip-flop;但切换由 package scripts 自动完成,不再要求开发者记手动 rebuild。

**build / db / 打包仍统一 Electron ABI 130** 的做法:先跑 `scripts/ensure-electron-sqlite.mjs`,再经 `scripts/run-electron-node.mjs`(`ELECTRON_RUN_AS_NODE=1` 启动 Electron 内嵌 Node):

```
pnpm build       → ensure-electron-sqlite → ELECTRON_RUN_AS_NODE=1 electron node_modules/next/dist/bin/next build
pnpm db:push     → ensure-electron-sqlite → ELECTRON_RUN_AS_NODE=1 electron node_modules/drizzle-kit/bin.cjs push --force
pnpm db:seed     → ensure-electron-sqlite → ELECTRON_RUN_AS_NODE=1 electron node_modules/tsx/dist/cli.mjs src/db/seed.ts
pnpm dev/test    → ensure-node-sqlite → node/vitest/playwright(纯 Node)
```

`electron:build` 流程(全程 Electron ABI 130)是:

```
1. pnpm build              # next build 在 Electron Node 里跑，standalone 自带 ABI 130 .node
2. pnpm electron:prebuild  # 拷 static/public + 补依赖 + 清 broken symlinks/重复 runtime
3. pnpm electron:tsc       # 编 main 进程
4. electron-builder        # 打包；配 npmRebuild: false 禁用内置 rebuild（已经不需要）
```

**`build.npmRebuild: false`** 必须配。否则 electron-builder 默认会跑 `@electron/rebuild`，pnpm 的 content-addressable 硬链接会让 staging 副本的 rebuild 污染 source store —— 那条老路上每次 build 完都得手动 `pnpm rebuild better-sqlite3` 恢复 dev。

**Electron 33 vs better-sqlite3 12.10.0**：本项目锁 `electron@33.4.11`，因为 better-sqlite3 12.10.0 native 代码用过时的 `v8::External::New(isolate, addon)` 2 参数形式，跟 Electron 34+ 的 V8 13 不兼容（编译报 "expected 3, have 2"）。等 better-sqlite3 升级支持新 V8 API 后再追新 Electron major。

**asarUnpack: `[".next/standalone/**"]`** 仍然必要（chdir 跨不进 asar 归档，详见 §6.5）。

### 6.2 @anthropic-ai/claude-agent-sdk

- SDK 内部 `spawn('claude-code')` 调用 Claude Code CLI 二进制
- 需求：用户机器上**已**装过 Claude Code CLI（与现状一致；不打包进 app）。打不到时由 SDK 在第一次 `query()` 时抛错，UI 走错误路径展示
- SDK 自带的 JS 入口需要能被 require：放在 standalone 的 node_modules 里，electron-builder 默认会带

### 6.3 @openai/codex-sdk

- SDK 使用 npm 依赖里的 `@openai/codex` runtime，通过 `runStreamed()` 输出结构化 JSONL 事件；不要求用户额外全局安装 Codex CLI
- `@openai/codex` 通过 optionalDependencies 携带平台二进制包（darwin / linux / win32 × x64 / arm64）
- `next.config.ts` 必须把 `@openai/codex-sdk` / `@openai/codex` 放进 `serverExternalPackages`，避免被打包器内联后丢失 CLI binary 查找语义
- `scripts/electron-prebuild.mjs` 的 standalone 依赖补齐逻辑以 Next 已 trace 的包 + 明确 server runtime allowlist 为种子，递归读取 dependencies / optionalDependencies，并把当前平台可用的 Codex runtime 一起带进 `.next/standalone/node_modules`；不要从 root `package.json` 全量补依赖，避免把纯前端库打进 Electron Node runtime
- `scripts/electron-prebuild.mjs` 只保留顶层 npm alias 平台包（如 `@openai/codex-darwin-arm64`），删除 Next tracer 可能额外带入的 `.pnpm/@openai+codex@...-<platform>` 重复 runtime store，避免 Electron 安装体积多出约 190MB
- Codex adapter 默认 `networkAccessEnabled=false`、`webSearchMode='disabled'`；Review 模式 read-only，Auto 模式 workspace-write；子进程 `CODEX_HOME` 指到 AgentMeld dataDir 下，避免继承用户 `~/.codex` / CC Switch 配置
- Codex adapter 的 AgentMeld MCP bridge 由 `scripts/agentmeld-codex-mcp.mjs` 启动；Next standalone 必须通过 `outputFileTracingIncludes` 把该脚本复制到 `.next/standalone/scripts/`，Electron embedded server 会设置 `AGENTMELD_INTERNAL_BASE_URL`

### 6.4 electron-builder 配置（节选 package.json）

```json
{
  "build": {
    "appId": "com.agentmeld.app",
    "productName": "AgentMeld",
    "directories": { "output": "release" },
    "asar": true,
    "asarUnpack": [
      ".next/standalone/**"
    ],
    "files": [
      "dist-electron/**",
      ".next/standalone/**",
      "package.json"
    ],
    "npmRebuild": false,
    "mac": {
      "category": "public.app-category.developer-tools",
      "target": [{ "target": "dmg", "arch": ["arm64", "x64"] }],
      "hardenedRuntime": false,
      "gatekeeperAssess": false
    },
    "win": {
      "target": [{ "target": "nsis", "arch": ["x64"] }]
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true
    }
  }
}
```

`npmRebuild: false` 关键：禁用 electron-builder 内置的 `@electron/rebuild`。Electron ABI 准备由 `scripts/ensure-electron-sqlite.mjs` 在 build/db 命令前完成，不需要 electron-builder 再 rebuild。开了它反而会通过 pnpm 硬链接污染 source store。

### 6.5 asarUnpack + .asar.unpacked require 路径

**为什么 `asarUnpack: [".next/standalone/**"]`**：Next 的 standalone `server.js` 启动第一行就 `process.chdir(__dirname)`。`chdir` 是真实文件系统系统调用，跨不进 asar 归档（asar 不是真实目录），会抛 `ENOTDIR`。把整个 standalone 解出到 `app.asar.unpacked/.next/standalone/`，`__dirname` 就指向真实目录，chdir 通过。better-sqlite3 / claude-agent-sdk 都在 standalone 自带的 node_modules 里，跟着一起 unpack，不需要单独写 `**/better-sqlite3/**`。

**⚠️ 还要 require unpacked 路径**：仅仅 `asarUnpack` 不够。如果通过 `app.getAppPath() + '.next/standalone/server.js'` 这条 `.asar/...` 路径 require，Electron 的 asar layer 会把模块的 `__dirname` 设成 asar 逻辑路径（即使物理文件在 `.asar.unpacked/...`）。chdir 看到 asar 逻辑路径，依然 ENOTDIR。`server-bootstrap.ts` 必须把 `.asar` 替换成 `.asar.unpacked`，让 require 走真实磁盘路径，绕过 asar layer：

```typescript
const appPath = app.getAppPath()
const standaloneRoot = appPath.endsWith('.asar')
  ? appPath + '.unpacked'
  : appPath  // dev 模式没 asar
require(path.join(standaloneRoot, '.next', 'standalone', 'server.js'))
```

**`scripts/electron-prebuild.mjs` 做四件事**：
1. 把 `.next/static` 与 `public/` 拷进 `.next/standalone/` 子树。Next standalone 默认不包含这两份内容，server.js 启动后会找不到静态资源
2. 递归补齐 Next 已 trace 的包 + 明确 server runtime allowlist 在 `.next/standalone/node_modules` 中缺失的运行时依赖；非当前平台的 optional runtime 包会被跳过
3. 删除 Codex npm alias 已经提供的平台 runtime 对应的 `.pnpm/@openai+codex@...-<platform>` 重复 store；运行时解析走顶层 alias 包，重复 store 只会增加安装体积
4. 扫 standalone 子树清除 broken symlinks。pnpm 在 `.next/standalone/node_modules/.pnpm/node_modules/` 里有部分 hoist 入口指向未被 Next file tracer 收录的旧版本（典型：`semver -> ../semver@6.3.1/...`，但 standalone 只带 `semver@7.8.1`）。这些 dangling link 运行时无害，但 electron-builder 打包阶段 `stat` 会 ENOENT

### 6.6 next.config.ts 改动

```ts
const nextConfig: NextConfig = {
  output: 'standalone',
  // Electron 打包后 native / SDK 子进程依赖走运行时 require/import，不要 webpack bundle 它
  serverExternalPackages: [
    'better-sqlite3',
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    '@openai/codex',
  ],
}
```

---

## 7. 开发与构建流程

### 7.1 ABI preflight

`pnpm install` 后无需手动切 ABI。常用命令会自行执行对应 preflight：

- `scripts/ensure-node-sqlite.mjs`：在当前 Node 下 `new Database(':memory:')` + trivial query；失败且是 native ABI/load error 时跑 `pnpm rebuild better-sqlite3`。
- `scripts/ensure-electron-sqlite.mjs`：用 `ELECTRON_RUN_AS_NODE=1 electron scripts/check-sqlite-binding.mjs` 打开内存库；失败且是 native ABI/load error 时跑 `pnpm electron:rebuild`。
- `scripts/check-sqlite-binding.mjs`：共享的真实 native binding 检查入口。**只 import package 不够**，`better_sqlite3.node` 到打开数据库时才会加载。

### 7.2 命令

| 命令 | 行为 |
|---|---|
| `pnpm dev` | `pnpm sqlite:ensure:node && node next dev` —— **纯 Node**(Node ABI);electron-as-node 会让 Next dev 请求挂死,故 dev 不走 wrapper |
| `pnpm test` / `test:watch` / `e2e` | 先 `sqlite:ensure:node`,再跑 Vitest / Playwright |
| `pnpm build` / `start` | 先 `sqlite:ensure:electron`,再 `ELECTRON_RUN_AS_NODE=1 electron next build/start` |
| `pnpm db:push` / `db:seed` / `db:studio` / `db:generate` | 先 `sqlite:ensure:electron`,再通过 `run-electron-node.mjs` 包装 |
| `pnpm electron:dev` | 并发跑 `pnpm dev` + `tsc watch` + Electron main 窗口；main 不嵌 server，loadURL `http://localhost:3000` |
| `pnpm electron:rebuild` | `scripts/rebuild-electron-sqlite.mjs` 直接用 Electron headers 重建 better-sqlite3（通常只作手动强制修复） |
| `pnpm electron:build` | `pnpm build` → `pnpm electron:prebuild` → `pnpm electron:tsc` → `electron-builder` |

### 7.3 electron-dev 详细

`electron/main.ts` 检测 `process.env.AGENTMELD_DEV === '1'` → 跳过 §4.3 内嵌 server，直接 `loadURL('http://localhost:3000')`。

启动靠 `concurrently` 并发跑三件事：
- `pnpm dev` → Next dev server(**纯 Node**,Node ABI)
- `tsc -w -p electron/tsconfig.json` → 把 main.ts 编到 `dist-electron/main.js` 并 watch
- `wait-on tcp:127.0.0.1:3000 file:./dist-electron/main.js` → 两边都就绪后启动 `scripts/electron-dev.mjs`（注入 `AGENTMELD_DEV=1` 后 spawn `electron dist-electron/main.js`）

### 7.4 electron-build 详细

```bash
pnpm electron:build
# 1. pnpm build           — ensure Electron ABI;Next 在 Electron Node 里 build，standalone 自带 ABI 130 .node
# 2. pnpm electron:prebuild — 拷 static/public + 补依赖 + 清 broken symlinks/重复 runtime
# 3. pnpm electron:tsc      — 编 main 进程到 dist-electron/main.js
# 4. electron-builder       — 打包；npmRebuild: false，直接复用现成的 ABI 130 .node
# 输出 release/AgentMeld-<ver>.dmg、release/AgentMeld-<ver>-setup.exe
```

打包链路 ABI 一致，且没有 afterPack hook。源码 `node_modules` 的 ABI 会按最后执行的 Node/Electron 命令自动切换；这是单 native binding 的预期行为。

---

## 8. 跨平台细节（与 Spec 11 对齐）

- **Shell 选择 / 黑名单 / 路径校验**：完全复用 Spec 11 的实现，Electron 包装层不改这部分。`getEffectiveCwd` 仍走 workspace
- **HOME env 兜底**：Spec 11 §「SDK 子进程的 HOME 兼容」依旧适用；Electron 在 Windows 上 `process.env.HOME` 同样可能缺失
- **路径大小写**：Spec 11 的 `isPathWithin` 与 `isPathSafe` 不受 Electron 影响
- **userData 是「敏感目录」吗**：`~/Library/Application Support/AgentMeld` / `%APPDATA%\AgentMeld` 本身是「应用自己的写区」，不在 Spec 11 §systemRoots / sensitiveSegments 列表内。但用户**绑定的 boundPath（local workspace）**仍受 `isPathSafe` 检查 —— 与 web 版语义一致

---

## 9. 安全模型

- Renderer `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true` —— 渲染端等同浏览器
- Preload（如启用）只暴露白名单 API：当前只规划 `electronAPI.pickDirectory()` 走原生 dialog 选 boundPath，**Phase 1 可不挂**（继续用 web 版 `/api/fs/listdir`）
- 不开 `webSecurity: false`、不开 `allowRunningInsecureContent`
- iframe 渲染 LLM 产物：与 web 版完全一致（`sandbox="allow-scripts"`，详见 CLAUDE.md §5.1）
- API key 存储：与 web 版完全一致（`app_settings` SQLite 单行表，详见 Spec 08 §8）。**不**引入 OS keychain / safeStorage：
  - macOS：`~/Library/Application Support/AgentMeld/data/agentmeld.db` 默认只本用户可读（OS 文件权限），与浏览器 localStorage / IndexedDB 同级别
  - Windows：`%APPDATA%\AgentMeld` 同理
  - 引入 keychain 会增加跨平台代码、密码提示、多账号语义复杂度，详见 CLAUDE.md §5.4

---

## 10. CSP 与本地 origin

Renderer 加载 `http://127.0.0.1:<port>`，等价于一个本地 web 站点：

- API fetch 走相对路径 `/api/...`，浏览器自动同源
- SSE 同上
- 浏览器开发工具：dev 模式自动打开，prod 默认关闭（`webPreferences.devTools: !app.isPackaged`）

---

## 11. 失败回退

如果 standalone in-process require 在某个 Next.js 版本下出问题（已知 16.x 仍在快速迭代），**回退方案**：

1. 退到 `spawn('node', [path.join(__dirname, '../.next/standalone/server.js')])` 子进程模式
2. main 监听子进程 stdout/stderr 并 forward 到日志文件 `~/Library/Logs/AgentMeld/`
3. `app.on('before-quit')` → 主动 SIGTERM 子进程；2s 未退升级 SIGKILL（Windows 用 `taskkill /F /T /PID`，沿用 Spec 11 §「进程清理」的 helper）

Spec 12 把 in-process 作为首选；回退方案保留入口（同一份 main 代码用 env flag 切换）。

---

## 12. 验证清单

**ABI / DB bootstrap（本次主要验证项）**：
- [x] dev server 起得来、`GET /api/agents` 返回 200 + 5 个内置 agent(自动 seed 通过)。**注:`pnpm dev` 现为纯 Node(Node ABI);electron-as-node 下会挂死,见 §6.1 更新**
- [x] `pnpm test` 先跑 Node ABI preflight,即使上一条命令把 native binding 切到 Electron ABI,也会自动切回 Node ABI
- [x] `pnpm build` / `pnpm db:*` 先跑 Electron ABI preflight,即使上一条命令把 native binding 切到 Node ABI,也会自动切回 Electron ABI
- [x] `pnpm electron:build` 日志包含 `skipped dependencies rebuild reason=npmRebuild is set to false`（确认没有 npm rebuild 反复污染 source store）
- [x] packaged `Contents/MacOS/AgentMeld` 从终端启动无错误，`~/Library/Application Support/AgentMeld/data/agentmeld.db` 8 张表全建好，5 个内置 agent 已自动 seed
- [x] packaged app 内 `app.asar.unpacked/.next/standalone/.../better_sqlite3.node` 是 arm64（standalone 自带的那份就是 ABI 130，无需 afterPack 覆盖）

**功能等价（macOS / Windows 都需通过）**：
- [ ] 启动后能进入主界面，sidebar 列出 builtin agents
- [ ] 「设置」面板填 key → 创建会话 → 发消息 → agent 回复
- [ ] sandbox workspace：bash 工具能跑 `ls` / `Get-ChildItem`
- [ ] local workspace：能绑定 `~/Documents/somewhere`，bash 在该目录跑
- [ ] Claude Code agent：能跑 `query()`，子进程能起来（前提是用户装过 Claude Code CLI）
- [ ] 重启 app 后会话历史还在（DB 在 userData 而非临时目录）
- [ ] SSE：消息流式输出可见

**打包与安装**：
- [x] `pnpm electron:build` 输出 `release/AgentMeld-<ver>-arm64.dmg`、`release/AgentMeld-<ver>.dmg`、（Windows 待验）`release/AgentMeld-<ver>-setup.exe`
- [ ] DMG 拖进 Applications 后双击能启动（macOS 26+ 需在 System Settings → Privacy & Security 点 "Open Anyway" 绕过 Gatekeeper 未签名警告）
- [ ] EXE 安装后开始菜单出现快捷方式，启动正常
- [x] 安装包体积 < 300 MB（实测 arm64 = 179 MB，x64 = 185 MB）

**资源 / 安全**：
- [ ] 进程列表里只有 1 个主进程 + 1 个 renderer + 必要的 chromium helper（无孤儿 Next server 子进程）
- [ ] 关闭主窗口 → 全部进程退出
- [ ] DevTools 在 prod 不可开（`Cmd+Option+I` 无反应）
- [ ] `~/Library/Application Support/AgentMeld/data/agentmeld.db` 文件权限 `0600`-类（仅本用户可读）

---

## 13. 不做 / 推迟

| 项 | 不做的理由 |
|---|---|
| Auto-update（electron-updater） | 需要架设静态文件服务器分发更新清单；Phase 1 让用户手动下载新版即可 |
| 代码签名 / 公证（macOS Notarization） | 需要 Apple Developer 账号 + 公证服务器流水；社区分发可接受首次「右键 → 打开」 |
| Linux 构建 | 用户量低，等需求 |
| 多窗口 / 多实例 | `singleInstanceLock` 限定单实例；多窗口未来再说 |
| 应用菜单 / 托盘 / 全局快捷键 | Phase 1 用 Electron 默认菜单（即 OS 标准菜单），不做自定义 |
| 深链接 protocol handler（`agentmeld://`） | 未规划用户场景 |
| 把 Claude Code CLI 打包进 app | CLI 体积大、版本与官方解耦，让用户自行装；缺失走错误提示 |
| OS keychain / safeStorage 存 key | 详见 CLAUDE.md §5.4 与 §9 |
| 渲染端 IPC 暴露 | Phase 1 通信全走 HTTP/SSE；preload 仅在 native dialog 介入时启用 |

---

## 14. 与其它 spec 的关系

- **Spec 08（DB schema）**：`AGENTMELD_DATA_DIR` env 决定 `agentmeld.db` 位置；表结构不变。`app_settings` 是 desktop / web 共用的全局 key 持久层（详见 Spec 08 §8）
- **Spec 11（平台）**：Shell / 黑名单 / 路径校验 / 进程清理完全复用；本 spec 不重复定义。本 spec 仅追加「userData 不是敏感目录」一条
- **CLAUDE.md §5.4**：明确 Electron 模式仍走 `app_settings` 表，不引入 keychain
- **README.md「快速开始」**：Phase 1 不在 README 替换为「下载安装包」入口；待打包稳定后再加
