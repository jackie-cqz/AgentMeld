# P6 - 产物与预览

## 目标

把 Artifact 做成独立实体，而不是消息附件。Agent 创建产物后，消息中只出现 `artifact_ref`，用户点击后在独立 preview panel 中查看。

## 参考文件

- `openspec/specs/artifacts/spec.md`
- `openspec/specs/message-parts/spec.md`
- `openspec/specs/frontend/spec.md`
- `specs/04-artifacts.md`
- `specs/03-message-parts.md`
- `specs/02-stream-events.md`
- `skills/add-artifact-type.md`
- `skills/add-message-part.md`

## 范围

需要实现：

- `src/server/artifact-service.ts`
- `src/app/api/artifacts/route.ts`
- `src/app/api/artifacts/[id]/route.ts`
- `src/app/api/artifacts/[id]/preview/route.ts`
- `src/components/artifact-preview-panel.tsx`
- `ArtifactRefPart`
- `write_artifact` / `read_artifact` 工具的完整 MVP 版本

## UI 组件级实现计划

### UI 参考图对齐

参考图：`agent-conference-preview.png`。

P6 的 artifact UI 应对齐参考图右侧面板：

- Artifact preview 是常驻右侧 panel，而不是临时 modal。
- Panel 顶部显示 artifact 图标、标题、类型、版本，例如“TODO LIST APP v2（修复添加按钮） / web_app · v2 / 2”。
- 顶部右侧提供一组 icon 操作：关系/历史/打开/复制/下载/关闭等。MVP 可先实现 close、copy、open。
- 内容区顶部有 `预览` 和 `编辑` tab，MVP 先让 `预览` 可用，`编辑` 可做只读/占位。
- web_app 预览区域要能展示真实应用状态：表单、筛选器、空状态、按钮等，而不是静态缩略图。
- 右侧预览背景可使用浅色画布，iframe 内部保持 artifact 自身样式。

### 页面区域

P6 在 P3 工作台右侧补齐 artifact preview panel，并让 chat 中的 `artifact_ref` 成为进入产物预览的主要入口。

```text
AppShell
  Sidebar
    ArtifactsTab
      ArtifactLibrary
  ChatPanel
    MessagePartList
      ArtifactRefPart
  ArtifactPreviewPanel
    ArtifactPanelHeader
    ArtifactPreviewTabs
    ArtifactVersionBar
    ArtifactView
      DocumentArtifactView
      WebAppArtifactView
      ImageArtifactView
      CodeFileArtifactView
      UnsupportedArtifactView
```

### `ArtifactRefPart`

职责：

- 在消息流中渲染产物引用卡片。
- 点击后设置 `activeArtifactId` 并打开 preview panel。

展示内容：

| 字段 | 来源 |
|---|---|
| 标题 | artifact title 或 part title |
| 类型 | artifact type |
| 版本 | artifact version |
| 创建者 | createdByAgentId -> agent name |
| 状态 | 可用/已删除/加载中 |

交互：

- 点击打开 preview。
- 对 web_app artifact 显示“预览”快捷按钮。
- 对 missing artifact 显示 tombstone，不报错。

参考：

- `specs/03-message-parts.md`
- `specs/04-artifacts.md`

### `ArtifactPreviewPanel`

职责：

- 独立于 chat 展示 artifact 内容。
- 支持关闭、切换版本、删除、后续编辑。
- 根据 artifact type 分发到具体 view。

状态来源：

- `appStore.activeArtifactId`
- `appStore.artifacts`
- `appStore.artifactVersions`

布局：

- 右侧固定宽度 panel，桌面端约 `420px-560px`。
- 窄屏后续可变为 drawer。
- Header 固定，内容区域滚动。
- 与参考图一致，panel 左侧和 chat 中间用清晰竖向分隔线。
- preview canvas 占据面板主体，避免再套多层卡片。

验收：

- 无 active artifact 时显示空态。
- artifact 加载失败显示错误态和重试按钮。

### `ArtifactPanelHeader`

职责：

- 显示 artifact 标题、类型、版本、创建时间。
- 提供 open/copy/delete/close 操作。

按钮：

