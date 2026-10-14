# AgentMeld 飞书渠道接入 — 设计评审与实现方案

> 对应 Issue：feat: 接入飞书多 Agent 机器人与群聊协作
> 状态：**方案评审稿，尚未实现任何代码。** 本文所有「已验证」结论都附代码位置或官方文档依据；「待验证」项明确标注，需由 F0 PoC 回答。
> 日期：2026-10-15

## 1. 结论摘要

Issue 的方向成立，且有两条比它预期更好的消息和一条比它预期更麻烦的消息。

**两条好消息**

1. **「每个 Agent 一个 Bot 身份」不需要手工建应用。** 飞书官方「一键创建智能体应用」提供 OAuth 2.0 设备码流程（RFC 8628）：服务端拿到验证链接/二维码 → 用户扫码确认 → 直接返回 `App ID` + `App Secret`。这正好就是「一键扫码把智能体绑定到飞书 Bot」。Node 侧入口是 `registerApp`（`@larksuite/channel` 重新导出，底层 `@larksuiteoapi/node-sdk` ≥ 1.61.1）。
2. **bot@bot 权限扫sw码即得。** 默认「智能体应用配置清单」里已经包含 `im:message.group_at_msg.include_bot:readonly`（*获取群组中其他机器人和用户 @ 当前机器人的消息*）。本文第 3 节曾把这一项列为头号风险，官方清单把它的风险等级下调为「F0 确认」而非「F0 决定成败」。

**一条坏消息**

3. **独立网关进程不是免费的，而且它的前置条件是一个安全问题。** 全仓 `/api` 路由**没有任何入站鉴权**，且 `next dev` / `next start` 均未指定 host（默认监听所有网卡）。一旦引入网关，`POST /api/pending-bash/{id}/resolve` 就是任何人（含同一局域网）可调用的工具执行审批入口。Issue 的「群消息入口不改变现有工具权限」「未授权用户和 Bot 无法批准敏感工具」在今天**依赖一个不存在的信任边界**。因此：**入站鉴权必须先落地，或者选择进程内方案绕过它。**

**建议**：先做两个凭据无关的小 PR（审批操作者身份、消息来源标记），再跑 F0，最后才决定网关形态。理由见第 7 节。

## 2. 对 Issue 的勘误

