# Skill：新增一种 Artifact 类型

> **目的**:让产物面板支持一种新产物 kind(如**激活已存在但「死」的 `diff`**,或新增图表 / 表格)。
> **契约文档**:`specs/04-artifacts.md`。
> *行号基线:commit `b60c4f8`。对不上时按符号名搜索。*

---

## 何时用 / 何时不用

- ✅ 产物面板要渲染 / 创建一种新形态的产物。
- ❌ 只是某 kind 的渲染细节调整——直接改对应 `*View` 组件。
- 💡 **本指南用「激活 `diff`」当贯穿范例**:`diff` 已在类型联合里,但 write 工具 enum 不认它、渲染器只显「开发中」,是个现成的「死类型」——正好演示从类型到落地的全链路。

---

## 前置阅读

1. `specs/04-artifacts.md` —— 产物类型、存储策略、渲染契约、版本链。
2. `src/shared/types.ts` —— `ArtifactType`(`:36`)、`ArtifactContent` 联合(`:38-68`)、`DiffHunk`(`:70-76`)。
3. `src/server/tools/write-artifact.ts` —— LLM 创建产物的唯一入口(zod + 规整)。
4. `src/components/artifact-preview-panel.tsx` —— 渲染分发 + 版本切换 + iframe 沙箱。

---

## 核心心智模型

> **加一个 artifact kind = 扩类型联合 + 放开 write 工具(zod enum + JSON Schema + 规整分支)+ 加渲染 case/组件 + 加图标。DB 与 service 层不用动。**

- `content` 是单个 JSON 列存的 tagged union,`artifact-service.ts` 把 `type` 当**不透明 string**(`:16/39`)——**新增 kind 不需要 migration**,list/delete 照常可用。
- **只有 `write_artifact` 工具能插入 `artifacts` 表**(spec 04:15);adapter / 前端不得直接写。
- **产物独立于 Message**(CLAUDE.md §3.5):message 只持 `artifact_ref` part 引用 `artifactId`,产物内容不内联。新 kind 在消息链路上**什么都不用加**。

---

## 步骤

以**激活 `diff`** 为例(新增全新 kind 同理,把 `diff` 换成你的名字、补一支联合即可)。

### 1. 类型联合(`diff` 已存在,新 kind 才加)

`src/shared/types.ts:36`:

```ts
export type ArtifactType = 'web_app' | 'code_file' | 'diff' | 'document' | 'image'
```

`ArtifactContent` 联合(`:38-68`)里 `diff` 成员已在(`:51-56`),配 `DiffHunk`(`:70-76`):

```ts
  | { type: 'diff'; targetArtifactId: string; hunks: DiffHunk[]; applied: boolean }
```

> 新增**全新** kind 时:这里加字符串字面量 + 加一支 `{ type:'xxx'; ... }` content 成员。

### 2. 放开 write 工具(3 处)

`src/server/tools/write-artifact.ts`:

1. zod enum(`:24`):`z.enum(['web_app', 'document', 'image'])` → 加 `'diff'`。
2. LLM 可见的 JSON Schema enum + 描述(`:39-43`)→ 加 `'diff'` 并说明它的 `content` 形状。
3. `content` 描述(`:45-49`)→ 补新形状说明。
4. `buildArtifactContent`(`:107-201`)里加一支 `if (type === 'diff') { … }`,把 LLM 给的原始 `content` 规整成 `{ type:'diff', targetArtifactId, hunks, applied:false }`,**坏输入返回 `null`**(→ 工具回 `{ok:false,error:'Invalid content for type diff'}`,`:65-67`)。

抄 `document` 分支(`:165-182`,容错接受 `{content}`/`{markdown}`/`{text}`/裸串)的写法。

### 3. 加渲染 case + 组件

`src/components/artifact-preview-panel.tsx`,`ArtifactView` 的 `switch (content.type)`(`:167-184`)。把现有 `diff` 占位(`:176-181`,「Diff 视图开发中」)替换为:

```tsx
case 'diff':
  return wrap(<DiffView content={content} />)
```

再写 `DiffView`——`content` 已被判别式收窄为 diff 成员,可直接读 `content.hunks` 等。最简模板抄 `DocumentView`(`:245-257`,`<ScrollArea>` 包 `<Markdown>`);图片类非文本抄 `ImageView`(`:260-271`)。

