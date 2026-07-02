# Skill：新增一种 MessagePart 类型

> **目的**:让消息能渲染一种新的内容块(如 `deploy_status` 部署状态卡)。
> **契约文档**:`specs/03-message-parts.md`(+ 涉及流式时 `specs/02-stream-events.md`)。
> *行号基线:commit `b60c4f8`。对不上时按符号名搜索。*

---

## 何时用 / 何时不用

- ✅ 要在消息流里展示一种**结构化、可交互、markdown 表达不了**的内容块。
- ❌ **能用 markdown 表达的,不要开新 part 类型**(spec 03:224、230 明确要求先判断必要性)。一段富文本就用 `text` part。
- ⚠️ spec 03 第 3 行写明「**修改 part 类型需先讨论**」——动手前对齐(CLAUDE.md §6.2)。

---

## 前置阅读

1. `specs/03-message-parts.md` —— 8 种现有 part 详解 + 设计原则。
2. `src/shared/types.ts` —— `MessagePart` 联合(`:7-27`)、`PartDelta`(`:30-33`)、`StreamEvent`(`:161-191`)。
3. `src/components/message-parts.tsx` —— 渲染分发(`PartRenderer`)。

---

## 核心心智模型(先懂这个再动手)

> **加一个普通 part 类型 = 扩 1 个联合 + 加 1 个渲染 case + 补 1 个穷尽 switch + 找个生产者 emit。reducer 和持久化通常不用改。**

为什么 reducer/持久化不用改:投递 part 的通道是通用三件套 `part.start / part.delta / part.end`(`shared/types.ts:169-171`),而 `part.start` 的 payload 字段类型就是 `MessagePart`。**你一旦扩了 `MessagePart` 联合,`part.start` 自动能携带新类型**,无需新 StreamEvent 变体,reducer 的 `part.start` 分支也是**泛型**的(下文 §4)。

只有两种情况要多动:
- **新 part 要流式增量** → 要加新 `PartDelta` → 才动 reducer / 持久化的 `part.delta` 分支。
- **新内容要独立生命周期**(不挂在某条 message 的 partIndex 上,像 tool/artifact 那样) → 才仿照 `tool.call`/`artifact.create` 开新 StreamEvent 变体。普通展示型 part **不要**走这条。

⚠️ **关键事实**:`MessagePart` **没有任何 zod 运行时校验**(全 `src/` 搜过)。DB 列是 `text('parts',{mode:'json'}).$type<MessagePart[]>()`(`schema.ts:96`)——JSON 列 + 编译期类型断言。所以**新增 part 类型对旧数据完全向后兼容,不需要 migration**;但也意味着 producer emit 错形状不会被运行时拦截,**producer 端自己保证形状对**。

---

## 步骤

以新增 `deploy_status` part 为例。

### 1. 扩 `MessagePart` 联合

`src/shared/types.ts:7-27`,在结尾 `}` 前追加一支:

```ts
  | {
      type: 'deploy_status'
      url: string
      state: 'building' | 'ready' | 'failed'
    }
```

### 2.(仅流式增量时)扩 `PartDelta`

`src/shared/types.ts:30-33`。**普通卡片不需要**——`deploy_status` 一次性 emit 即可,跳过本步。

### 3. 加渲染 case + 写组件

`src/components/message-parts.tsx`,`PartRenderer` 的 `switch`(`:77-104`),在 `default:` 前(约 `:100`)加:

```tsx
case 'deploy_status':
  return <DeployStatusPart {...part} />
```

`part.type` 在 case 内已被 TS 收窄,可直接解构该变体字段。再写 `DeployStatusPart` 组件:纯展示抄 `CodePart`(`:243-245`);可折叠抄 `ThinkingPart`(`:215-240`);卡片 + 懒加载抄 `ArtifactRefPart`(`:423-491`)。

> `default: return null`(`:101-102`)已满足 spec 02:251「未实现 case 必须静默忽略」——忘了加 case 不会崩,只是不渲染。
> `tool_use`/`tool_result` 是特例(在 `PartList` 里按 `callId` 合并,`:16-75`),普通新 part **不碰 `PartList`**。

### 4. 补穷尽 switch(否则编译失败 / 静默漏判)

