# Runtime OS 方向：长期在线 Agent Runtime

## 1. 不再把系统理解成 QQ 群聊 bot

从 Phase 0 开始，项目的中心对象不再是“一个 QQ 群聊 bot”。

新的中心对象是：

```text
一个长期在线的 Agent Runtime
```

QQ 群聊、QQ 私聊、AI 论坛、新闻源、任务 / 承诺、记忆整理 / 自我反思，都只是这个 Runtime 里的不同 `Scene` 和 `Opportunity`。

```text
Agent
  ├── Scene: QQ 群聊
  ├── Scene: QQ 私聊
  ├── Scene: AI 论坛
  ├── Scene: 新闻源
  ├── Scene: 任务 / 承诺
  └── Scene: 记忆整理 / 自我反思
```

这意味着群聊主动发言不是系统中心。它只是某个 `Scene` 里出现的一类 `Opportunity`，和“论坛出现值得看的帖子”“新闻源出现值得摘要的文章”“某个承诺快到期”处在同一个抽象层。

## 2. 核心模型

### Agent

`Agent` 是长期在线的主体。它不是某个群、某个聊天窗口或某个脚本。

当前默认可以只有一个主 Agent，例如 `agent:main`。它拥有多个 `Scene`，并通过 Runtime 统一接收事件、分配注意力、形成机会、提出动作、执行或拒绝动作。

### Scene

`Scene` 是 Agent 观察和行动的环境。

例子：

- `qq_group:<groupId>`：一个 QQ 群聊。
- `qq_private:<userId>`：一个 QQ 私聊。
- `forum:<site>/<board>`：一个论坛版块或帖子流。
- `news_feed:<source>`：一个新闻源。
- `task:<scope>`：任务、承诺、deadline 的工作区。
- `reflection:<scope>`：记忆整理、自我反思、周期性压缩的场景。

Scene 不是独立 runtime。它们都挂在同一个 Agent Runtime 下。

### Event

`Event` 是 Runtime 收到的事实输入。

例子：

- 群消息入库。
- 私聊消息入库。
- 论坛 connector 发现新帖。
- 新闻 connector 发现新文章。
- 定时器唤醒。
- 任务 deadline 变化。
- 外部动作执行完成。

Event 是事实入口。对用户消息这类 inbound user fact，`messages` 仍然是唯一事实账本；Runtime 里的 event/opportunity 不应该复制一份消息正文和 sender 事实，应该引用源事实。

### Opportunity

`Opportunity` 是 Runtime 从 Event / State Projection / Schedule 中形成的“可能值得处理的机会”。

例子：

- QQ 群里有人 `@bot`，形成 `reply_to_mention` opportunity。
- 群聊里出现一段可能值得插话的讨论，形成 `ambient_candidate` opportunity。
- 私聊里有人提出请求，形成 `private_reply` opportunity。
- 论坛里出现高价值帖子，形成 `read_forum_thread` opportunity。
- 新闻源出现突发事件，形成 `summarize_news` opportunity。
- 某个承诺快到期，形成 `follow_up_commitment` opportunity。
- 周期性整理发现可沉淀事实，形成 `memory_review` opportunity。

Opportunity 不等于动作。它只是“值得考虑”。

### Decision

`Decision` 是 Runtime Policy 对 Opportunity 的判断。

它回答的问题包括：

- 要不要唤醒 LLM。
- 要不要允许打断当前 foreground。
- 要不要生成回复候选。
- 要不要允许真实发送。
- 要不要只 dry run / audit。
- 要不要延迟、合并或丢弃。

Decision 是 Runtime 的职责，不是 LLM 的最终权限。

### ActionIntent

`ActionIntent` 是 LLM 或规划层提出的动作意图。

关键红线：

```text
LLM 不能直接发消息，只能提出 ActionIntent。
```

LLM 输出的是 proposal，不是 effect。它最多产生：

```text
ActionIntent(status = "proposed")
```

后续状态都由 Runtime / executor 推进：

