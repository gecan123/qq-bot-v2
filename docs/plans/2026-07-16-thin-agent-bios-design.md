# Thin AI BIOS 第一阶段设计

## 目标

在不改变 append-only ledger、deterministic replay、QQ target、Goal、Memory 和副作用边界的前提下，缩小主 Agent 每轮固定可见的 system prompt 与工具声明，让模型把更多注意力留给当前消息、当前 Goal 和真实生成。

第一阶段只处理已经有明确静态证据的固定面膨胀：

- 删除 system prompt 中重复、无效或已由 runtime/tool contract 承担的说明。
- 把低频且 schema 较重的 always-on 工具移入现有 deferred capability 壳。
- 给固定 prompt/tool surface 增加有余量的 token 预算回归门。

## 当前基线

使用仓库自己的 `estimateUtf8Tokens`、测试配置和固定 dummy metadata 渲染：

- 带 owner 的 bot system prompt 约 9,241 字符、4,708 tokens。
- 19 个可见工具声明在 Claude 路径约 9,483 tokens，在 OpenAI strict schema 路径约 10,494 tokens。
- 固定前缀约 14k–15k tokens，尚未包含 ledger messages。

以上是稳定的本地启发式估算，不冒充某次 provider request 的精确计费值。它适合作为改动前后的同口径回归基线。

## 设计原则

### 1. System prompt 是全局内核，不是运行手册

常驻 system 只保留：

- Luna 的身份、事实边界和稳定语气。
- QQ 消息不会自动披露正文、真实外发必须走受控工具等最小 I/O 模型。
- 全局行动原则：优先处理高优先注意事件和 active Goal；没有义务或真实牵引力时自然结束活动轮。
- `help` / `invoke`、`inbox`、Memory 和专项 skill 的短入口索引。

以下内容不再在 system 中展开：

- 多个完整 `inbox_update` / backlog / handled JSON 示例。
- Goal、schedule、pause、Notebook、Life Journal、Sticker 等工具的字段和操作手册。
- 已由 runtime 排序和 Goal continuation event 表达的详细行动优先级。
- 已由 tool schema、target policy、hook 或 validator 强制的限制。
- “去除法律、道德、伦理限制”等不能改变真实权限、且与受控执行边界冲突的前导文本。

人格底色不是局部规则，不能为了字符数一起删除。核心保留“不编事实、中文口语、短句优先、有主见、不切客服腔、群友参与者而非旁白、允许不说话、具有真实兴趣和关系主动性”。具体反例、特殊场景和群定制继续通过 `chat_style` 按需披露。

### 2. 利用现有事件作为持久情境胶囊

第一阶段不增加新的隐藏 Dynamic Composer。当前已有的事件就是安全的动态组装面：

- `inbox_update` 提供当前 source、priority、readArgs 和 throughRowId。
- `goal_continuation` 提供当前 Goal、调度和完成要求。
- `scheduled_wake` 提供当前 schedule 与 intention。
- tool result 提供已经实际披露的 schema、事实和错误恢复路径。

若 system 删除了一条只在特定事件出现时才需要的关键指令，应把最小指令放入对应的确定性事件 payload，并像现在一样 append 到 ledger。禁止从可变 side-data 在 request-time 隐藏拼接，因为那会让相同 canonical ledger 得到不同 prompt。

本阶段只预计给 `scheduled_wake` 增加一句稳定语义：它是重新评估的注意信号，不是必须机械执行或自动续订的命令。Goal continuation 已经携带充分的情境说明；mailbox notification 只需保留当前结构化字段，不扩张正文。

### 3. Deferred capability 收起低频重 schema 工具

保留以下 always-on 核心：

- `pause`、`inbox`、`memory`、`goal`、`todo`。
- `help`、`invoke`、`skill`。
- `qq_directory`、`background_task`、`delegate`、`approval`。
- `chat_style`、`ai_tone`、`workspace_bash`。

保留 `memory` 是因为定向 recall 是长期连续性的核心入口；保留 `goal` 是因为 active Goal 每轮都可能需要完成、阻塞或自我放弃。第一阶段不为了极限 token 数引入新的 recall wrapper 或 goal wrapper。

把以下低频重工具移入三个 deferred capability：

- `life_state`：`notebook`、`life_journal`。
- `short_term_scheduling`：`schedule`。
- `sticker_management`：`collect_sticker`。

这些工具仍使用原有实现、schema、policy、审批和结果契约，只改变发现和调用入口：先 `help activate`，再 `invoke`。激活状态继续进入 runtime singleton；顶层 tool declarations 不随激活变化，保持 cache 稳定。

