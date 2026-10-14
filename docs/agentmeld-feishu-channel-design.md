# AgentMeld 飞书渠道接入 — 设计评审与实现方案

> 对应 Issue：feat: 接入飞书多 Agent 机器人与群聊协作
> 状态：**§4 扫码绑定（PR #21/#22）、连接层（PR #32）、入站路由（PR #33）已合入 master；出站投影在 PR #34。F0 第一项已实测完成，完整闭环已用真实应用与真实群跑通。** 本文所有「已验证」结论都附代码位置、SDK 源码或官方文档依据；「待验证」项明确标注。**§5.8 的六层防护逐条标注了实现状态——其中两层只实现了一部分、一层未实现、一个开关没有 UI 入口。**
> 本文经过独立对抗式复核（记录见第 10 节）、一次 F0 实测（第 8 节，含三处对正文的更正），以及三轮针对具体实现的复核（连接层、入站路由、出站投影）；实现落地后 §5.1 / §5.2 / §5.3 已按实际做法更正。
> 日期：2026-10-15

## 1. 结论摘要

Issue 的方向成立，且有两条比它预期更好的消息和一条它排序错了的风险。

**两条好消息**

1. **「每个 Agent 一个 Bot 身份」不需要手工建应用。** 飞书官方「一键创建智能体应用」提供 OAuth 2.0 设备码流程（RFC 8628）：服务端拿到验证链接/二维码 → 用户扫码确认 → 直接返回 `App ID` + `App Secret`。这正好就是「一键扫码把智能体绑定到飞书 Bot」。Node 侧入口是 `registerApp`（`@larksuite/channel` 重新导出）。
2. **bot@bot 权限扫码即得——且已实测确认事件真的到达。** 默认「智能体应用配置清单」里包含 `im:message.group_at_msg.include_bot:readonly`（*获取群组中其他机器人和用户 @ 当前机器人的消息*），扫码后在开发者后台可见；两个真实应用在同一群里互相 @ 时，接收方拿到的是 `senderType=bot` / `senderIsBot=true` / `mentionedBot=true` 的事件。**第 6 节 R3 因此结案**：「多 Bot 各自身份」的设计成立，不必塌缩成「单 Conductor Bot + 网页投影」。详见第 8 节。

**一条坏消息（但归因需要更正）**

3. **全仓 `/api` 路由没有任何入站鉴权**，且 `next dev` / `next start` 均未指定 host（默认 `0.0.0.0`，已实测监听 `*:3000`）。所以 `POST /api/pending-bash/{id}/resolve` 这一类工具执行审批入口，**今天**就已经对同网段可用。
   - **这不是引入网关才产生的问题**，网关只是让它多一个调用方。Issue 的「群消息入口不改变现有工具权限」「未授权用户和 Bot 无法批准敏感工具」在今天依赖一个不存在的信任边界。
   - 顺带发现：`app_settings` 有 `companion_mode`（`off|lan|tailnet`）与 `mobile_device_token` 两个字段，看起来正是为 LAN/移动端鉴权预留的槽位，但**从不参与任何请求校验**（见 R11）。
   - 因此：**入站鉴权必须先落地，或者选择进程内方案绕过它。**

**建议**：先做两个凭据无关的小 PR（审批操作者身份、消息来源标记），再跑 F0，最后才决定网关形态。理由见第 7 节。

## 2. 对 Issue 的勘误