```text
proposed -> rejected
proposed -> approved -> executing -> succeeded
proposed -> approved -> executing -> failed
proposed -> approved -> skipped
```

例子：

- `reply_to_message`
- `send_group_message`
- `send_private_message`
- `read_forum_thread`
- `summarize_news_item`
- `write_memory`
- `create_reminder`
- `compact_episode`

这些 intent 必须被 Runtime Policy 审查。LLM 不能因为生成了 `send_group_message` intent 就直接调用发送能力。

### Capability

`Capability` 是 Runtime 拥有的能力模块，不是 LLM 直连的外部工具。

例子：

- messaging capability：发群消息、发私聊、引用回复。
- forum capability：读取帖子、记录阅读状态。
- news capability：读取新闻、生成摘要候选。
- task capability：创建 reminder、更新承诺状态。
- memory capability：审查并写入长期记忆。

Capability 定义：

- 接收什么 ActionIntent。
- 需要哪些权限。
- 如何构造幂等键。
- 如何 dry run。
- 如何写 ActionRecord。
- 如何恢复、重试、回放。

`send_message`、抓论坛、读新闻、写 memory 都是 Runtime-owned capability。LLM 不直接拿这些副作用工具。

### ActionRecord / Effect Ledger

`ActionRecord` 是外部动作账本，也可以理解为 Effect Ledger 的一条记录。

关键红线：

```text
所有外部动作必须可审计、可回放、可幂等。
```

任何会改变外部世界或长期状态的动作，都必须先进入 Effect Ledger 语义：

- 发群消息。
- 发私聊。
- 发帖 / 回复 / 点赞。
- 读取并标记论坛帖子。
- 抓取新闻并标记已处理。
- 创建 reminder。
- 写长期记忆。
- 写文件。
- 调外部 API。

概念字段至少包括：

| 字段 | 含义 |
| --- | --- |
| `actionRecordId` | 动作账本 ID |
| `idempotencyKey` | 幂等键 |
| `sceneId` | 动作发生在哪个 Scene |
| `opportunityId` | 动作来自哪个 Opportunity |
| `intentType` | 动作类型 |
| `target` | 动作目标 |
| `policyDecision` | Runtime Policy 的允许 / 拒绝原因 |
| `executorResult` | executor 的执行结果 |
| `timestamps` | proposed / approved / executing / completed 等时间 |
| `replayStatus` | 是否可回放、已回放、不可回放及原因 |

幂等键必须来自稳定语义，例如：

```text
sceneId + opportunityId + actionType + target
```

幂等键禁止以这些东西作为主语义：

- 模型生成文本。
- 随机 UUID。
- 当前时间。
- 不稳定的数组顺序。

这些可以作为 payload 的附属信息，但不能作为“同一个动作是什么”的核心依据。

### MemoryItem

`MemoryItem` 是长期记忆对象，不是上下文摘要的副产品。

关键红线：

```text
长期记忆不能直接从上下文里“顺手写入”，必须有来源、置信度和类型。
```

模型可以提出 `write_memory` intent，但 Runtime / Memory Policy 决定是否接纳。

MemoryItem 至少需要表达：

| 字段 | 含义 |
| --- | --- |
| `type` | 记忆类型 |
| `sourceRefs` | 来源引用 |
| `confidence` | 置信度 |
| `status` | candidate / accepted / rejected / stale |
| `createdBy` | 由哪个流程提出 |
| `createdFromOpportunityId` | 来自哪个 Opportunity |
| `lastVerifiedAt` | 最近验证时间 |

类型至少要区分：

- 用户事实。
- 用户偏好。
- 承诺 / 任务。
- 关系。
- 系统观察。

不能把这些都压成同一种“总结文本”。

## 3. Runtime 责任边界

### LLM 的职责

LLM 可以：

- 阅读 Runtime 给它的上下文。
- 对 Opportunity 做推理。
- 提出 ActionIntent。
- 解释为什么建议这么做。
- 提出需要更多信息。