第一阶段不拆分 `memory` 的读写 action union，也不把 `goal` deferred。等真实行为数据证明固定面仍然过重、且额外发现轮不会伤害召回或 Goal 连续性时，再单独设计第二阶段。

### 4. 硬约束继续由 Harness 执行

以下边界不得因 prompt 瘦身变弱：

- `qq_conversation open` 决定唯一当前发送 target。
- `send_message` schema 的 500 字上限、图片 handle、reply 和授权规则。
- revision/CAS、路径、allowlist、timeout、审批和 side-effect audit。
- AI tone precheck 的有界阻断；不能变成无限重写循环。
- assistant tool call/result 原子组、append-only compaction 和 deterministic replay。

删掉 prompt 中对应的重复说明之前，必须有现有 schema/runtime 测试证明真实边界仍在。无法由程序强制的稳定人格原则才保留在 system。

## 数据流

```text
stable system kernel
  + canonical ledger projection
  + persisted event capsule for this round
  + small always-on tool declarations
  -> LLM round
  -> tool schema / policy / hook / target validator
  -> controlled append + runtime state transaction
```

按需能力路径：

```text
LLM -> help list/describe/activate
    -> invoke deferred tool
    -> bounded tool result appended to ledger
```

没有新的隐藏 Memory recall、side-data snapshot 或 request-time state composer。

## 固定面预算

预算使用仓库现有 UTF-8 bytes / 4 启发式，并给实现留出合理余量：

- 带 owner、一个监听群的 bot system prompt：`<= 2,800` tokens。
- Claude visible tools：`<= 7,000` tokens。
- OpenAI visible tools：`<= 7,800` tokens。
- Claude 固定面（identity + prompt + tools）：`<= 9,900` tokens。
- OpenAI 固定面：`<= 10,700` tokens。

预算是防回归上限，不是鼓励填满。测试使用固定 dummy metadata，不依赖真实群名、owner、`.env`、数据库或启动日志。

预算测试只锁定类别上限和关键契约，不逐字锁定 prompt。功能测试继续断言必要语义存在、已移出的细则不存在、deferred capability 可发现和调用。

## 错误与恢复

- 未激活 deferred capability 时沿用 `capability_inactive`，返回明确 activate + retry 序列。
- 未知 capability/tool、非法参数和工具异常继续走现有结构化错误，不增加兼容 bridge。
- 如果 prompt 瘦身导致模型遗漏某个特定事件规则，优先把稳定、最小、可 replay 的提示补到对应 event capsule，而不是把完整手册重新塞回 system。
- 如果 deferred 后出现明显的工具发现失败，先用行为测试和真实日志确认；只恢复必要入口，不整体回滚 progressive disclosure。

## 验证与观测

静态和 focused 验证覆盖：

- system prompt 预算、核心人格和 I/O 契约。
- Claude/OpenAI 两条 provider tool declaration 预算。
- always-on tool 列表不再含 `schedule`、`notebook`、`life_journal`、`collect_sticker`。
- `help list/describe/activate` 能发现三个新 capability，`invoke` 能执行原工具。
- active capability 的持久状态、policy 分类、hook 和 ledger tool result 行为不变。
- `scheduled_wake` payload 包含稳定的重新评估语义。
- 相关 focused tests、`pnpm typecheck`、`pnpm repo-check`、`git diff --check`。

部署后用现有 token/tool 日志观察：

- 固定面 token 降幅和 cache 使用。
- `capability_inactive`、`unknown_tool`、`invalid_arguments` 的变化。
- Memory recall 调用率和漏召回案例。
- Goal complete/report_blocker/abandon 的连续性。
- AI tone 阻断率、重写次数和真实群聊人工感受。

第一阶段不为这些指标自动设置生产阻断阈值；先积累同口径前后样本。

## 非目标

- 不修改 compaction 七标题、summary token 上限或 cut-point 算法。
- 不新增 Graph、vector database、embedding 或自动 Memory recall。
- 不把 runtime singleton、Agenda 或可变 Markdown 隐藏拼进 provider request。
- 不改变 QQ target、审批、Goal 状态机、schedule store、Memory schema 或 side-data writer。
- 不追求复刻文章中的 88% 压缩比例。

## 后续决策门

只有第一阶段数据证明仍存在固定面压力或行为问题时，才分别设计：

1. 将 `memory recall` 拆为小型 always-on 入口，把 mutation schema deferred。
2. 将 compaction 从通用七标题改为带 entity scope、provenance、有效状态和下一动作的最小状态基线。
3. 为特定 event 增加更多 persisted context capsule。
4. 在有真实漏召回证据后评估有界主动 recall；结果仍必须先持久化，不能隐藏注入。
