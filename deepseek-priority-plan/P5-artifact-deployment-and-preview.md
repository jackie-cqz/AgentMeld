# P5 - Artifact、部署与预览闭环

## 目标

让 Agent 生成的产物可以被可靠查看、版本化、部署预览，并能回到上下文中被后续 Agent 使用。

## 当前基础

已有 artifact API、artifact panel、artifact versions route、deploy tools、deployment service 和 `deploy.status` store 处理。

## 参考图要求

`agent-conference-preview.png` 中右侧是一个完整 Artifact 工作区，而不是轻量预览卡片。后续实现应以此为目标：

- 右侧面板固定在主界面第三栏。
- 顶部显示 artifact 图标、标题、类型、版本，例如 `web_app · v2 / 2`。
- 顶部右侧提供操作按钮：关系/历史、刷新或回滚、在新窗口打开、复制、下载、关闭。
- 次级 tab 至少包含 `预览` 和 `编辑`。
- `web_app` 预览使用大面积 iframe 画布，预览内容应居中、可滚动、不会被工具栏遮挡。
- 编辑态后续用于 web_app/source、document markdown、ppt JSON 等内容。

## 参考文件

- `src/server/artifact-service.ts`
- `src/server/deployment-service.ts`
- `src/server/tools/write-artifact.ts`
- `src/server/tools/read-artifact.ts`
- `src/server/tools/deploy-artifact.ts`
- `src/server/tools/deploy-workspace.ts`
- `src/app/api/artifacts/`
- `src/components/artifact-panel.tsx`
- `src/components/artifact-library.tsx`
- `specs/04-artifacts.md`
- `openspec/changes/enhance-artifact-deployment/`
- `openspec/changes/replace-diff-artifact-with-version-compare/`

## 具体任务

1. Artifact version 语义稳定化。
   - 更新 artifact 时创建新版本。
   - UI 能查看历史版本。
   - 支持版本比较，而不是只展示最新内容。
   - version compare 覆盖 document、web_app、ppt、code_file metadata。

2. Web app artifact 预览。
   - `web_app` content 中 files/entry 必须校验。
   - 预览 iframe 沙箱化。
   - 缺少 entry 或 HTML 错误时给出可读提示。
   - preview route 设置 CSP sandbox、nosniff、no-store。
   - iframe 在右侧面板内使用稳定尺寸，避免每次加载导致布局跳动。
   - 预览区域顶部 tab 与 iframe 内容之间有清晰分隔。

3. Deployment 状态闭环。
   - deploy tool 产出 `deploy.status` event。
   - AgentRunner 持久化或注入 `deploy_status` message part。
   - UI 可点击预览、下载 source、查看失败原因。
   - 本地静态部署提供 source ZIP 和 container ZIP 下载。
   - 外部静态发布读取 `app_settings.deployment_publish_*` 配置。
   - 聊天消息中的 deployment path 可点击后在右侧 Artifact/Deploy 面板打开。

4. Workspace deployment。
   - `deploy_workspace` 只允许 workspace 内目录。
   - 检查 `index.html`。
   - 忽略 `.git`、`node_modules`、隐藏敏感文件。

5. Artifact 回到上下文。
   - `artifact_ref` 进入 `buildHistoryFor`。
   - `read_artifact` 支持读取指定版本。
   - Orchestrator outputBindings 使用 artifact ID 传递。

6. 部署候选命令。
   - 用户发送 `部署` / `发布` / `上线` / `/deploy` 时走确定性部署，不启动 AgentRun。
   - 没有候选时提示当前没有可部署产物。
   - 一个 web_app 候选时直接部署。
   - 多个 web_app 候选时插入 `deploy_candidates` part，用户选择后部署。

7. PPT artifact。
   - `write_artifact` 支持 `ppt` content。
   - 预览按 slides/blocks 渲染。
   - 支持编辑 JSON 后提交新版本。
   - 支持导出 editable `.pptx`；visual mode 可先返回未实现提示。

8. code_file 与 legacy diff。
   - `code_file` 只保存 workspacePath/metadata，不把大文件塞 DB。
   - 历史 `diff` artifact 只读兼容，不作为新 agent 产物暴露。

9. Artifact 面板组件拆分。
   - `ArtifactPanelHeader`：标题、类型、版本、操作按钮。
   - `ArtifactPanelTabs`：预览/编辑/历史/对比入口。
   - `WebAppPreviewFrame`：iframe 沙箱预览。
   - `ArtifactSourceViewer`：源码文件选择和代码查看。
   - `ArtifactVersionTimeline`：版本列表和对比入口。
   - `DeployStatusActions`：打开、复制 URL、下载 source/container。

## 验收标准

- Agent 生成 web app artifact 后可以一键预览。
- 部署失败和成功都能作为 message part 展示。
- artifact 版本可追踪、可比较。
- 后续 Agent 能通过 artifact ID 读取前序产物。
- `deploy_candidates`、PPT 预览/导出、source/container download 有明确 UI 或降级提示。
- 右侧 Artifact 面板视觉和交互结构与 `agent-conference-preview.png` 保持一致。