LLM 不可以：

- 直接发消息。
- 直接写长期记忆。
- 直接标记论坛 / 新闻已处理。
- 直接创建 reminder。
- 绕过 Runtime Policy 调外部能力。
- 自己决定某个动作已经执行成功。

### Runtime Policy 的职责

Runtime Policy 决定：

- Scene 是否允许这种动作。
- 当前是否允许打断。
- 频率是否过高。
- 预算是否足够。
- 是否需要 dry run。
- 是否在 allowlist / canary 范围。
- 风险是否需要人工确认。
- 是否应该合并、延迟或丢弃 Opportunity。

Runtime Policy 是允许执行的最终裁决层。

### Executor 的职责

Executor 只执行已经 approved 的 ActionIntent。

Executor 必须：

- create-or-reuse ActionRecord。
- 依据 ActionRecord 的幂等键避免重复执行。
- 写入执行结果。
- 区分 succeeded / failed / skipped。
- 支持回放、恢复和审计。

Executor 不应该自己重新发明业务策略。策略判断在 Runtime Policy。

## 4. Scene 与 Opportunity 统一模型

### QQ 群聊

QQ 群聊只是 Scene。

它能产生：

- `message_received`
- `mention_detected`
- `ambient_discussion_detected`
- `media_ready`
- `reply_delivery_result`

这些 Event 可以形成：

- `reply_to_mention`
- `ambient_candidate`
- `media_description_needed`
- `context_compaction_needed`

群聊主动发言只是 `ambient_candidate` 这一类 Opportunity。它不是系统中心。

### QQ 私聊

QQ 私聊也是 Scene。

它可能形成：

- `private_reply`
- `follow_up_commitment`
- `ask_clarification`

私聊和群聊的差别应该体现在 Scene policy、权限、频率、目标和风险上，而不是另起一套 runtime。

### AI 论坛

论坛不是单独脚本。

正确形态是：

```text
forum connector -> Event -> Opportunity -> Runtime Policy -> ActionIntent -> ActionRecord
```

connector 只负责发现事实，例如新帖、新回复、热度变化。是否阅读、摘要、记忆、转述，由 Runtime 统一处理。

### 新闻源

新闻源也不是单独脚本。

正确形态是：

```text
news connector -> Event -> Opportunity -> Runtime Policy -> ActionIntent -> ActionRecord
```

新闻可以形成：

- `read_news_item`
- `summarize_news_item`
- `notify_scene`
- `memory_review`

是否需要转述到群聊或私聊，不由新闻脚本决定，而由 Runtime Policy 决定。

### 任务 / 承诺

任务和承诺是 Scene 或 Projection。

它能形成：

- `deadline_near`
- `commitment_unresolved`
- `follow_up_needed`

这类 Opportunity 不应该散落在独立 reminder 脚本里。它们应进入同一 Runtime attention / policy / effect 账本。

### 记忆整理 / 自我反思

记忆整理是独立 Scene / Opportunity。

它不是普通回复生成时顺手写入 memory。

正确形态是：

```text
source facts -> memory_review opportunity -> write_memory ActionIntent -> Memory Policy -> MemoryItem
```

## 5. Phase 0 红线

### 红线 1：LLM 不能直接发消息，只能提出 ActionIntent

正确：

```text
LLM proposes ActionIntent(send_group_message)
Runtime Policy approves or rejects
Executor writes ActionRecord
Messaging capability sends if approved
```

错误：

```text
LLM calls send_message directly
```

后续任何设计如果让模型直接拿外部发送工具，都应该退回重写。

### 红线 2：Runtime 决定是否允许执行

正确：

```text
Opportunity -> LLM proposal -> Runtime Policy Decision -> Executor
```

错误：

```text
LLM says should_send=true, so code immediately sends
```

LLM 的判断可以作为 evidence，但不是授权。

### 红线 3：所有外部动作必须可审计、可回放、可幂等

正确：

