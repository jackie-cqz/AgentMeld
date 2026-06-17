# P4 - 工具审批、安全沙箱与本地执行体验

## 目标

让本地工具既有能力又可控。文件写入、Bash 命令、部署、附件读取等工具必须有清晰权限边界、审批体验和错误恢复。

## 当前基础

`fs_write` 已支持 review/auto 模式，`bash` 已支持危险命令审批，pending queues、API、Store、UI 都有雏形。

## 参考文件

- `src/server/tools/fs-write.ts`
- `src/server/tools/bash.ts`
- `src/server/tools/deploy-artifact.ts`
- `src/server/tools/deploy-workspace.ts`
- `src/server/pending-writes.ts`
- `src/server/pending-bash.ts`
- `src/components/pending-approval-panel.tsx`
- `src/server/security.ts`
- `src/server/workspace-utils.ts`
- `specs/07-tools.md`
- `openspec/specs/tools/spec.md`

## 具体任务

1. 审批 UI 细化。
   - 文件写入展示 old/new diff。
   - Bash 展示 cwd、命令、风险原因。
   - approve/reject 后即时从 pending panel 移除。

2. pending 状态恢复。
   - 页面刷新后从 API 拉取 pending write/bash/plan。
   - resolver 丢失时提示“服务重启后该审批已失效，请重新运行”。

3. Bash 安全策略完善。
   - Windows PowerShell 与 POSIX 分别维护 banned patterns。
   - 对安装依赖、删除、git reset、docker 等命令强制审批。
   - 输出截断时提示 truncated。

4. 文件工具补齐。
   - `fs_read` 支持行范围和 max chars。
   - `fs_list` 支持 ignore hidden/node_modules。
   - `fs_write` 记录写入路径，供 Orchestrator 冲突检测使用。

5. 工具结果格式标准化。
   - 每个工具返回 `{ ok, value/error }`。
   - value 中必须包含可供 UI 和模型理解的摘要字段。
   - 大输出写入 artifact 或截断，不直接塞满对话。

6. pending question 闭环。
   - `ask_user` 注册 `ask_user.pending`。
   - UI 展示结构化问题、选项、说明与 freeform note。
   - 答案提交后唤醒工具调用并继续 run。
   - 移动端后续复用同一 pending question API。

7. `read_attachment` 能力补齐。
   - 文本类文件截断到 50,000 字符。
   - PDF 可作为后续增强抽取文本；扫描版返回 note。
   - 图片附件返回 metadata，说明图片通过 multimodal channel 处理。
   - docx/zip 等二进制只返回 metadata，不塞原始字节。

8. 工具提示注入。
   - AgentRunner 根据当前 agent 可用工具生成工具使用规范。
   - `write_artifact` 明确禁止空参数调用。
   - local workspace 模式下提示优先落盘源码，不用 artifact 假装写入本地项目。

## 验收标准

- 审批型工具在 UI 中可见、可处理、可恢复。
- 危险 Bash 命令不会绕过审批。
- 文件写入不会越出 workspace。
- Orchestrator 可读取每个 child run 的文件写入记录。
- 工具失败不会让整个 run 静默中断。
- `ask_user`、`fs_write`、`bash` 三类 pending 都有前后端闭环。