> `wrap(...)`(`:156-165`)给内容加 `data-selection-target` 标记供选区改写用;文本类(web_app/document/code_file)都 wrap,image 不 wrap。新视图是文本就 wrap。
> `switch` 有 `default`(`:182-183`「该类型暂不支持预览」),所以**漏加 case 不会编译报错,只会静默落到兜底**——手动确认加了。

### 4. 加头部图标

`TypeIcon`(`:332-336`)加一支,让面板标题栏显对应图标。

### 5. 同步 spec

`specs/04-artifacts.md`:类型表(`:19-30`)、存储策略(`:34-42`)、MVP 接受类型说明(`:48`)、引用的 zod schema 块(`:50-57`)、渲染契约(`:149-171`)。

---

## 版本链(diff 范例的关键背景)

diff「比较两个版本」依赖现成的版本链机制:

- **写**:`write-artifact.ts:69-95` —— 传 `parentArtifactId` 则 `version = parent.version + 1` 并链接(新版本是**新行新 id**,非原地更新);断言同会话(`:78`)。
- **读**:`GET /api/artifacts/:id/versions`(`src/app/api/artifacts/[id]/versions/route.ts:16-57`)—— 先沿 `parentArtifactId` 爬到根(`:19-36`,带 `climbed` set 防环),再 BFS 向下收全部后代(`:38-53`),按 `version` 升序(`:55`)。客户端 `fetchArtifactVersions`(`src/lib/api.ts:473-477`)。
- **UI**:`ArtifactPreviewPanel` 在 `id` 变化时拉版本(`:33-53`),`versions.length > 1` 显历史按钮(`:81-90`),版本切换条在 `:106-144`。

所以 `DiffView` 要做「版本间 diff」时,`content.targetArtifactId` 指向要对比的那一版,版本 API 已把整条链给你,可在前端解析。

---

## 常见坑

1. **iframe 沙箱是硬安全契约**(CLAUDE.md §5.1、spec 04:234):LLM 生成的 HTML 在 `artifact-preview-panel.tsx:228` 以 `sandbox="allow-scripts"` 渲染,**绝不给 `allow-same-origin`**。HTML 由 `buildIframeHtml(files, entry)`(`:339-370`)拼装(把 `style.css` 注入 `</head>`、`script.js` 包进 IIFE 放 `</body>` 前,注意 `:345-348` 的 `JSON.stringify`+split 技巧防 `</script>` 提前闭合)。**任何渲染不可信 HTML/JS 的新 kind 必须复用这个沙箱**,不得加 `allow-same-origin`。

2. **markdown 关掉原生 HTML** 防 XSS(spec 04:235)。新 kind 若渲染 markdown,沿用同规则。

3. **`switch` 漏 case 是静默 bug**:`ArtifactView` 有 `default`(`:182-183`),加了联合成员 TS **不会**报错,会静默落到「该类型暂不支持预览」。手动确认渲染 case 加了。

4. **创建入口唯一**:产物只能由 `write_artifact` 工具插入。别在 adapter / 前端直接写表(spec 04:15)。新 kind 在消息链路上不用加东西——adapter 在 `tool.result` 后发 `artifact.create`,Runner 注入 `artifact_ref` part(`write-artifact.ts:18-20`、spec 04:121-129)。

5. **无 DB migration**:`content` 是单 JSON 列存 tagged union,`type` string 列只存判别式。新 content 形状不用动 schema(spec 04:14、66-76)。

---

## 提交自检(对齐 CLAUDE.md §6.5)

- [ ] `pnpm typecheck` / `pnpm lint` 过
- [ ] write 工具 3 处(zod enum / JSON Schema enum / `buildArtifactContent` 分支)都改了,坏输入回 `null`
- [ ] `ArtifactView` 加了渲染 case(确认没静默落到兜底)+ `TypeIcon` 加了图标
- [ ] 渲染不可信 HTML 的复用了 `sandbox="allow-scripts"` iframe,没加 `allow-same-origin`
- [ ] 没直接写 `artifacts` 表(只经 `write_artifact`)
- [ ] `specs/04` 已同步
