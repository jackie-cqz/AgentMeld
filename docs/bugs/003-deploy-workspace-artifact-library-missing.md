# Bug #003：deploy_workspace 部署结果未进入产物库

> 发现日期：2026-06-23
> 严重程度：高
> 影响范围：前端工程师、Workspace 部署、Artifact Library、实时 SSE

---

## 现象

前端工程师在本地 workspace 中完成项目构建并调用：

```text
deploy_workspace({ path: "dist", title: "Todo App" })
```

部署成功，聊天中能够得到预览路径或部署结果，但左侧「产物库」中找不到该 Web App。
刷新页面后仍然不存在。

## 根因

AgentMeld 中 Deployment 与 Artifact 是两套不同的数据：

| 数据 | 用途 | 数据来源 |
|------|------|----------|
| Deployment | 静态文件快照与预览 URL | `dataDir/deployments/` |
| Artifact | 产物库、版本、编辑和会话归属 | SQLite `artifacts` 表 |

修复前，`deploy_workspace` 只调用：

```typescript
deployWorkspace(workspacePath, targetPath, title);
```

该函数会：

1. 校验目标目录；
2. 复制构建产物到 deployment 目录；
3. 返回 `DeployStatusRecord`。

但它不会创建 `Artifact` 数据库记录。返回值中的 `artifactId` 只是：

```text
workspace:dist
```

这是一个虚拟来源标识，并非 `artifacts.id`。

产物库只读取前端 Store 中的 `artifacts`，Store 又来源于：

- bootstrap 的 SQLite Artifact 列表；
- 实时 `artifact.create` SSE。

因此 Deployment 成功与产物库完全断开，刷新也无法恢复。

## 修复

### 1. Workspace 部署成功后创建正式 Web App Artifact

`deploy_workspace` 现在会在复制静态目录成功后调用 `createNewArtifact()`：

```typescript
const artifact = createNewArtifact({
  conversationId: ctx.conversationId,
  createdByAgentId: ctx.agentId,
  type: "web_app",
  title: result.title,
  content: {
    type: "web_app",
    files: {
      "index.html": deploymentRedirectHtml
    },
    entry: "index.html"
  }
});
```

Artifact 记录包含：

- 当前 conversation；
- 执行部署的 Agent；
- `web_app` 类型；
- 正式 `art_*` ID；
- `version = 1`。

### 2. Artifact 使用部署快照作为真实内容来源

workspace 构建结果可能包含图片、字体、压缩 JS 等二进制文件，不适合全部序列化进
SQLite 的 `ArtifactContent.files`。

因此 Artifact 的入口 HTML 会跳转到已经复制完成的 deployment 快照：

```text
/deployments/dep_ws_...
```

这样既满足现有 `web_app` Artifact 契约，又保留完整构建结果和二进制资源。

### 3. 部署结果返回真实 artifactId

工具返回值中的 `artifactId` 和 `version` 现在来自新建 Artifact：

```json
{
  "artifactId": "art_...",
  "version": 1,
  "sourceType": "workspace",
  "previewPath": "/deployments/dep_ws_..."
}
```

### 4. 放宽 Artifact 实时事件识别

Custom Agent Adapter 原先只对 `write_artifact` 的结果发布 `artifact.create`：

```typescript
tc.name === "write_artifact"
```

现在只要工具成功返回真实 `artifactId`，就从数据库读取完整 Artifact 并发布
`artifact.create`。

因此 `deploy_workspace` 创建的产物无需刷新即可进入前端 Store 和产物库。

## 数据流

修复后的完整链路：

```text
deploy_workspace
  -> 复制 workspace 构建目录
  -> 创建 deployment 快照
  -> 创建 SQLite web_app Artifact
  -> 工具返回真实 artifactId
  -> Adapter 发布 artifact.create
  -> Store 写入 artifacts + artifactIdsByConversation
  -> Artifact Library 实时显示
```

## 验证

回归测试覆盖：

1. workspace 中存在可部署的 `dist/index.html`；
2. `deploy_workspace` 返回 ready；
3. 返回正式 `art_*` ID；
4. SQLite 中存在对应 `web_app` Artifact；
5. Artifact conversationId 与当前会话一致；
6. createdByAgentId 与执行 Agent 一致；
7. Artifact 入口包含 deployment previewPath；
8. Adapter 能对非 `write_artifact` 工具结果发布 `artifact.create`。

相关检查：

- 52 个部署、工具、Adapter 和流消费测试通过
- TypeScript、ESLint、生产构建通过

## 兼容性说明

- 修复只影响此后执行的 `deploy_workspace`。
- 修复前已生成的 `dep_ws_*` deployment 没有 conversationId 和真实 Artifact 关联，
  无法可靠自动补录。
- 旧部署需要重新调用一次 `deploy_workspace` 才会进入产物库。
- `deploy_artifact` 原有流程不受影响。

## 教训

1. Deployment 和 Artifact 生命周期不同，创建预览文件不等于创建产物。
2. UI 数据来源必须明确：产物库只认 Artifact，不应依赖聊天中的部署卡片反推。
3. 工具创建实体后，必须同时完成持久化和实时事件两条链路。
4. 虚拟来源 ID 不应被当成正式实体 ID 使用。
5. 构建输出包含二进制资源时，不要为了满足数据库模型而强行文本化所有文件。

## 相关文件

- `src/server/tools/deploy-workspace.ts`
- `src/server/deployment-service.ts`
- `src/server/adapters/custom-agent-adapter.ts`
- `src/server/tools/tools.test.ts`
- `src/server/consume-stream.ts`
- `src/components/artifact-library.tsx`
- `src/stores/reducers/artifact-events.ts`

