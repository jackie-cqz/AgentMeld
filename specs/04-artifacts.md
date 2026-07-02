# Spec 04 — Artifacts

> Artifact 是 Agent 产出的「可独立预览的产物」：网页 / 代码 / 文档 / 图片 / PPT；历史 `diff` 产物仅做只读兼容。**与 Message 解耦**，有独立的生命周期、版本、二次编辑。**修改 ArtifactContent 结构需先讨论。**

源文件：`src/shared/types.ts`、`src/db/schema.ts`、`src/server/artifact-service.ts`、`src/server/deployment-service.ts`、`src/components/artifact-preview-panel.tsx`、`src/server/tools/write-artifact.ts`、`src/server/tools/deploy-artifact.ts`

---

## 设计原则

1. **独立于 Message**（CLAUDE.md §3.5）：产物有自己的 DB 行，不内联在 message.parts 的字符串里
2. **消息只持有引用** —— `artifact_ref` part 引用 artifactId（详见 Spec 03）
3. **版本链 via parent**：v2 在 `parentArtifactId` 指向 v1，物理上是新一行
4. **6 种 type 共享一张表**：用 `content: JSON` 列存可辨联合，按 `type` 字段分发
5. **来源唯一**：Agent 通过 `write_artifact` 工具创建；不允许 Adapter / 前端直接写 artifacts 表

---

## ArtifactContent 六种 type

源：`src/shared/types.ts:38-68`

```typescript
type ArtifactContent =
  | { type: 'web_app'; files: Record<string, string>; entry: string }
  | { type: 'code_file'; workspacePath: string; language: string; sizeBytes: number; checksum: string }
  | { type: 'diff'; targetArtifactId: string; hunks: DiffHunk[]; applied: boolean }
  | { type: 'document'; format: 'markdown'; content: string }
  | { type: 'image'; url: string; alt: string; width?: number; height?: number }
  | { type: 'ppt'; title?: string; theme?: PptTheme; slides: PptSlide[] }
  // PptSlide: { title?, subtitle?, bullets?: string[], blocks?: PptBlock[], notes?, layout? }
  // PptLayout: 'title'|'title-bullets'|'section'|'blank'|'content'|'two-column'|'metrics'|'timeline'|'quote'
  // PptBlock: heading | paragraph | bullets | metric | quote | timeline | columns | callout | divider | spacer
  // PptTheme（全可选 hex 视觉 token）: { primary, background, surface, textBody, textMuted, accentPositive, accentNegative, divider, fontHeading, fontBody }；渲染经 resolvePptTheme 填默认（src/shared/ppt-theme.ts）
```

### 存储策略对照

| type | 内容存哪 | 用途 | 写入工具 |
|---|---|---|---|
| `web_app` | **DB JSON 列**（files: Record<path, source>） | 完整 HTML/CSS/JS 包，iframe 渲染 | `write_artifact` |
| `document` | **DB JSON 列**（content: markdown 字符串） | 文档 / 报告 / 说明 | `write_artifact` |
| `image` | **DB JSON 列**（url + alt + 可选尺寸） | URL 或 data URI | `write_artifact` |
| `diff` | **DB JSON 列**（hunks 列表 + 目标 artifactId） | 历史兼容：只读双栏预览，不再作为 Agent 新产物类型 | legacy/internal |
| `code_file` | **仅 workspacePath 入 DB**，文件本身在 workspace 文件系统 | 大代码文件 / 多文件项目，面板可从 workspace 加载 | workspace/fs + 用户面板编辑 |
| `ppt` | **DB JSON 列**（slides 数组：legacy title/bullets 或 semantic blocks） | 幻灯片，分页预览 + 导出真 .pptx | `write_artifact` |

**为什么 code_file 不入 DB**：代码文件可能 MB 级，塞 SQLite JSON 列会卡。改为 workspace 引用 + checksum 校验。`code_file` 当前由 workspace 文件读写路径承载，产物面板根据 `artifact.conversationId + content.workspacePath` 读取文件内容；用户在面板内保存时，先写回 workspace 文件，再创建一个新的 `code_file` 版本记录更新 size/checksum。

---

## MVP 限制

