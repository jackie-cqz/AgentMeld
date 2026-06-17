# P10 - 本地打包、发布与后续扩展

## 目标

当 P0-P8 稳定后，把项目整理成可长期本地使用、可发布、可迁移的数据和应用形态。

## 参考文件

- `specs/11-platform.md`
- `specs/12-desktop-electron.md`
- `specs/14-mobile-remote.md`
- `openspec/specs/desktop-electron/spec.md`
- `openspec/specs/mobile-companion/spec.md`
- `openspec/specs/platform-security/spec.md`

## 具体任务

1. 本地数据目录策略。
   - SQLite、attachments、deployments、workspace 数据位置清晰。
   - 支持备份和迁移。
   - 不把 API Key 明文写进可导出的项目文件。

2. 桌面封装准备。
   - 明确 Electron 是否作为第一发布形态。
   - Next server 启动、端口、静态部署目录需要稳定。
   - 本地文件权限和 workspace 选择需要 UI。
   - 对齐 Spec 12：Next standalone in-process server、随机本地端口、BrowserWindow 加载 `127.0.0.1`。
   - 打包后数据目录使用 Electron `userData`，不再依赖 repo cwd。
   - `better-sqlite3` ABI 要区分 Node dev/test 与 Electron build/package。
   - `electron:prebuild` 需要复制 `.next/static`、`public`、server runtime 依赖并清理 broken symlinks。

3. Release checklist。
   - typecheck/test/build。
   - 初始化数据库。
   - 默认 Agent 可用。
   - 无 API Key 时也能进入 app 并看到配置引导。

4. 移动/远程 companion 延后。
   - 当前不作为 DeepSeek MVP 主线。
   - 后续按 Spec 14 做 Capacitor App，而不是手机浏览器/PWA。
   - 桌面端提供 companion mode：off/lan/tailnet。
   - 移动端通过 Bearer device token 访问 `/api/mobile/*`。
   - 移动端第一版支持 snapshot、events、发送消息、审批 fs_write、回答 ask_user、查看 Orchestrator 状态。

5. 文档整理。
   - README 更新为 DeepSeek 主线路线。
   - `AGENT_BACKEND.md` 标明哪些已实现、哪些是目标设计。
   - 增加本地运行、配置 API Key、创建 Agent、运行 Orchestrator 的步骤。

6. 平台安全验证。
   - Windows/PowerShell 与 POSIX shell 行为分开测试。
   - DirPicker 拒绝系统目录、敏感目录、Windows POSIX 风格路径。
   - workspace usage 扫描防 symlink/junction 循环。
   - 进程超时/abort 后能清理子进程树。

## 验收标准

- 新机器 clone 后可以按 README 跑起来。
- 数据目录和 workspace 目录可解释、可迁移。
- Release 前检查命令固定。
- 文档不会把 optional Claude/Codex 写成已完成能力。
- Electron/mobile/platform specs 被标记为发布阶段任务，不会遗漏。