| Issue 原文 | 实际情况 | 依据 |
| --- | --- | --- |
| 建议新增 `src/server/channels/feishu/` | 同意，该目录当前不存在 | `src/server/` 列表 |
| 参考「飞书官方 Channel SDK」指向 `larksuite/channel-sdk-node` | 仓库名如此，但**可安装的包名是 `@larksuite/channel`**（npm latest 0.7.1，直接依赖 `@larksuiteoapi/node-sdk ^1.73.1`） | npm registry；[README.zh.md](https://github.com/larksuite/channel-sdk-node/blob/main/README.zh.md) |
| F0 第三项验证 bot@bot 权限 | 曾提为 **F0 第一项**（平台对未开通场景静默失败且无自查 API）。**已完成,结果可达** | §8.1.1 |
| 「本地优先场景验证官方 SDK 长连接」 | 不仅是可行，而且是**一键创建应用的默认订阅方式**（事件与卡片回调均默认 WebSocket 长连接），无需公网回调地址 | [一键创建应用 overview](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview) |
| 「持久化入站去重」列为自建能力 | **不需要自建**。SDK 的去重是双层结构（内存 LRU + **可注入的长期 Cache**），去重键为裸 `messageId`、namespace 固定 `channel:seen`、无 appId 隔离；**注入一个共享且持久化的 `Cache` 即可获得跨重启、跨 App 的去重**。详见 5.1 | `channel-sdk-node/src/safety/dedup-cache.ts`、`src/safety/types.ts` |
| 「Bot 协作限制目标、轮数、超时及资源预算」 | `policy.botLoopGuard` **只**统计「别的 bot @ 我」的消息、滑动窗口超阈值即 `drop`/`reject`（且默认**关闭**）。对「目标、超时、资源预算」零覆盖，对「轮数」只是粗粒度窗口计数。其余仍需自建 | SDK README；`src/safety/loop-guard.ts` |
| 「设置允许使用的群、用户及可信 Bot」 | `policy.groupAllowlist` + `requireMention` 即可圈定；官方建议**按群授权而非逐个发送方**（发送方 open_id 事先拿不到） | SDK README |
| 「审批校验操作者」 | `resolved_by` **列存在但被写成状态字面量**，且没有任何调用点传身份——有位置，但从未装过「谁」 | `src/server/repositories.ts:392,395` |
| 「多端同时审批时只允许一次状态转换」 | **原语已存在**，无需新建：条件是 `WHERE status = 'pending'` 的 UPDATE，靠 `changes > 0` 判首个决定；`resolve` 路由已返回 409 | `src/server/repositories.ts:388-399`、`src/app/api/pending-bash/[id]/resolve/route.ts` |
| 「当前 `sendMessage` 会创建 user 消息」 | 属实，且比描述的更危险：无 `@` 时会兜底分派给 Conductor，构成真实回环路径 | `src/server/conversation-service.ts:193`、`:232-246` |
| 「内存 EventBus 与审批 Promise 不能跨进程直接共享」 | 属实。但审批的**跨进程结算通道已经存在**（HTTP resolve 端点），缺的只是鉴权，不是机制 | `src/server/event-bus.ts:69-74`、`src/server/pending-bash.ts:13-22,44-59`、`src/app/api/pending-bash/[id]/resolve/route.ts` |

## 3. 已验证的代码事实

以下结论均通过读代码/执行验证，非推断。引用格式 `文件:行`。

**消息入口**

- ~~`sendMessage` 对任何来源都硬编码 `role: "user"`。`SendMessageInput` 没有来源/渠道字段。~~ **已由「消息来源标记」改动解决**：`sendMessage` 现在要求显式传入 `origin`（`human` | `bot` | `internal`，见 5.3），消息落库也带该列。
- `pickResponders`（`src/server/conversation-service.ts`）：`single` 模式取首个 agent；有 `@` 取被 @ 的；**否则在会话含 Conductor 时兜底分派给 Conductor**，不含则返回空。因此一条 bot 回显只要走进 `sendMessage`，即使没 @ 任何人也会启动一次新的 Conductor 运行。**这正是 5.3 的闸门所拦的路径。**
- `messages` 表此前只有 `role` / `agentId` / `runId` / `mentionedAgentIds` / `parentMessageId`，**没有来源列**；现已新增 `origin`。

**运行与审批**

- `startAgentRun` 是**同步**函数，把 `executeRun(...)` 脱离执行后立刻返回 `{ runId, promise }`（`src/server/agent-runner.ts:94-100`）；HTTP 路由返回 `202`。
  - 两个必须说清的边界：
    1. **顶层 run 不被 await，但并非所有 run 都「天然脱离」。** Conductor 派发子任务时**确实 await 了** run 的 promise（`src/server/conductor-service.ts:925` `await promise;`）。它在 Conductor run 内部而不是渠道 handler，所以 5.2 的铁律结论仍然成立，但「天然脱离」不能当普适陈述。
    2. `startAgentRun` 在返回前已给 promise 挂了 `.catch(...)`，只做 `console.error`（`src/server/agent-runner.ts:96-98`），因此该 promise **不会 reject**，不会产生 unhandled rejection；也正因如此 `conductor-service.ts:926` 的 `catch` 是死代码。
- `resolveApproval` 是 `UPDATE ... WHERE id = ? AND status = 'pending'`，返回 `changes > 0`（`src/server/repositories.ts:388-399`）——「首个决定生效」的原子原语已经正确实现。
- 但同一语句里 `resolved_by` 被写入 `approved ? "approved" : "rejected"`（`src/server/repositories.ts:392,395`），**不是操作者身份**。`src/` 下共 **8 个调用点**，无一传身份：`pending-bash.ts:103,113`、`dispatch-plan-manager.ts:108,122`、`pending-writes.ts:108,118`、`pending-questions.ts:82,169`。

**事件与跨进程**

- `eventBus` 是 `globalThis` 上的进程内单例，回放缓冲 `MAX_REPLAY_EVENTS = 500` 且纯内存（`src/server/event-bus.ts:10,69-74`）。`/api/stream` 以 SSE 暴露，支持 `last-event-id` 回放（`src/app/api/stream/route.ts:12`）。
- 审批 resolver 是 `globalThis` 上 Map 里的进程内 Promise（`src/server/pending-bash.ts:13-22,44-59`）。DB 里持久化的只有审批**状态**。
- **但跨进程结算是现成的**：`POST /api/pending-bash/{id}/resolve` 取到同进程的 `getPendingBash(id)` 后调 `approvePendingBash/rejectPendingBash`，并在已结算时返回 409（`src/app/api/pending-bash/[id]/resolve/route.ts`）。即：另一进程可以结算这个进程内的 Promise，缺的只是鉴权。

**安全基线**

- `src/app/api/` 下**没有任何入站鉴权**：按 `unauthorized|401|signature|timingSafeEqual` 全量搜索零命中；无 `middleware.ts`（Next 16 的新名 `proxy.ts` 也查过）；`next.config` 无鉴权相关 `headers`/`rewrites`；`src/server/api-utils.ts` 只有响应封装；`src/server/security.ts` 是危险 shell 命令模式拦截，与请求鉴权无关。唯一像鉴权的匹配是 `settings` 路由里的**出站** LLM key。
- `package.json` 的 `dev`/`start` 均无 `-H`/`--hostname`；安装版 `next@16.2.6` CLI 帮助两处标注 `(default: 0.0.0.0)`；**实测**在跑的 `next dev` 监听 `TCP *:3000`。
- `mobileDeviceToken` 有 schema 列、有 bootstrap `ensureColumn`、有行映射与类型（`src/db/schema.ts:325`、`src/db/bootstrap.ts:238,472`、`src/db/rows.ts:153,308`、`src/shared/types.ts:276`），但**从不被任何请求读取或校验**——grep 全仓只命中配置读写链路，`src/app/api/` 下零使用。
- 结论：今天是「本地优先、信任本机」的合理基线，但它不是一个可承载网关的边界；而它**今天就已经是敞开的**。

**存储侧**

- `agents` 表已有 `name` / `avatar` / `description`（`src/db/schema.ts:20-37`）——与 `registerApp` 的 `appPreset.{name,avatar,desc}` 字段一一对应，绑定流程可以直接复用，无需用户重新填写机器人身份。
- **但 `avatar` 是 emoji/短文本**（取值样例：`"🧭"`、`"🎨"`、`"🔍"`、`"A"`、`""`），而 `appPreset.avatar` 要求 `png/jpg/jpeg/webp/gif` 的 **URL**。见第 6 节风险 R1。
- `app_settings` 是单例行；密钥掩码助手 `maskSettings`/`maskKey` 定义在**路由文件内部**（`src/app/api/settings/route.ts:36,46`），不是共享工具——新渠道路由需要自己实现或先把它们提出来。
- `package.json` 中**没有任何二维码依赖**。

**SDK 行为（源码级，非 README 转述）**

- **去重（tier 1 流水线）**：`SeenCache` 是**双层**结构——热内存 LRU + 可注入的长期 `Cache`（`src/safety/dedup-cache.ts`）。检查在 push 时按**原始消息**做（`src/safety/index.ts:110` `seenCache.has(msg.messageId)`）；标记写在与 handler 同级的 `finally` 里，且**对 `batch.sourceIds` 中每一个 id 都写**（`src/safety/index.ts:153-155`）；在途重复由按 `messageId` 的 `ProcessingLock` 兜住（`:142`）。默认参数 `ttl=12h`、`maxEntries=5000`、`namespace='channel:seen'`（`src/safety/types.ts` `DEFAULT_DEDUP`）。
- **批合并默认开启**：`queueEnabled = chatQueue.enabled ?? true`（`src/safety/index.ts:75`）。开启时同一 chat 内 `delayMs=600` 窗口内最多 `maxMessages=8` 条会被合并成**一条** `NormalizedMessage` 再交给 handler，且 `sourceIds` **不暴露给 handler**（`:147-149` 只传 `batch.message`）。关闭队列时不合并，`sourceIds: [msg.messageId]`（`:167`）。默认值见 `DEFAULT_BATCH`（`src/safety/types.ts`）；另有 `DEFAULT_STALE_MS=30min`、`DEFAULT_LOCK_TTL_MS=5min`。
- **流水线顺序**（`src/safety/index.ts:48` 注释）：stale → dedup → policy → lock → batch → queue。
- 卡片动作队列默认 `'same'`，`'separate'` 是显式选项（`src/safety/types.ts` `resolveCardActionQueueMode`）。
- 一键创建应用默认订阅方式为 **WebSocket 长连接**（事件 + `card.action.trigger` 回调），无需公网地址。
- 默认清单已含：`im:message.group_at_msg:readonly`、`im:message.group_at_msg.include_bot:readonly`、`im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`cardkit:card:write|read`、`im:chat.members:bot_access`、`im:chat:read`、`application:bot.basic_info:read` 等；回调 `card.action.trigger`。
- **实测更正**：这份清单**不覆盖**「列出群内机器人」。`getChatBots`（`GET /im/v1/chats/{chat_id}/members/bots`）实测返回 400，服务端要求 `im:chat:readonly` / `im:chat` / `im:chat.group_info:readonly` / `im:chat.members:read` 之一——清单里的 `im:chat:read` 与 `im:chat.members:bot_access` **都不在其中**。后果与对策见 §5.7 与 §8.1。
- `addons` 可**增量**追加权限/事件/回调，预填到用户确认页；**不能删减**基础权限；敏感配置（事件订阅方式、回调地址、`security.*`、加密 key）**不能**经 `addons` 传入，需走 `application-config` OpenAPI。
- `createOnly: true` 让落地页只允许新建应用，隐藏「选择已有应用」——**对逐 Agent 绑定是必要的**，否则用户可能误选并覆盖另一个 Agent 的应用配置。
- 传入已有 `appId` 则流程变为「为该应用增量开通权限」，可用于「补授权/重新授权」。
- 二维码链接**官方文档称「10 分钟有效」、仅一位用户可扫**（官方原文）；返回值含 `client_id` / `client_secret` / `user_info.{open_id,tenant_brand}`；错误 `access_denied|expired_token|abort`；状态 `polling|slow_down|domain_switched`（自动区分飞书/Lark）。**实测的 `expireIn` 是 3600 秒，不是 600**（§8.1.5）——实现必须跟随 SDK 返回值，不要把 10 分钟写死。
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

**关键实现约束：`registerApp` 会一直 await 到扫码或过期（文档称最长 10 分钟，实测 `expireIn` 为 3600 秒——以 SDK 返回值为准），绝不能把它挂在单个 HTTP 请求上。** 因此 `POST /bind/start` 必须在拿到 `onQRCodeReady` 后**立即返回** `{ bindingId, qrUrl, expireIn }`，把 `registerApp` 的 promise 交给后台，结果通过既有事件通道推送。

**这一步可以完全复用已验证的现有基建**：进程内 `eventBus` + `/api/stream`（SSE）。新增事件类型即可，客户端零新机制。

### 4.2 状态与存储

绑定会话（内存，短生命周期）：

```text
channel_bindings（待确认）  Map<bindingId, {
  agentId, status: 'awaiting_scan' | 'succeeded' | 'failed',
  qrUrl, expireIn, abort: AbortController, error?: string
}>
```

内存态可接受：二维码按 SDK 给的有效期过期（实测 3600 秒，文档称 10 分钟），进程重启后会话本就失效（用 `AbortController` 取消在途轮询，避免悬挂）。**这与 `pending-bash` 的既有模式一致。**

持久化（新增表，建议 `channel_bindings`）：

| 列 | 说明 |
| --- | --- |
| `id` | 绑定 id |
| `agentId` | → `agents.id`，唯一（一个 Agent 一个飞书 Bot 身份） |
| `channel` | `'feishu'`（为后续渠道留位） |
| `appId` | `cli_…` |
| `appSecret` | **仅服务端**，永不经 API 返回 |
| `tenantBrand` | `feishu` \| `lark` |
| `botOpenId` | `getBotIdentity().openId`，用于识别自身发言 |
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

### 4.5 两种会话：普通会话 vs 飞书渠道会话

AgentMeld 的会话本来就能自由加 Agent，而**飞书群里的 Bot 必须是绑定过的**。所以这不是「同一个东西的两种视图」，而是**两种会话**，前端必须能区分：

| | 普通会话 | 飞书渠道会话 |
| --- | --- | --- |
| 成员 | 任意 Agent | **只能是有飞书绑定的 Agent** |
| 来源 | 网页 | 一个真实的飞书群，持有 `chatId` |
| 发言 | 网页渲染 | 各 Agent 用自己的 Bot 发到群里，**且网页同样能看到全部** |
| 数据 | 完全在本地 | 消息与运行仍完全在本地；飞书只是收发的一个面 |

**前端区分**：

- 会话列表给飞书渠道会话一个标记（群名 / 图标），与普通会话一眼可分。
- 会话头部显示所绑定的群。
- **创建时**：普通会话照旧；飞书渠道会话要求所选 Agent **全部已绑定**，未绑定的置灰并给出「去绑定」入口——**这个约束在创建时强制，而不是运行时才发现**。

**两个边界情况（需明确行为，不要留白）**：

1. **创建之后把某个 Agent 解绑了。** 群里的 Bot 身份还在（解绑不删应用），但 AgentMeld 侧没有凭据了，该 Agent 的产出投影不出去。约定：**保留会话**，该 Agent 降级为**只在网页显示**，并在群里**提示一次**「X 的飞书身份已解绑，其发言仅在网页可见」——不要静默消失。
2. **有人直接在飞书群里拉进一个新 Bot。** 那是一个新应用，AgentMeld 不知道它属于谁，也没有凭据。约定：**暂不支持**；需要先在 AgentMeld 里为该 Agent 完成绑定。文档与 UI 都不得暗示「拉进群即可用」。

## 5. 入站路由设计

### 5.1 去重：实现选了「原子认领表」，注入 Cache 仍待办

**实现状态（本节曾在实现前写成结论，现已更正）**：代码用的是 `channel_inbound_messages` 的唯一索引 `(channel, external_message_id)`，靠一次 `INSERT ... ON CONFLICT DO NOTHING` 判定 `changes > 0`。**这张表就是去重的正确性来源**，不是"只做映射、不承担去重"。原因：

- 它是**原子**的：「见过没」与「标记已见」是同一步，所以并发投递不会两个都赢、重启后重投也不会赢。
- 它**天然跨 App**：键里没有 appId，两个 Bot 收到同一条人类消息时 `external_message_id` 相同，第二个必然认领失败。这正是官方《接收消息》推荐的做法（用 `message_id` 去重，**不要**依赖 `event_id`）。
- 它同时留下了**审计线索**（外部 id → 本地 message 的映射），而这一点原本被写成表的唯一用途。

**纵深防御已落地（`cache.ts`）**：SDK 的去重长期层是可注入的持久化 `Cache`（默认 `internalCache` 只有内存）。现在给它注入了基于 SQLite 的实现，于是得到两件事：

- **跨重启去重**：进程重启后长期层仍在。这正是补上的缺口——SDK 默认按 chat 批合并并以**批内最后一条**的 messageId 作批次标签，而它会把**批内全部 sourceIds** 标记为已见；没有持久层时这些标记随进程消失，一次「重新投递且批组成不同」就可能被再次路由。
- **跨 App 去重**：键为裸 `messageId`、namespace 固定 `'channel:seen'`、**无 appId 隔离**，因此两个 Bot 收到同一条人类消息时会互相去重。

实现里有两处 SDK 契约细节是**承重**的，注释与测试都钉住了：`set` 的第三个参数是**绝对毫秒时间戳**（不是时长），namespace 拼成 `${namespace}/${key}`（否则 message id 与 event id 会撞）。

**为什么 `messageId` 可以作为键（依据）**：官方《消息管理概述》说明单个租户内系统为每条消息生成唯一 `message_id`；《接收消息》进一步明确：「特殊情况下可能会收到重复的推送，如有幂等需求请使用 `message_id` 去重，**不要依赖 `event_id`**」。

### 5.2 批合并会改变分派语义（必须显式决策）

**这是最容易踩空的一点。** SDK 的按 chat 队列默认**开启**（`chatQueue.enabled ?? true`），开启时同一 chat 内 600ms 窗口、最多 8 条消息会被合并成**一条** `NormalizedMessage` 再交给 handler，且 `sourceIds` 不暴露给 handler。

后果：

1. 「一条人类消息 → 一次分派」的既有前提变成「**一批消息 → 一次分派**」。`sendMessage` 每次调用都会创建一个 user 消息并触发 `pickResponders`，所以一批 3 条若逐条落库会触发 3 次分派。
2. AgentMeld 在 handler 里**只能看到合并后的代表 `messageId`**，无法知道这批还包含哪些外部消息 id，因此任何「逐条外部 id 映射」都是不完整的。
3. 去重的正确性**不受**影响：SDK 在原始消息层检查去重（`index.ts:110`），并在 dispatch 的 `finally` 里对**全部 `sourceIds`** 写标记（`:153-155`），在途重复另有按 `messageId` 的锁兜住。这批消息整体不会重复投递。

**决策点**（F1 前必须定，二选一）：

- **A. 接受批语义**：把合并后的一条当作一次输入投给 `sendMessage`。符合人类的真实输入习惯（连发几句是一句话），也让「一次分派」重新成立。代价：模型看到的是拼接后的文本，元数据取最后一条。
- **B. 关掉批合并**：`chatQueue.enabled = false`（或把 `batch.text.delayMs` 设为 0），恢复逐条语义。代价：失去按 chat 串行与忙时合并。

**决策：已选 A。** 实现没有关掉批合并，也没有试图还原 `sourceIds`——合并后的一条就是一次输入。上面第 3 点说的「去重不受影响」现在完全成立：持久化 Cache 已注入（§5.1），所以 SDK 会把**批内全部 sourceIds** 标记为已见，而不只是批次代表。

### 5.3 来源与回显

1. **来源标记是必需的，且已实现**：消息带 `origin`（`human` | `bot` | `internal`），`sendMessage` 要求显式传入。`dispatchTargets` 对任何非 `human` 来源返回空目标，于是 `pickResponders` 的无 `@` 兜底触发 Conductor **不会被非人类消息走到**。
   - **这条闸门现在是活的（此处曾写「不可达」，已过期）**：入站路由已落地，机器人发来的消息以 `origin: "bot"` 走 `sendMessage`，是**真实的生产调用方**。实测确认：一条 bot 消息被正常落库，而**以它为 trigger 的 run 数为 0**。闸门不再只是"为将来准备的区分"——它正在挡一个飞书群里真实存在的回环。
   - 同一改动还让 `origin` 成为消息的一等属性（`role` 表示对话如何对待它，`origin` 表示它实际来自谁——外部 bot 的消息仍是 `role: "user"`）。
2. **自身回显检测在 IM 路径不是必需的**（更正 Issue 的假设）：飞书**不把机器人自己发送的消息投递给它自己**——群消息权限说明明确「不包含当前机器人自己发送的消息」，`im.message.receive_v1` 的投递前提是被 @ 或单聊；SDK 也只对**会议通道**提供 `selfEcho`。
   - 因此「保存出站 `messageId` 以识别自身回显」**不构成 IM 路径的正确性依赖**。可以保留为防御性措施（成本低），但不要当作设计支柱，也不要为它牺牲简洁性。真正的回环风险来自 `origin`，不是来自自身回显。

### 5.4 永不 await（设计铁律）

渠道 handler 的职责边界：**归一化 → 去重 → 落库 → 触发 → 返回**。触发即 `sendMessage`（同步返回 runIds），**绝不 await run、绝不 await 审批**。所有进展、审批请求、产物交付都通过订阅事件异步投影回飞书。

理由：SDK 明确警告在 `message` handler 里 `await` 一次卡片审批会**死锁**（默认 `safety.chatQueue.cardActions: 'same'`，点击排在该 chat 在途工作之后）。AgentMeld 从 `sendMessage` 发起的顶层 run 恰好不被 await，所以只要遵守这条铁律就不会踩中。

### 5.5 不要用 `onRawEvent` 接管 IM 消息

`onRawEvent` 注册的 handler 会**绕过整个安全管线**：`PolicyGate`（`dmMode`/`dmAllowlist`/`groupAllowlist`/`requireMention`）、去重、按 chat 串行的锁、防回环、过期丢弃**全部不生效**。SDK 文档明确警告，对 `im.message.receive_v1` 注册 raw handler「等于为它开了第二条不设防的入口」，被白名单拒掉的消息照样收得到。本方案不使用它。

### 5.6 事件 → 飞书消息

必须遵守 Issue 的「不逐 token 新发群消息」。`/api/stream` 的流式增量应聚合后用 `stream()` 流式卡片或 `updateCard()` 就地更新，而不是每条事件发一条群消息。默认不发布原始推理、凭据、完整工具日志。

**出站范围（已确定）**：每个 Agent **一段聚合后的进展 + 最终产物**；工具调用细节、推理过程、原始日志**留在网页**。

「聚合」的可操作定义（**逐条标注实现状态**）：

- **进展**：同一 Agent 在同一任务里的同类进展**合并成一条**，并用卡片**就地更新**（`updateCard`），而不是每步新发一条。由 §5.8 第 5 层的节流落实。❌ **未实现**——当前的"聚合"来自消息本身（runner 把 parts 流式写进一条消息，完成时投影即一条），不是靠卡片更新。
- **产物**：任务结束时单独发一条卡片，带产物入口（文件 / 部署预览）。⚠️ **只做了标签**：产物引用被渲染成 `📎 <标题>`，**没有可打开的入口**。原因是产物没有群成员能访问的 URL——这正是 §7.3 列为「明确不在本方案内」的**本地优先 vs 平台可访问**那对矛盾；在它解决之前"产物入口"无法兑现，文档不得宣称有。
- **失败**：同样要发——静默失败比刷屏更糟。✅ **已实现**：`run.end` 且 `status = "failed"` 时由该 Agent 的 Bot 发一条说明。每个 run 只发一次、**不受发送预算限制**（失败条数由 run 数封顶，而"失败通知因为是第 21 条而被吞掉"恰恰是最需要它的时刻）；**中止不算失败**（用户自己停的，他知道），因此不发。**代价（有意为之）**：说明里**不含原因**——错误字符串经常带环境变量名、路径与 provider 内部信息，正是回复不该带进群的那类细节，而且群里也无法据此行动。要看原因去网页。
- **不投影**：token 级流式增量、工具调用参数与返回、系统提示、凭据、内部推理。

### 5.6.1 入站分派：照搬桌面语义，不新增规则

飞书是**同一个会话的另一个入站面**，不是一个新系统。因此分派**完全复用**桌面已有的语义（`conversation-service.ts` 的 `pickResponders`）：

| 入站消息 | 行为 | 桌面已有？ |
| --- | --- | --- |
| @ 了具体 Agent（一个或多个） | 派给**被 @ 的那些 Agent** | ✅ 已有 |
| 没有 @ 任何人 | 交给 **Conductor** 兜底（走 DAG） | ✅ 已有 |
| 单聊（`p2p`） | 同单 Agent 会话 | ✅ 已有 |
| **来自 Bot**（`senderType = bot`） | **不启动任何工作**，只落库 | ✅ 已有（`origin` 闸门） |

**关键：不引入任何飞书特有的分派逻辑。** 不因为「它来自飞书」就特殊对待，也不因为「对方是 Bot」就传递任务。多 Agent 协作仍然由**内部 Conductor 调度**产生，飞书只是用**各 Agent 自己的 Bot 身份**把协作过程与结果展示出来——这与 Issue 第一阶段「内部 Conductor 调度实际任务，飞书展示对应的真实 @ 与协作进展」一致。

至于「通过飞书 @ 事件驱动跨 Bot 接力」，那是**需要独立 delegation 语义的后续阶段**（来源 Agent、目标、task/attempt、一次性 correlationId、预算，见 Issue #24），本方案在第一阶段**不做**——它也**不需要**，因为协作的方式就是桌面已有的方式。

### 5.7 提及别的 Agent：用已知 openId，不要依赖按名字解析

SDK 的群成员 roster 有**三个**来源（`README.zh.md`「名字解析」）：

| 来源 | 取什么 | 一键清单够不够 |
| --- | --- | --- |
| `getChatMembers` | 群内**用户** | ❌ 走 `GET /im/v1/chats/:id/members`，要求 `im:chat` / `im:chat:readonly` / `im:chat.members:read` / `im:chat.group_info:readonly`，**四个都不在**清单里 |
| `getChatBots` | 群内**机器人** | ❌ 同上四个，**一个都不在**（§8.1.2 实测 400） |
| 入站 mention | 别人 @ 我时观察到的身份 | ✅ 不需要额外 scope |

**所以默认唯一可用的 roster 来源是「别人 @ 过我」。** 这带来一个必须说清的后果：

- 对**已经 @ 过我**、因而进入 roster 的 peer，**按名字 @ 是可用的**（官方也这么说：要么先调一次 `getChatBots` 预热，要么依赖它已在群里露过面）。
- 对**没有**的 peer，按名字 @ **不可靠**。而且两种写法的失败方式不同：
  - 结构化 `mentions: [{ name }]` 解析不到时，该项**被直接丢弃**——连 `@` 都不会出现；
  - 正文里的 `@xxx` + `resolveMentionsInText: true` 解析不到时，**保留为纯文本**——看起来像 @ 了，其实不会送达。

**两种都是静默失效。** 因此实现约定：

> **凡是要 @ 某个已知 Agent，一律用它的 openId 构造 `mentions`，不用名字。** 名字只用于展示。

openId 从哪来：本进程 `connect()` 后的 `getBotIdentity()`（自己的），以及入站事件的 `mentions[].openId`（别人 @ 我时观察到的）。**实测跨 Bot 提及走的正是这条**（§8.1.1）。

若将来确实需要稳定的按名字解析（例如用户手打的 `@PM`），再走 §4.4 的重授权补上表中的一个 scope，并把它当成独立工作——**不要依赖 roster 恰好补齐**。

### 5.8 环路防护（六层，从架构到传输）

R12 的实测说明回环**不是理论风险且很快**：一个「任何群消息 → @ 其他 Bot」的**无条件**规则两秒内就自激。根因不在传输层，而在**规则本身**。所以防护的主体是架构约束，传输层的守卫只是兜底。

**第一原则：投影只能由 AgentMeld 自己的状态驱动，绝不能由「收到一条消息」触发。**

入站消息只做三件事——**去重、落库、按 `origin` 决定是否分派**。它**不触发任何"回复"**。产品里不允许存在「有人说话 → 我回一条」这种规则；Bot 发言的唯一来源是**它自己的运行**产出了东西。

| # | 层 | 内容 | 实现状态 |
| --- | --- | --- | --- |
| 1 | **架构** | 入站不生产出站（第一原则）。 | ✅ **已实现**。`router.ts` 的唯一产物是一条本地消息，它没有任何发送路径；`projection.ts` 只由**本地事件**（`message.end`、`run.end`）驱动，**从不由入站事件驱动**。这条是"由构造保证"，不是靠自觉 |
| 2 | **投影白名单** | 只有列明的事件类型允许投影；「收到了一条消息」不在白名单里。 | ⚠️ **部分实现**。白名单是两条：**Agent 消息完成**（`message.end` + `role: "agent"` + `status: "complete"`）与**运行失败**（`run.end` + `status: "failed"`，只发说明、不发原因、一次一条）。原列的 `run.started` 与产物卡片**未实现**——产物只有标签、没有入口（§5.6 已注明原因） |
| 3 | **来源闸门** | `origin !== "human"` → 不启动工作。 | ✅ **已实现且已在守**（不再惰性）。实测：bot 消息落库、**以它为 trigger 的 run 为 0** |
| 4 | **每任务预算** | 一个任务对一个群的投影条数上限。 | ⚠️ **实现成了另一个东西**：**每会话每分钟 20 条**的滚动窗口，不是每 `(会话, 任务)` 计数。原因是运行的产出是"每个 Agent 一条"，按任务计数几乎不会触发；按会话限速才能兜住真正的失控。触顶发**一条**说明 |
| 5 | **合流/节流** | 同类进展在 `X` 秒内只发一条、卡片就地更新。 | ❌ **未实现**。当前不靠定时器聚合——runner 把 parts 流式写进同一条消息，「完成时投影」本身就是每答复一条。**长答复的卡片就地更新没做**；它改变呈现方式，不改变条数 |
| 6 | **传输层兜底** | `botLoopGuard = { enabled: true, onTrip: "reject" }`。 | ✅ **已实现**，显式开启并用 `reject`（触发时可见，而不是被 `drop` 静默吞掉）。官方自述只是启发式，所以不当作唯一防线 |

**关于「总开关」——此处曾写成"设置里一个按钮"，不准确。** 代码里有 `setChannelProjectionPaused(true)`，**但没有任何 UI 入口或 API 暴露它**，所以它目前只能由代码调用，用户按不到。要兑现这一段，需要一个设置项（或一个受保护的管理端点）。写库、入站、网页不受影响这一点是成立的。

**验收（§5.8 第一条）——已存在，但**只覆盖部分层**，这里如实划清界限。**
`loop-bound.test.ts` 构造 A ↔ B 互相 @ 的场景，断言**消息数量有界且最终停止**，走真实的 router / projection / eventBus。**两样是假的**：平台客户端，以及 `startAgentRun`（让"一次运行"成为被计数的事件而非模型调用）。

- **第 1 层（入站不生产出站）**：✅ 由接线覆盖。
- **第 3 层（来源闸门）**：✅ 覆盖——**删掉闸门它会失败**（实测 `2 failed | 1 passed`，run 计数从 1 变成 3，即循环真的复现）。
- **第 6 层（`botLoopGuard`）**：❌ **不在本测试覆盖内**。connection 模块被 mock，它武装的策略在别处断言（`connection.test.ts`）。

## 6. 风险与未验证项

| 编号 | 风险 | 处置 |
| --- | --- | --- |
| **R1** | **`appPreset.avatar` 与本地优先冲突。** 它要求可访问的图片 URL（png/jpg/webp/gif），而本仓 `avatar` 是 emoji 短文本。要「身份一致」，需把 emoji 渲染成 PNG 并托管在一个**飞书可访问**的地址——这与本地优先直接矛盾 | F0 验证：确认头像是由**用户客户端**还是**平台服务端**抓取。前者可用本机地址，后者必须公网。**降级方案**：不传 `avatar`，让用户在确认页自行选择；文档不得承诺「头像自动一致」 |
| **R2** | 权限是否需要租户管理员审批。扫码人若非管理员，部分 scopes 可能停在待审批态 | F0 用普通成员账号扫一次，观察 `getBotIdentity`/发消息是否成功 |
| **R3** | ~~未开通 `include_bot` 时 bot@bot 静默失败~~ **已结案**：权限在清单里且事件确实投递（§8.1.1） | 无需处理 |
| **R4** | 解绑后飞书侧应用是否可程序化删除（`application` 删除文档路径实测 404，未能确认存在） | 查 `application` 系列 OpenAPI；不确定则在 UI 明示「需手动到开发者后台清理」 |
| **R5** | 逐 Agent 建应用是否有配额/频率限制 | F0 记录实际创建数量与报错 |
| **R6** | 每 Agent 一条 WS 长连接（官方：同一应用开两条连接会导致事件分流）。`next dev` 的 HMR 会重新求值模块，可能造成重复连接 | F0 验证重连与实例行为；连接宿主必须做单例保护。这是第 7 节架构选择的直接输入 |
| **R7** | 去重若**不注入**持久化 Cache，则重启即失（默认 `internalCache` 只有内存） | 注入共享持久化 `Cache`（5.1）。这不是「必须自建」，而是「必须注入」 |
| **R8** | `/api` 无入站鉴权 + 默认监听所有网卡。**此风险今天已存在，非网关引入** | 网关方案的硬前置（7.1）。若走进程内形态则不新增网络入口 |
| **R9** | `resolved_by` 不装操作者，「审批校验操作者」有列无值 | 独立小 PR 先修（7.2 PR1） |
| **R10** | SDK 默认按 chat 批合并（600ms / 最多 8 条）改变分派语义，且 `sourceIds` 不外泄 | F1 前显式决策（5.2）。这是本次复核新增项 |
| **R11** | `mobileDeviceToken` / `companionMode` 字段存在却从不参与请求校验，疑似为 LAN/移动端鉴权预留但未接线 | 设计入站鉴权前先确认这两个字段的既定意图，避免另起一套 |
| **R12** | **Bot 接力回环。已用探针复现**：一个「任何群消息 → @ 其他 Bot」的**无条件**规则在两秒内自激并持续往返，直到进程被杀。注意复现物是**临时探针而非 AgentMeld 链路**——产品里只要不写这种规则，就没有这个循环。SDK 的 `botLoopGuard` 默认关闭，且官方自述只是「启发式兜底，非协议级保证」 | **防护见 §5.8**（六层，从架构到传输）。这是 F1 的前置：连接层落地时就带着它，而不是事后补 |
| **R13** | **一键清单缺少「列出群内机器人」与「列出群成员」的 scope**（§3 更正、§8.1.2 实测 400） | 按名字提及因此**只对已 @ 过我、被 roster 观察到的 peer 可用**；其余情况用已知 openId（§5.7）。需要用名字时走 §4.4 重授权补 scope |
| **R14** | **没有发送者或群 allowlist**。`connection.ts` 只设了 `requireMention` / `respondToMentionAll` / `botLoopGuard`；SDK 的 `dmMode` 默认 `open`，`groupAllowlist` 未设。**后果：任何能在群里 @ 到 Bot 的飞书用户，都会以 `origin: "human"` 触发一次 Agent 运行**——包括内容形如 `/deploy` 的消息（那会走部署分支）。 | **未修**。SDK 建议用 `groupAllowlist` 圈定群。这是 issue #24「网页、飞书与远端接管共用的认证和审批权限边界」的直接范围——在鉴权落地前，飞书入口的授权边界等于「群成员」。**不要**把它当成已解决 |
| **R15** | **渠道建出来的群会话只有 1 个成员**，绕过了服务层「group 至少两个 Agent」的校验（`validateConversationAgents`）。后果：之后有人在 UI 里按 group 规则编辑该会话，会直接抛错。 | **未修**。修它要么放宽校验（要确认放宽不会让手工建的会话也变得不合法），要么让渠道会话用另一种模式表达。真实数据里已有这样一条会话 |
| **R16** | **membership 只增不减**：Bot 被移出群后仍留在 `conversation.agentIds` 与成员表里，没有离群处理路径。 | **未修**。`im:chat.members:bot_access` 权限在清单里，所以理论上可以订阅机器人进出群事件来收敛；尚未接 |
| **R17** | 本地消息**丢弃了 `threadId`**（话题归属），且 `message_id` 为 null 同时表示「空消息」与「认领后失败」，两件事无法区分。 | **未修**，属可观测性/话题隔离（Issue F3），先记录 |

## 7. 架构选择与实施顺序

### 7.1 进程内 vs 独立网关

Issue 推荐独立网关进程。核实后，两条路的代价差得比看上去小——**因为跨进程审批结算是现成的**：

| | 进程内（渠道跑在 Next 进程内） | 独立网关（Issue 方案） |
| --- | --- | --- |
| 事件 → 飞书 | 直接 `eventBus.subscribe` | 走 `/api/stream` SSE（已有），但回放缓冲仅 500 条且内存态 |
| 审批结算 | 直接 `resolvePendingBash` | **已可行**：`POST /api/pending-bash/{id}/resolve` 现成，且已用条件 UPDATE 保证首个决定生效、重复调用返回 409。缺的是**鉴权**，不是机制 |
| 入站鉴权（R8） | 不新增网络入口 | **必须先做** |
| 持久化 inbox/outbox | 不需要 | 需要，否则断线丢事件（SSE 回放只有 500 条） |
| WS 长连接生命周期 | 与 Web 进程绑定，HMR 下需单例保护（R6） | 独立进程更稳 |
| 与 Issue 的一致性 | 偏离 | 一致 |

**结论：先做进程内形态。** 它消掉的是**入站鉴权**与**持久化 inbox/outbox** 两件事（注意：不含审批结算，那本来就可行），并且**不损害未来拆分**——只要渠道适配层面向内部接口而非直接依赖 `eventBus`/审批模块，将来换成网关只需替换实现。当前证据不足以证明独立网关是本地优先场景的必要代价。

### 7.2 建议顺序

**PR1（无凭据，现在可做）— 审批操作者身份**
修 `resolveApproval` 把状态写进 `resolved_by` 的问题（`src/server/repositories.ts:392,395`）：增加操作者参数并持久化，**8 个调用点**透传，schema + bootstrap + 类型 + API 暴露同步跟进，并补测试。
范围需明确（本次复核新增）：目前只有**计划审批**会写 `approval_resolved` 证据行（`src/server/dispatch-plan-manager.ts:164`），`pending-bash` 与 `pending-writes` 的审批**没有任何 evidence 行**。PR1 要决定是只修 `resolved_by`，还是同时给三处补审批证据。
价值：直接满足「审批校验操作者」「未授权用户和 Bot 无法批准敏感工具」两条验收标准的前置条件；**与飞书无关**，独立可评审。
注：「首个决定生效」已由现有条件 UPDATE 保证（`src/server/repositories.ts:388-399`），不要重复实现。

**PR2（无凭据，现在可做）— 消息来源标记**
为消息引入 `origin`（`human`/`bot`/`internal`）并落库，`sendMessage` 要求显式传入；`dispatchTargets` 让任何非 `human` 来源都得不到分派目标（`pickResponders` 保持为纯路由函数）。
价值：让渠道落地时**无法**引入 5.3 那条回环，并把「谁写的」变成消息的一等属性。**注意它今天不关闭任何正在发生的回环**——见 5.3 的准确表述。

**F0（需凭据）— 接入验证**
**第一项已完成**：bot@bot 事件可达，「多 Bot 各自身份」的设计成立（§8.1.1）；顺带确认了「Bot 收不到自己发的、也收不到不 @ 它的消息」（§8.1.3）。其余项按 R1、R2、R4–R6、R10、R11 逐项取判定，产出「实际权限、发布配置、平台限制」记录。

**下一步：连接层 + 环路防护（一起做，不分开）**
§5.8 的防护是**连接层的一部分**——连接一旦存在，"什么会被发出去"就已经在定义回环半径了。所以它既不是「F1 的前置」也不是「F1 的验收」，而是**连接层的验收**：连接层落地的同一批测试里就断言「A ↔ B 互相 @ 时消息条数有界且停止」。

已确定的架构决策（不再讨论，直接实现）：

| 决策 | 结论 |
| --- | --- |
| 会话形态 | **两种会话**（普通 / 飞书渠道），前端区分，创建飞书渠道会话时强制所选 Agent 全部已绑定（§4.5） |
| 入站分派 | **照搬桌面语义**，不新增飞书特有规则（§5.6.1） |
| 出站范围 | 每 Agent **一段聚合进展 + 最终产物**；工具细节留在网页（§5.6） |
| @ 别人 | **一律用已知 openId**，不用名字（§5.7） |
| 环路防护 | §5.8 的六层 + 总开关 |
| 协作机制 | 第一阶段**由内部 Conductor 调度**，飞书用各 Bot 身份**展示**；不做跨 Bot 接力（§5.6.1） |

**F1+**：按 Issue 原计划，但把 5.2（批合并决策）、5.3（来源标记）作为前置，而不是事后补。

### 7.3 明确不在本方案内

- 持久化 inbox/outbox、网关拆分：等 F0 与进程内形态验证后再定。
- 部署预览的公网可达地址（Issue F3）：与 R1 同源，都属「本地优先 vs 平台可访问」这一未解矛盾，需单独讨论。
- 现有 `db:seed` 启动恢复副作用（见 README 警告）：与本功能无关，不在此处理。

## 8. F0 问题表与实测结果

按「答不出来就不能继续」排序。**已实测的标注结果与日期。**

> **证据说明（必须说清）**：下面引用的运行输出是**整理后的摘要，不是原始日志**。F0 用的是两个临时探针脚本（`.tmp-feishu-f0.mts` / `.tmp-feishu-self.mts`），它们被 `.gitignore` 的 `/.tmp-*` 排除，**没有入库，运行输出也没有落盘**。因此这些证据**在本仓库内不可核验**；它们记录的是当时观察到的结果，读者应据此判断结论强度。要复现，需要两个真实应用、一个真实群与自己的凭据重跑一遍。
>
> 引用的每行都保留了**接收者身份**与**发送者 id**，因为 `senderType=bot` 对「自己发的消息」同样成立——只有接收者 ≠ 发送者才能排除自消息。

### 8.1 已实测

#### 8.1.1 两个 Bot 同群，A @ B，B 是否收到事件？→ ✅ **可达**

2026-10-15,两个真实应用(`cli_aa45114061789c1b` = Conductor、`cli_aa4512cf2bb8dc0a` = PM 小灰)+ 一个真实群 + 各一条 WS 长连接。整理后的输出(注:`<< ...(openId)` 中的 openId 是**接收者自己**,`sender=` 是发送者):

```
[16:38:29] << ag_mock_conductor(ou_f5c69d222) RECEIVED
             sender=ou_f9fedd4ad  senderType=user  senderIsBot=false  mentionedBot=true
           (接收者 ou_f5c69d222 ≠ 发送者 ou_f9fedd4ad → 是人类发的)

[16:38:31] << ag_pm(ou_948977a68) RECEIVED
             sender=ou_370901b8f  senderType=bot   senderIsBot=true   mentionedBot=true
           (接收者 ou_948977a68 ≠ 发送者 ou_370901b8f → 是**另一个 Bot**发的)

[16:38:32] << ag_mock_conductor(ou_f5c69d222) RECEIVED
             sender=ou_816d0f0ef  senderType=bot   senderIsBot=true   mentionedBot=true
```

- 扫码后在开发者后台**确认** `im:message.group_at_msg.include_bot:readonly` 存在于权限清单。
- **事件确实投递**，且 `senderType` / `senderIsBot` / `mentionedBot` 解析正确；**接收者身份与发送者 id 不同**，排除了自消息。
- 结论:**「每个 Agent 一个 Bot 身份、互相 @」的设计成立**,不必塌缩成「单 Conductor Bot + 网页投影」。R3 结案。
- 同时确认:**用已知 openId 构造的 `<at user_id="ou_…">` 提及可以跨 Bot 生效**（§8.1.4 有对照）。

#### 8.1.2 一键清单是否覆盖「列出群内机器人 / 群成员」？→ ❌ **都不覆盖**

调用 `getChatBots`(`GET /im/v1/chats/{chat_id}/members/bots`)实测 400:

```
Access denied. One of the following scopes is required:
  [im:chat:readonly, im:chat, im:chat.group_info:readonly, im:chat.members:read]
应用尚未开通所需的应用身份权限
```

一键清单含 `im:chat:read`(查看群信息)与 `im:chat.members:bot_access`(机器人进出群事件),但**都不在服务端要求的这四个之中**。`getChatMembers`(群成员列表)要求同样这四个,因此**两个 API 名册源都不可用**。这是一处对 §3 的更正(§3 原先只依据官方文档逐字符核对清单,没有实测调用)。

**后果与对策**:按名字提及**只对已 @ 过我、被 roster 观察到的 peer 可用**，其余情况不可靠，且两种失败写法都**静默失效**（§5.7）。本方案改为**一律用已知 openId 构造提及**。

#### 8.1.3 机器人会不会收到自己发的、或不 @ 它的消息？→ ❌ **都不会**

这是 §5.3 与「网页是完整记录、飞书是投影」两条设计的前提，因此单独被动测了一次（只发 2 条消息、不接力，不会成环）:

```
check 1  Conductor 发一条 PLAIN 消息（不 @ 任何人）
         → 等待 8 秒，received=0
         ✓ 连发送者自己都没收到，其他 Bot 也没收到

check 2  Conductor @ PM 小灰（对照）
         → ag_pm RECEIVED  sender=ou_370901b8f  senderType=bot  mentionedBot=true
           而 ag_pm 自己的 openId = ou_948977a68  → 接收者 ≠ 发送者
         ✓ @ 到了就收到，且确认不是自消息
```

**两条结论**:

1. **Bot 收不到自己发的消息** —— 这是回环设计的前提，此前只有官方口径，现在有实测。
2. **Bot 收不到不 @ 它的消息** —— 因为一键清单给的是 `group_at_msg`（@ 机器人的消息），**不是** `im:message.group_msg`（群内所有消息，敏感权限）。所以「让 Bot 读到群里的全部消息」这条路默认不存在，**也不需要**：网页由 AgentMeld 自己的状态喂，本来就是完整的。

#### 8.1.4 回环：用探针复现了

探针的接力规则是「**任何**群消息 → @ 群里其他 Bot」，**无条件**。它自激并在两秒内持续往返，直到进程被杀。

**注意复现物的性质**：这是**临时探针**，不是 AgentMeld 链路。它证明的是**平台层不会阻止这种循环**，以及「无条件转发」这条规则会成环；它**不**说明 AgentMeld 会有同样的行为——只要不写那种规则（§5.8 第一原则），就没有这个循环。R12 的处置见 §5.8。

**未测量**：往返速率、消息总数与是否触发平台频控都没有留存数据（时间戳随日志丢失），因此本文**不给数字**。已知的只有：它确实是正反馈，且很快就明显。

#### 8.1.5 其他顺手确认的

- **长连接可用,无需公网地址**:两条 WS 均建立并收到事件。SDK 会打印一条「订阅方式需在开发者后台设为长连接」的提示,实测**没有阻塞**(一键创建默认为长连接)。
- **注册链接的有效期**:`onQRCodeReady` 的 `expireIn` 实测为 **3600**(秒)，而公开文档写「十分钟内有效」。会话跟随 SDK 实际给的值（§4.2 已按此修正）。

### 8.2 未实测

**F0 原计划里仍未覆盖的：**

1. 扫码人**非管理员**时权限是否即时生效？(R2) 本次扫码人权限足够，所以这条**完全没有覆盖**——不要把它读成「已验证」。
2. `appPreset.avatar` 的图片由谁抓取——用户客户端还是平台服务端?(R1)
3. 卡片按钮回调、表单提交、卡片就地更新、流式回复是否均可用?
4. 断线重连后事件是否补投?重复事件如何表现?(配合 5.1 的持久化 Cache 验证跨重启去重)
5. 单应用开两条 WS 连接时事件是否分流?(R6)
6. 逐 Agent 创建应用的数量与频率上限?(R5)
7. 是否存在删除应用的 OpenAPI?(R4)
8. 一批合并后交付对用户体验与上下文的影响(5.2 决策 A 的实测)。(R10)
9. `mobileDeviceToken` / `companionMode` 的既定意图(R11) —— §7.2 把它列进「其余 F0 项」，这里一并记上，避免两处不自洽。

**这次实测**暴露**出**的缺口（比上面更要紧，因为它们是「以为测了其实没测」）：

| 缺口 | 为什么重要 |
| --- | --- |
| **`botLoopGuard` 到底能不能断环** | §5.8 把它列为第 6 层兜底，但**从未在循环运行时试过它**。它是官方自称的启发式，不试就不能算防线 |
| **回环的后果半径** | 无条件转发会把人类的普通消息也每个 Bot 各转一次（消息放大）。是否触发平台频控/限流、会不会影响账号，完全未知——**这是再次触发前必须补的** |
| **`getChatMembers` 缺失的连带影响** | §8.1.2 只测了 `getChatBots`；`getChatMembers` 要求同样的 scope，因此 `resolveSenderNames`（把 sender id 显示成人名）与按用户名 @ **同样不可用**。§5.7 已按此更正，但未实测其降级表现 |
| **解绑后再绑定、以及重授权补 scope** | §4.4 的重授权流程一次都没跑过；而 §5.7 要「稳定按名字 @」正需要它 |

## 9. 参考

- [一键创建飞书智能体应用（overview + 配置清单）](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview)
- [一键创建应用（NodeJS）](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/scan-to-create-an-app-in-one-click-nodejs)
- [飞书官方 Channel SDK](https://github.com/larksuite/channel-sdk-node/blob/main/README.zh.md)
- [官方 Bot-at-bot 说明](https://github.com/larksuite/channel-sdk-node#bot-at-bot)
- [飞书官方 Node SDK](https://github.com/larksuite/node-sdk)
- [接收消息事件](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
- [消息管理概述（message_id 唯一性）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/intro)
- [发送消息接口](https://open.feishu.cn/document/server-docs/im-v1/message/create)

## 10. 复核记录

本文经过一轮独立对抗式复核（复核方无作者上下文），结果如下，已全部落进正文：

**被推翻并更正的结论**

| 编号 | 原结论 | 更正 |
| --- | --- | --- |
| F1 | SDK 去重是进程内 Cache、重启即失、跨 App 必须自建 | **错**。双层结构 + 可注入持久化 Cache；键为裸 `messageId`、无 appId 隔离，注入共享持久 Cache 即得跨重启/跨 App 去重 → 改为「注入，不要自建」（5.1） |
| F2 | `botLoopGuard` 已提供「限制目标/轮数/超时/预算」的大部分 | **夸大**。它只统计「别的 bot @ 我」并做窗口阈值 `drop`/`reject`，默认关闭 → 已改为准确描述 |
| F3 | 全仓 7 个 `resolveApproval` 调用点 | **实为 8 个** → 已改 |
| F4 | 独立网关的审批结算「不可行，必须新增轮询/通知机制」 | **错**，且与本文 §1 自相矛盾。HTTP resolve 端点已现成，缺的是鉴权 → 7.1 表已重写 |
| F5 | 「AgentMeld 的 run 天然是脱离的」 | **过度概括**。Conductor 派发子任务时会 await（`conductor-service.ts:925`）→ 已限定并补充 `.catch` 吞 rejection 的事实 |
| U2 | 「二维码一次只创建一个应用」 | 官方未述，属推论 → 已删 |
| U3 | `resolved_by`「当前无处落账」 | 措辞不准：列存在但被写成状态字面量 → 已改 |
| U4 | 「本文第 3 节曾把该风险列为头号风险」 | 交叉引用错误，应为第 6 节 R3 → 已改 |
| U5 | 底层 node-sdk「≥1.61.1」 | 混淆了「直连安装要求」与传递依赖；`@larksuite/channel` 实际依赖 `^1.73.1` → 已改 |
| M2 | 出站 `messageId` 判自身回显为必需 | 飞书不向机器人投递其自身消息，`selfEcho` 仅会议通道 → 已降级为可选防御措施并说明 |
| M4 | 把该鉴权风险说成「引入网关的坏消息」 | 风险**今天已存在**，与网关无关 → §1 已更正归因 |
| M5 | PR1 只谈 `resolveApproval` 一处 | 只有计划审批写 `approval_resolved` 证据，bash/write 无 → 7.2 已补范围问题 |

**新增内容**：5.2（批合并语义 + 决策点，R10）、5.5（`onRawEvent` 绕过安全管线）、R11（`mobileDeviceToken`/`companionMode` 未接线）、5.1 的官方 `messageId` 依据、7.1 的审批结算更正。

**对复核意见的一处纠正**：复核的 M1 指出「SDK 默认批合并」属实且重要（已采纳并升格为 5.2），但其机制描述「一批 N 条只落 1 条去重记录，重启后另外 N−1 条不被拦」**不成立**——源码显示去重标记在 dispatch 的 `finally` 里对**全部 `batch.sourceIds`** 逐个写入（`src/safety/index.ts:153-155`），在途重复另由按 `messageId` 的 `ProcessingLock` 兜住（`:142`）。批合并影响的是**分派语义与 id 可见性**，不是去重完整性。

**复核确认无误的关键结论**（未在正文改动）：`/api` 无入站鉴权且默认监听所有网卡（实测 `*:3000`）；`resolveApproval` 的条件 UPDATE 与「首个决定生效」；`pickResponders` 语义；`sendMessage` 曾硬编码 `role:"user"`（现已由来源标记改动解决，见 5.3）；`agents.avatar` 为 emoji 且 `appPreset.avatar` 需图片 URL（R1 为真风险）；一键创建默认 WebSocket 长连接且清单逐字符含 `im:message.group_at_msg.include_bot:readonly`；`addons` 增量语义、`createOnly`、传 `appId` 增量授权、返回值/错误码/状态机；`registerApp` 由 `@larksuite/channel` 重新导出；卡片回调死锁警告与 `cardActions` 默认 `'same'`；全部引用 URL 有效。

### 10.2 第二轮复核（针对第 8 节的 F0 记录）

第二轮复核的对象是 F0 记录本身。核心结论（bot@bot 可达、回环真实、须用 openId）经独立复核**成立**；被推翻的集中在**证据标注强度**与几处机制/一致性表述，已全部落进正文：

| 编号 | 被推翻的 | 更正 |
| --- | --- | --- |
| F1 | **R3 在风险表里出现两次**，一条未决、一条已结案 | 原行**原位**改为已结案，删掉追加的重复行（这是本次编辑最该修的问题） |
| F2 | 「roster 有**两个**来源，只有 `getChatBots` 缺 scope」 | roster 有**三个**来源；`getChatMembers` 要求同样那四个 scope，**两个 API 源都不可用**，默认只剩「别人 @ 过我」这一源（§5.7） |
| F3 | 「按 Bot 名字 @ **默认走不通**」 | **说过头**。对已 @ 过我、因而进入 roster 的 peer，按名字 @ 可用；应为「**不可靠**」而非「不可用」（§5.7） |
| F4 | §8 把整理摘要标成「原始日志 / 原始证据」 | 明确为**整理摘要**，并声明探针未入库、运行输出未落盘，**证据在本仓库内不可核验**（§8 开头的说明） |
| F5 | 摘录删掉了唯一能排除自消息的 `sender=` 字段 | 保留**接收者自身 openId** 与 `sender=`，并显式标注「接收者 ≠ 发送者」（§8.1.1） |
| F6 | R12 称 `origin` 闸门「**已让**非人类消息不启动工作」 | 与 §5.3 自己的更正冲突。改为「**已就位，但还没有生产调用方传入非人类 origin**，因此尚未在守」 |
| F7 | 3600 秒的更正没有回灌 §3 / §4.1 / §4.2 | 三处已改，并写明「**以 SDK 返回值为准，不要把 10 分钟写死**」 |
| F8 | 文档头「尚未实现任何代码」 | 已改为真实状态（§4 已合入 master，入站/出站/连接层未实现） |
| F9 | 两种「未解析 mention」混为一谈 | 分开：结构化 `{name}` 未解析**直接丢弃**；正文 `@xxx` **保留为纯文本**。**两者都是静默失效** |

**补做的实测**（复核指出这是整个回环设计的前提却从未测过）：机器人**收不到自己发的消息**，也**收不到不 @ 它的消息**（§8.1.3）。这条一行就能补的旁证此前只有官方口径。

**未采纳的唯一一条**：复核的 U1 要求为回环速率/条数提供来源、否则不要断言。数字确实随日志丢失，因此**保留结论、删除数字**（§8.1.4 现在只陈述「是正反馈，且很快就明显」），并把「未测量」写进正文，而不是继续引用不可核验的数字。