`write_artifact` 工具当前 `type` 接：`'web_app' | 'document' | 'image' | 'ppt'`。`diff` 不再暴露给 Agent 作为新产物类型；产物差异由 ArtifactPreviewPanel 的版本对比功能从两条已存版本确定性生成。`code_file` 仍不由 LLM 直接创建，避免把大文件内容塞进 DB 或绕过 workspace 文件写入路径。

源码 `src/server/tools/write-artifact.ts:21`：
```typescript
const ArgsSchema = z.object({
  type: z.enum(['web_app', 'document', 'image', 'ppt']),
  title: z.string().min(1),
  content: z.unknown(),
})
```

---

## DB 行结构

源：`src/db/schema.ts:88-109`（详见 Spec 08）

```typescript
artifacts {
  id                  // art_<nanoid>
  conversation_id     // FK → conversations.id (cascade)
  type                // ArtifactType
  title               // 人读标题
  content             // JSON: ArtifactContent
  version             // int, default 1
  parent_artifact_id  // 版本链（v2 → v1），不建外键
  created_by_agent_id // FK → agents.id
  created_at
}
INDEX idx_artifacts_conv ON (conversation_id)
```

`ArtifactRow` = drizzle inferred `$inferSelect`。

`ArtifactRecord`（用于事件 payload，`types.ts:117-127`）：字段同 row，但 `parentArtifactId` optional（兼容旧 emit 路径）。

---

## 写入路径：write_artifact 工具

源文件：`src/server/tools/write-artifact.ts`

### 参数容错（drift）

handler 接受 4 种 `content` 形状，归一化到标准 `ArtifactContent`：

| 输入形态（content 字段） | 归一化目标 | 例子 |
|---|---|---|
| `{ files: { ... }, entry }` | 直接用 | 标准 web_app |
| `{ html, css?, js? }` | 映射到 `index.html` / `style.css` / `script.js` | `{ html: '<div/>', css: 'body{}' }` |
| `{ content: '<html>...' }` 或 `{ code: '...' }` | 单文件 `index.html` | LLM 喜欢用 `content` 键 |
| 裸字符串 `'<html>...'` | 同上 | LLM 直接给 HTML |

document 类似：`{ content }` / `{ markdown }` / `{ text }` / 裸字符串都接受。

image 接受 `{ url, alt? }` 或裸 URL 字符串。

ppt 接受旧版 `{ title, bullets, notes?, layout? }` slide，也接受新版 block DSL：`subtitle`、`layout: 'content'|'two-column'|'metrics'|'timeline'|'quote'` 等，以及 `blocks`。支持的 block 类型固定为 `heading` / `paragraph` / `bullets` / `metric` / `quote` / `timeline` / `columns` / `callout` / `divider` / `spacer`；`columns` 子 block 只允许 `paragraph` / `bullets` / `metric` / `callout`。旧版 bullets 在渲染/导出边界由 `src/shared/ppt-normalize.ts` 归一化为 `{ type: 'bullets', items }`，不迁移历史 DB 行。PPT JSON 不允许直接嵌入 `data:*;base64,...` 这类无界二进制 payload；图片等大资产必须走可安全解析的 URL / 附件 / workspace 引用（当前 PPT 首版不实现图片 block）。

diff 解析逻辑仍保留在 `buildArtifactContent('diff', ...)`，用于旧 DB 行和内部兼容路径，但 `write_artifact` 的 zod schema / JSON Schema / LLM 描述不再接受 `diff`。

**为什么宽松**：LLM 即使按 JSON Schema 生成也会漂移。宁可在工具入口归一化，也不要因为参数键不对就直接 fail（用户感知是 agent「无故失败」）。

### 写入流程

```
1. zod 校验 type / title
2. buildArtifactContent(type, content) 归一化 → ArtifactContent | null
   null 则返回 ok:false
3. INSERT artifacts (id=art_<nanoid>, version=1, ...)
4. 返回 ok:true, value: { artifactId, title, type }

不做的事：
- 不直接 emit artifact.create 事件
- 不直接给 message 加 artifact_ref part
```

### 后续注入路径

write_artifact 只入库 + 返回 artifactId。**Adapter** 在 tool_result 之后检测到 result.value.artifactId 时：

