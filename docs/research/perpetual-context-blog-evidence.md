# 《十几亿 Token：永续上下文的普通一天》事实核对底稿

> 核对时间：2026-08-29（Asia/Singapore）
> 用途：给博客正文提供可引用事实、适用边界和安全表述。本文不是正文，不代表任何厂商价格在未来保持不变。

## 先给结论

这篇博客最有力量、同时也最经得起追问的说法是：

> 在我实际使用的 Claude Code 订阅线路和 LongCat 试用/特定额度线路里，缓存命中没有形成与账面 Token 等量的新增成本；因此，一天流经模型的上下文可以非常大。但这是具体线路和具体时期的实测，不是所有模型 API 的通用定价。

需要做五个事实修正：

1. **Claude Code 订阅的官方口径是“套餐内使用不按 Token 另行计费”，不是官方明确宣称“cache read 不占套餐额度”。** Anthropic 官方已经确认：订阅套餐内的 Claude Code 主会话默认申请 1 小时缓存，较长 TTL 不产生额外按 Token 费用；超出套餐后若使用 usage credits，则会开始计费，并自动回落到 5 分钟 TTL。至于 cache read 是否完全不消耗内部套餐额度，公开证据仍主要来自 she-llac 的非官方逆向。
2. **LongCat 当前按量 API 的缓存输入不是免费。** 当前官网限时价是未缓存输入 ¥2/百万 Token、缓存输入 ¥0.04/百万 Token；缓存价约为未缓存价的 2%。“LongCat 缓存免费”只能写成某一试用期、资源包、活动额度或用户实际线路的历史事实，不能写成当前全平台规则。
3. **“一天十几亿 Token”要称为上下文流量或账面 Token，不应直接称为新增计算量、训练量或账单。** 缓存 Token 仍计入模型上下文窗口，也可能计入服务商使用量，只是现金价格或套餐扣量方式可能大幅不同。
4. **长窗口不等于无损记忆。** 当前优秀模型已经能在 50 万到 100 万 Token 区间保持相当强的检索能力，但公开基准仍显示随长度增加而明显退化；“能放进去”与“总能准确用出来”不是同一件事。
5. **OpenClaw 不能被描述成每次按需唤醒就失忆。** 当前 OpenClaw 已有 rolling main session、持久 transcript、compaction、长期 Memory、Prompt Cache 和 heartbeat keep-warm。博客与它的区别应放在“永续是否成为核心产品契约、怎样验证经验真的改变下一次行为”，而不是声称它没有这些基础能力。

## 一、本仓库能直接证明什么

### 1. Token 日志的字段口径

本仓库 Claude-compatible adapter 把一次 provider usage 记成：

```text
inputTokens = input_tokens
            + cache_read_input_tokens
            + cache_creation_input_tokens

cachedTokens = cache_read_input_tokens
```

代码依据：

- [`src/agent/claude-code/llm-client.ts`](../../src/agent/claude-code/llm-client.ts) 第 497—503 行计算 `inputTokens`，第 518—521 行映射 `cachedTokens`。
- [`src/agent/token-stats.ts`](../../src/agent/token-stats.ts) 第 45—79 行把 usage 追加到 `logs/token-usage.ndjson`，并以 `cachedTokens / inputTokens` 计算 cache hit rate。

因此，日志中的 `inputTokens` 是**包含缓存读取和缓存写入的总输入流量**，不能直接当作未缓存 Token 或现金成本。

### 2. 一个可复核的真实日切片

对本地 `logs/token-usage.ndjson` 做如下过滤：

```text
日期：2026-08-26
provider：claude-code
model：LongCat-2.0
status：succeeded
durationMs > 0
```

得到的本地快照是：

| 指标 | 数值 |
| --- | ---: |
| 调用数 | 2,042 |
| 总输入流量 | 475,865,391 tokens |
| 缓存读取 | 472,423,296 tokens |
| 未命中部分（总输入减缓存读取） | 3,442,095 tokens |
| 输出 | 571,551 tokens |
| 缓存读取占总输入 | 99.2767% |
| 日志覆盖时段 | 13:42:36—23:59:05（UTC+8） |

该切片中最大的一次调用为：

