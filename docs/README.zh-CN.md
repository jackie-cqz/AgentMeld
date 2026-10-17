# AgentMeld

<p align="center">
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-111111?logo=nextdotjs&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-087ea4?logo=react&logoColor=white">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white">
  <img alt="Pi 0.84.2" src="https://img.shields.io/badge/Pi-0.84.2-536b45">
  <img alt="SQLite local-first" src="https://img.shields.io/badge/SQLite-local--first-0b6b88?logo=sqlite&logoColor=white">
  <a href="https://github.com/jackie-cqz/AgentMeld/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jackie-cqz/AgentMeld/actions/workflows/ci.yml/badge.svg"></a>
  <a href="../LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-22a06b"></a>
</p>

<p align="center">
  <a href="../README.md">English</a> · <strong>简体中文</strong>
</p>

**基于 Pi 的本地优先 AI 编程团队群聊工作台。**

把不同角色的 Agent 放进同一个会话：先讨论方案，再执行任务；需要时向其他 Agent 咨询，遇到阻塞时把未完成的任务交接给队友，不必手工复制整段聊天记录。文件、工具调用、审批、产物和执行证据都保留在会话旁边。

当前 **Pi 是唯一的生产执行内核**。Pi 负责模型请求和 Agent Loop；AgentMeld 负责团队身份、消息路由、任务协作、上下文和工作空间。跨 Harness 执行属于后续方向，不是已经上线的能力。

![AgentMeld 对话与产物工作台](images/main-workspace/desktop-light.png)