1. 从 DB 拉完整 artifact row
2. yield `{ type: 'artifact.create', artifact: <row> }` 事件
3. AgentRunner 接到 artifact.create → 给当前 message 末尾 push `artifact_ref` part 并补发 `part.start`

这样事件流单一来源（Adapter emit），DB 写入单一来源（工具 handler），互不串味。

---

## 渲染契约

源：`src/components/artifact-preview-panel.tsx`

### 入口：ArtifactPreviewPanel

```
store.previewArtifactId → ArtifactPreviewPanel
                              │ 按 content.type 分发
                              ▼
   ┌─────────┬─────────────┬─────────┬───────────────┬─────────┬─────────┐
   │ web_app │  document   │  image  │   code_file   │  diff   │   ppt   │
   │         │             │         │ workspace ref │ viewer  │ slides  │
   └─────────┴─────────────┴─────────┴───────────────┴─────────┴─────────┘
```

### web_app

`WebAppView`：
- 上方 tab 切「预览 / 源码」
- 预览：`<iframe src="/api/artifacts/:id/preview" sandbox="allow-scripts">`（**没有 allow-same-origin**，详见 CLAUDE.md §5.1）
- 源码：选文件 dropdown + `<pre><code>` 显示（**TODO**：源码视图也走 shiki 高亮）
- `buildIframeHtml`：共享 helper，自动把 `style.css` / `script.js` 注入到 `index.html` 的 `</head>` / `</body>` 前；裸 HTML 片段会自动包成完整 doc

### 一键预览 URL

`GET /api/artifacts/:id/preview` 只服务 `web_app` artifact，返回 `text/html`，并设置 CSP sandbox / `nosniff` / `no-store`。前端 artifact 卡与 ArtifactPreviewPanel 顶部直接使用该实时预览路径。

`deploy_artifact` 始终会从 `web_app` artifact 生成本地静态发布目录；`deploy_workspace` 则从 workspace 内已经构建好的静态目录复制文件到同一套发布目录结构：

```
.agentmeld-data/deployments/dep_xxx/
  index.html
  assets/
    app.js                    # 嵌套目录原样保留
  ...                         # 对外可服务的静态资源
```

无外部发布配置时，成功返回的 `DeployStatusRecord.previewPath` 指向稳定 `/deployments/:id`。当前 Web MVP 未实现源码包与容器包下载，因此不返回虚假的下载路径：

```typescript
{
  id: 'dep_xxx',
  artifactId: 'art_xxx',
  title: string,
  version: number,
  previewPath: '/deployments/dep_xxx',
  status: 'ready' | 'failed',
  sourceType?: 'artifact' | 'workspace',
  workspacePath?: 'dist',
  deploymentType?: 'local_static' | 'external_static',
  deploymentPath?: '/deployments/dep_xxx',
  localPreviewPath?: '/deployments/dep_xxx',
  publicUrl?: 'https://example.com/apps/dep_xxx/',
  publishPath?: 'D:\\sites\\agentmeld\\dep_xxx',
  publishTargetType?: 'static_directory',
  summaryInstruction?: string,
  error?: string,
  createdAt: number
}
```

`sourceType='artifact'` 的记录来自聊天内 `web_app` artifact；`sourceType='workspace'` 的记录来自本地 workspace 静态输出目录，`artifactId` 使用 `workspace:<workspacePath>` 占位，`version` 固定为 `0`。

若 `app_settings` 配置了外部静态发布目标，`deploy_artifact` / `deploy_workspace` 会额外把公开文件复制到 `<deployment_publish_dir>/<deploymentId>/`，并把 `previewPath` 设为 `deployment_public_base_url + deploymentId + '/'`。这种情况下 `localPreviewPath` 保留本地回退路径，`publishPath` 是实际写入目录。AgentMeld 不启动外部托管服务，用户需要让 nginx / Caddy / Tailscale Serve / Pages 同步等服务指向该发布根目录。

`summaryInstruction` 只给 Agent 看，用于约束最终文字总结：本地发布时不得自造公网域名；外部发布时只能引用结构化返回的 `previewPath` / `publicUrl`，不得改写成其它 URL。UI 展示仍以结构化部署卡片为准。