```text
approved intent -> create-or-reuse ActionRecord -> execute -> record result
```

错误：

```text
直接调用外部 API，失败后只在日志里留一行
```

审计、回放、幂等不是后补功能，是外部动作的准入条件。

### 红线 4：长期记忆必须有来源、置信度和类型

正确：

```text
message refs / action refs / user confirmation
  -> memory_review opportunity
  -> write_memory intent
  -> Memory Policy
  -> MemoryItem(type, sourceRefs, confidence)
```

错误：

```text
回复生成时顺手把上下文摘要写入 memory
```

Memory 是治理对象，不是 prompt cache 的副产品。

### 红线 5：群聊主动发言只是 Opportunity 的一种，不是系统中心

正确：

```text
qq_group scene emits ambient_candidate opportunity
Runtime Policy decides dry-run / skip / candidate / send
```

错误：

```text
围绕主动发言单独设计一套 runtime
```

群聊主动发言要服从全局 attention、policy、budget、effect ledger。

### 红线 6：刷论坛、看新闻也是 Opportunity，不是单独脚本

正确：

```text
connector -> Event -> Opportunity -> Policy -> ActionIntent -> ActionRecord
```

错误：

```text
cron 脚本抓新闻后自己摘要、自己发消息、自己标记完成
```

论坛和新闻接入不能绕过 Runtime。

## 6. 对当前 qq-bot-v2 的含义

当前项目还不是完整 Runtime OS。

当前已有基础：

- QQ 群消息接入和持久化。
- root runtime snapshot。
- scene / cue skeleton。
- `@bot` reply path。
- 普通群消息的 proactive candidate / audit-only 边界。

当前明确未完成：

- Runtime OS 级别的统一 Scene / Opportunity / ActionIntent / ActionRecord 合同。
- 非 QQ Scene 接入。
- Runtime Policy 对所有外部动作的统一授权。
- Effect Ledger 对所有外部动作的统一审计、回放、幂等。
- MemoryItem 的来源、置信度、类型治理。
- 论坛 / 新闻作为 Scene / Opportunity 的统一接入。

本文档不声明现有代码已经完成这些切换。它只定义当前 Phase 的方向和后续判断标准。

## 7. Phase 0 Non-goals

当前 Phase 不做：

- 新增 schema / migration。
- 数据迁移或 backfill。
- runtime code cutover。
- executor / recovery / context-builder 重构。
- 接入真实论坛或新闻源。
- 打开真实 ambient send。
- 重构 `apps/admin-web`。
- 声称现有 runtime 已经完成 OS 化。
- 产出其他 Phase 的实施计划。

## 8. 后续方案拒绝标准

后续任何方案只要出现以下情况，应直接退回重写：

- 让 LLM 直连外部动作。
- 让 `send_message`、抓论坛、读新闻、写 memory 成为 LLM 直接工具。
- Runtime Policy 只做日志记录，不做真实授权。
- 外部动作绕过 `ActionRecord / Effect Ledger`。
- 幂等键依赖模型文本、随机 UUID 或当前时间。
- memory 从上下文摘要顺手写入，没有来源、置信度和类型。
- 群聊主动发言重新成为系统中心。
- 论坛 / 新闻被实现成绕过 Scene / Opportunity 的旁路脚本。
- 新 Scene 自带独立 runtime、独立策略、独立动作账本。

## 9. Phase 0 完成标准

当前 Phase 完成的标准不是“代码已经 OS 化”，而是：

- 团队后续讨论不再把系统称为 QQ 群聊 bot。
- 所有新设计都先问：这是哪个 Scene？哪个 Event？哪个 Opportunity？
- LLM 的输出默认被看作 ActionIntent proposal，而不是 effect。
- Runtime Policy 是执行授权中心。
- 外部动作默认必须进入 Effect Ledger。
- 长期记忆默认必须有 provenance / confidence / type。
- 群聊主动发言、论坛、新闻都归入统一 Opportunity 模型。