[快速开始](#快速开始) · [群聊如何协作](#群聊如何协作) · [工具与安全](#工具与安全) · [已知限制](#已知限制) · [English](../README.md)

## 可以用它做什么

| 场景 | AgentMeld 的使用方式 |
| --- | --- |
| 改代码前先比较方案 | 在群里讨论、指定 Agent 或回复某个 Agent，不必先创建交付计划。 |
| 做一个明确的小改动 | 交给对应 Agent，不必强制经过 PM、设计、开发、审查整条流水线。 |
| 完成多阶段功能开发 | 由 Conductor 提出带依赖的计划，用户审查后跟踪各角色的任务与输出。 |
| 执行中途改变需求 | 发送补充或纠正，平台记录投递状态，必要时替换当前执行。 |
| Agent 需要第二意见 | 向当前会话的队友发起有边界、可追踪的咨询。 |
| 某个实现任务卡住 | 人工确认后，把任务约束、已有证据和相关上下文交给另一个 Pi Agent。 |
| 检查最终结果 | 浏览文件、比较产物版本、打开静态预览，检查 Context Trace 和工具证据。 |

内置角色包括 Conductor、PM、UI 设计师、前端工程师和 Reviewer。也可以创建自己的 Agent，设置身份、头像、模型、能力描述和系统提示词。

## 群聊如何协作

### 先沟通，按需规划

- 消息接收优先级为：显式指定的 Agent、回复对象对应的 Agent、会话默认 Conductor。支持指定多个接收者，但群消息不会自动唤醒所有 Agent。
- 普通讨论不强制要求 Conductor；没有 Conductor 的团队需要明确指定消息接收者。
- 复杂交付可使用 Conductor 的计划审查、DAG 依赖调度、失败重试、输出绑定和结果汇总；简单请求不必走固定角色链路。
- 用户消息有持久化的提交标识和投递状态。丢失响应后重试发送会按提交标识去重，避免再次触发执行；查询进度可以读取已有任务，而不是重新启动任务。
- 纠正与可执行的补充会保留原始目标。无法安全地实时追加输入时，平台停止旧调用、等待退出确认，再将最新要求编译到新的执行尝试中。

### Agent 咨询与任务交接

这两种操作解决不同的问题：

| | Agent 咨询 | 任务交接 |
| --- | --- | --- |
| 目的 | 向队友获取有边界的第二意见 | 转移未完成或失败的委派任务 |
| 责任归属 | 仍由发起者负责 | 用户确认后，接收者在同一任务 ID 下获得新的 run 和 attempt |
| 传递内容 | 用户请求、咨询问题和相关任务上下文 | 实际执行过的任务约束、失败与证据引用、当前事实、上游产物版本及文件指纹 |
| 完成判断 | 咨询回复只是意见，不算任务验收通过 | 接收者仍需汇报结果并通过验证 |

咨询有数量、时限和递归边界，不会无限扩展成 Agent 互相聊天。发起者同步等待队友时，会暂停自己的工具桥并临时借出工作区执行权，只有队友确认退出后才能继续。

交接包会在接受前再次检查。上下文过期、来源尝试已失效、旧进程退出不明确时，不会直接启动另一个写入者。接手失败计划中的一个任务，**不等于自动恢复该计划的全部下游任务**。

例如：

```text
你 -> @开发：先比较两种实现方案，暂时不要改代码。
开发 -> @审查：发起咨询，请队友给出第二意见。
你 -> @开发：采用方案 B，实现并运行测试。
你：保持现有 API 的响应结构。
AgentMeld：记录纠正；必要时等待旧调用退出，再重新组织上下文。
如果委派任务卡住：你确认把任务交给另一个 Agent。
接收者：获得新的任务上下文，检查现有文件并验证修改。
```

“暂时不要改代码”是给模型的行为要求，不会移除工具，也不是强制只读的安全模式。

## 工作台能力

### 证据驱动的上下文

Task Context Compiler 根据当前任务、依赖约束、已验证上游输出、会话当前事实、相关历史、工作区状态、验收要求和既往失败组织上下文，而不是把整个群聊重新塞给每个委派 Agent。

- 会话级事实支持校验与新旧替换。
- 每次任务尝试保留上下文快照和输出绑定。
- 工具结果进入 Evidence Ledger；模型说“成功了”不等于任务真正完成。
- Context Trace 展示纳入与省略的上下文、缺失输入、证据、验收结果及告警。

### 文件、工具与产物

- Pi 原生文件浏览、搜索、读取、写入、修改与 Bash 执行。
- 平台提供用户询问、团队成员查询、Agent 咨询、任务汇报、事实、产物和部署工具。
- 公网搜索与抓取、只读 Git 检查、隔离浏览器验收。
- 文档、Web 应用、图片和演示文稿产物，支持版本、源码查看与预览。
- 工作区静态构建可部署为本地预览，并关联真实部署记录。

### 工作台、模型与渠道

- 支持明暗主题，对话、工作区文件、产物、诊断和审批集中在同一工作台。
- 供应商预设与集中模型配置；每个 Agent 选择供应商和模型，并可覆盖连接设置。
- Agent 创建和编辑支持预设头像，系统提示词独立配置，运行时工具清单只读展示。
- SSE 事件覆盖文本、工具、审批、用量、任务进度、咨询、交接和产物。刷新后恢复持久化展示，不代表恢复旧执行进程。
- 所有者设备配对与可撤销的浏览器会话。
- 可选飞书渠道绑定，支持每个 Agent 对应独立 Bot 身份。渠道消息使用平台身份和审批记录，任意 Bot 的 @ 不会直接获得执行授权。配置与验证边界见[飞书运维说明](feishu-operations.md)。

## 快速开始

### 环境要求

- **Node.js >=22.19.0**、**pnpm 10**；仓库锁定 pnpm 10.33.4。
- 可用的模型供应商凭据，例如 DeepSeek、OpenAI-compatible 服务或 Anthropic。
- Windows 需要 **Git Bash** 执行原生命令，以及 Windows PowerShell/.NET 管理进程生命周期。
- Pi 随 lockfile 安装，无需全局安装。
- 可选：原生搜索使用 PATH 中的 `rg` 和 `fd`；`browser_check` 需要 Chromium。

### 安装与启动

Linux/macOS 或兼容 POSIX 的 Shell：

```bash
git clone https://github.com/jackie-cqz/AgentMeld.git
cd AgentMeld
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

Windows PowerShell：

```powershell
git clone https://github.com/jackie-cqz/AgentMeld.git
Set-Location AgentMeld
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
pnpm exec next dev -H 127.0.0.1
```

PowerShell 的启动命令避开了 `dev` 脚本中的 POSIX 环境变量语法。打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。

1. 在当前浏览器完成首次配对；初始化期间保持服务仅监听本机回环地址。
2. 打开**设置**，添加模型供应商，填写 API Key 并配置模型。
3. 创建或编辑 Agent，选择对应模型。Pi 安装检测不代表供应商认证成功。
4. 创建会话并加入需要的队友，显式指定接收者，或让 Conductor 协调任务。

**首次启动会自动创建 SQLite 数据库、数据表和内置 Agent，无需手工建库，也无需运行 `db:push`。**

需要浏览器验收且未配置可用浏览器时，先安装 Chromium：

```bash
pnpm exec playwright install chromium
```

## 配置与本地数据

可以在界面管理设置，也可以按照[环境变量示例](../.env.example)，在 `.env.local` 中仅配置需要的供应商：

```env
AGENTMELD_DATA_DIR=.agentmeld-data
DEEPSEEK_API_KEY=your_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

Agent 独立连接设置优先于全局设置，全局设置优先于环境变量。应用根据 `AGENTMELD_DATA_DIR` 确定数据库位置；`AGENTMELD_DB_PATH` 只供 Drizzle CLI 使用。

默认 `.agentmeld-data/` 存放 SQLite 数据库、会话工作区、产物、部署和 Pi 私有执行文件。该目录、`node_modules/` 和本地环境文件均被 Git 忽略。不要提交凭据、原生会话记录或包含私有内容的生成工作区。

**本地优先不等于离线。** 选入上下文的提示词、文件内容和工具结果会发送到配置的模型供应商，搜索请求会发送到搜索供应商。请使用可信服务，并避免让 Agent 能访问的文件包含秘密。

浏览器会话失效时，可在仍已配对的设备上生成配对码。全部所有者会话都失效时，在服务所在机器执行 `pnpm run auth:reset` 后重新配对。该命令撤销现有所有者会话，不删除对话数据。使用自定义数据目录时，需要在执行命令的 Shell 中明确设置 `AGENTMELD_DATA_DIR`；此恢复脚本不读取 `.env.local`。

## 工具与安全

**所有普通 Agent 使用相同的完整运行时工具集**，讨论和咨询也不例外。数据库中的旧工具选择不再授权或限制工具；Agent 编辑页仅展示只读工具清单。

文件操作由 Pi 原生 `read`、`write`、`edit`、`ls`、`grep`、`find` 执行，`fs_patch` 等平台名称映射到对应原生实现。Bash 是通用命令工具，允许源码修改，不再仅限验证命令。内部意图分类器和 Conductor 协议阶段仍使用各自的专用工具集合。

完整工具集**不代表跳过平台现有控制**：

- 文件 Review 模式可在原生写入、修改前要求审批；文件 Auto 不等于自动批准所有计划和命令。
- 危险删除等命令模式仍会拦截，部分命令仍需审批。
- 资源限制、执行证据、文件哈希、任务验收和工作区执行权控制仍然有效。
- 新的托管写入者需要等待旧执行退出确认；无法确认 Pi 清理结果时，会保留持久化工作区租约，不直接放行。

**这不是 OS 沙箱。** 原生文件工具不限于工作区，文件操作和 Shell/项目脚本使用服务进程所属用户的操作系统权限。审批与租约不能隔离任意代码、后台进程、依赖或秘密。只运行可信项目，或自行提供操作系统、容器级隔离。

Pi 扩展使用经过认证的私有本地桥接，**不是外部 MCP 服务**。详见 [Pi 执行架构](pi-runtime.md)与[工作区工具说明](workspace-toolkit.md)。

## 架构概览

```text
Next.js / React 工作台
  -> 认证 API 路由 + SSE
  -> 会话路由 / 用户输入准入
  -> Agent Runner / Conductor / 咨询 / 交接
  -> 项目锁定版本的 Pi RPC 子进程
       Pi：模型请求、Agent Loop、原生工具、单次调用历史
       AgentMeld 桥接：审批、平台工具、证据、生命周期
  -> SQLite + 任务上下文 / 事实 + 工作区 / 产物 / 静态预览
```

| 部分 | 实现 |
| --- | --- |
| 界面与状态 | Next.js 16、React 19、Tailwind CSS、Zustand、Immer |
| 执行内核 | Pi 0.84.2，每次调用使用私有配置和 RPC |
| 持久化 | SQLite、Drizzle ORM、`better-sqlite3` |
| Runtime 服务 | `src/server/`：协作、上下文、证据、工具、验证 |
| 共享契约 | `src/shared/`；API 路由位于 `src/app/api/` |
| 质量检查 | TypeScript、ESLint、Vitest、Playwright、Linux/Windows Pi 契约 CI |

原自研 Agent Loop 与生产 Adapter 注册表已退役。旧 Custom/Mock Agent 迁移到 Pi 时保留身份、历史和渠道绑定；其他已退役执行器需要显式迁移。

## 开发与验证

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm start
```

Windows PowerShell 的生产启动使用 `pnpm exec next start -H 127.0.0.1`，需先完成构建。

[CI](https://github.com/jackie-cqz/AgentMeld/actions/workflows/ci.yml) 在 Linux 运行类型检查、Lint、完整测试和生产构建，另外在 Linux 与 Windows 运行 Pi 契约测试。原生集成测试真实启动锁定版本的 Pi 子进程，但使用确定性的本地模型 fixture，无需公网 API Key；它验证执行链路，不代表所有外部供应商或真实模型的指令遵循质量。

高级评估命令包括 `e2e:fixture`、`e2e:report`、`agent:bench:all`、`agent:bench:smoke`、`agent:bench:full` 和 `quality:gates`。实际 benchmark 运行需要模型凭据，质量门禁需要已生成报告，不是全新仓库的开箱即用冒烟测试。

数据库维护**不是普通安装步骤**。不要对真实应用数据库执行 `db:push`：Drizzle 类型镜像可能提议删除 FTS 表。也不要在服务运行时对同一数据目录执行 `db:seed`：它会触发启动恢复，可能把正在运行的任务标记为中断，却不停止其进程。详见[数据库说明](schema.md)。

## 已知限制

- **当前仅支持 Pi。** DSH、OpenCode、Claude Code、Codex、任意全局 Pi 版本、用户自装 Pi 扩展和原生会话导入都不是已支持的执行后端。
- **单所有者，每个数据目录只运行一个控制服务。** 配对是该所有者的设备访问，不是组织级多租户或角色权限隔离。
- **每次调用使用新的 Pi 会话。** 平台上下文可跨调用传递，但原生会话和中断命令不会自动续跑；刷新恢复的是记录，不是进程。
- **托管工作区访问串行化。** 咨询采用受控租约借用，不代表同一目录允许多个独立写入者并行。
- **没有宿主机安全沙箱。** 完整工具集下的讨论不是强制只读，仍依赖用户要求与模型行为。
- **仅本地静态预览。** 部署不托管 SSR/API 后端，也不自动发布到云服务。
- **外部依赖有差异。** 工具调用质量受模型影响，搜索和浏览器需额外配置。飞书需要相应凭据和权限；最新协作改动通过确定性渠道测试，但尚未做真实飞书端到端验收。
- **仍处于早期开发。** Schema、Runtime 接口和评估工具可能变化，standalone 服务打包尚未验证。

## 后续方向

以下是后续计划，不是当前已实现功能：

- 进一步分离长期 Agent 身份与执行绑定，再按需接入 DSH、OpenCode 等 Harness。
- 将基于证据的交接扩展到跨 Harness，不承诺直接迁移原生会话。
- 改善飞书协作、初始化、投递反馈与真实设备验证。
- 接入远程 Worker、容器或沙箱供应商，而不是先自建完整云基础设施。
- 改善手机端监督、审批和接管，优先通过 Web/PWA 推进。
- 继续完善上下文筛选、证据摘要、失败恢复和 Trace 导航。
- 探索外部 MCP 工具接入，同时保留审批、来源、生命周期和事件语义。

## 更多文档

- [English](../README.md)
- [Pi 执行、配置、工具与恢复](pi-runtime.md)
- [工作区工具与浏览器验收](workspace-toolkit.md)
- [群聊协作实现说明与历史验收记录](group-chat-collaboration-implementation.md)
- [飞书运维说明](feishu-operations.md)与[真实设备检查](feishu-real-device-checks.md)
- [数据库结构与维护边界](schema.md)

## 开源许可证

[MIT License](../LICENSE)。