`GET /deployments/:id/[[...path]]` 只从该 deployment 目录读文件，拒绝访问 `.agentmeld` 私有目录和路径逃逸。HTML 响应继续设置 CSP `sandbox allow-scripts` / `nosniff` / `no-store`。

源码 ZIP 与容器 ZIP 属于后续导出能力；实现对应路由前，`DeployStatusRecord` 不得宣传 `sourceDownloadPath` / `containerDownloadPath`。

### document

`DocumentView`：直接走 `<Markdown>`（同消息气泡里 text part 的渲染），含 shiki 高亮的 fenced code block。

### image

`ImageView`：`<img>` 居中 + 灰底，限制 max-h/max-w 防超出面板。

### code_file

`CodeFileView`：根据 `artifact.conversationId + content.workspacePath` 调 workspace read API 加载文件内容，提供「源码 / 编辑」视图。保存时走用户手动文件写入 API（不走 Agent fs_write 审批），随后通过 `POST /api/artifacts/:id/versions` 创建新的 `code_file` 版本，记录更新后的 `sizeBytes` 与 checksum。超出读取上限被截断的文件只允许查看，不允许保存。

### version compare

当同一条版本链存在 2 个及以上版本时，`ArtifactPreviewPanel` 顶部显示「对比版本」入口。前端基于 `GET /api/artifacts/:id/versions` 返回的完整版本行，在客户端调用 `buildArtifactVersionDiff(oldContent, newContent)` 生成只读 diff section：

- `document`：比较 markdown 正文。
- `web_app`：比较两版文件名并集，每个文件一个 diff section；新增/删除文件以空文本对比。
- `ppt`：比较稳定排序后的 slides JSON。
- `code_file`：只比较 DB 中的 workspace metadata（真实文件内容是 live workspace，不在 artifact 版本里保存快照）。
- `image` / 跨类型 / 历史 `diff`：显示不支持确定性文本对比，不让 Agent 另造 diff artifact。

### diff (legacy)

`DiffArtifactView`：把历史 `diff` 产物的 `hunks` 还原为修改前/修改后文本，复用 `react-diff-viewer-continued` 双栏渲染，与 fs_write 审批 diff 保持一致。顶部显示「历史 diff · 只读」、目标 artifactId 与 applied 状态。当前只预览 diff，不直接应用到目标 artifact。

### ppt

`SlideDeckView`（`artifact-preview-panel.tsx`）：先调用 `normalizePptDeck`，再从 canonical slides 渲染分页幻灯片（◀▶ 翻页 + 页码 + 全屏）。旧版 `title/bullets/layout` 仍显示为原有「标题 + 卡片化要点」风格；新版 `blocks` 支持 heading、paragraph、bullets、metric、quote、timeline、columns、callout、divider、spacer。所有文本容器用固定 slide 边界内的 line clamp / overflow hidden / anywhere wrap，避免长文本撑破预览或全屏画布。**预览与 pptx 导出同源消费 `resolvePptTheme`**（`src/shared/ppt-theme.ts`：把完整视觉 token 填默认后用于背景/主色/正文/字体/字号），反映设计的整套配色而非单一主色。要点纯文本（非 markdown，与导出一致）。「编辑 JSON」视图展示 `toEditablePptContent` 生成的 block-based JSON，保存后提交新版本。

**导出真 .pptx**：`GET /api/artifacts/:id/export` 的 ppt 分支默认等价于 `?mode=editable`，调 `src/server/ppt-export.ts` 的 `slidesToPptxBuffer`，用 `pptxgenjs`（动态 import；next.config `serverExternalPackages` 已登记）把 canonical blocks 转成 Office 可打开、可继续编辑的 .pptx 二进制。预览近似、导出为交付物（浏览器难像素级预览 pptx）。

**visual-priority 导出**：接口接受 `?mode=visual` 作为显式高保真/图片型导出意图；当前首版未启用 HTML/CSS 截图渲染器，返回 501 且提示改用默认 editable 导出。没有 `mode` 参数时必须保持 editable `.pptx` 行为，保证旧下载 URL 兼容。

---

## 卡片入口：artifact_ref part

源：`src/components/message-parts.tsx:205-273`

`<ArtifactRefPart artifactId>`：

