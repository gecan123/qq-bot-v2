# Luna 易落地愿望清单设计

## 目标

先完成愿望清单里风险最低、收益直接的四项：

- 生图质量可调。
- 并行生图。
- 梦境日记持续写。
- 表情包库扩充。

本轮只改 bot/backend 工具和最小相关文档，不引入 admin WebUI，不改变 `AgentContext` replay 模型，不把大块图片、日记或表情列表塞进常驻 prompt。

## 非目标

- 不做语音/音乐出站。
- 不做 GIF/动图生成。
- 不做外部站点或管理后台。
- 不重构媒体存储模型或工具执行框架。

## 方案总览

推荐把四项做成一组工具层增强，继续沿用现有渐进式披露模型：

- `generate_image` 增加质量、批量输出和多源图输入。
- `write_journal` 增加读取和搜索动作，让日记/梦境可回顾。
- `collect_sticker` 扩展为表情池工具，支持收藏、列表、搜索和随机推荐。

这些能力都通过工具结果按需进入 LLM ledger。数据库表和 `OutboundCache` 继续作为事实存储或短期图片字节缓存，不能反向重建 prompt history。

## 图片生成

`generate_image` 保持单一工具入口，schema 增加：

- `quality?: "low" | "medium" | "high"`，默认 `medium`，透传给底层图片生成 API。
- `count?: number`，范围 `1..4`，默认 `1`。
- `images?: ImageHandle[]`，最多 5 张。

行为：

- 不传 `images`：从零生成。
- 传 1 张图：按当前编辑语义处理。
- 传 2 到 5 张图：按多图参考/合成处理。工具描述提醒 Luna 明确说明要保留的主体、布局、风格和合成目标。
- 输出 `count` 张图。每张图独立写入 `OutboundCache`，拥有自己的 `ephemeralRef`、`dataHash`、大小、content type 和描述。
- 任务仍走 `BackgroundTaskRegistry`。`background_task get` 返回批量结果，并尽量携带预览图；预览过多时可以只返回文本元数据，避免 context 过大。

底层：

- `src/llm/image-gen.ts` 的 `generateImage` 接收 quality。
- `editImage` 从单个 `Buffer` 改为 `Buffer[]`，调用 images edit 时传多文件数组。
- 单图编辑只是多图数组长度为 1 的特例。

错误处理：

- 任一输入图片 handle 解析失败时，任务不启动，直接返回错误。
- 批量输出中单张失败时，记录失败项；如果全部失败，任务失败。
- `quality` 和 `count` 使用 schema 上限保护成本与上下文体积。

## 日记与梦境

保留现有 `write_journal` 名称，扩展为 discriminated union：

- `action="write"`：写 `kind: diary|dream` 和 `content`，兼容现有语义。
- `action="list"`：按 `kind` 和 `limit` 返回最近条目。
- `action="search"`：按关键词和可选 `kind` 搜索。

输出只返回短列表：`id`、`kind`、时间和截断内容。完整内容不自动注入常驻 prompt；需要更长内容时再做分页或读取动作。

成功标准：

- Luna 空闲时可以继续写梦境/日记。
- 需要回顾时可以查最近条目或关键词，而不是只写不可读。

## 表情包池

保留 `collect_sticker` 名称，但扩展动作：

- `action="collect"`：现有收藏逻辑，参数保持 `image/name/tags/description`。
- `action="list"`：按使用次数和创建时间返回表情摘要。
- `action="search"`：按名称、标签或描述关键词搜索。
- `action="random"`：按可选标签随机返回若干个候选。

输出包含可直接发图的引用：

- `mediaRef: "media:<id>"`
- `name`
- `tags`
- `description`
- `useCount`

发送图片成功后的 `useCount` 和 `lastUsedAt` 递增逻辑继续复用现有 `send_message` 行为。

## 数据流

图片生成：

1. LLM 调 `generate_image`。
2. 工具解析可选 `ImageHandle[]`。
3. 注册后台任务。
4. 图片 API 生成或编辑图片。
5. 每张结果写入 `OutboundCache`。
6. 后台任务完成事件进入 `AgentContext`。
7. LLM 用 `background_task get` 取 `ephemeralRef`，再用 `send_message` 发送。

日记：

1. LLM 调 `write_journal action=write/list/search`。
2. 工具读写 `JournalEntry`。
3. 工具结果返回短文本，不自动改写历史前缀。

表情：

1. LLM 调 `collect_sticker action=collect/search/list/random`。
2. 工具读写 `StickerPool` 和 `Media`。
3. 工具返回 `media:<id>`。
4. LLM 调 `send_message` 发图。

## 测试

最小测试范围：

- `generate_image`：
  - 默认 quality 为 `medium`。
  - 指定 `low/high` 会透传到底层。
  - `count` 上限为 4。
  - `images` 上限为 5。
  - 多图输入会调用 edit 路径。
  - 批量结果每张都有独立 `ephemeralRef`。
- `write_journal`：
  - `write` 写入 diary/dream。
  - `list` 限制条数并按时间倒序。
  - `search` 做关键词过滤。
- `collect_sticker`：
  - `collect` 保持现有 upsert 行为。
  - `list/search/random` 返回 `media:<id>`。

验证命令：

- focused tests：相关 `*.test.ts`。
- `pnpm repo-check`。
- 影响工具 schema 和 TypeScript 类型时跑 `pnpm typecheck`。

## 交付顺序

1. 扩展图片生成底层和 `generate_image` 工具。
2. 扩展 `write_journal`。
3. 扩展 `collect_sticker`。
4. 更新 `docs/TOOLS.md` 的能力描述。
5. 跑 focused tests、`pnpm typecheck` 和 `pnpm repo-check`。
