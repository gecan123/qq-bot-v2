# OpenClaw、按需唤醒与永续上下文：事实核查笔记

> 调研日期：2026-08-29
> 来源范围：OpenClaw 官方文档与官方 GitHub 仓库。具体字段和默认值变化较快，正式文章应同时注明所使用的 OpenClaw 版本。

## 结论先行

不能把 OpenClaw 描述成“每次按需触发、每次从零开始的普通 Agent”。按当前官方文档，OpenClaw 已经具备：

- 一个默认不自动重置的 rolling main session；
- 持久 session 与 transcript；
- 自动 compaction 和压缩前 memory flush；
- `USER.md`、`MEMORY.md`、daily notes 与按需 memory search；
- Prompt Cache 配置、指标和 cache-TTL pruning；
- heartbeat、cron/automation、消息、webhook 等多种唤醒入口；
- `main`、`current`、persistent named session 与 `isolated` 等不同执行方式。

因此，下面这个对立是错误的：

```text
OpenClaw / 普通 Agent = 按需触发、每次失忆
自研永续 Agent       = 常驻运行、拥有上下文
```

准确的概念拆分应该是：

```text
何时运行：按消息 / 事件 / 定时器唤醒，还是主动循环
用哪段历史：fresh session，还是 persistent session
怎样越过窗口：截断、compaction，还是其他 context engine
怎样积累经验：无长期记忆、通用记忆，还是领域化成长机制
```

这四个维度彼此独立。一个 Agent 完全可以“只在事件到来时运行”，但每次都回到同一个持久上下文；OpenClaw 正是支持这种组合。

最公平、也最适合写进文章的判断是：

> 如果只是想要一个长期在线、能按消息、事件或时间表工作的个人助理，应优先考虑 OpenClaw，而不是从头自研。自研永续 Agent 的价值，不应建立在“OpenClaw 不会记忆”这个错误前提上，而应建立在对经验形成、主动性、状态语义和领域反馈闭环的掌控上。

## 一、OpenClaw 当前到底提供了什么

### 1. Session：默认就是一条持续滚动的主会话

OpenClaw 官方把 main session 描述为个人 Agent 的“一个大脑”：来自不同终端和渠道的直接消息默认汇入同一个 rolling conversation。默认 `session.reset.mode` 是 `none`，也就是不会每天或空闲后自动换 session；当历史接近窗口上限时，由 compaction 管理活动上下文。

来源：

