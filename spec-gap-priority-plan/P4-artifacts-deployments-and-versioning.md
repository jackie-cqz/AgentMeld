# P4 - Artifact、部署、版本与导出

## 对应 specs

- `specs/03-message-parts.md`
- `specs/04-artifacts.md`
- `specs/07-tools.md`
- `specs/09-frontend-architecture.md`

## 当前问题

当前已实现：

- artifact 表和 repository。
- `write_artifact` / `read_artifact`。
- `ArtifactPanel` 可显示最新 artifact。
- web_app iframe preview route。
- document/image/source view 的基础渲染。

缺口：

- ArtifactPanel 只显示当前 conversation 的第一个 artifact，没有 activeArtifactId。
- `artifact_ref` 不可点击打开指定 artifact。
- VersionHistory 是占位文案。
- `GET /api/artifacts/:id/versions`、`POST /api/artifacts/:id/versions` 缺失。
- web_app preview 只返回 entry HTML，多文件 css/js 资源没有完整服务策略。
- `deploy_artifact` / `deploy_workspace` / deployment-service 缺失。
- `/deployments/:id`、download source/container API 缺失。
- `deploy_candidates` 只是类型和渲染占位，没有确定性部署命令服务。
- ppt preview/export、code_file view/edit、legacy diff view 不完整。
- ArtifactLibrary 全局产物库不存在。

## 需要做的内容

1. Artifact active state。
   - store 增加 `activeArtifactId`。
   - `artifact_ref` 点击设置 active artifact。
   - ArtifactPanel 显示 active artifact，否则显示最新 artifact。
   - 支持 artifact 404 tombstone。

2. Artifact library。
   - Sidebar 产物 tab 可列出全部 artifacts。
   - 展示 title、type、version、conversation title、createdAt。
   - 点击进入会话并打开预览。
   - 支持删除。

3. 版本链。
   - `GET /api/artifacts/:id/versions`。
   - `POST /api/artifacts/:id/versions`。
   - service 层按 root 收集整条链，按 version 排序。
   - web_app/document/ppt 可编辑并提交新版本。
   - version compare 对 document/web_app/ppt 做确定性 diff。

4. web_app preview 完整化。
   - 统一 `buildWebAppHtml` helper。
   - 自动注入 `style.css` 和 `script.js`。
   - 资源路径限制在 artifact files 中。
   - iframe 保持 `sandbox="allow-scripts"`，不加 `allow-same-origin`。
   - preview route 设置 CSP、nosniff、no-store。

5. 部署工具。
   - 新增 `deployment-service.ts`。
   - 新增 `deploy_artifact`。
   - 新增 `deploy_workspace`。
   - 本地部署目录：`.agentmeld-data/deployments/dep_xxx/`。
   - 私有 source 存 `.agentmeld/source`。
   - 支持外部静态目录发布配置。
   - 返回 DeployStatusRecord。

6. 部署 API 和 UI。
   - `/deployments/:id/[[...path]]`。
   - `/api/deployments/:id/download/source`。
   - `/api/deployments/:id/download/container`。
   - `/api/conversations/:id/deploy`。
   - MessageParts 中 deploy_status 支持打开/复制/下载。
   - 多候选时 deploy_candidates 可选择部署。

7. PPT/code_file/diff。
   - ppt 分页预览。
   - ppt editable export API。
   - code_file 从 workspace 读取，保存后生成新版本。
   - legacy diff 只读预览。

## 验收标准

- 用户点击任意 artifact_ref，右侧显示对应产物。
- 同一 artifact 可创建 v2/v3，并在版本列表切换。
- web_app preview 能加载 CSS/JS。
- `deploy_artifact` 返回可打开的本地 preview URL。
- `/deploy art_xxx` 可确定性部署指定 web_app。
- 多个 web_app 时显示 deploy_candidates。
- iframe 不带 allow-same-origin。
- 删除 artifact 后消息中的引用显示墓碑。

## 不在本优先级范围

- 不实现服务型后端部署。
- 不实现 visual-priority ppt export。
- 不做 artifact 语义搜索。