| 操作 | MVP 行为 |
|---|---|
| Close | 清空 `activeArtifactId` |
| Copy | 对 document 复制 markdown，对 web_app 复制 preview URL |
| Open | web_app 打开 preview route |
| Delete | 调 DELETE API，成功后关闭 |
| Download | P10 前可占位，document 下载 md，web_app 下载包后续实现 |

验收：

- 删除前有确认。
- web_app 的 open 按钮只在 preview 可用时出现。

### `ArtifactLibrary`

职责：

- Sidebar 的 artifacts tab 中列出所有 artifact。
- 支持按 conversation、type 简单过滤，MVP 可先只做列表。

列表项信息：

- title
- type icon
- conversation title
- updated/created time

API：

- `GET /api/artifacts`

验收：

- 点击 artifact library item 打开对应 preview。
- 删除 artifact 后列表同步移除。

### `ArtifactView`

职责：

- 按 `ArtifactContent.type` 分发具体 view。

映射：

| type | 组件 | MVP 行为 |
|---|---|---|
| `document` | `DocumentArtifactView` | markdown 渲染，不启用 raw HTML |
| `web_app` | `WebAppArtifactView` | sandbox iframe + source tabs |
| `image` | `ImageArtifactView` | `<img>` 预览，显示 alt |
| `code_file` | `CodeFileArtifactView` | 通过 API 读取 workspace file |
| `ppt` | `PptArtifactJsonView` | 只读 JSON/slide list，占位 |
| `diff` | `LegacyDiffArtifactView` | 只读兼容或 unsupported |

### `ArtifactPreviewTabs`

职责：

- 在 panel header 下方提供 `预览` / `编辑` 两个 tab。
- `预览` 展示 artifact 渲染结果。
- `编辑` 在 MVP 可先展示只读 JSON/source，后续接 append-only version edit。

验收：

- web_app 默认进入预览 tab。
- 切换 tab 不丢失当前 artifact。

参考：

- `specs/04-artifacts.md`
- `skills/add-artifact-type.md`

### `WebAppArtifactView`

职责：

- 预览 Agent 生成的 HTML/CSS/JS。
- 展示源码。

子组件：

| 组件 | 职责 |
|---|---|
| `WebAppPreviewFrame` | iframe sandbox 预览 |
| `WebAppSourceTabs` | 文件选择 |
| `WebAppSourceViewer` | 代码显示 |

安全要求：

- iframe 必须 `sandbox="allow-scripts"`。
- 不允许 `allow-same-origin`。
- preview route 必须有 CSP sandbox。

验收：

- web_app 能渲染。
- JS 不能访问宿主 origin。
- 源码 tab 能查看 entry/css/js。
- 预览内容在右侧 panel 中完整居中显示，避免被顶部工具栏遮挡。

### `ArtifactVersionBar`

职责：

- 展示 artifact 版本链。
- 支持切换版本。

API：

- `GET /api/artifacts/[id]/versions`

验收：

- 单版本时隐藏或弱化。
- 多版本按 `version` 升序显示。

## MVP Artifact 类型

| 类型 | MVP 行为 |
|---|---|
| `document` | markdown 文档预览，不启用 raw HTML |
| `web_app` | files + entry，iframe sandbox 预览 |
| `image` | URL/data URI 预览 |
| `code_file` | workspace path 引用，读取时走 workspace 安全路径 |
| `ppt` | 先保留类型和只读 JSON 预览，导出暂缓 |
| `diff` | legacy 只读兼容，Agent 不应新建 diff artifact |

## 任务拆分

1. 实现 artifact CRUD。
2. `write_artifact` 支持 document/web_app/image。
3. 工具返回 `artifactId` 后，AgentRunner 注入 `artifact_ref`。
4. 实现 artifact library。
5. 实现 preview panel。
6. 实现 web_app preview route。
7. 加 CSP/sandbox header。
8. 实现版本链的基础读取。

## 验收标准

- Agent 能创建 document artifact。
- Agent 能创建 web_app artifact。
- Message 中只保存 `artifact_ref`。
- 点击 artifact card 打开 preview panel。
- web app iframe 使用 `sandbox="allow-scripts"`，没有 `allow-same-origin`。
- 非 web artifact 请求 preview route 会失败。

## 风险

- LLM 生成 HTML/JS 不可信，sandbox 是硬约束。
- Artifact version edit 是 append-only，不要原地覆盖旧产物。