| 指标 | 数值 |
| --- | ---: |
| 总输入 | 610,435 tokens |
| 缓存读取 | 609,664 tokens |
| 总输入减缓存读取 | 771 tokens |
| 输出 | 236 tokens |
| 缓存读取占总输入 | 99.8737% |

这足以支持以下表述：

> 在一段真实日常运行记录里，Agent 半天多就产生了约 4.76 亿输入 Token 的上下文流量，其中约 99.28% 是缓存读取；单次请求也曾达到 61 万输入、99.87% 缓存命中。

但它**不能独立证明**：

- 一整天确实超过十几亿 Token；
- 这些缓存读取在 LongCat 账单或资源额度中完全不扣量；
- 所有行都来自同一个用户可见工作负载，而没有任何内部维护调用；
- “459,222 输入、458,880 cached”这一组具体数字。当前仓库日志中没有找到这两个精确值。

博客若使用“一天十几亿 Token”的截图，应把截图本身作为第一方证据，并在图注标明日期、统计面板、输入/输出/cache 的口径和是否跨模型汇总。不要用当前仓库日志替代那张截图的证明责任。

### 3. 为什么不能直接汇总整个日志文件

`logs/token-usage.ndjson` 同时包含 `mock`、`unknown`、`text-only` 等测试或诊断行；部分测试数据故意写入几十万甚至百万级 Token。直接对文件所有行求和会夸大真实用量。至少要过滤真实 provider、真实 model、成功状态和非零耗时，并在分享里说明统计规则。

## 二、Claude Code 与 Anthropic

### 已确认的官方事实