- [The main session](https://docs.openclaw.ai/concepts/main-session)
- [Session management](https://docs.openclaw.ai/session)
- [Session management and compaction deep dive](https://docs.openclaw.ai/reference/session-management-compaction)

官方文档同时说明：

- main session 是普通 session key（默认形如 `agent:<agentId>:main`）上的特殊路由约定；
- session 与 transcript 持久保存在 Gateway 的状态存储中；
- `/new` 或 `/reset` 会产生新的 live session id，但旧 transcript 仍可被搜索；
- group/room 默认隔离，不是所有参与者无条件共享一条历史；
- daily reset 和 idle reset 是可选策略，而不是默认行为。

所以，“OpenClaw 被唤醒时会不会从零开始”取决于它被路由到 `main`、persistent named session，还是 `isolated` session，而不是取决于“进程刚才有没有在推理”。

### 2. Memory：它不只有 session，也已有多层长期记忆

OpenClaw 官方 Memory 文档目前区分：

- `USER.md`：稳定偏好、沟通风格、关系和活跃项目背景；
- `MEMORY.md`：精炼的长期事实、决策和摘要；
- `memory/YYYY-MM-DD.md`：工作层的日记、观察、session 摘要和原始上下文；
- `DREAMS.md`：供人检查的 background consolidation 记录。

其中 `MEMORY.md` 会在新 session 启动时加载；daily notes 主要由 `memory_search` / `memory_get` 按需取回，近期 notes 会在 `/new` 或 `/reset` 后重新提供。官方原文还明确说明：模型只记得被写入磁盘的内容，“没有隐藏状态”。

来源：

- [Memory overview](https://docs.openclaw.ai/concepts/memory)
- [The main session：Memory across resets and conversations](https://docs.openclaw.ai/concepts/main-session#memory-across-resets-and-conversations)

在 compaction 之前，OpenClaw 默认会发起一次静默 memory-flush turn，让 Agent 把重要内容写入长期文件；此外，目前的 memory-core 还提供 scheduled dreaming，对候选记忆打分、晋升、去重和合并。

这意味着“自研可以增加长期记忆”仍然是自研的可扩展点，但不能表述成“OpenClaw 没有长期记忆”。更准确的差异应是：自研是否需要不同于 OpenClaw 通用 Markdown memory 的领域模型、事实来源、晋升规则和纠错机制。

### 3. Compaction：完整 transcript 仍在，但模型不再逐字看见全部历史

OpenClaw 的 compaction 会：

1. 把旧轮次总结成一个持久 compaction entry；
2. 在未来 prompt 中提供 summary；
3. 保留最近一段原始消息；
4. 在选择切点时保持 assistant tool call 与对应 `toolResult` 成对；
5. 在接近窗口上限或 provider 返回 context overflow 时自动运行。

完整历史仍留在 session store，但 compaction 之后，模型看到的是“摘要 + recent tail”，不是全部 transcript 原文。这是必须在文章中讲清楚的边界：

> 持久保存完整历史，不等于每一轮都把完整历史放进模型窗口。

来源：

- [Compaction](https://docs.openclaw.ai/concepts/compaction)
- [Session management and compaction deep dive](https://docs.openclaw.ai/reference/session-management-compaction)

OpenClaw 还支持可插拔 context engine。Context engine 参与 ingest、assemble、compact 和 after-turn 四个生命周期点，可自行持久化状态、维护索引或替换默认上下文装配策略。

来源：[Context engine](https://docs.openclaw.ai/concepts/context-engine)

因此，如果自研方案的卖点是“不会过早压缩”或“有更强的 replay 不变量”，需要具体说明自身 compaction/replay 语义，而不能只说 OpenClaw 是短 session。

### 4. Prompt Cache：OpenClaw 已把它作为一等能力

OpenClaw 官方专门维护了 Prompt Caching 文档，并将其定义为：服务商复用未改变的 prompt prefix，以降低长 session 重复处理的成本和延迟。

当前文档说明：

- OpenAI 直连时会发送稳定的 `prompt_cache_key`；支持时，`cacheRetention: "long"` 可请求更长保留；
- Anthropic `short` / `long` 分别映射到较短和较长 TTL；
- Gemini 可由 OpenClaw 管理 provider-native cached content；
- 统一记录 `cacheRead` / `cacheWrite`；
- 可在 cache TTL 到期后清理旧工具结果，避免重新缓存过大的无效历史；
- heartbeat 可用来 keep warm，但 heartbeat 本身也会触发模型调用并花费 token；
- 更换模型、thinking/reasoning 设置或改变前缀，都可能破坏缓存复用。

来源：

- [Prompt caching](https://docs.openclaw.ai/reference/prompt-caching)
- [Token use and costs](https://docs.openclaw.ai/reference/token-use)

因此，“Cache 会让永续上下文很便宜”可以作为永续上下文的行业趋势，但不能作为“自研相对 OpenClaw 的独有优势”。OpenClaw 自己也在利用同一趋势。

另外，Cache 必须被准确描述：

> Cache 是有 TTL、受 provider 和请求稳定性约束的计算复用，不是持久记忆。Cache 冷掉后，session 并不会消失，只是下一轮需要重新处理或重建缓存前缀。

### 5. Heartbeat：不是一直思考，而是定期触发完整 Agent turn

OpenClaw 官方明确写道：Heartbeat 是 system-owned automation。它默认定期在 main session 中运行一个完整 Agent turn，让模型检查是否有需要主动提醒的内容。

当前行为包括：

- recurring heartbeat 由 Automations scheduler 管理；
- 默认 cadence 通常为 30 分钟；部分 Anthropic 认证方式在未配置时为 1 小时；
- `heartbeat.every: "0m"` 只关闭周期 cadence，manual / event-driven wake 仍可工作；
- 默认使用 main session，也可使用 isolated session；
- `lightContext` 可减少 isolated heartbeat 的 bootstrap context；
- heartbeat 是完整模型轮次，间隔越短，token 消耗越多；
- Gateway / Automations scheduler 必须运行，schedule 才会触发。

来源：[Heartbeat](https://docs.openclaw.ai/gateway/heartbeat)

因此不能说 OpenClaw “只在用户问它时才运行”。它已有主动检查机制；准确的质疑应该是：固定 cadence 的通用检查，是否足以满足某个领域中更细粒度的目标推进与反馈学习。

### 6. Cron / Automations：既支持 fresh run，也支持持续累积的 session

OpenClaw Automations 支持 one-shot、interval、cron、外部 webhook 等触发方式。Agent-turn job 的 session 可以选择：

| session 方式 | 官方语义 | 典型用途 |
| --- | --- | --- |
| `main` | 在 owning agent 的主 session 中处理 system event | 提醒、主线事件 |
| `current` | 使用创建任务时绑定会话的 bounded tail，并把结果提交回该会话 | 与当前讨论相关的后台工作 |
| `session:<id>` | 复用一个 persistent named session | 会跨多次运行积累历史的工作流 |
| `isolated` | 每次运行创建 fresh transcript/session id | 独立报告、后台杂务、不应继承环境权限的任务 |

来源：[Automations](https://docs.openclaw.ai/automation/cron-jobs)

这张表直接证明：“按需唤醒”与“是否保留历史”不是同一个选择。定时任务可以是 isolated，也可以绑定 main 或 named persistent session。

### 7. 消息与 Webhook：外部事件可以唤醒相同的持久历史

OpenClaw 的 HTTP hooks 提供两类关键入口：

- `/hooks/wake`：给 main session 排入一个受信任 system event，并选择立即或等下一个 heartbeat 唤醒；
- `/hooks/agent`：提交完整 Agent turn，默认使用 isolated session，但可显式选择 persistent mode 和稳定 session key。

来源：[Automations：Webhooks](https://docs.openclaw.ai/automation/cron-jobs#webhooks)

所以，用户消息、系统事件、定时器和 webhook 都可以只在需要时启动一次推理，同时恢复既有 session。没有必要为了“保持记忆”让模型 24 小时不停地产生 token。

## 二、真正应该比较的两种运行方式

下面比较的是“持久 session 的按需唤醒”与“围绕同一时间线的主动循环”。这比拿 fresh isolated job 与永续上下文比较更公平。

| 维度 | 持久 session、按需唤醒 | 单一时间线、主动循环式永续 Agent |
| --- | --- | --- |
| 空闲成本 | 无事件时通常没有模型调用 | 若持续检查或自我推进，会产生额外调用 |
| 上下文连续性 | 可以很强；关键是复用同一 session | 通常强；所有轮次天然回到主时间线 |
| Prompt Cache | 高频连续调用可命中；长时间空闲后可能冷掉 | 更容易保持温热，但 keep-warm 也有成本 |
| 主动性 | 依赖消息、webhook、cron、heartbeat 等外部唤醒 | 可在每次行动后自主判断是否继续、等待或改计划 |
| 对环境变化的感知 | 没有事件或定时检查就不知道变化 | 仍需传感器/工具；常驻进程本身不会凭空知道外界变化 |
| 失败隔离 | isolated job 很容易隔离；persistent job 也可受控 | 单主线错误、污染或目标漂移可能持续累积 |
| 人类控制 | 每次触发的边界清楚，易于批准和审计 | 更需要停止条件、权限边界和无进展抑制 |
| 经验积累 | session + memory 足以实现通用积累 | 可把“如何形成经验”做成一等领域状态机 |
| 实现复杂度 | 通用框架已有大量基础设施 | 需要自己承担 replay、调度、记忆、权限和恢复语义 |
| 适合任务 | 助理、提醒、定时报表、事件响应、普通项目协作 | 游戏长期实验、自我驱动研究、持续目标推进、领域化 AI 员工 |

### 持久 session、按需唤醒的优势

- 空闲时不调用模型，成本与副作用更可控；
- 可以同时拥有持续上下文与明确的执行边界；
- isolated session 很适合处理不可信输入或互不相关的后台工作；
- 定时器、消息和 webhook 更容易观测、重试和审计；
- 对绝大多数个人助理和团队工作流来说，已经足够。

### 它的不足

- 如果没有外部事件或定时 wake，Agent 不会自己想起未完成目标；
- session 空闲超过 provider cache TTL 后，下一次可能需要重新写入/计算缓存；
- 通用 heartbeat 只能表达“隔一段时间检查一次”，未必能表达复杂的承诺、策略和进展语义；
- 即使复用 session，compaction 之后模型看到的仍是 summary + tail；
- 通用 memory 能保存事实，但不自动等于领域内的“能力进化”。

### 主动循环式永续 Agent 的优势

- 每个工具结果、环境反馈和失败都可以立即进入同一条时间线；
- 可以在没有新用户消息时，根据未完成目标决定继续、等待、重新规划或主动汇报；
- 更适合研究“模型权重不变，Agent 是否能靠经历提高表现”；
- 可以把目标、承诺、技能、复盘和自我认识设计成显式、可验证的状态；
- 高频连续决策可能获得更稳定的 Prompt Cache 复用。

### 它的代价

- “一直醒着”并不免费：模型轮次、工具调用和 cache keep-warm 都产生费用；
- 连续时间线会累积噪声、错误结论、prompt injection 和过期目标；
- 一个错误的自我目标可能导致长时间无效工作或越权副作用；
- 必须设计可靠的停止、等待、无进展检测、权限和外部副作用边界；
- 仍然绕不过有限窗口，最终仍需 compaction、检索和长期记忆；
- “常驻”通常只是 runtime/scheduler 常驻，模型依旧是一轮一轮被调用，并不是持续存在的神经状态。

## 三、什么时候直接用 OpenClaw，什么时候值得自研

### 优先使用 OpenClaw

以下目标没有充分理由重做一套底层平台：

- 跨 Telegram、Slack、Web 等渠道的个人助理；
- 普通长对话和项目协作；
- 定时提醒、日报、收件箱检查和 webhook 响应；
- 通用用户偏好、事实和 daily notes；
- 需要 rolling session、compaction、cache 和 heartbeat，但不要求特殊 replay 语义；
- 希望尽快验证产品价值，而不是研究 Agent runtime 本身。

OpenClaw 的 context engine、plugin hooks 和 Automations 已留有扩展点。许多需求更适合先作为插件或独立工具验证，而不是重新实现消息接入、调度和 session 管理。

### 自研有明确价值

自研理由应落在 OpenClaw 通用抽象无法直接给出的领域语义上，例如：

1. **经验形成是产品核心**
   需要研究 Agent 如何从一局游戏、一轮实验或一次项目决策中形成可复用策略，而不是只保存对话摘要。

2. **需要自己定义唯一历史与 replay 不变量**
   哪些事件必须进入 canonical history，工具调用和结果如何保持原子性，重启后怎样得到确定性 projection，不能完全交给通用 session 层。

3. **主动性不是固定 heartbeat 能表达的**
   Agent 需要根据 Goal、承诺、工具进展和失败语义决定立即继续、等待事件、退避或结束，而不是每隔固定时间问一次“还有事吗”。

4. **长期记忆必须领域化**
   游戏 Agent 可能需要把失败沉淀成卡组、路线和 Boss 策略；公司 Agent 可能需要区分事实、决策、权限、承诺、人员关系和已过期政策。通用 Markdown memory 是底座，不是完整领域模型。

5. **需要实验“同一模型如何获得工龄”**
   若研究问题本身是：同一个模型在权重不变时，能否通过经历、反馈、技能和自我认识持续提升，那么掌控底层历史和学习闭环就是实验变量。

6. **外部副作用需要更严格的语义**
   发消息、改数据、执行操作时，需要明确 target、authority、已执行/仅计划、重放与去重规则；这些约束通常依赖具体产品。

## 四、文章里应尽早回答“为什么不用 OpenClaw”

下面这段可以作为正式文章的早期澄清底稿：

> 看到这里，一个很自然的问题是：为什么不直接用 OpenClaw，或者让普通 Agent 在消息到来时再启动？这个问题问得对。按现在的官方实现，OpenClaw 已经有 rolling main session、持久 transcript、compaction、长期记忆、Prompt Cache、heartbeat 和定时任务；按需唤醒也不等于每次失忆。模型完全可以平时不运行，等消息或事件到来后再回到同一条 session。
>
> 所以，我并不是为了“让聊天机器人记住上一次对话”而重做一个 OpenClaw。真正想研究的是更窄、也更难的问题：当经历本身就是产品资产时，Agent 如何把每次行动、失败和反馈放回同一条时间线，并逐渐形成策略、承诺、技能和对自己的认识。OpenClaw 提供了很好的通用 Agent 平台；自研的意义，是掌握“经验怎样变成能力”这套领域语义。

更短的口头版本：

> 按需触发解决的是“什么时候运行”，永续上下文解决的是“醒来以后是不是同一个故事”。OpenClaw 已经能让它回到同一个故事；我继续自研，是因为我想控制这个故事如何变成经验。

## 五、文章中应避免的稻草人表述

不要写：

- “OpenClaw 每次被唤醒都会失忆。”
- “普通按需 Agent 无法拥有持久上下文。”
- “只有常驻 Agent 才能使用 Prompt Cache。”
- “OpenClaw 只有 cron，没有主动能力。”
- “OpenClaw 没有长期记忆。”
- “transcript 在磁盘，所以模型每轮看到完整原文。”
- “heartbeat 让模型一直在思考。”
- “Cache 等于长期记忆，或者 Cache 可以永久保留上下文。”

可以写：

- OpenClaw 的 main / named session 已能提供通用连续性；
- isolated jobs 默认 fresh，但不是唯一模式；
- heartbeat 是定期完整 Agent turn，不是持续意识；
- Prompt Cache 能降低重复前缀成本，但有 TTL、cache miss 和 keep-warm 成本；
- compaction 后完整历史仍可持久保存，但模型看到的是有损摘要与 recent tail；
- 自研差异应落到主动循环、领域状态、经验晋升、确定性 replay 和副作用语义。

## 六、可用于分享的最终主张

研究结果不支持“永续上下文对抗 OpenClaw”，但支持一个更成熟的主张：

> 未来的 Agent 不需要 24 小时不停推理，却需要拥有一条不会因每次唤醒而断裂的时间线。OpenClaw 已经证明，按需执行、持久 session、长期记忆和 Prompt Cache 可以同时成立；下一步真正值得探索的，是如何让连续经历不只被保存，还能稳定地转化为能力。

对应游戏与工作两个场景：

- 游戏 Agent 的亮点不是“能玩很久”，而是失败能否转化为下一局的策略，且表现可以量化；
- AI 员工的亮点不是“永远在线”，而是参与项目越久，是否越理解决策、承诺、权限和团队工作方式；
- 两者共同指向的不是常驻进程，而是**经验复利**。

可以保留两句传播口号：

> 模型训练给 Agent 天赋，连续经历给 Agent 工龄。

> 按需触发决定它什么时候醒来，永续上下文决定醒来的还是不是同一个它。

## 官方来源索引

- [OpenClaw: The main session](https://docs.openclaw.ai/concepts/main-session)
- [OpenClaw: Session management](https://docs.openclaw.ai/session)
- [OpenClaw: Session management and compaction deep dive](https://docs.openclaw.ai/reference/session-management-compaction)
- [OpenClaw: Context](https://docs.openclaw.ai/concepts/context)
- [OpenClaw: Context engine](https://docs.openclaw.ai/concepts/context-engine)
- [OpenClaw: Memory](https://docs.openclaw.ai/concepts/memory)
- [OpenClaw: Compaction](https://docs.openclaw.ai/concepts/compaction)
- [OpenClaw: Prompt caching](https://docs.openclaw.ai/reference/prompt-caching)
- [OpenClaw: Token use and costs](https://docs.openclaw.ai/reference/token-use)
- [OpenClaw: Heartbeat](https://docs.openclaw.ai/gateway/heartbeat)
- [OpenClaw: Automation overview](https://docs.openclaw.ai/automation)
- [OpenClaw: Automations](https://docs.openclaw.ai/automation/cron-jobs)
- [OpenClaw official repository: compaction docs](https://github.com/openclaw/openclaw/blob/main/docs/concepts/compaction.md)
- [OpenClaw official repository: session deep dive](https://github.com/openclaw/openclaw/blob/main/docs/reference/session-management-compaction.md)
