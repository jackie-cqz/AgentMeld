# AgentMeld 产物系统

> Artifact 是 Agent 产出的结构化成果——独立于消息，有自己的版本链和预览。

## 产物类型

| 类型 | `content` 格式 | 用途 |
|------|---------------|------|
| `document` | `{ format: "markdown", content: "..." }` | PRD、设计文档、会议纪要 |
| `web_app` | `{ files: { "index.html": "...", ... }, entry: "index.html" }` | 网页应用、前端原型 |
| `image` | `{ url: "...", alt: "...", width?, height? }` | AI 生成的图片 |
| `ppt` | `{ title: "...", slides: [...], theme?: {...} }` | 演示文稿 |

## 生命周期

```
Agent 调用 write_artifact
  → ArtifactService.createArtifact()
  → INSERT INTO artifacts (id, type, title, content, version=1, ...)
  → 返回 artifactId
  → Agent 可将 artifactId 传给下游 Agent（通过 expectedOutputs/outputKey）

Agent 调用 read_artifact(artifactId)
  → getArtifact(artifactId)
  → 返回完整 content

用户手动编辑产物
  → PATCH /api/artifacts/:id
  → 新版本 (version+1, parentArtifactId=旧版本)
  → 版本链: v1 → v2 → v3
```

## write_artifact 参数

```typescript
{
  type: "document" | "web_app" | "image" | "ppt";
  title: string;                    // 简短标题
  content: ArtifactContent;         // 根据 type 变化
  outputKey?: string;               // 对应 plan 中的 expectedOutputs.id
}
```

### document

```json
{
  "type": "document",
  "title": "番茄钟 PRD",
  "content": {
    "format": "markdown",
    "content": "# 番茄钟 PRD\n\n## 1. 目标用户..."
  }
}
```

### web_app

```json
{
  "type": "web_app",
  "title": "番茄钟",
  "content": {
    "files": {
      "index.html": "<!doctype html>...",
      "style.css": "body { ... }",
      "script.js": "let timer = 1500; ..."
    },
    "entry": "index.html"
  }
}
```

Web app 产物通过 `deploy_artifact` 部署为本地预览 URL，前端 iframe 渲染。支持嵌套文件路径（`assets/app.js`），自动创建目录结构。

## 版本管理

```
v1 (art_001)  ← 原始版本
  ↓ parentArtifactId
v2 (art_002)  ← 用户编辑或 Agent 修改
  ↓ parentArtifactId
v3 (art_003)  ← 最新版本
```

- `GET /api/artifacts/:id/versions` 返回完整版本链
- `ArtifactVersionCompare` 组件支持两版本 diff 对比
- 版本不可变：修改永远创建新版本

## 部署

### deploy_artifact

```typescript
deploy_artifact({ artifactId: "art_001" })
```

将 web_app 产物部署为本地可访问的预览页面。返回 `previewPath`，前端 iframe 加载。

### deploy_workspace

```typescript
deploy_workspace({ path: ".", title: "项目预览" })
```

将 workspace 构建后的静态目录部署预览。适合 `npm run build` 后部署 `dist/`。

## 产物与消息

每个产物在创建时，对应的 Agent 消息中会注入 `artifact_ref` part：

```typescript
{ type: "artifact_ref", artifactId: "art_001", title: "番茄钟 PRD", artifactType: "document" }
```

前端渲染为可点击卡片，点击后在右侧 Artifact Workspace 打开。

## 产出绑定 (Conductor)

Conductor plan 中声明 `expectedOutputs`，子 Agent 通过 `outputKey` 绑定产物：

```
plan: task t1 expects output "prd_doc" (type: document)
  → t1 调用 write_artifact({ ..., outputKey: "prd_doc" })
  → t2 声明 inputs: [{ fromTaskId: "t1", outputId: "prd_doc" }]
  → t2 的 prompt 中注入 <upstream_artifacts><artifact id="art_001".../>
```

绑定通过 `outputBindings: Map<taskId.outputKey, artifactId>` 管理，持久化到 `orchestration_output_bindings` 表。

## 前端组件

| 组件 | 功能 |
|------|------|
| `ArtifactPanel` | 右侧工作区：预览/源码/编辑/版本历史/部署 |
| `ArtifactLibrary` | 侧栏产物库列表 |
| `ArtifactVersionCompare` | 双版本 diff 对比 |
| `artifact_ref` card (MessageParts) | 消息中的产物引用卡片 |

## 相关文件

| 文件 | 内容 |
|------|------|
| `src/server/tools/write-artifact.ts` | 创建产物 |
| `src/server/tools/read-artifact.ts` | 读取产物 |
| `src/server/tools/deploy-artifact.ts` | 部署产物 |
| `src/server/artifact-service.ts` | 产物 CRUD + 版本 + 预览 |
| `src/shared/types.ts` | Artifact / ArtifactContent / ArtifactType |
| `src/components/artifact-panel.tsx` | 产物工作区 |
| `specs/04-artifacts.md` | 产物规格 |