- Claude API Prompt Cache 有 5 分钟和 1 小时两种 TTL。API 按量计费时，5 分钟 cache write 是普通输入的 1.25 倍，1 小时 cache write 是 2 倍，cache hit/read 是普通输入的 0.1 倍。[Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- 每次命中会刷新缓存计时；保持相同前缀并在 TTL 内继续请求，可以让缓存持续温热。[Claude Code Prompt Caching](https://code.claude.com/docs/en/prompt-caching)
- 在 Claude Pro/Max 等订阅的套餐内使用中，Claude Code 主会话默认申请 1 小时 TTL。官方表述是使用量包含在套餐中，较长 TTL 不会带来额外按 Token 费用。超出套餐、开始使用 usage credits 后，会产生费用并默认改回 5 分钟 TTL。[Claude Code Prompt Caching](https://code.claude.com/docs/en/prompt-caching)
- 模型、system prompt、工具定义和项目上下文等稳定前缀发生变化会造成部分或全部 cache miss；不同模型拥有不同缓存链路。Claude Code 当前还说明，同一机器与目录更容易共享前缀，而不同 worktree 因 cwd 等信息不同会错失缓存。[Claude Code Prompt Caching](https://code.claude.com/docs/en/prompt-caching)

### “cache read 完全免费”的证据等级

she-llac 在 2026-01-25 发布的逆向分析根据 Claude 订阅 usage endpoint/SSE 浮点变化推导套餐内部额度，结论是 cache read 不消耗其推导出的订阅 credits；它还展示了 warm-cache 场景只计算新增输入和输出的测算。[suspiciously precise floats, or, how I got Claude's real limits](https://she-llac.com/claude-limits)

这是一项有方法、有数据的**非官方逆向观察**，但不是 Anthropic 的计费承诺。推荐写法：

> Anthropic 官方已经确认，Claude Code 在订阅套餐内不会按 API Token 价格另行收取缓存费用；一份针对订阅限额的非官方逆向还观察到，cache read 不消耗其推导出的内部 credits。后者不是官方保证，策略随时可能变化。

不推荐写法：

> Claude 的缓存永远免费。

### 主动保温是否成立

成立，但要满足三个条件：

1. 请求必须命中同一个稳定前缀；
2. 保温请求必须发生在 TTL 过期之前；
3. 临时消息应放在稳定缓存边界之后，不能改动前面的 system、tools 或历史。

Claude Code 官方说明命中会刷新计时，`/rewind` 回到仍然温热的旧前缀也能再次命中。OpenClaw 也已经把 heartbeat keep-warm 作为显式用法。因此“在尾部追加一句极短消息，下一轮不再携带这句，但继续复用它之前的稳定前缀”在原理上成立。

更稳妥的实现语义是：

```text
正式历史 P：持久、append-only
保温请求：P + 临时尾部 H
下一次工作：P + 新任务 N
```

`H` 属于 provider-only 的运行控制，不应先写进正式历史再删除。否则会破坏可审计 replay，并可能改变模型看到的故事。保温也不是绝对零成本：它仍占一次请求，带来少量新增输入、可能的输出、速率限制和套餐使用量。

## 三、OpenAI

以下数字只针对当前 GPT-5.6 Sol，不能外推到所有 OpenAI 模型：

| 项目 | 当前官方值 |
| --- | ---: |
| Context window | 1,050,000 tokens |
| 普通输入 | $4.00 / 1M tokens |
| Cached input | $0.40 / 1M tokens |
| Cache write | 普通输入的 1.25 倍 |
| 超过 272K 输入 | 整个请求 input 2 倍、output 1.5 倍定价 |

来源：[GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol)。GPT-5.6 于 2026-07-09 发布，价格在 2026-08-21 有更新。[GPT-5.6 release](https://openai.com/index/gpt-5-6/)

GPT-5.6 支持显式 Prompt Cache breakpoint；当前 Responses API reference 给出的 `prompt_cache_options.ttl` 默认是 30 分钟，且页面称目前只支持该值。每次请求最多可写四个显式 breakpoint，匹配时会考虑最近的 breakpoint。[Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)

适用边界：OpenAI 的 cached input 当前是普通输入的 10%，不是免费；cache write 还可能更贵。因此 keep-warm 是否省钱必须比较“保温调用成本”和“下次冷启动重写成本”，不能无条件开启。

## 四、Gemini

以稳定、仍在官方价格页列出的 Gemini 2.5 Flash 为例：

| 项目 | 当前官方值 |
| --- | ---: |
| Context window | 1M tokens |
| 普通文本/图片/视频输入 | $0.30 / 1M tokens |
| Context caching | $0.03 / 1M tokens |
| 显式缓存存储 | $1.00 / 1M tokens / hour |

来源：[Gemini API Pricing](https://ai.google.dev/gemini-api/docs/pricing)。

Gemini 2.5 及更新模型默认支持 implicit caching。当前 Interactions API 页面说明它会把命中带来的节省传递给用户，但命中本身依赖相似前缀和较短时间间隔，不能当作持久状态保证；Interactions API 目前也不支持显式缓存对象。[Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching)

如果使用 GenerateContent API，则可以创建可引用的 explicit cache 并自行设置 TTL；该接口的显式缓存默认 TTL 是 1 小时，同时收缓存 Token 的折扣价和按时间计算的存储费。[Gemini GenerateContent Explicit Caching](https://ai.google.dev/gemini-api/docs/generate-content/caching)

适用边界：Gemini 免费层的普通输入可以免费，但 Gemini 2.5 Flash 的显式 Context Caching 在免费层标为不可用。因此不能把“Gemini 免费层免费”和“Gemini cache read 免费”混为一谈。

## 五、LongCat

### 当前官方状态

LongCat-2.0 当前官方规格是 1M context window、最大 128K 输出。[LongCat Quick Start](https://longcat.chat/platform/docs/zh/)

当前按量价格为：

| 项目 | 原价 / 1M | 限时价 / 1M |
| --- | ---: | ---: |
| 未命中缓存输入 | ¥5 | ¥2 |
| 命中缓存输入 | ¥0.10 | ¥0.04 |
| 输出 | ¥20 | ¥8 |

来源：[LongCat-2.0 Pricing](https://longcat.chat/platform/docs/zh/pricing/long-cat-2.0)。官网明确提示最终价格以结算记录为准。

LongCat-2.0-Preview 在 2026-04-20 上线时提供每天 500 万 Token 的初始试用额度，反馈可刷新额度，官方写明单日最高可到 1.2 亿；2026-06-30 LongCat-2.0 正式发布并启用 Token 资源包和 API 按量付费。[LongCat Change Log](https://longcat.chat/platform/docs/zh/ChangeLog.html)

### 怎样讲“LongCat 缓存免费”才准确

本地 2026-08-26 数据记录了 4.76 亿输入流量，其中 4.72 亿是 cache read，而未命中部分加输出约 401 万 Token。这与“高缓存命中让有限试用额度支撑远大于额度数字的账面流量”相容，但本地日志没有 LongCat 结算明细，不能单凭 usage 日志证明平台没有扣 cache read。

推荐写法：

> 在我实际使用的 LongCat 试用/额度线路里，缓存读取没有形成可见的新增扣费或等量额度消耗，因此有限额度支撑了数亿乃至更大的账面上下文流量。当前 LongCat-2.0 按量 API 已经对缓存输入定价，所以这是我的具体线路和时期，不是现在所有账户的统一规则。

若用户截图能同时显示 cached tokens 与剩余额度/账单变化，应把它作为此结论的直接第一方证据。

## 六、OpenClaw 已经具备哪些能力

根据当前官方文档，OpenClaw 已具备：

- 一个跨多个客户端继续使用的 rolling main session；默认没有自动 reset；[The main session](https://docs.openclaw.ai/concepts/main-session)
- 持久 transcript；接近窗口上限时 compaction，把旧对话压缩成持久 summary，同时完整历史仍保存在 session store；[Compaction](https://docs.openclaw.ai/compaction)
- `MEMORY.md`、每日 notes、搜索召回和 compaction 前 memory flush；[Memory overview](https://docs.openclaw.ai/concepts/memory)
- 针对 Anthropic/OpenAI/Gemini 等 provider 的 Prompt Cache 配置、稳定 prefix/易变 suffix 边界和 cache usage 观测；[Prompt caching](https://docs.openclaw.ai/reference/prompt-caching)
- 用 heartbeat 在 TTL 过期前 keep warm；官方同时建议只给确实受益的 Agent 开启，因为 heartbeat 自身会触发模型轮次。[Prompt caching](https://docs.openclaw.ai/reference/prompt-caching)、[Heartbeat](https://docs.openclaw.ai/heartbeat)

因此博客开头可以简短回答：

> 我当然可以直接使用 OpenClaw，很多场景也应该这么做。按需唤醒决定的是 Agent 什么时候工作；我想讨论的“永续”则是另一层问题：怎样把连续经历作为核心产品契约，怎样让它低成本维持，又怎样证明这些经历真的改变了下一次行动。

不应声称：

- OpenClaw 按需启动后一定清空上下文；
- OpenClaw 没有长期记忆、compaction 或 heartbeat；
- heartbeat 代表模型在间隔期间持续思考。

### 一个需要现场验证的版本差异

OpenClaw 当前文档仍写到为 OpenAI 发送 `prompt_cache_retention: "24h"`；OpenAI 当前 GPT-5.6 API reference 已把旧字段标为 deprecated，并改用 `prompt_cache_options.ttl`，当前值为 `30m`。因此若博客演示 OpenClaw + OpenAI 的长缓存，必须以实际请求和 usage 命中为准，不能仅靠配置名推断 24 小时缓存仍生效。

## 七、长上下文的能力与限制

### 趋势有依据

- GPT-5.6 Sol 当前窗口为 1.05M；LongCat-2.0、多个 Claude 新模型和多款 Gemini 模型也达到约 1M。
- GPT-5.6 官方长上下文基准中，Sol 在 MRCR v2 8-needle 的 256K—512K 区间为 91.5%，512K—1M 区间为 73.8%；GraphWalks BFS F1 从 256K 的 90.7% 降至 1M 的 77.1%。[GPT-5.6 release](https://openai.com/index/gpt-5-6/)

这组数据同时支持两个结论：

1. 好模型确实已经能在数十万乃至百万 Token 中利用很早的信息；
2. 能力并不完美，长度增加后仍有明显退化。

Anthropic 官方把 context window 称为模型的 working memory，并明确说明更多上下文不自动意味着更好，准确率和召回会随 Token 增加而下降；其工程文章建议把上下文视为有限、边际收益递减的资源。[Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)、[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

推荐写法：

> 上下文窗口正在快速逼近百万 Token，而且好模型已经能在 50 万甚至更长的上下文里找回开头的重要信息。但这不是无损记忆：公开基准仍然显示，越接近窗口上限，准确率越容易下降。

不推荐写法：

> 60 万 Token 以后模型仍然不会忘记开头。

## 八、短期 Context、Prompt Cache 与长期 Memory 的合理边界

三者不是替代关系：

| 层 | 保存什么 | 解决什么 | 不应该承担什么 |
| --- | --- | --- | --- |
| 当前 Context | 当前目标、对话顺序、临时假设、工具调用及结果、刚发生的纠正 | 保留高保真的工作现场和因果链 | 无限增长、充当跨项目知识库 |
| Prompt Cache | provider 已计算过的稳定前缀 | 降低重复处理 Context 的成本和延迟 | 持久化、事实来源、长期记忆 |
| 长期 Memory | 稳定事实、偏好、经过验证的经验、跨任务仍有价值的策略 | 跨 session 召回与经验积累 | 保存整段原始 transcript、替代当前现场 |
| Notebook/过程状态 | 仍在演进的研究、项目材料和阶段进度 | 跨天延续尚未稳定的过程 | 冒充已经确认的长期知识 |

本仓库的产品契约进一步要求：

- [`docs/AGENT_CONTEXT.md`](../AGENT_CONTEXT.md) 把 canonical ledger 定义为唯一持久 LLM history source；Prompt Cache 只是 provider-only 性能路径，cache miss 不得改变 replay 语义。
- [`docs/MEMORY_ARCHITECTURE.md`](../MEMORY_ARCHITECTURE.md) 把稳定事实、偏好、规则和经验交给 Memory，把仍会增长的跨天材料交给 Notebook；只有显式 recall 的结果进入 canonical context，不能用 side memory 静默重建历史。

合理的循环是：

```text
长期 Memory / Notebook
        ↓ 按需召回
当前 Context（高保真现场）
        ↓ 行动、结果、反馈
复盘、筛选、纠错
        ↓
写回长期 Memory 或继续留在 Notebook
```

Prompt Cache 在这个循环外侧，负责让当前 Context 的重复读取更便宜。它不会自动把历史变成经验。只有当反馈被提炼、纠错，并在下一次行动中改变选择时，才能说 Agent 发生了学习或成长。

一句适合正文的总结：

> Cache 让短期现场养得起，Context 让 Agent 接得上，Memory 让重要经验留得住；反馈闭环才让这些记忆改变下一次行动。

## 九、博客可以直接采用的事实表述

### 开场数字

> 一天十几亿 Token，但这只是永续上下文的普通一天。这里的“十几亿”是流经模型的上下文总量，其中绝大部分是同一段稳定历史的缓存复用，不是十几亿 Token 的全新内容，也不等于十几亿 Token 的普通输入账单。

前提：十几亿数字必须由用户原始截图或导出记录支撑，并注明统计口径。

### Cache 的价值

> 过去，每一轮都要重新为模型理解全部历史付费；当缓存命中免费或只有普通输入的一小部分价格时，成本开始主要跟新增尾部有关，而不是跟全部过去一起增长。

### 主动保温

> 对长上下文 Agent 来说，有时什么都不做反而更贵：在缓存过期前发起一次极小的 keep-warm 请求，可能比下一次重建几十万 Token 的冷缓存更划算。但它只有在前缀稳定、下一次使用概率足够高时才成立。

### 永续的定义

> 永续的不是进程，也不是要求模型二十四小时不断推理；永续的是一条可以休眠、恢复、压缩、召回和纠错的经历。

### 长短期记忆

> Context 保留现场，Memory 保存穿过现场之后仍然有价值的东西。只有 Context，历史最终会膨胀；只有 Memory，提炼和检索又会丢失过程。二者结合，才同时拥有连续性和可持续性。

### 最后的主张

> 免费或极低价的 Cache 让 Agent 养得起一段连续经历；长短期记忆让这段经历既接得上，也走得远；反馈和迭代才让经历真正变成能力。

## 十、来源登记

| 来源 | 类型 | 发布/更新时间 | 访问时间 | 本文使用范围 |
| --- | --- | --- | --- | --- |
| [Claude Code Prompt Caching](https://code.claude.com/docs/en/prompt-caching) | Anthropic 官方文档 | 持续更新，页面未标单一发布日期 | 2026-08-29 | 订阅 TTL、套餐内计费边界、exact-prefix、失效条件 |
| [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing) | Anthropic 官方文档 | 持续更新 | 2026-08-29 | API cache write/read 倍率、长上下文价格 |
| [Claude Context Windows](https://platform.claude.com/docs/en/build-with-claude/context-windows) | Anthropic 官方文档 | 持续更新 | 2026-08-29 | working memory、context rot、窗口边界 |
| [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Anthropic 官方工程文章 | 2025-09-29 | 2026-08-29 | 上下文的有限性、compaction/notes/just-in-time recall |
| [she-llac Claude limits](https://she-llac.com/claude-limits) | 非官方逆向分析 | 2026-01-25 | 2026-08-29 | 订阅 cache read 不消耗逆向推导 credits；不得作为官方承诺 |
| [GPT-5.6 model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol) | OpenAI 官方模型页 | 持续更新；当前价格至少有效至 2026-11-21 | 2026-08-29 | 1.05M 窗口、价格、长输入加价 |
| [GPT-5.6 release](https://openai.com/index/gpt-5-6/) | OpenAI 官方发布 | 2026-07-09；2026-08-21 更新价格 | 2026-08-29 | 长上下文基准与趋势 |
| [Responses API create](https://developers.openai.com/api/reference/resources/responses/methods/create) | OpenAI 官方 API reference | 持续更新 | 2026-08-29 | 显式 breakpoint、30m TTL、旧字段弃用 |
| [Gemini API Pricing](https://ai.google.dev/gemini-api/docs/pricing) | Google 官方文档 | 持续更新 | 2026-08-29 | Gemini 2.5 Flash 价格和 1M 窗口 |
| [Gemini Context Caching](https://ai.google.dev/gemini-api/docs/caching) | Google 官方文档 | 2026-08-13 更新 | 2026-08-29 | Interactions API implicit cache、命中条件 |
| [Gemini GenerateContent Explicit Caching](https://ai.google.dev/gemini-api/docs/generate-content/caching) | Google 官方文档 | 持续更新 | 2026-08-29 | explicit cache、TTL、存储费 |
| [LongCat-2.0 Pricing](https://longcat.chat/platform/docs/zh/pricing/long-cat-2.0) | LongCat 官方文档 | 持续更新 | 2026-08-29 | 当前缓存与未缓存输入价格 |
| [LongCat Change Log](https://longcat.chat/platform/docs/zh/ChangeLog.html) | LongCat 官方文档 | 2026-04-20、2026-06-30 条目 | 2026-08-29 | Preview 额度、正式计费时间 |
| [LongCat Quick Start](https://longcat.chat/platform/docs/zh/) | LongCat 官方文档 | 持续更新 | 2026-08-29 | 1M context、128K output |
| [OpenClaw Prompt Caching](https://docs.openclaw.ai/reference/prompt-caching) | OpenClaw 官方文档 | 持续更新 | 2026-08-29 | cache boundary、heartbeat keep-warm、provider 行为 |
| [OpenClaw Main Session](https://docs.openclaw.ai/concepts/main-session) | OpenClaw 官方文档 | 持续更新 | 2026-08-29 | rolling session、跨客户端连续性、Memory |
| [OpenClaw Memory](https://docs.openclaw.ai/concepts/memory) | OpenClaw 官方文档 | 持续更新 | 2026-08-29 | MEMORY.md、daily notes、召回与 flush |
| [OpenClaw Compaction](https://docs.openclaw.ai/compaction) | OpenClaw 官方文档 | 持续更新 | 2026-08-29 | 持久摘要、保留完整 transcript |
| `logs/token-usage.ndjson`（本地、未纳入 Git） | 本仓库本地运行证据 | 2026-08-23—2026-08-29 当前快照 | 2026-08-29 | LongCat 实际流量与 cache hit；不证明账单 |
| [`docs/AGENT_CONTEXT.md`](../AGENT_CONTEXT.md) | 本仓库产品契约 | 当前工作树 | 2026-08-29 | Context/replay/cache 边界 |
| [`docs/MEMORY_ARCHITECTURE.md`](../MEMORY_ARCHITECTURE.md) | 本仓库产品契约 | 当前工作树 | 2026-08-29 | Memory/Notebook/Context 分工 |