1. `useAppStore.artifacts[id]` 读
2. 若不在 store，`fetchArtifact(id)`：
   - 200 → `upsertArtifact(row)`
   - 404 → 渲染「产物已删除」墓碑卡片（type=document/web_app 等都灰化）
3. 命中后渲染：图标 + title + `type · v<version> · 点击预览`
4. 点击 → `openArtifactPreview(id)` 触发右侧面板滑入

---

## 删除

源：`DELETE /api/artifacts/[id]` → `artifact-service.deleteArtifact`

直接 `DELETE FROM artifacts WHERE id = ?`。**不删除引用该 artifact 的 message 里的 artifact_ref part**（part 仍存，前端 lazy fetch 时 404 显示墓碑）。

会话级 cascade：删除 conversation → `artifacts` 表通过 FK `ON DELETE CASCADE` 自动清空。

---

## 版本链 + 二次编辑（已实现）

字段：`artifacts.parent_artifact_id` + `version`。新版本 = **新行**，`parentArtifactId` 指向父，`version = parent.version + 1`（不原地改）。

**三条写新版本的路径**，共用 `buildArtifactContent`（`src/server/artifact-content.ts`）做内容校验/规整（单一来源）：

1. **Agent 驱动**：`write_artifact` 工具传 `parentArtifactId`（由 LLM 决定）→ Adapter 在 `tool.result` 后发 `artifact.create`，Runner 注入 `artifact_ref` part。
2. **用户驱动**：在 `ArtifactPreviewPanel` 里用 CodeMirror 编辑 →「提交为新版本」→ `POST /api/artifacts/:id/versions` → `artifact-service.createArtifactVersion(parentId, content, title?)`（继承父的 `conversationId` / `type` / `createdByAgentId`）→ 前端 `upsertArtifact` + `openArtifactPreview(newId)` 切到新版本。可编辑范围：**web_app（多文件）/ document（markdown）/ ppt（slides JSON）**；image / diff 不可编辑。
3. **workspace code_file 用户编辑**：面板先通过 workspace write API 写回真实文件，再创建新的 `code_file` 版本记录。DB 里仍只保存 metadata，不保存完整代码正文。

**版本链读取**：`GET /api/artifacts/:id/versions` 从 root BFS 收集整条链，按 `version` 升序；`ArtifactPreviewPanel` 顶部「历史」切换条据此渲染。

注：`StreamEvent 'artifact.update'`（浅合并 patch）类型 + reducer 仍在，但版本链走「新行 + `artifact.create`」而非原地 patch；`artifact.update` 保留给未来「原地更新」场景。

---

## 列表 / 全局视图

源：`GET /api/artifacts` → `listArtifacts()`

`ArtifactLibrary` 组件（在 sidebar 第三个 tab）：
- 列出全部产物按 `createdAt` 降序
- 一次性 JOIN 出 `conversationTitle`（避免 N+1）
- 点击进入对应会话并打开预览面板
- 删除按钮 → DELETE API

---

## 安全 / 沙箱

- **web_app 的 iframe 必须 `sandbox="allow-scripts"`，绝不加 `allow-same-origin`**（CLAUDE.md §5.1）。LLM 生成的 JS 可能尝试访问宿主 cookie / localStorage，必须隔离
- **web_app 的 preview route 必须设置 CSP sandbox**，和 iframe sandbox 形成双层约束
- **document 的 markdown 由 react-markdown 渲染**，默认不开启原生 HTML（避免 XSS）。如要支持 HTML，需要走 sanitize
- **image 的 url**：可以是 `https://...` 或 `data:image/...;base64,...`。LLM 当前主要产 data URI（base64 编码的小图）。SVG data URI 仍可触发 XSS（SVG 内含 script），建议未来用 `<img>` 的 origin 隔离或 sanitize SVG

---

## 与其它 spec 的关系

- Spec 01：Artifact 实体的字段定义
- Spec 02：`artifact.create` / `artifact.update` 事件，artifact_ref part 注入路径
- Spec 03：MessagePart 的 `artifact_ref` 类型
- Spec 07：`write_artifact` 工具规格
- Spec 08：artifacts 表 + 索引 + cascade 关系
- Spec 09：ArtifactPreviewPanel 与 ArtifactRefPart 渲染