`src/stores/app-store.ts` 的 `areMessagePartsEquivalent`(`:764-801`)有个 `switch (a.type)` **没有 `default`**——加了联合分支后 TS 穷尽性检查会**在这里编译报错**,必须补:

```ts
case 'deploy_status':
  return a.url === b.url && a.state === (b as typeof a).state
```

它用于判断「DB 重新加载的 message 是否变了、要不要换引用」(`setMessagesForConversation`,`:217-229`)。漏了会导致刷新后该 part 的更新检测不到。**这是最容易漏的隐藏触点**,好在 TS 会逼你。

### 5.(仅新增了 PartDelta 时)动 reducer + 持久化

只有第 2 步加了新 `PartDelta` 才需要:
- `app-store.ts` 的 `applyEvent` → `part.delta` case(`:572-585`)加 `else if`。
- `agent-runner.ts` 的 `persistEvent` → `part.delta` case(`:789-800`)加同样的 `else if`,否则 delta 被静默丢弃。

### 6. 找个生产者 emit

某个 adapter 或工具处,emit `part.start`(可选 `part.delta` → `part.end`)。样板:`custom-agent-adapter.ts:158-174`(thinking 的 start+delta 配对)、`mock-adapter.ts:44`。producer **自管 `partIndex`**(递增计数器,`custom-agent-adapter.ts:159`),保证同一 message 内单调不冲突。

若新 part 是「由副作用注入、而非 adapter 直接产出」(像 `artifact_ref` 那样由 Runner 在收到 `artifact.create` 后 push),抄 `agent-runner.ts:712-731`。

### 7. 同步 spec

`specs/03-message-parts.md`:类型定义(`:20-32`)、加一节详解、渲染分发表(`:178-187`)、新增步骤(`:222-233`)。若你加了新 StreamEvent 变体或 PartDelta,**还要**改 `specs/02-stream-events.md`(事件全集 `:18-101`)。

---

## 常见坑

1. **Message 是 parts 数组,不是 markdown 字符串**(CLAUDE.md §3.4、spec 03:11)。别把新内容塞进 `text` part 的 markdown 再用正则解析(`message-parts.tsx:139` 的 `splitQuotedSelections` 是历史遗留反面教材,别学)。

2. **三处「静默漏改」**(不会编译报错,要手查):
   - `PartRenderer`(有 `default`)→ 漏了不渲染;
   - reducer/persist 的 `part.delta`(是 `if` 链)→ 漏了丢增量;
   - `extractTextFromParts`(`agent-runner.ts:1345-1360`,有兜底 `return ''`)→ 漏了**该 part 不进下一轮 LLM history**。
   只有 `areMessagePartsEquivalent`(无 default)会编译期提醒你。

3. **历史拼接**:`extractTextFromParts` 决定新 part 在「回传给 LLM 的下一轮 history」里长什么样。当前未知类型 `return ''`(不进 history)。若新 part 含 agent 后续轮次需要的信息,**必须**在这里加分支,否则上下文丢失(spec 03:200-218 有拼接策略表)。

4. **无运行时校验**:MessagePart 不在任何 zod schema 里。安全靠 TS 编译期 + producer 自律。(对比:tool args 执行前**有** zod,那是 tool schema 不是 part schema。)

5. **持久化是即时写,不是 100ms 批量**:`persistEvent` 每个事件即时 `db.update`(`:786/798/810/822`);spec 02:211-221 的「100ms 批量 flush」是目标/伪代码,**与现状不符**。新 part 若走高频 delta,留意这点(指南/PR 里点明)。

---

## 提交自检(对齐 CLAUDE.md §6.5)

- [ ] `pnpm typecheck`(尤其确认 `areMessagePartsEquivalent` 穷尽性通过)/ `pnpm lint` 过
- [ ] `PartRenderer` 加了 case 且组件按现有模式写
- [ ] 三处「静默漏改」点都过了一遍(渲染 / delta / history)
- [ ] 确认是否真需要新 `PartDelta` / 新 StreamEvent 变体(默认都不需要)
- [ ] producer emit 的 part 形状与联合定义一致,`partIndex` 不冲突
- [ ] `specs/03` 已同步;动了事件/delta 的同步了 `specs/02`
- [ ] 没破坏现有事件契约
