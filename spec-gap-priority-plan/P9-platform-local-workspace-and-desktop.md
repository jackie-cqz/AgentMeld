# P9 - Platform、Local Workspace 与 Electron 桌面版

## 对应 specs

- `specs/01-core-entities.md`
- `specs/07-tools.md`
- `specs/11-platform.md`
- `specs/12-desktop-electron.md`

## 当前问题

当前已有：

- platform 判断。
- Windows/POSIX shell 基础。
- 黑名单基础。
- path containment 和 sandbox quota。
- workspace 表支持 `mode` 和 `boundPath`。

缺口：

- UI/API 没有绑定 local workspace 的入口。
- boundPath 安全校验、DirPicker、隐藏目录过滤不完整。
- bash 的进程清理升级策略不完整。
- Windows HOME/env 兼容未完整接入 SDK 子进程。
- Electron 目录、main、server-bootstrap、prebuild、builder 配置不存在。
- 当前 package scripts 不是 specs 里描述的 Electron ABI preflight 流程。

## 需要做的内容

1. Local workspace。
   - Conversation 创建/设置时支持 sandbox/local。
   - local 模式绑定用户选择的目录。
   - boundPath 必须绝对路径。
   - 禁止系统根和敏感目录。
   - sandbox attachments 仍写 rootPath，不污染 boundPath。
   - local 模式不强制 100MB/1000 文件配额。

2. Platform safety。
   - `isPathSafe` 统一用于 boundPath、attachment、workspace。
   - Windows 路径大小写不敏感。
   - symlink/junction 防循环扫描。
   - workspace 删除失败重试。

3. Bash 加固。
   - 平台化 description。
   - Windows 用 PowerShell。
   - POSIX 用 login shell。
   - 超时后清理进程树。
   - POSIX 先 TERM，再 KILL。
   - Windows taskkill /F /T。
   - 后台进程输出继承导致卡死时清理。

4. Electron scaffold。
   - `electron/main.ts`。
   - `electron/server-bootstrap.ts`。
   - `electron/tsconfig.json`。
   - BrowserWindow 安全配置。
   - in-process Next standalone server。
   - userData data dir。
   - single instance lock。

5. Native ABI scripts。
   - ensure-node-sqlite。
   - ensure-electron-sqlite。
   - run-electron-node。
   - electron-prebuild。
   - electron-rebuild。
   - package scripts 更新。

6. Electron builder。
   - `output: standalone`。
   - `serverExternalPackages`。
   - asarUnpack standalone。
   - npmRebuild false。
   - mac/win targets。
   - 静态资源复制。
   - Codex runtime/SDK optional dependency 处理。

## 验收标准

- sandbox 会话 bash 可在 workspace 中执行基础命令。
- local workspace 绑定真实目录后，bash/fs 工具在 boundPath 下运行。
- 路径逃逸和敏感目录绑定被拒绝。
- Windows dangerous command 被拦截。
- bash 超时后没有孤儿进程。
- `pnpm electron:dev` 可打开桌面窗口。
- packaged app 使用 userData DB，重启后历史仍在。
- Electron renderer nodeIntegration=false、contextIsolation=true、sandbox=true。

## 不在本优先级范围

- 不做 auto-update。
- 不做代码签名/公证。
- 不做 Linux packaging。
- 不做 OS keychain。