| Issue 原文 | 实际情况 | 依据 |
| --- | --- | --- |
| 建议新增 `src/server/channels/feishu/` | 同意，该目录当前不存在 | `src/server/` 列表 |
| 参考「飞书官方 Channel SDK」指向 `larksuite/channel-sdk-node` | 仓库名如此，但**可安装的包名是 `@larksuite/channel`** | [README.zh.md](https://github.com/larksuite/channel-sdk-node/blob/main/README.zh.md) |
| F0 第三项验证 bot@bot 权限 | 应提为 **F0 第一项**：默认清单已含该权限，但平台对未开通场景**静默失败且无自查 API**，必须先确认事件真的到达 | SDK README「Bot-at-bot」 |
| 「本地优先场景验证官方 SDK 长连接」 | 不仅是可行，而且是**一键创建应用的默认订阅方式**（事件与卡片回调均默认 WebSocket 长连接），无需公网回调地址 | [一键创建应用 overview](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview) |
| 「持久化入站去重」列为自建能力 | 部分重复：SDK 的 `safety.dedup` 已提供去重，但它是**进程内 Cache（TTL）**，重启即失，且**按实例隔离**。跨重启、跨 App 的去重仍需自建 | SDK README `SafetyConfig` / `cache` |
| 「Bot 协作限制目标、轮数、超时及资源预算」 | 大部分已由 `policy.botLoopGuard` 提供（窗口内 bot @ 阈值命中即 `drop`/`reject`），但官方自称「启发式兜底，非协议级保证」 | SDK README |
| 「设置允许使用的群、用户及可信 Bot」 | `policy.groupAllowlist` + `requireMention` 即可圈定；官方建议**按群授权而非逐个发送方**（发送方 open_id 事先拿不到） | SDK README |
| 「审批校验操作者」 | **当前无处落账**：`resolved_by` 被写成状态字面量，没有任何调用点传身份 | `src/server/repositories.ts:392-395` |
| 「多端同时审批时只允许一次状态转换」 | **原语已存在**，无需新建：条件是 `WHERE status = 'pending'` 的 UPDATE，靠 `changes > 0` 判首个决定 | `src/server/repositories.ts:388-399` |
| 「当前 `sendMessage` 会创建 user 消息」 | 属实，且比描述的更危险：无 `@` 时会兜底分派给 Conductor，构成真实回环路径 | `src/server/conversation-service.ts:193`、`:232-246` |
| 「内存 EventBus 与审批 Promise 不能跨进程直接共享」 | 属实 | `src/server/event-bus.ts:69-74`、`src/server/pending-bash.ts:13-22,44-59` |

## 3. 已验证的代码事实

以下结论均通过读代码/执行验证，非推断。引用格式 `文件:行`。

**消息入口**

- `sendMessage` 对任何来源都硬编码 `role: "user"`（`src/server/conversation-service.ts:193`）。`SendMessageInput` 没有来源/渠道字段。
- `pickResponders`（`src/server/conversation-service.ts:232-246`）：`single` 模式取首个 agent；有 `@` 取被 @ 的；**否则兜底分派给 Conductor**。因此一条 bot 回显只要走进 `sendMessage`，即使没 @ 任何人也会启动一次新的 Conductor 运行。
- `messages` 表只有 `role` / `agentId` / `runId` / `mentionedAgentIds` / `parentMessageId`，**没有来源列**（`src/db/schema.ts:59-76`）。

**运行与审批**

- `startAgentRun` 是**同步**函数，把 `executeRun(...)` 脱离执行后立刻返回 `{ runId, promise }`（`src/server/agent-runner.ts:94-100`）；HTTP 路由返回 `202`。
  - 这直接决定 F2 的安全性：SDK 明确警告在 `message` handler 里 `await` 一次卡片审批会**死锁**（默认 `safety.chatQueue.cardActions: 'same'` 时点击排在该 chat 在途工作之后）。AgentMeld 的 run 天然是脱离的，所以**只要渠道 handler 永不 await run 或审批**，就不会踩中；进展只能通过订阅事件投影。这条应写成显式设计铁律。
- `resolveApproval` 是 `UPDATE ... WHERE id = ? AND status = 'pending'`，返回 `changes > 0`（`src/server/repositories.ts:388-399`）——即「首个决定生效」的原子原语已经正确实现。
- 但同一语句里 `resolved_by` 被写入 `approved ? "approved" : "rejected"`（`src/server/repositories.ts:392,395`），**不是操作者身份**。全仓 7 个调用点没有一个传身份。`resolved_by` 列存在（`src/db/schema.ts:195`、`src/db/bootstrap.ts:149`）但从未装过「谁」。

**事件与跨进程**

- `eventBus` 是 `globalThis` 上的进程内单例，回放缓冲 `MAX_REPLAY_EVENTS = 500` 且纯内存（`src/server/event-bus.ts:10,69-74`）。`/api/stream` 以 SSE 暴露，支持 `last-event-id` 回放（`src/app/api/stream/route.ts`）。
- 审批 resolver 是 `globalThis` 上 Map 里的进程内 Promise（`src/server/pending-bash.ts:13-22,44-59`）。DB 里持久化的只有审批**状态**，唤醒等待方的那一半不可跨进程。

**安全基线**

- `src/app/api/` 下**没有任何入站鉴权**：按 `unauthorized|401|signature|timingSafeEqual` 全量搜索零命中；`src/server/api-utils.ts` 只有响应封装；`src/server/security.ts` 是危险 shell 命令模式拦截，与请求鉴权无关。唯一像鉴权的匹配是 `settings` 路由里的**出站** LLM key。
- `package.json` 的 `dev`/`start` 均无 `-H`/`--hostname`。
- 结论：今天是「本地优先、信任本机」的合理基线，但它不是一个可承载网关的边界。

**存储侧**

- `agents` 表已有 `name` / `avatar` / `description`（`src/db/schema.ts:20-37`）——与 `registerApp` 的 `appPreset.{name,avatar,desc}` 字段一一对应，绑定流程可以直接复用，无需用户重新填写机器人身份。
- **但 `avatar` 是 emoji/短文本**（全仓取值样例：`"🧭"`、`"🎨"`、`"🔍"`、`"A"`、`""`），而 `appPreset.avatar` 要求 `png/jpg/jpeg/webp/gif` 的 **URL**。见第 6 节风险 R1。
- `app_settings` 是单例行；密钥掩码助手 `maskSettings`/`maskKey` 定义在**路由文件内部**（`src/app/api/settings/route.ts:36,46`），不是共享工具——新渠道路由需要自己实现或先把它们提出来。
- `package.json` 中**没有任何二维码依赖**。

**SDK 能力（官方文档）**

- 一键创建应用默认订阅方式为 **WebSocket 长连接**（事件 + `card.action.trigger` 回调），无需公网地址。
- 默认清单已含：`im:message.group_at_msg:readonly`、`im:message.group_at_msg.include_bot:readonly`、`im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`cardkit:card:write|read`、`im:chat.members:bot_access`、`application:bot.basic_info:read` 等；回调 `card.action.trigger`。
- `addons` 可**增量**追加权限/事件/回调，预填到用户确认页；**不能删减**基础权限；敏感配置（事件订阅方式、回调地址、`security.*`、加密 key）**不能**经 `addons` 传入，需走 `application-config` OpenAPI。
- `createOnly: true` 让落地页只允许新建应用，隐藏「选择已有应用」——**对逐 Agent 绑定是必要的**，否则用户可能误选并覆盖另一个 Agent 的应用配置。
- 传入已有 `appId` 则流程变为「为该应用增量开通权限」，可用于「补授权/重新授权」。
- 二维码链接**10 分钟有效、仅一位用户可扫、一次只创建一个应用**。
- 返回值含 `client_id` / `client_secret` / `user_info.{open_id,tenant_brand}`；错误 `access_denied|expired_token|abort`；状态 `polling|slow_down|domain_switched`（自动区分飞书/Lark）。
- Channel SDK 层面额外提供：`senderType`/`senderIsBot`、`getBotIdentity()`、`getChatBots()`、`policy.requireMention`/`groupAllowlist`/`botLoopGuard`、`reply()`（跟随触发消息是否在话题内）、`stream()` 流式卡片、`updateCard()`。

## 4. 一键扫码绑定设计

这是本次要交付的核心体验：**在 AgentMeld 里点一下「绑定飞书」，扫一次码，该 Agent 就拥有自己的飞书机器人身份。**

### 4.1 流程

```text
网页（Agent 详情）               服务端                        飞书
   │  ① POST /bind/start {agentId}
   │──────────────────────────▶ 创建 binding session
   │                            调 registerApp(appPreset←agent,
   │                                          createOnly: true)
   │  ◀── ② { bindingId, qrUrl }  onQRCodeReady 立刻返回
   │  渲染二维码
   │  ③ 用户扫码 ─────────────────────────────────────────▶ 确认页
   │                                                        用户确认
   │                            ◀── client_secret / user_info
   │                            落库 channel_bindings
   │                            建连 createLarkChannel
   │  ◀── ④ SSE channel.binding.succeeded
   │  ④ 显示已绑定 + Bot 身份（getBotIdentity）
```

**关键实现约束：`registerApp` 会一直 await 到扫码或过期（最长 10 分钟），绝不能把它挂在单个 HTTP 请求上。** 因此 `POST /bind/start` 必须在拿到 `onQRCodeReady` 后**立即返回** `{ bindingId, qrUrl, expireIn }`，把 `registerApp` 的 promise 交给后台，结果通过既有事件通道推送。

**这一步可以完全复用已验证的现有基建**：进程内 `eventBus` + `/api/stream`（SSE）。新增事件类型即可，客户端零新机制。

### 4.2 状态与存储

绑定会话（内存，短生命周期）：

```text
channel_bindings（待确认）  Map<bindingId, {
  agentId, status: 'awaiting_scan' | 'succeeded' | 'failed',
  qrUrl, expireIn, abort: AbortController, error?: string
}>
```

内存态可接受：二维码 10 分钟过期，进程重启后会话本就失效（用 `AbortController` 取消在途轮询，避免悬挂）。**这与 `pending-bash` 的既有模式一致。**

持久化（新增表，建议 `channel_bindings`）：

| 列 | 说明 |
| --- | --- |
| `id` | 绑定 id |
| `agentId` | → `agents.id`，唯一（一个 Agent 一个飞书 Bot 身份） |
| `channel` | `'feishu'`（为后续渠道留位） |
| `appId` | `cli_…` |
| `appSecret` | **仅服务端**，永不经 API 返回 |
| `tenantBrand` | `feishu` \| `lark` |
| `botOpenId` | `getBotIdentity().openId`，用于识别自身回显 |
| `boundByOpenId` | 扫码人 open_id（`user_info.open_id`） |
| `chatId` / `conversationId` | 群/会话绑定（F1，可空） |
| `createdAt` / `updatedAt` | |

落库需**同时**改 Drizzle schema（`src/db/schema.ts`）与手写建表（`src/db/bootstrap.ts:149` 一带的 `CREATE TABLE`）——本仓两条路径并存。

密钥存储说明：本仓已有「把 provider 密钥存 DB」的先例（`agents.apiKey`、`app_settings.*_api_key`），因此把 `appSecret` 存 DB 与既有实践一致；但应遵守既有**掩码约定**，任何 GET 接口只返回 `cli_xxx` 与「已/未绑定」，绝不回传 secret。

### 4.3 身份继承

`agents` 已有 `name`/`avatar`/`description`，可直接映射：

```ts
appPreset: {
  name: agent.name,          // 支持 {user} 占位符
  desc: agent.description,
  avatar: /* 见风险 R1 */
}
```

`createOnly: true` 必开。绑定完成后用 `getBotIdentity()` 回写 `botOpenId`，并把飞书 Bot 名称/头像回显到 Agent 详情页，形成闭环。

### 4.4 解绑与重授权

- **重授权**：已有绑定则传 `appId` 走增量流程，用于补权限（例如将来需要新的 scopes），而不是重建应用。
- **解绑**：删除本地绑定、`disconnect()` 连接、`botOpenId` 清空。**注意：本地解绑不会删除飞书侧应用**——是否存在删除应用的 OpenAPI 属待验证项（R4），文档与 UI 不应暗示「解绑即删除」。

## 5. 入站路由设计

### 5.1 身份与去重

本仓的既有语义（`conversation-service.ts`）假定「一条人类消息 → 一次分派」。飞书侧要补三件事：

1. **来源**：消息必须带 `origin`（`human` | `bot` | `internal`）。`sendMessage` 当前硬编码 `role:"user"`，无法区分 bot 回显与人类输入，而 `pickResponders` 会在无 `@` 时兜底触发 Conductor——这是**可复现的回环**，不是理论风险。
2. **去重**：SDK 的 `safety.dedup` 是进程内、按实例隔离的。**跨 App 去重必须自建**：同一个人类消息被多个 Bot（各为独立 App）同时收到时，`messageId` 是**同一条消息的同一个 id**，因此持久化去重键应为 `(chatId, externalMessageId)`——**不含 appId**。这样多个 Bot 收到也只创建一条内部消息，正对 Issue 的「多 Bot 接收同一人类消息时，只创建一条」。
3. **回显识别**：出站发送后保存飞书 `messageId`（`SendResult.messageId`，流式卡片另有 `chunkIds`）；入站事件若命中已记录的出站 id，则判为自身回显，不进入路由。

### 5.2 永不 await（设计铁律）

渠道 handler 的职责边界：**归一化 → 去重 → 落库 → 触发 → 返回**。触发即 `sendMessage`（同步返回 runIds），**绝不 await run、绝不 await 审批**。所有进展、审批请求、产物交付都通过订阅事件异步投影回飞书。

理由见第 3 节：SDK 的默认 per-chat 队列下，在 message handler 里等待一次卡片点击是死锁。这条铁律同时让「取消运行」「进度查询」等能力自然落到事件投影上。

### 5.3 事件 → 飞书消息

必须遵守 Issue 的「不逐 token 新发群消息」。`/api/stream` 的流式增量应聚合后用 `stream()` 流式卡片或 `updateCard()` 就地更新，而不是每条事件发一条群消息。默认不发布原始推理、凭据、完整工具日志。

## 6. 风险与未验证项

| 编号 | 风险 | 处置 |
| --- | --- | --- |
| **R1** | **`appPreset.avatar` 与本地优先冲突。** 它要求可访问的图片 URL（png/jpg/webp/gif），而本仓 `avatar` 是 emoji 短文本。要「身份一致」，需把 emoji 渲染成 PNG 并托管在一个**飞书服务端可访问**的地址——这与本地优先直接矛盾 | F0 验证：确认头像是由**用户客户端**还是**平台服务端**抓取。前者可用本机地址，后者必须公网。**降级方案**：不传 `avatar`，让用户在确认页自行选择；文档不得承诺「头像自动一致」 |
| **R2** | 权限是否需要租户管理员审批。扫码人若非管理员，部分 scopes 可能停在待审批态 | F0 用普通成员账号扫一次，观察 `getBotIdentity`/发消息是否成功 |
| **R3** | 未开通 `include_bot` 时 bot@bot **静默失败且无自查 API** | F0 第一项：两个 Bot 同群互 @，验证事件真的到达。这是整个「多 Bot 身份」前提 |
| **R4** | 解绑后飞书侧应用是否可程序化删除 | 查 `application` 系列 OpenAPI；不确定则在 UI 明示「需手动到开发者后台清理」 |
| **R5** | 逐 Agent 建应用是否有配额/频率限制 | F0 记录实际创建数量与报错 |
| **R6** | 每 Agent 一条 WS 长连接（官方：同一应用开两条连接会导致事件分流）。`next dev` 的 HMR 会重新求值模块，可能造成重复连接 | F0 验证重连与实例行为；连接宿主必须做单例保护。这是第 7 节架构选择的直接输入 |
| **R7** | `safety.dedup` 重启即失 | 自建持久化去重（5.1），不依赖 SDK 去重做正确性保证 |
| **R8** | `/api` 无入站鉴权 + 默认监听所有网卡 | **网关方案的硬前置**。见第 7 节 |
| **R9** | `resolved_by` 不装操作者，「审批校验操作者」无处落账 | 独立小 PR 先修（第 7 节 PR1） |

## 7. 架构选择与实施顺序

### 7.1 进程内 vs 独立网关

Issue 推荐独立网关进程。核实后，两条路的代价差得比看上去大：

| | 进程内（渠道跑在 Next 进程内） | 独立网关（Issue 方案） |
| --- | --- | --- |
| 事件 → 飞书 | 直接 `eventBus.subscribe` | 走 `/api/stream` SSE（已有），但回放缓冲仅 500 条且内存态 |
| 审批结算 | 直接 `resolvePendingBash` | **不可行**：唤醒等待方的 Promise 在另一进程。必须新增轮询/通知机制 |
| 入站鉴权（R8） | 不需要（不新增网络入口） | **必须先做**，否则审批接口对局域网裸奔 |
| 持久化 inbox/outbox | 不需要 | 需要，否则断线丢事件 |
| WS 长连接生命周期 | 与 Web 进程绑定，HMR 下需单例保护（R6） | 独立进程更稳 |
| 与 Issue 的一致性 | 偏离 | 一致 |

**结论：先做进程内形态。** 它把 R8（鉴权）、审批跨进程、inbox/outbox 三个最贵的问题一次性消掉，并且**不损害未来拆分**——只要渠道适配层本身不直接依赖 `eventBus`/审批模块，而是面向一个内部接口，将来换成网关只需替换实现。当前证据不足以证明独立网关是本地优先场景的必要代价。

### 7.2 建议顺序

**PR1（无凭据，现在可做）— 审批操作者身份**
修 `resolveApproval` 把状态写进 `resolved_by` 的问题（`src/server/repositories.ts:392,395`）：增加操作者参数并持久化，7 个调用点透传，schema + bootstrap + 类型 + API 暴露同步跟进。同时补测试。
价值：直接满足「审批校验操作者」「未授权用户和 Bot 无法批准敏感工具」两条验收标准的前置条件；**与飞书无关**，独立可评审。
注：「首个决定生效」已由现有条件 UPDATE 保证（`src/server/repositories.ts:388-399`），不要重复实现。

**PR2（无凭据，现在可做）— 消息来源标记**
为消息引入 `origin`（`human`/`bot`/`internal`），解除 `sendMessage` 的 `role:"user"` 硬编码（`src/server/conversation-service.ts:193`），并让 `pickResponders`（`:232-246`）拒绝把 bot/internal 来源当作新的人类要求。
价值：堵住第 5.1 节那条可复现的回环；是「内部消息回显不重复执行」的实现基础。

**F0（需凭据）— 接入验证**
按 R1–R6 逐项取判定，产出「实际权限、发布配置、平台限制」记录。**R3（bot@bot 事件是否真的到达）第一项做**，它的结果决定后续是「多 Bot 各自身份」还是「单 Conductor Bot + 网页投影」。

**F1+**：按 Issue 原计划，但把第 5 节的来源/去重/回显三件事作为前置，而不是事后补。

### 7.3 明确不在本方案内

- 入站鉴权、持久化 inbox/outbox、网关拆分：等 F0 与进程内形态验证后再定。
- 部署预览的公网可达地址（Issue F3）：与 R1 同源，都属「本地优先 vs 平台可访问」这一未解矛盾，需单独讨论。
- 现有 `db:seed` 启动恢复副作用（见 README 警告）：与本功能无关，不在此处理。

## 8. 待办清单（F0 问题表）

按「答不出来就不能继续」排序：

1. 两个 Bot 同群，A @ B，B 是否收到事件？（`include_bot` 静默失败风险 R3）
2. 扫码人非管理员时权限是否即时生效？（R2）
3. `appPreset.avatar` 的图片由谁抓取——用户客户端还是平台服务端？（R1）
4. 卡片按钮回调、表单提交、卡片就地更新、流式回复是否均可用（长连接模式下无需公网地址）？
5. 断线重连后事件是否补投？重复事件如何表现？
6. 单应用开两条 WS 连接时事件是否分流？（R6）
7. 逐 Agent 创建应用的数量与频率上限？（R5）
8. 是否存在删除应用的 OpenAPI？（R4）

## 9. 参考

- [一键创建飞书智能体应用（overview + 配置清单）](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview)
- [一键创建应用（NodeJS）](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/scan-to-create-an-app-in-one-click-nodejs)
- [飞书官方 Channel SDK](https://github.com/larksuite/channel-sdk-node/blob/main/README.zh.md)
- [官方 Bot-at-bot 说明](https://github.com/larksuite/channel-sdk-node#bot-at-bot)
- [飞书官方 Node SDK](https://github.com/larksuite/node-sdk)
- [接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
- [发送消息接口](https://open.feishu.cn/document/server-docs/im-v1/message/create)
